import { onUnmounted, ref, watch, type Ref } from 'vue'
import type { EverythingFilter, EverythingItem, SearchCategory } from '@shared/unifiedSearch'

/**
 * 防抖查询 Everything，取消旧进程并阻止迟到结果覆盖新关键词。
 * @param query 当前主输入框关键词。
 * @param category 当前分类。
 * @param enabled 普通文本搜索时启用，粘贴匹配和插件子输入不启用。
 * @returns 索引结果、加载状态、错误与重试操作。
 */
export function useEverythingSearch(
  query: Ref<string>,
  category: Ref<SearchCategory>,
  enabled: Ref<boolean>
) {
  const items = ref<EverythingItem[]>([])
  const loading = ref(false)
  const error = ref('')
  const limited = ref(false)
  const revision = ref(0)
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  watch(
    [query, category, enabled, revision],
    () => {
      // 立即清空过期结果；只在输入暂停后启动外部查询。
      const current = ++generation
      clearTimeout(timer)
      window.ztools.everything.cancel()
      items.value = []
      error.value = ''
      limited.value = false
      loading.value = false
      if (!enabled.value || !['all', 'app', 'file', 'folder'].includes(category.value)) return
      loading.value = true
      const text = query.value.trim()
      const filter = category.value as EverythingFilter
      timer = setTimeout(async () => {
        try {
          const result = await window.ztools.everything.search(text, filter)
          if (current !== generation) return
          items.value = result.items
          error.value = result.error || ''
          limited.value = result.limited
        } catch (failure) {
          if (current === generation)
            error.value = failure instanceof Error ? failure.message : String(failure)
        } finally {
          if (current === generation) loading.value = false
        }
      }, 220)
    },
    { immediate: true }
  )
  onUnmounted(() => {
    generation++
    clearTimeout(timer)
    window.ztools.everything.cancel()
  })
  /**
   * 在设置修复或索引就绪后重新查询。
   * @returns 无返回值。
   */
  function retry(): void {
    revision.value++
  }
  return { items, loading, error, limited, retry }
}
