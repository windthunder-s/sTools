<template>
  <div class="search-results-container" @click="handleContainerClick">
    <div v-if="isUnifiedSearch" class="search-categories" role="tablist" aria-label="搜索分类">
      <button
        v-for="(category, index) in SEARCH_CATEGORIES"
        :key="category.key"
        role="tab"
        :aria-selected="activeCategory === category.key"
        :data-category="category.key"
        :title="category.label + ' · Alt+' + (index + 1)"
        @click="activeCategory = category.key"
      >
        {{ category.label }}
      </button>
      <button class="search-settings-entry" @click="searchSettingsOpen = !searchSettingsOpen">
        搜索设置
      </button>
    </div>
    <div v-if="!isUnifiedSearch && !searchSettingsOpen" class="search-home-status">
      <span
        >{{ engineLabel
        }}<template v-if="searchStatus?.index.phase === 'scanning'"> · 正在建立索引</template></span
      >
      <button @click="searchSettingsOpen = true">搜索设置</button>
    </div>
    <SearchSettings
      v-if="searchSettingsOpen"
      @close="closeSearchSettings"
      @changed="refreshStatus(true)"
    />
    <div v-else ref="scrollContainerRef" class="scrollable-content">
      <!-- 聚合模式 -->
      <AggregateView
        v-if="searchMode === 'aggregate'"
        v-model:recent-expanded="isRecentExpanded"
        v-model:pinned-expanded="isPinnedExpanded"
        v-model:search-results-expanded="isSearchResultsExpanded"
        v-model:best-matches-expanded="isBestMatchesExpanded"
        v-model:recommendations-expanded="isRecommendationsExpanded"
        :search-query="searchQuery"
        :pasted-image="pastedImage"
        :pasted-files="pastedFiles"
        :pasted-text="pastedText"
        :best-search-results="bestSearchResults"
        :best-matches="bestMatches"
        :recommendations="recommendationItems"
        :main-push-groups="visibleMainPushGroups"
        :display-apps="displayApps"
        :pinned-apps="pinnedApps"
        :window-matched-actions="visibleWindowActions"
        :window-match-title="windowMatchTitle"
        :navigation-grid="navigationGrid"
        :selected-row="selectedRow"
        :selected-col="selectedCol"
        :loading="loading"
        :show-recent-in-search="showRecentInSearch"
        :recent-rows="windowStore.recentRows"
        :pinned-rows="windowStore.pinnedRows"
        @select="handleSelectApp"
        @select-window="handleWindowAction"
        @select-recommendation="handleRecommendationSelect"
        @select-main-push="handleMainPushSelectAction"
        @enter-main-push-app="handleEnterMainPushApp"
        @contextmenu="handleAppContextMenu"
        @update:pinned-order="updatePinnedOrder"
        @height-changed="emit('height-changed')"
      />

      <section
        v-if="searchMode === 'aggregate' && indexedResults.length"
        class="indexed-results"
        aria-label="本机搜索结果"
      >
        <div class="indexed-heading">
          本机结果 <span>{{ engineLabel }} · {{ indexedResults.length }} 项</span>
        </div>
        <VerticalList
          :apps="indexedResults"
          :selected-index="indexedSelectedIndex"
          :search-query="searchQuery"
          @select="handleSelectApp"
          @contextmenu="(app) => handleAppContextMenu(app, 'search')"
        />
      </section>
      <!-- 列表模式 -->
      <div v-if="searchMode === 'list' && hasSearchContent" class="list-mode-results">
        <VerticalList
          :apps="allListModeResults"
          :selected-index="listModeSelectedIndex"
          :search-query="searchQuery"
          @select="handleSelectApp"
          @contextmenu="(app) => handleAppContextMenu(app, 'search')"
        />
      </div>
      <div v-if="isUnifiedSearch" class="search-status" role="status">
        <span v-if="indexLoading">{{ engineLabel }}正在搜索…</span>
        <span v-else-if="searchStatus?.index.phase === 'scanning'"
          >正在建立本地索引 · 已收录
          {{ searchStatus.index.count.toLocaleString() }} 项，结果会逐步补全</span
        >
        <template v-else-if="indexError">
          <span class="search-error">{{ indexError }}</span>
          <button @click="searchSettingsOpen = true">搜索设置</button>
          <button @click="retryIndex">重试</button
          ><button @click="openToolSettings">工具设置</button>
        </template>
        <span v-else-if="!navigationGrid.length">此分类下没有找到结果</span>
        <template v-else-if="indexLimited">
          <span>已加载 {{ indexedItems.length }} / {{ indexTotal }} 项</span>
          <button :disabled="loadingMore" @click.stop="loadMore" @keydown.stop>
            {{ loadingMore ? '正在加载…' : '加载更多' }}
          </button>
        </template>
        <span v-else-if="indexedResults.length"
          >↑↓ 选择 · Enter 打开 · Ctrl+Enter 打开所在位置 · Alt+1–6 切换分类</span
        >
        <span v-if="actionError" class="search-error">{{ actionError }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, nextTick, onMounted, onUnmounted, ref, toRaw, watch } from 'vue'
