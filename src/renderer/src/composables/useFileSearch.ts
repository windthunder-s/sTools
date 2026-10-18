import { computed, onUnmounted, ref, watch, type Ref } from 'vue'
import type { EverythingFilter, EverythingItem, SearchCategory } from '@shared/unifiedSearch'
import type { FileSearchResponse, FileSearchStatus, FileSearchPage } from '@shared/fileSearch'

/**
 * 将内置索引与可选 Everything 接入统一结果；分类缓存避免切换闪空。
 * @param query 主搜索关键词。
 * @param category 当前分类。
 * @param enabled 是否处于普通文本搜索。
 * @returns 查询结果、索引进度以及刷新入口。
 */
export function useFileSearch(
  query: Ref<string>,
  category: Ref<SearchCategory>,
  enabled: Ref<boolean>
) {
  const items = ref<EverythingItem[]>([])
  const loading = ref(false)
  const error = ref('')
  const limited = ref(false)
  const total = ref(0)
  const loadingMore = ref(false)
  let resultVersion: number | undefined
  const status = ref<FileSearchStatus>()
  const engine = computed(() => status.value?.config.engine || 'builtin')
  const engineLabel = computed(() =>
    engine.value === 'builtin' ? 'sTools 内置搜索' : 'Everything SDK'
  )
  const revision = ref(0)
  const cache = new Map<string, { response: FileSearchPage; time: number }>()
  let generation = 0
  let disposed = false
  let debounce: ReturnType<typeof setTimeout> | undefined
  let polling: ReturnType<typeof setTimeout> | undefined
  let loadedQuery = ''
  let loadedCategory = ''

  /**
   * 更新索引状态，内容版本变化时后台刷新当前结果。
   * @param force 是否忽略缓存并刷新配置。
   * @returns 状态更新完成后的 Promise。
   */
  async function refreshStatus(force = false): Promise<void> {
    try {
      const next = await window.ztools.fileSearch.status({ watchQuery: enabled.value && !!query.value.trim() && document.visibilityState === 'visible' && ['all', 'app', 'file', 'folder'].includes(category.value) })
      if (disposed) return
      const previous = status.value
      status.value = next
      if (force || previous?.config.engine !== next.config.engine) {
        cache.clear()
        revision.value++
      } else if (previous?.index.version !== next.index.version) {
        // A search response may already contain the latest index version before status polling catches up.
        for (const [key, entry] of cache)
          if (entry.response.version !== next.index.version) cache.delete(key)
        if (resultVersion !== next.index.version) revision.value++
      }
    } catch (failure) {
      if (!disposed) error.value = String(failure)
    }
  }

  /**
   * 以有限频率获取后台扫描进度和索引变化。
   * @returns 本次状态轮询完成后的 Promise。
   */
  async function poll(): Promise<void> {
    await refreshStatus()
    if (!disposed)
      polling = setTimeout(poll, status.value?.index.phase === 'scanning' ? 1000 : 2000)
  }
  void poll()

  /**
   * 生成与引擎、关键词及类别绑定的缓存键。
   * @param filter 文件结果类型。
   * @returns 缓存键。
   */
  function cacheKey(filter: string): string {
    return JSON.stringify([engine.value, query.value.trim(), filter])
  }

  /**
   * 发布当前分类结果并记住其来源，后台刷新保持旧结果可见。
   * @param response 对应当前输入的查询结果。
   * @returns 无返回值。
   */
  function publish(response: FileSearchPage): void {
    items.value = response.items
    limited.value = response.limited
    total.value = response.total ?? response.items.length
    resultVersion = response.version
    error.value = response.error || ''
    loadedQuery = query.value.trim()
    loadedCategory = category.value
  }

  watch(
    [query, category, enabled, revision],
    (_next, previous) => {
      const current = ++generation
      clearTimeout(debounce)
      window.ztools.everything.cancel()
      loading.value = false
      loadingMore.value = false
      error.value = ''
      if (!enabled.value || !['all', 'app', 'file', 'folder'].includes(category.value)) {
        items.value = []
        limited.value = false
        return
      }
      const text = query.value.trim()
      const filter = category.value as EverythingFilter
      const cached = cache.get(cacheKey(filter))
      if (cached && (engine.value === 'builtin' || Date.now() - cached.time < 15000)) {
        publish(cached.response)
        return
      }
      // 只有输入或分类改变才丢弃旧内容，索引后台更新不造成列表闪空。
      if (loadedQuery !== text || loadedCategory !== filter) {
        items.value = []
        limited.value = false
      }
      loading.value = true
      const delay = previous && previous[0] === query.value ? 0 : 160
      debounce = setTimeout(async () => {
        try {
          const response: FileSearchResponse = await window.ztools.fileSearch.search(text, filter)
          if (disposed || current !== generation) return
          if (!response.error) {
            const pages = response.buckets || { [filter]: response }
            for (const [kind, page] of Object.entries(pages))
              if (page) cache.set(cacheKey(kind), { response: page, time: Date.now() })
            while (cache.size > 48) cache.delete(cache.keys().next().value!)
          }
          publish(response.buckets?.[filter] || response)
        } catch (failure) {
          if (current === generation && !disposed) error.value = String(failure)
        } finally {
          if (current === generation && !disposed) loading.value = false
        }
      }, delay)
    },
    { immediate: true }
  )

  /**
   * Append the next page from the same index snapshot, resetting safely after a version change.
   * @returns Page load completion.
   */
  async function loadMore(): Promise<void> {
    if (!limited.value || loading.value || loadingMore.value) return
    const current = generation,
      text = query.value.trim(),
      filter = category.value as EverythingFilter
    loadingMore.value = true
    error.value = ''
    try {
      const response = await window.ztools.fileSearch.search(text, filter, {
        offset: items.value.length,
        version: resultVersion
      })
      if (disposed || current !== generation) return
      if (response.error) {
        error.value = response.error
        return
      }
      const merged: FileSearchPage = {
        ...response,
        items: response.offset === 0 ? response.items : [...items.value, ...response.items]
      }
      cache.set(cacheKey(filter), { response: merged, time: Date.now() })
      publish(merged)
    } catch (failure) {
      if (!disposed && current === generation) error.value = String(failure)
    } finally {
      if (!disposed && current === generation) loadingMore.value = false
    }
  }

  /**
   * 清除宿主和界面查询缓存并重新读取索引。
   * @returns 刷新完成后的 Promise。
   */
  async function retry(): Promise<void> {
    await window.ztools.fileSearch.refresh()
    cache.clear()
    revision.value++
  }
  onUnmounted(() => {
    disposed = true
    generation++
    clearTimeout(debounce)
    clearTimeout(polling)
    window.ztools.everything.cancel()
  })
  return {
    items,
    loading,
    error,
    limited,
    total,
    loadingMore,
    loadMore,
    status,
    engine,
    engineLabel,
    retry,
    refreshStatus
  }
}
