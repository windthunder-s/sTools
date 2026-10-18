<template>
  <div v-if="apps.length > 0" class="vertical-list">
    <div
      v-for="(app, index) in apps"
      :key="app.name + '|' + app.path + (app.featureCode || '')"
      class="list-item"
      :class="{ selected: index === selectedIndex }"
      @click="$emit('select', app)"
      @contextmenu.prevent="$emit('contextmenu', app)"
    >
      <div class="item-icon">
        <img v-if="app.icon" :src="app.icon" alt="" draggable="false" />
        <svg
          v-else-if="app.searchSource === 'everything'"
          class="file-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          aria-hidden="true"
        >
          <path v-if="app.category === 'folder'" d="M3 7V5h6l2 2h10v13H3Z" />
          <g v-else-if="app.category === 'app'">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 9h18M6 6.5h2m2 0h2" />
          </g>
          <g v-else><path d="M5 3h9l5 5v13H5Z M14 3v6h5M8 13h8m-8 4h8" /></g>
        </svg>
        <span
          v-if="app.pluginName && isDevelopmentPluginName(app.pluginName)"
          class="item-dev-badge"
          >DEV</span
        >
      </div>
      <div class="item-content">
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div class="item-title" v-html="getHighlightedName(app)"></div>
        <div v-if="getSubtitle(app)" class="item-subtitle">
          {{ getSubtitle(app) }}
        </div>
      </div>
      <div v-if="app.searchSource === 'everything'" class="item-badge">
        {{ SEARCH_CATEGORIES.find((category) => category.key === app.category)?.label }}
      </div>
      <div v-else-if="app.type === 'plugin'" class="item-badge">
        {{ app.pluginName || 'Ctool' }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Command } from '../../stores/commandDataStore'
import { highlightMatch } from '../../utils/highlight'
import { SEARCH_CATEGORIES } from '@shared/unifiedSearch'
import { isDevelopmentPluginName } from '../../../../shared/pluginRuntimeNamespace'

interface Props {
  apps: Command[]
  selectedIndex?: number
  searchQuery?: string // 搜索查询（用于高亮）
}

const props = withDefaults(defineProps<Props>(), {
  selectedIndex: -1,
  searchQuery: ''
})

defineEmits<{
  (e: 'select', app: Command): void
  (e: 'contextmenu', app: Command): void
}>()

function getHighlightedName(app: Command): string {
  return highlightMatch(app.name, app.matches, app.matchType, props.searchQuery)
}

function getSubtitle(app: Command): string {
  if (app.pluginExplain) {
    return app.pluginExplain
  }

  if ((app.type === 'direct' || app.type === 'local-file') && app.subType !== 'system-setting' && app.path) {
    return app.path
  }

  return ''
}
</script>

<style scoped>
.vertical-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.list-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.15s;
  user-select: none;
}

.list-item:hover {
  background: var(--hover-bg);
}

.list-item.selected {
  background: var(--primary-light-bg);
}

.item-icon {
  position: relative;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.item-icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.item-dev-badge {
  position: absolute;
  right: -5px;
  bottom: -5px;
  display: inline-flex;
  min-width: 18px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--bg-color);
  border-radius: 999px;
  background: var(--highlight-color);
  color: var(--text-on-primary);
  font-size: 8px;
  font-weight: 700;
  line-height: 1;
  padding: 2px 4px;
}

.item-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.item-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-subtitle {
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-badge {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--control-bg);
}

/* 高亮样式 */
.item-title :deep(mark.highlight) {
  background-color: transparent;
  color: var(--highlight-color);
  font-weight: 600;
}
.file-icon {
  width: 29px;
  height: 29px;
  color: var(--highlight-color);
}
</style>