import { normalizeConfigList } from '@shared/pluginSettings'
import {
  useMainPushResults,
  type MainPushGroup,
  type MainPushItem
} from '../../composables/useMainPushResults'
import {
  resolveMainPushMenuState,
  toggleMainPushSetting
} from '../../composables/useMainPushSetting'
import { useNavigation } from '../../composables/useNavigation'
import { useSearchResults } from '../../composables/useSearchResults'
import { useFileSearch } from '../../composables/useFileSearch'
import SearchSettings from './SearchSettings.vue'
import {
  SEARCH_CATEGORIES,
  searchCategory,
  everythingCategory,
  uniqueEverythingItems,
  type SearchCategory
} from '@shared/unifiedSearch'
import type { Command } from '../../stores/commandDataStore'
import { useCommandDataStore } from '../../stores/commandDataStore'
import { useWindowStore } from '../../stores/windowStore'
import VerticalList from '../common/VerticalList.vue'
import AggregateView from './AggregateView.vue'
import { buildAggregateNavigationGrid, type NavigationGridRow } from './navigationGrid'

// MatchFile 接口（传递给插件的文件格式）
interface MatchFile {
  isFile: boolean
  isDirectory: boolean
  name: string
  path: string
}

// FileItem 接口（从剪贴板管理器返回的格式）
interface FileItem {
  path: string
  name: string
  isDirectory: boolean
}

interface Props {
  searchQuery: string
  pastedImage?: string | null
  pastedFiles?: FileItem[] | null
  pastedText?: string | null
}

type ContextMenuSource = 'history' | 'pinned' | 'search' | 'recommendation'

const props = defineProps<Props>()

const windowStore = useWindowStore()
const searchMode = computed(() => windowStore.searchMode)

const emit = defineEmits<{
  (e: 'height-changed'): void
  (e: 'focus-input'): void
  (e: 'restore-match', state: any): void
}>()

// 使用 store
const commandDataStore = useCommandDataStore()
const { loading } = storeToRefs(commandDataStore)
const {
  getRecentCommands,
  removeFromHistory,
  pinCommand,
  unpinCommand,
  isPinned,
  getRecommendationPinIndex,
  isRecommendationPinned,
  pinRecommendation,
  unpinRecommendation,
  moveRecommendationToFront,
  getPinnedCommands,
  updatePinnedOrder,
  saveSearchPreference,
  loadSuperPanelPinnedData,
  isPinnedToSuperPanel
} = commandDataStore

// 使用搜索结果 composable
const rawResults = useSearchResults(props)
const activeCategory = ref<SearchCategory>('all')
const actionError = ref('')
const searchSettingsOpen = ref(false)
/**
 * 关闭搜索设置并将焦点交还主输入框。
 * @returns 无返回值。
 */
function closeSearchSettings(): void {
  searchSettingsOpen.value = false
  emit('focus-input')
}
const isUnifiedSearch = computed(() =>
  Boolean(props.searchQuery.trim() && !props.pastedImage && !props.pastedFiles && !props.pastedText)
)
const {
  items: indexedItems,
  loading: indexLoading,
  error: indexError,
  limited: indexLimited,
  total: indexTotal,
  loadingMore,
  loadMore,
  retry: retryIndex,
  status: searchStatus,
  engineLabel,
  refreshStatus
} = useFileSearch(
  computed(() => props.searchQuery),
  activeCategory,
  isUnifiedSearch
)

/**
 * 分类筛选保留原有相关性排序；粘贴匹配不受分类影响。
 * @param commands 已匹配的指令。
 * @returns 当前分类内的指令。
 */
function filterCategory(commands: Command[]): Command[] {
  return !isUnifiedSearch.value || activeCategory.value === 'all'
    ? commands
    : commands.filter((command) => searchCategory(command) === activeCategory.value)
}
const bestSearchResults = computed(() => filterCategory(rawResults.bestSearchResults.value))
const bestMatches = computed(() => filterCategory(rawResults.bestMatches.value))
const recommendations = computed(() => filterCategory(rawResults.recommendations.value))
const indexedResults = computed<Command[]>(() =>
  uniqueEverythingItems(
    indexedItems.value,
    filterCategory(rawResults.allListModeResults.value)
  ).map((item) => ({
    name: item.name,
    path: item.path,
    type: 'local-file' as const,
    subType: everythingCategory(item) === 'app' ? ('app' as const) : ('local-shortcut' as const),
    category: everythingCategory(item),
    searchSource: 'everything' as const
  }))
)
const allListModeResults = computed(() => [
  ...filterCategory(rawResults.allListModeResults.value),
  ...indexedResults.value
])

/**
 * 从错误提示打开与主搜索共享配置的本地工具设置。
 * @returns 插件启动完成后结束的 Promise。
 */
async function openToolSettings(): Promise<void> {
  const command = commandDataStore.commands.find(
    (item) => item.pluginName === 'local-tools' && item.featureCode === 'configure'
  )
  if (command) await handleSelectApp(command)
}

// 为推荐项附加仅用于渲染的置顶状态，避免把 UI 字段写入固定列表数据。
const recommendationItems = computed(() =>
  recommendations.value.map((item) => ({
    ...item,
    isPinnedInSearch: isRecommendationPinned(item)
  }))
)

// 使用 mainPush 结果 composable
const { mainPushGroups, handleMainPushSelect } = useMainPushResults(props)
const visibleMainPushGroups = computed(() =>
  !isUnifiedSearch.value || ['all', 'plugin'].includes(activeCategory.value)
    ? mainPushGroups.value
    : []
)

// 内部状态
const scrollContainerRef = ref<HTMLElement>()
const showRecentInSearch = computed(() => windowStore.showRecentInSearch)

// 展示设置插件详情页面对应小项的 payload
type PluginPayload = { pluginName: string; path?: string }

/**
 * 从搜索结果项中提取插件名称载荷。
 */
function getPluginPayload(app: any): PluginPayload | null {
  if (!app?.pluginName) {
    return null
  }
  return { pluginName: app.pluginName, path: app.path }
}

/**
 * 解析右键菜单回传的插件载荷。
 */
function parsePluginPayload(raw: string): PluginPayload | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed?.pluginName) return null
    return { pluginName: parsed.pluginName, path: parsed.path }
  } catch {
    return null
  }
}

// 是否有搜索内容

const hasSearchContent = computed(() => {
  return !!(props.searchQuery.trim() || props.pastedImage || props.pastedText || props.pastedFiles)
})

// 窗口匹配的操作列表（基于 feature 动态匹配）
const windowMatchedActions = computed(() => {
  const currentWindow = windowStore.currentWindow
  if (!currentWindow) {
    return []
  }

  // 使用 commandDataStore 的 searchWindowCommands 进行匹配
  const matched = commandDataStore.searchWindowCommands({
    app: currentWindow.app,
    title: currentWindow.title,
    className: currentWindow.className
  })

  // 如果有搜索内容，在匹配的窗口指令中进一步搜索
  if (props.searchQuery.trim()) {
    return commandDataStore.searchInCommands(matched, props.searchQuery)
  }

  return matched
})

const visibleWindowActions = computed(() => filterCategory(windowMatchedActions.value))

// 窗口匹配栏的标题（基于当前窗口的 app 名称）
const windowMatchTitle = computed(() => {
  const currentWindow = windowStore.currentWindow
  if (!currentWindow) {
    return ''
  }
  // 提取 app 名称（去掉 .app 后缀）
  const appName = currentWindow.app || ''
  return appName.replace(/\.app$/i, '')
})

// 显示的应用列表
const displayApps = computed(() => {
  if (props.pastedImage || props.pastedText || props.pastedFiles) return []
  if (props.searchQuery.trim() === '') {
    return getRecentCommands()
  }
  return []
})

// 固定应用列表
const pinnedApps = computed(() => {
  return getPinnedCommands()
})

// 折叠状态（提升到这里统一管理）
const isRecentExpanded = ref(false)
const isPinnedExpanded = ref(false)
const isSearchResultsExpanded = ref(false)
const isBestMatchesExpanded = ref(false)
const isRecommendationsExpanded = ref(false)

// 构建导航网格
const navigationGrid = computed<NavigationGridRow[]>(() => {
  // 列表模式：使用一维数组（每个项目占一行）
  if (searchMode.value === 'list') {
    if (!hasSearchContent.value) {
      return []
    }
    return allListModeResults.value.map((item: any) => ({ type: 'listItem', items: [item] }))
  }

  const rows = buildAggregateNavigationGrid({
    hasSearchContent: hasSearchContent.value,
    bestSearchResults: bestSearchResults.value,
    bestMatches: bestMatches.value,
    recommendations: recommendationItems.value,
    mainPushGroups: visibleMainPushGroups.value,
    windowMatchedActions: visibleWindowActions.value,
    displayApps: displayApps.value,
    pinnedApps: pinnedApps.value,
    showRecentInSearch: showRecentInSearch.value,
    recentExpanded: isRecentExpanded.value,
    pinnedExpanded: isPinnedExpanded.value,
    searchResultsExpanded: isSearchResultsExpanded.value,
    bestMatchesExpanded: isBestMatchesExpanded.value,
    recommendationsExpanded: isRecommendationsExpanded.value,
    recentRows: windowStore.recentRows,
    pinnedRows: windowStore.pinnedRows
  })
  return [...rows, ...indexedResults.value.map((item) => ({ type: 'indexed', items: [item] }))]
})

// 使用导航 composable
const {
  selectedRow,
  selectedCol,
  selectedItem,
  handleKeydown: handleNavigationKeydown,
  resetSelection: resetNavigationSelection
} = useNavigation(searchMode, navigationGrid)

/**
 * 重置选中项和结果滚动位置，避免新关键词或分类沿用旧列表的偏移。
 * @returns 无返回值。
 */
function resetSelection(): void {
  resetNavigationSelection()
  if (scrollContainerRef.value) scrollContainerRef.value.scrollTop = 0
}

const indexedSelectedIndex = computed(() => {
  if (navigationGrid.value[selectedRow.value]?.type !== 'indexed') return -1
  return selectedRow.value - navigationGrid.value.findIndex((row) => row.type === 'indexed')
})
watch([activeCategory, isUnifiedSearch, searchMode], () => {
  if (!isUnifiedSearch.value) activeCategory.value = 'all'
  resetSelection()
})
watch(
  [
    navigationGrid,
    indexLoading,
    indexError,
    indexLimited,
    actionError,
    searchSettingsOpen,
    searchStatus
  ],
  () => nextTick(() => emit('height-changed'))
)

// 列表模式的选中索引（一维索引）
const listModeSelectedIndex = computed(() => {
  if (searchMode.value !== 'list') {
    return -1
  }

  const grid = navigationGrid.value
  if (grid.length === 0 || selectedRow.value >= grid.length) {
    return -1
  }

  // 计算一维索引
  let index = 0
  for (let i = 0; i < selectedRow.value; i++) {
    index += grid[i].items.length
  }
  index += selectedCol.value

  return index
})

// 监听搜索内容变化,重置选中状态和折叠状态
watch(
  [
    () => props.searchQuery,
    () => props.pastedImage,
    () => props.pastedText,
    () => props.pastedFiles
  ],
  () => {
    resetSelection()
    actionError.value = ''
    // 重置所有折叠状态
    isRecentExpanded.value = false
    isPinnedExpanded.value = false
    isSearchResultsExpanded.value = false
    isBestMatchesExpanded.value = false
    isRecommendationsExpanded.value = false
    emit('height-changed')
  }
)

// 监听折叠状态变化，通知父组件调整窗口高度
watch(
  [
    isRecentExpanded,
    isPinnedExpanded,
    isSearchResultsExpanded,
    isBestMatchesExpanded,
    isRecommendationsExpanded
  ],
  () => {
    emit('height-changed')
  }
)

/**
 * 将网格指令或 Everything 列表中的当前项滚动到可见区域。
 * @returns 无返回值。
 */
function scrollToSelectedItem(): void {
  nextTick(() => {
    // DOM 更新后读取当前选中项，不保留会在换词后执行的旧滚动定时器。
    const container = scrollContainerRef.value
    if (!container?.isConnected) return
    const selector =
      searchMode.value === 'list' || navigationGrid.value[selectedRow.value]?.type === 'indexed'
        ? '.list-item.selected'
        : '.app-item.selected'
    const selectedElement = container.querySelector<HTMLElement>(selector)
    if (!selectedElement) return

    // 分类栏独立在滚动区外，文件只能绘制在此视口内。
    const viewport = container.getBoundingClientRect()
    const item = selectedElement.getBoundingClientRect()
    if (item.top < viewport.top) {
      container.scrollBy({ top: item.top - viewport.top, behavior: 'auto' })
    } else if (item.bottom > viewport.bottom) {
      container.scrollBy({ top: item.bottom - viewport.bottom, behavior: 'auto' })
    }
  })
}

// 监听选中项变化，自动滚动
watch([selectedRow, selectedCol], () => {
  scrollToSelectedItem()
})

// 监听 mainPush 结果变化，调整窗口高度
watch(
  () => mainPushGroups.value,
  () => {
    emit('height-changed')
  },
  { deep: true }
)

// 监听固定列表变化，调整窗口高度
watch(
  () => pinnedApps.value.length,
  () => {
    emit('height-changed')
  }
)

// 监听历史记录列表变化，调整窗口高度
watch(
  () => displayApps.value.length,
  () => {
    emit('height-changed')
  }
)

/**
 * 根据结果来源构建应用右键菜单。
 * @param app 触发菜单的指令
 * @param source 结果所在区域
 * @returns 菜单展示完成后结束的 Promise
 */
async function handleAppContextMenu(app: any, source: ContextMenuSource = 'search'): Promise<void> {
  if (app.searchSource === 'everything') {
    await window.ztools.showContextMenu([
      { id: 'open-indexed:' + JSON.stringify({ path: app.path, name: app.name }), label: '打开' },
      { id: 'reveal-in-finder:' + JSON.stringify({ path: app.path }), label: '打开所在位置' },
      { id: 'copy-indexed-path:' + JSON.stringify({ path: app.path }), label: '复制完整路径' }
    ])
    return
  }
  const menuItems: any[] = []

  // 只在历史记录中显示"从使用记录删除"
  if (source === 'history') {
    const historyMatchName =
      app.type === 'plugin'
        ? app.pluginName || app.name
        : app.type === 'direct' && app.subType === 'app'
          ? app.persistedName || app.name
          : app.name
    menuItems.push({
      id: `remove-from-history:${JSON.stringify({
        path: app.path,
        featureCode: app.featureCode,
        name: historyMatchName
      })}`,
      label: '从使用记录删除'
    })
  }

  // 如果是应用（不是插件和系统设置，且不是协议链接），显示"打开文件位置"
  const isProtocolLink = /^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(app.path) && !app.path.includes('\\')
  const isLocalApp =
    app.type !== 'system-setting' && app.type !== 'plugin' && app.path && !isProtocolLink
  if (isLocalApp) {
    menuItems.push({
      id: `reveal-in-finder:${JSON.stringify({ path: app.path })}`,
      label: '打开文件位置'
    })
  }

  // Windows 本地应用显示"以管理员身份运行"
  if (isLocalApp && window.ztools.getPlatform() === 'win32') {
    menuItems.push({
      id: `launch-as-admin:${JSON.stringify({ path: app.path, name: app.name })}`,
      label: '以管理员身份运行'
    })
  }

  if (source === 'recommendation') {
    // 推荐区使用独立置顶序列，与主搜索框固定列表完全隔离。
    const recommendationIndex = getRecommendationPinIndex(app)
    if (recommendationIndex >= 0) {
      menuItems.push({
        id: `unpin-recommendation:${JSON.stringify({
          path: app.path,
          featureCode: app.featureCode,
          name: app.name,
          pluginName: app.pluginName,
          type: app.type
        })}`,
        label: '取消置顶'
      })
      menuItems.push({
        id: `move-recommendation-to-front:${JSON.stringify({
          path: app.path,
          featureCode: app.featureCode,
          name: app.name,
          pluginName: app.pluginName,
          type: app.type
        })}`,
        label: '排到最前',
        enabled: recommendationIndex > 0
      })
    } else {
      menuItems.push({
        id: `pin-recommendation:${JSON.stringify({
          path: app.path,
          featureCode: app.featureCode,
          name: app.name,
          pluginName: app.pluginName,
          type: app.type
        })}`,
        label: '置顶'
      })
    }

    // 匹配推荐使用专属菜单，不追加超级面板、插件设置和快捷键等通用操作。
    await window.ztools.showContextMenu(menuItems)
    return
  } else {
    // 其他区域继续使用原有的主搜索框固定逻辑。
    const fixedMatchName =
      app.type === 'plugin'
        ? app.pluginName || app.name
        : app.type === 'direct' && app.subType === 'app'
          ? app.persistedName || app.name
          : app.name
    if (isPinned(app.path, app.featureCode, fixedMatchName)) {
      menuItems.push({
        id: `unpin-app:${JSON.stringify({
          path: app.path,
          featureCode: app.featureCode,
          name: fixedMatchName
        })}`,
        label: '从搜索框取消固定'
      })
    } else {
      menuItems.push({
        id: `pin-app:${JSON.stringify({
          name:
            app.type === 'direct' && app.subType === 'app'
              ? app.persistedName || app.name
              : app.name,
          path: app.path,
          icon: app.icon,
          pinyin: app.pinyin,
          pinyinAbbr: app.pinyinAbbr,
          type: app.type,
          featureCode: app.featureCode,
          pluginName: app.pluginName,
          pluginExplain: app.pluginExplain,
          subType: app.subType,
          cmdType: app.cmdType,
          originalName: app.originalName,
          persistedName: app.persistedName
        })}`,
        label: '固定到搜索框'
      })
    }
  }

  // 超级面板固定/取消固定
  if (isPinnedToSuperPanel(app)) {
    menuItems.push({
      id: `unpin-super-panel:${JSON.stringify({ path: app.path, featureCode: app.featureCode })}`,
      label: '从超级面板取消固定'
    })
  } else {
    menuItems.push({
      id: `pin-super-panel:${JSON.stringify({
        name: app.name,
        path: app.path,
        icon: app.icon,
        type: app.type,
        featureCode: app.featureCode,
        pluginName: app.pluginName,
        pluginExplain: app.pluginExplain,
        cmdType: app.cmdType
      })}`,
      label: '固定到超级面板'
    })
  }

  // 如果是插件，添加插件设置菜单
  if (app.type === 'plugin' && app.pluginName) {
    let outKillPlugins: string[] = []
    let autoDetachPlugins: string[] = []
    try {
      const killData = await window.ztools.dbGet('out-kill-plugin')
      outKillPlugins = normalizeConfigList(killData)
      const detachData = await window.ztools.dbGet('auto-detach-plugin')
      autoDetachPlugins = normalizeConfigList(detachData)
    } catch (error) {
      console.log('读取配置失败:', error)
    }

    const pluginPayload = getPluginPayload(app)
    const isAutoKill = !!pluginPayload && outKillPlugins.includes(pluginPayload.pluginName)
    const isAutoDetach = !!pluginPayload && autoDetachPlugins.includes(pluginPayload.pluginName)
    const mainPushState = await resolveMainPushMenuState(pluginPayload?.pluginName)

    menuItems.push({
      label: '插件设置',
      submenu: [
        ...(mainPushState.supported
          ? [
              {
                id: `toggle-main-push:${JSON.stringify(pluginPayload)}`,
                label: '搜索栏推送',
                type: 'checkbox',
                checked: mainPushState.enabled
              }
            ]
          : []),
        {
          id: `toggle-auto-kill:${JSON.stringify(pluginPayload)}`,
          label: '退出到后台立即结束运行',
          type: 'checkbox',
          checked: isAutoKill
        },
        {
          id: `toggle-auto-detach:${JSON.stringify(pluginPayload)}`,
          label: '自动分离为独立窗口',
          type: 'checkbox',
          checked: isAutoDetach
        }
      ]
    })

    menuItems.push({
      id: `view-plugin-detail:${JSON.stringify(pluginPayload)}`,
      label: '查看插件详情'
    })
  }

  // 添加更多菜单
  menuItems.push({
    label: '更多',
    submenu: [
      {
        id: `add-global-shortcut:${JSON.stringify({ name: app.name, pluginTitle: app.pluginTitle || app.pluginName })}`,
        label: '设置全局快捷键'
      }
    ]
  })

  await window.ztools.showContextMenu(menuItems)
}

/**
 * 打开本机文件、程序或插件并保留现有匹配上下文。
 * @param app 用户选中的结果。
 * @returns 启动完成后结束的 Promise，失败信息显示在搜索窗口。
 */
async function handleSelectApp(app: any): Promise<void> {
  try {
    // 如果是"上次匹配"指令，执行恢复逻辑
    if (app.path === 'special:last-match') {
      const state = await window.ztools.restoreLastMatch()
      if (state) {
        emit('restore-match', state)
      }
      return
    }

    // 记录搜索偏好（仅普通文本搜索时，排除匹配指令类型）
    if (props.searchQuery.trim() && (!app.cmdType || app.cmdType === 'text')) {
      saveSearchPreference(props.searchQuery, app)
    }

    // 构造 payload 和 type
    let payload: any = props.searchQuery
    let type = app.cmdType || 'text'

    if (app.cmdType === 'img' && props.pastedImage) {
      payload = props.pastedImage
    } else if (app.cmdType === 'over' && props.pastedText) {
      payload = props.pastedText
    } else if (app.cmdType === 'regex' && props.pastedText) {
      payload = props.pastedText
    } else if (app.cmdType === 'files' && props.pastedFiles) {
      payload = props.pastedFiles.map((file) => ({
        isFile: !file.isDirectory,
        isDirectory: file.isDirectory,
        name: file.name,
        path: file.path
      })) as MatchFile[]
    } else if (app.cmdType === 'window') {
      if (!commandDataStore.matchesWindowCommand(app, windowStore.currentWindow)) {
        console.warn('window 指令与当前窗口不匹配，已阻止启动:', app.name)
        return
      }
      payload = JSON.parse(JSON.stringify(windowStore.currentWindow))
    }

    // 启动应用或插件
    const result = await window.ztools.launch({
      path: app.path,
      type: app.type || 'app',
      featureCode: app.featureCode,
      name: app.name,
      cmdType: app.cmdType || 'text',
      confirmDialog: app.confirmDialog
        ? {
            type: app.confirmDialog.type,
            buttons: [...app.confirmDialog.buttons],
            defaultId: app.confirmDialog.defaultId,
            cancelId: app.confirmDialog.cancelId,
            title: app.confirmDialog.title,
            message: app.confirmDialog.message,
            detail: app.confirmDialog.detail
          }
        : undefined,
      param: {
        payload,
        type,
        inputState: {
          searchQuery: props.searchQuery,
          pastedImage: props.pastedImage,
          pastedFiles: props.pastedFiles
            ? props.pastedFiles.map((file) => ({
                isFile: !file.isDirectory,
                isDirectory: file.isDirectory,
                name: file.name,
                path: file.path
              }))
            : null,
          pastedText: props.pastedText
        }
      }
    })
    if (result && result.success === false) actionError.value = result.error || '打开失败'
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error)
    console.error('启动失败:', error)
  }
}

// 窗口功能选择
async function handleWindowAction(item: any): Promise<void> {
  try {
    // 执行命令，将 window feature 的命令作为普通插件命令执行
    await handleSelectApp(item)
  } catch (error) {
    console.error('执行窗口操作失败:', error)
  }
}

// 选择推荐项
async function handleRecommendationSelect(item: any): Promise<void> {
  if (item.type === 'plugin') {
    await handleSelectApp(item)
  }
}

// 处理 mainPush 搜索结果选择
async function handleMainPushSelectAction(group: MainPushGroup, item: MainPushItem): Promise<void> {
  try {
    const shouldEnter = await handleMainPushSelect(group, item, props.searchQuery)
    if (shouldEnter) {
      // 构建原始 item（剔除内部展示字段）
      const rawItem = JSON.parse(JSON.stringify(toRaw(item)))
      delete rawItem._resolvedIcon
      // 进入插件
      await window.ztools.launch({
        path: group.pluginPath,
        type: 'plugin',
        featureCode: group.featureCode,
        name: group.featureExplain || group.pluginName,
        cmdType: group.matchedCmdType,
        param: {
          payload: props.searchQuery,
          type: group.matchedCmdType,
          from: 'main',
          option: rawItem
        }
      })
    }
  } catch (error) {
    console.error('mainPush 选择处理失败:', error)
  }
}

// 点击 mainPush 标题行，直接进入插件应用
async function handleEnterMainPushApp(group: MainPushGroup): Promise<void> {
  try {
    await window.ztools.launch({
      path: group.pluginPath,
      type: 'plugin',
      featureCode: group.featureCode,
      name: group.featureExplain || group.pluginName,
      cmdType: group.matchedCmdType,
      param: {
        payload: props.searchQuery,
        type: group.matchedCmdType,
        from: 'main'
      }
    })
  } catch (error) {
    console.error('mainPush 进入应用失败:', error)
  }
}

/**
 * 处理分类快捷键、结果导航和打开所在位置。
 * @param event 主搜索窗口的键盘事件。
 * @returns 事件处理完成后结束的 Promise。
 */
async function handleKeydown(event: KeyboardEvent): Promise<void> {
  if (isUnifiedSearch.value && event.altKey && /^[1-6]$/.test(event.key)) {
    event.preventDefault()
    activeCategory.value = SEARCH_CATEGORIES[Number(event.key) - 1].key
    return
  }
  if (event.key === 'Enter' && event.ctrlKey && selectedItem.value?.searchSource === 'everything') {
    event.preventDefault()
    await window.ztools.revealInFinder(selectedItem.value.path)
    return
  }
  const grid = navigationGrid.value
  if (!grid || grid.length === 0) return

  // 处理 Enter 键的特殊逻辑
  if (event.key === 'Enter') {
    event.preventDefault()
    const item = selectedItem.value
    if (item) {
      const currentRow = grid[selectedRow.value]
      if (currentRow.type === 'window') {
        handleWindowAction(item)
      } else if (currentRow.type === 'recommendation') {
        handleRecommendationSelect(item)
      } else if (currentRow.type?.startsWith('mainPush:') && currentRow.mainPushGroup) {
        handleMainPushSelectAction(currentRow.mainPushGroup, item)
      } else {
        handleSelectApp(item)
      }
    }
    return
  }

  // 处理空格键的特殊逻辑（开启了空格打开指令时）
  if (event.key === ' ' && windowStore.spaceOpenCommand) {
    event.preventDefault()
    const item = selectedItem.value
    if (item) {
      const currentRow = grid[selectedRow.value]
      if (currentRow.type === 'window') {
        handleWindowAction(item)
      } else if (currentRow.type === 'recommendation') {
        handleRecommendationSelect(item)
      } else if (currentRow.type?.startsWith('mainPush:') && currentRow.mainPushGroup) {
        handleMainPushSelectAction(currentRow.mainPushGroup, item)
      } else {
        handleSelectApp(item)
      }
    }
    return
  }

  // 其他导航键交给 useNavigation 处理
  handleNavigationKeydown(event, () => {
    // 这个回调不会被调用，因为 Enter 键已经在上面处理了
  })
}

/**
 * 执行主进程右键菜单回传的命令。
 * @param command 菜单命令及其序列化参数
 * @returns 命令处理完成后结束的 Promise
 */
async function handleContextMenuCommand(command: string): Promise<void> {
  if (command.startsWith('open-indexed:')) {
    await handleSelectApp({
      ...JSON.parse(command.slice('open-indexed:'.length)),
      type: 'local-file',
      searchSource: 'everything'
    })
    return
  }
  if (command.startsWith('copy-indexed-path:')) {
    await window.ztools.copyToClipboard(JSON.parse(command.slice('copy-indexed-path:'.length)).path)
    return
  }
  if (command.startsWith('remove-from-history:')) {
    const jsonStr = command.replace('remove-from-history:', '')
    try {
      const { path, featureCode, name } = JSON.parse(jsonStr)
      await removeFromHistory(path, featureCode, name)
      nextTick(() => {
        emit('height-changed')
        emit('focus-input')
      })
    } catch (error) {
      console.error('从历史记录删除失败:', error)
    }
  } else if (command.startsWith('pin-recommendation:')) {
    const jsonStr = command.replace('pin-recommendation:', '')
    try {
      await pinRecommendation(JSON.parse(jsonStr))
      nextTick(() => {
        emit('height-changed')
        emit('focus-input')
      })
    } catch (error) {
      console.error('置顶匹配推荐失败:', error)
    }
  } else if (command.startsWith('unpin-recommendation:')) {
    const jsonStr = command.replace('unpin-recommendation:', '')
    try {
      await unpinRecommendation(JSON.parse(jsonStr))
      nextTick(() => {
        emit('height-changed')
        emit('focus-input')
      })
    } catch (error) {
      console.error('取消匹配推荐置顶失败:', error)
    }
  } else if (command.startsWith('move-recommendation-to-front:')) {
    const jsonStr = command.replace('move-recommendation-to-front:', '')
    try {
      await moveRecommendationToFront(JSON.parse(jsonStr))
      nextTick(() => {
        emit('height-changed')
        emit('focus-input')
      })
    } catch (error) {
      console.error('调整匹配推荐顺序失败:', error)
    }
  } else if (command.startsWith('pin-app:')) {
    const appJson = command.replace('pin-app:', '')
    try {
      const app = JSON.parse(appJson)
      await pinCommand(app)
      nextTick(() => {
        emit('height-changed')
        emit('focus-input')
      })
    } catch (error) {
      console.error('固定应用失败:', error)
    }
  } else if (command.startsWith('unpin-app:')) {
    const jsonStr = command.replace('unpin-app:', '')
    try {
      const { path, featureCode, name } = JSON.parse(jsonStr)
      await unpinCommand(path, featureCode, name)
      nextTick(() => {
        emit('height-changed')
        emit('focus-input')
      })
    } catch (error) {
      console.error('取消固定失败:', error)
    }
  } else if (command.startsWith('reveal-in-finder:')) {
    const jsonStr = command.replace('reveal-in-finder:', '')
    try {
      const { path: filePath } = JSON.parse(jsonStr)
      await window.ztools.revealInFinder(filePath)
      emit('focus-input')
    } catch (error) {
      console.error('打开文件位置失败:', error)
    }
  } else if (command.startsWith('launch-as-admin:')) {
    const jsonStr = command.replace('launch-as-admin:', '')
    try {
      const { path: appPath, name } = JSON.parse(jsonStr)
      await window.ztools.launchAsAdmin(appPath, name)
    } catch (error) {
      console.error('管理员启动失败:', error)
    }
  } else if (command.startsWith('toggle-auto-kill:')) {
    const pluginPayload = parsePluginPayload(command.replace('toggle-auto-kill:', ''))
    try {
      let outKillPlugins: string[] = []
      try {
        const data = await window.ztools.dbGet('out-kill-plugin')
        outKillPlugins = normalizeConfigList(data)
      } catch (error) {
        console.debug('未找outKillPlugin配置', error)
      }

      if (!pluginPayload) {
        return
      }

      const { pluginName } = pluginPayload
      outKillPlugins = outKillPlugins.includes(pluginName)
        ? outKillPlugins.filter((n) => n !== pluginName)
        : [...outKillPlugins, pluginName]
      await window.ztools.dbPut('out-kill-plugin', outKillPlugins)
      console.log('已更新 outKillPlugin 配置:', outKillPlugins)
    } catch (error: any) {
      console.error('切换自动结束配置失败:', error)
    }
  } else if (command.startsWith('view-plugin-detail:')) {
    const pluginPayload = parsePluginPayload(command.replace('view-plugin-detail:', ''))
    try {
      // 从 commandDataStore 中查找设置插件（已安装插件功能）的路径
      const settingCmd = commandDataStore.commands.find(
        (c) =>
          c.type === 'plugin' &&
          c.pluginName === 'setting' &&
          c.featureCode === 'ui.router?router=Plugins'
      )
      if (settingCmd) {
        await window.ztools.launch({
          path: settingCmd.path,
          type: 'plugin',
          featureCode: 'ui.router?router=Plugins',
          name: '已安装插件',
          cmdType: 'text',
          param: {
            payload: pluginPayload ? pluginPayload.pluginName : '',
            type: 'text'
          }
        })
      } else {
        console.error('未找到设置插件的已安装插件指令')
      }
    } catch (error) {
      console.error('查看插件详情失败:', error)
    }
  } else if (command.startsWith('toggle-auto-detach:')) {
    const pluginPayload = parsePluginPayload(command.replace('toggle-auto-detach:', ''))
    try {
      let autoDetachPlugins: string[] = []
      try {
        const data = await window.ztools.dbGet('auto-detach-plugin')
        autoDetachPlugins = normalizeConfigList(data)
      } catch (error) {
        console.debug('未找到 autoDetachPlugin 配置', error)
      }

      if (!pluginPayload) {
        return
      }

      const { pluginName } = pluginPayload
      autoDetachPlugins = autoDetachPlugins.includes(pluginName)
        ? autoDetachPlugins.filter((n) => n !== pluginName)
        : [...autoDetachPlugins, pluginName]
      await window.ztools.dbPut('auto-detach-plugin', autoDetachPlugins)
      console.log('已更新 autoDetachPlugin 配置:', autoDetachPlugins)
    } catch (error: any) {
      console.error('切换自动分离配置失败:', error)
    }
  } else if (command.startsWith('toggle-main-push:')) {
    const pluginPayload = parsePluginPayload(command.replace('toggle-main-push:', ''))
    try {
      await toggleMainPushSetting(pluginPayload?.pluginName)
    } catch (error: any) {
      console.error('切换搜索栏推送配置失败:', error)
    }
  } else if (command.startsWith('pin-super-panel:')) {
    const appJson = command.replace('pin-super-panel:', '')
    try {
      const app = JSON.parse(appJson)
      await window.ztools.pinToSuperPanel(app)
      await loadSuperPanelPinnedData()
    } catch (error) {
      console.error('固定到超级面板失败:', error)
    }
  } else if (command.startsWith('unpin-super-panel:')) {
    const jsonStr = command.replace('unpin-super-panel:', '')
    try {
      const { path, featureCode } = JSON.parse(jsonStr)
      await window.ztools.unpinSuperPanelCommand(path, featureCode)
      await loadSuperPanelPinnedData()
    } catch (error) {
      console.error('从超级面板取消固定失败:', error)
    }
  } else if (command.startsWith('add-global-shortcut:')) {
    const jsonStr = command.replace('add-global-shortcut:', '')
    try {
      const { name, pluginTitle } = JSON.parse(jsonStr)
      // 构建目标指令字符串（使用插件标题/指令名称格式）
      const targetCommand = pluginTitle ? `${pluginTitle}/${name}` : name

      // 找到设置插件的快捷键指令
      const settingCmd = commandDataStore.commands.find(
        (c) =>
          c.type === 'plugin' &&
          c.pluginName === 'setting' &&
          c.featureCode === 'ui.router?router=Shortcuts'
      )
      console.log('targetCommand', targetCommand)
      if (settingCmd) {
        await window.ztools.launch({
          path: settingCmd.path,
          type: 'plugin',
          featureCode: 'ui.router?router=Shortcuts',
          name: '快捷键',
          cmdType: 'text',
          param: {
            payload: targetCommand
          }
        })
      } else {
        console.error('未找到设置插件的快捷键指令')
      }
    } catch (error) {
      console.error('添加全局快捷键失败:', error)
    }
  }
}

// 点击容器聚焦输入框
function handleContainerClick(event: MouseEvent): void {
  const target = event.target as HTMLElement
  if (target.closest('.app-item')) {
    return
  }
  emit('focus-input')
}

// 重置折叠状态
function resetCollapseState(): void {
  isRecentExpanded.value = false
  isPinnedExpanded.value = false
  isSearchResultsExpanded.value = false
  isBestMatchesExpanded.value = false
  isRecommendationsExpanded.value = false
}

// 初始化
let cleanupContextMenuListener: (() => void) | null = null

onMounted(() => {
  // 先清理之前可能残留的监听器
  cleanupContextMenuListener?.()
  cleanupContextMenuListener = window.ztools.onContextMenuCommand(handleContextMenuCommand)
})

onUnmounted(() => {
  cleanupContextMenuListener?.()
  cleanupContextMenuListener = null
})

// 导出方法供父组件调用
defineExpose({
  navigationGrid,
  handleKeydown,
  resetSelection,
  resetCollapseState
})
</script>

<style scoped>
.search-home-status {
  display: flex;
  justify-content: space-between;
  padding: 5px 12px;
  font-size: 12px;
  opacity: 0.75;
  flex: 0 0 auto;
}
.search-home-status button {
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
}
.search-settings-entry {
  margin-left: auto;
  font-size: 12px;
}

.search-results-container {
  display: flex;
  flex-direction: column;
  max-height: 541px;
  min-height: 0;
  overflow: hidden;
}

.scrollable-content {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  user-select: none;
  padding: 0 0 2px 0;
  border-radius: 0;
}

.list-mode-results {
  display: flex;
  flex-direction: column;
}
.search-categories {
  display: flex;
  gap: 6px;
  padding: 5px 10px 9px;
  flex: 0 0 auto;
  border-bottom: 1px solid var(--divider-color);
  user-select: none;
}
.search-categories button,
.search-status button {
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-secondary);
  padding: 6px 14px;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
}
.search-categories button[aria-selected='true'] {
  color: var(--highlight-color);
  background: var(--primary-light-bg);
  font-weight: 600;
}
.search-categories button:hover,
.search-status button:hover {
  background: var(--hover-bg);
}
.indexed-results {
  padding: 4px 10px;
}
.indexed-heading {
  padding: 5px 2px 8px;
  color: var(--text-color);
  font-size: 14px;
  font-weight: 600;
}
.indexed-heading span {
  margin-left: 8px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 400;
}
.search-status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-secondary);
}
.search-status:empty {
  display: none;
}
.search-error {
  color: var(--text-color);
}
</style>
