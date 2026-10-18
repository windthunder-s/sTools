<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { AdaptiveIcon, BaseDialog, HotkeyInput, useToast } from '@/components'
import { useZtoolsSubInput } from '@/composables'
import { buildPluginGroups, changeBinding, readBindings } from './model'
import { changeLauncherShortcut } from './launcher'
import type {
  Binding,
  FunctionRow,
  PluginGroup,
  PluginSource,
  ScopedBinding,
  ShortcutScope
} from './model'

const api = window.ztools.internal
const platform = api.getPlatform()
const route = useRoute()
const { success, confirm } = useToast()
const { value: search, setSubInput } = useZtoolsSubInput(
  '',
  '搜索插件、功能或快捷键…',
  false,
  false
)
const plugins = ref<PluginSource[]>([])
const bindings = ref<ScopedBinding[]>([])
const disabledPaths = ref<string[]>([])
const loading = ref(true)
const pageError = ref('')
const captureShortcutWarning = ref('')
const filter = ref('all')
const selectedPlugin = ref(typeof route.query.plugin === 'string' ? route.query.plugin : '')
const groups = computed(() =>
  buildPluginGroups(plugins.value, bindings.value, disabledPaths.value, platform)
)
const total = computed(() => groups.value.reduce((count, group) => count + group.rows.length, 0))
const assigned = computed(() =>
  groups.value.reduce(
    (count, group) =>
      count + group.rows.filter((row) => row.bindings.some((binding) => binding.enabled)).length,
    0
  )
)
const visibleGroups = computed(() =>
  groups.value
    .filter((group) => !selectedPlugin.value || group.name === selectedPlugin.value)
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) => {
        const hasKey = row.bindings.some((binding) => binding.enabled)
        if ((filter.value === 'assigned' && !hasKey) || (filter.value === 'unassigned' && hasKey))
          return false
        const haystack = [
          group.title,
          row.title,
          row.description,
          ...row.aliases,
          ...row.bindings.map((binding) => binding.shortcut)
        ]
          .join(' ')
          .toLowerCase()
        return haystack.includes(search.value.trim().toLowerCase())
      })
    }))
    .filter((group) => group.rows.length)
)

const editor = ref<{ group: PluginGroup; row: FunctionRow; previous?: Binding }>()
const shortcut = ref('')
const scope = ref<ShortcutScope>('global')
const busy = ref(false)
const editorError = ref('')
const launcherShortcut = ref('')
const launcherEditing = ref(false)
const defaultLauncherShortcut = 'Ctrl+Alt+Space'

/**
 * 重新读取插件和快捷键配置；读取失败时显示重试入口。
 * @returns 刷新完成的 Promise。
 */
async function load(): Promise<void> {
  loading.value = true
  pageError.value = ''
  try {
    const [installed, disabled, globalKeys, appKeys, mainShortcut, captureInitialization] =
      await Promise.all([
        api.getAllPlugins(),
        api.getDisabledPlugins(),
        readBindings(api, 'global'),
        readBindings(api, 'app'),
        api.getCurrentShortcut(),
        api.dbGet('capture-quick-shortcut-initialized')
      ])
    const hasQuickShortcut = [...globalKeys, ...appKeys].some(
      (binding) =>
        binding.enabled &&
        /^(capture-tools|截图与录屏)\/(快速截图|快速截图入口)$/.test(
          binding.target.replace(/\s*\/\s*/g, '/')
        )
    )
    captureShortcutWarning.value =
      captureInitialization?.status === 'failed' && !hasQuickShortcut
        ? `快速截图默认 F1 未启用：${captureInitialization.error || '注册失败'} 可在下方「快速截图入口」中设置其它组合键。`
        : ''
    launcherShortcut.value = mainShortcut
    plugins.value = installed
    disabledPaths.value = disabled
    bindings.value = [
      ...globalKeys.map((binding) => ({ ...binding, scope: 'global' as const })),
      ...appKeys.map((binding) => ({ ...binding, scope: 'app' as const }))
    ]
  } catch (error) {
    pageError.value = error instanceof Error ? error.message : '读取失败，请刷新重试。'
  } finally {
    loading.value = false
  }
}

/**
 * 打开固定功能的快捷键设置，不再要求用户选择内部指令。
 * @param group 功能所属插件。
 * @param row 待配置功能。
 * @param binding 可选的已有绑定。
 * @returns 无返回值。
 */
function edit(group: PluginGroup, row: FunctionRow, binding?: ScopedBinding): void {
  const previous = binding ? (({ scope: _scope, ...value }) => value)(binding) : undefined
  editor.value = { group, row, previous }
  shortcut.value = previous?.shortcut || ''
  scope.value = binding?.scope || 'global'
  editorError.value = ''
}

/**
 * 关闭设置弹窗；保存期间防止丢失结果反馈。
 * @returns 无返回值。
 */
function close(): void {
  if (!busy.value) {
    editor.value = undefined
    launcherEditing.value = false
  }
}

/**
 * 保存组合键并立即生效，保留已有绑定的高级选项。
 * @returns 保存结束的 Promise。
 */
async function save(): Promise<void> {
  if (!editor.value || busy.value) return
  busy.value = true
  editorError.value = ''
  try {
    const { previous, row } = editor.value
    const next: Binding = {
      ...previous,
      id: previous?.id || crypto.randomUUID(),
      shortcut: shortcut.value,
      target: previous?.target || row.target,
      enabled: true
    }
    await changeBinding(api, scope.value, previous, next, platform)
    editor.value = undefined
    success('快捷键已保存，立即生效')
    await load()
  } catch (error) {
    editorError.value = error instanceof Error ? error.message : '保存失败，请重试。'
  } finally {
    busy.value = false
  }
}

/**
 * 移除当前快捷键，确认时说明功能仍能从搜索框打开。
 * @returns 删除结束的 Promise。
 */
async function remove(): Promise<void> {
  if (!editor.value?.previous || busy.value) return
  const current = editor.value
  const confirmed = await confirm({
    title: '移除快捷键',
    message: `移除 ${current.previous!.shortcut}？「${current.row.title}」仍可从搜索框打开。`,
    confirmText: '移除',
    cancelText: '取消',
    type: 'warning'
  })
  if (!confirmed) return
  busy.value = true
  editorError.value = ''
  try {
    await changeBinding(api, scope.value, current.previous, undefined, platform)
    editor.value = undefined
    success('快捷键已移除')
    await load()
  } catch (error) {
    editorError.value = error instanceof Error ? error.message : '移除失败，请重试。'
  } finally {
    busy.value = false
  }
}

/**
 * 打开主程序呼出键编辑器，复用录制交互并保留当前配置。
 * @returns 无返回值。
 */
function editLauncher(): void {
  shortcut.value = launcherShortcut.value
  editorError.value = ''
  launcherEditing.value = true
}

/**
 * 应用并保存主程序呼出快捷键，与通用设置保持同步。
 * @returns 保存完成的 Promise。
 */
async function saveLauncher(): Promise<void> {
  if (busy.value) return
  busy.value = true
  editorError.value = ''
  try {
    launcherShortcut.value = await changeLauncherShortcut(
      api,
      launcherShortcut.value,
      shortcut.value,
      platform
    )
    launcherEditing.value = false
    success('呼出快捷键已保存，立即生效')
  } catch (error) {
    editorError.value = error instanceof Error ? error.message : '保存失败，请重试。'
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <main class="plugin-shortcuts">
    <header class="page-heading">
      <div>
        <h1>插件快捷键</h1>
        <p>找到功能，按下组合键，就能快速启动。</p>
      </div>
      <button class="quiet" :disabled="loading || busy" @click="load">刷新</button>
    </header>
    <section class="launcher-card" aria-label="快速打开 sTools">
      <span class="launcher-logo" aria-hidden="true">S</span>
      <div class="function-copy">
        <h2>快速打开 sTools</h2>
        <p>sTools 在后台运行时，按快捷键立即呼出主窗口。</p>
        <button
          class="launcher-key"
          :disabled="loading || !launcherShortcut"
          aria-label="修改 sTools 呼出快捷键"
          @click="editLauncher"
        >
          <kbd>{{ launcherShortcut || '正在读取…' }}</kbd
          ><span>全局</span>
        </button>
      </div>
      <button class="set-key" :disabled="loading || !launcherShortcut" @click="editLauncher">
        修改快捷键
      </button>
    </section>
    <section class="overview" aria-label="快捷键概览">
      <span
        ><strong>{{ groups.length }}</strong> 个插件</span
      >
      <span
        ><strong>{{ total }}</strong> 项功能</span
      >
      <span
        ><strong>{{ assigned }}</strong> 项已设置</span
      >
      <p>全局快捷键：sTools 在后台运行时也能使用。</p>
    </section>
    <div class="filters">
      <input
        :value="search"
        aria-label="搜索插件、功能或快捷键"
        placeholder="搜索插件、功能或快捷键"
        @input="setSubInput(($event.target as HTMLInputElement).value)"
      />
      <select v-model="selectedPlugin" aria-label="选择插件">
        <option value="">全部插件</option>
        <option v-for="group in groups" :key="group.name" :value="group.name">
          {{ group.title }}
        </option>
      </select>
    </div>
    <div class="filter-tabs" aria-label="按设置状态筛选">
      <button
        v-for="item in [
          { value: 'all', label: '全部功能' },
          { value: 'assigned', label: '已设置' },
          { value: 'unassigned', label: '待设置' }
        ]"
        :key="item.value"
        :aria-pressed="filter === item.value"
        @click="filter = item.value"
      >
        {{ item.label }}
      </button>
    </div>
    <p v-if="captureShortcutWarning" class="error" role="status">{{ captureShortcutWarning }}</p>
    <p v-if="pageError" class="error" role="alert">{{ pageError }}</p>
    <p v-else-if="loading" class="empty" role="status">正在读取插件和快捷键…</p>
    <template v-else>
      <p v-if="!visibleGroups.length" class="empty">
        没有符合条件的功能，试试其它关键词或筛选条件。
      </p>
      <details
        v-for="group in visibleGroups"
        :key="group.name"
        class="plugin-group"
        :data-plugin="group.name"
        :open="
          !!search ||
          filter !== 'all' ||
          !!selectedPlugin ||
          !['system', 'setting'].includes(group.name)
        "
      >
        <summary>
          <AdaptiveIcon v-if="group.logo" :src="group.logo" class="plugin-logo" />
          <span class="group-title"
            >{{ group.title
            }}<small
              >{{ group.rows.length }} 项功能<span v-if="group.disabled"> · 插件已禁用</span></small
            ></span
          >
          <span class="expand-hint">展开 / 收起</span>
        </summary>
        <article
          v-for="row in group.rows"
          :key="row.id"
          class="function-row"
          :data-feature="row.code"
        >
          <div class="function-copy">
            <h2>{{ row.title }}</h2>
            <p>{{ row.description }}</p>
            <p v-if="row.needsContent" class="context-hint">
              需要先选择文字、图片或文件，再使用此功能。
            </p>
            <div v-if="row.bindings.length" class="bindings">
              <button
                v-for="binding in row.bindings"
                :key="binding.scope + binding.id"
                class="binding"
                :class="{ inactive: !binding.enabled }"
                :aria-label="`修改${row.title}快捷键 ${binding.shortcut}`"
                @click="edit(group, row, binding)"
              >
                <kbd>{{ binding.shortcut }}</kbd
                ><span
                  >{{ binding.scope === 'global' ? '全局' : '仅主搜索页'
                  }}{{ binding.enabled ? '' : ' · 已停用' }}</span
                >
              </button>
            </div>
            <span v-else class="unset">尚未设置快捷键</span>
          </div>
          <button
            class="set-key"
            :disabled="group.disabled || row.needsContent"
            :aria-label="`设置${row.title}快捷键`"
            @click="edit(group, row)"
          >
            {{ row.bindings.length ? '添加快捷键' : '设置快捷键' }}
          </button>
        </article>
      </details>
    </template>
    <p class="footer-note">点击已有快捷键可修改或移除。这里的设置与「快捷键管理」同步。</p>
    <BaseDialog
      :visible="launcherEditing"
      title="快速打开 sTools"
      subtitle="设置主程序的全局呼出快捷键"
      :close-on-overlay="!busy"
      :close-on-escape="!busy"
      @close="close"
    >
      <template v-if="launcherEditing">
        <p class="dialog-description">保存后，在其它软件中也能用这个组合键呼出 sTools。</p>
        <label class="field-label">呼出快捷键</label>
        <HotkeyInput
          v-model="shortcut"
          :platform="platform"
          placeholder="点击这里，然后按下组合键"
        />
        <p class="hint">sTools 需要保持后台运行。点击录制后按 Esc 可取消。</p>
        <button
          class="restore-launcher"
          :disabled="busy"
          @click="shortcut = defaultLauncherShortcut"
        >
          恢复默认 {{ defaultLauncherShortcut }}
        </button>
        <p v-if="editorError" class="error" role="alert">{{ editorError }}</p>
      </template>
      <template #footer>
        <button class="quiet" :disabled="busy" @click="close">取消</button>
        <button class="primary" :disabled="busy || !shortcut" @click="saveLauncher">
          {{ busy ? '正在保存…' : '保存' }}
        </button>
      </template>
    </BaseDialog>
    <BaseDialog
      :visible="!!editor"
      :title="`${editor?.previous ? '修改' : '设置'}${editor?.row.title || ''}快捷键`"
      :subtitle="editor?.group.title"
      :close-on-overlay="!busy"
      :close-on-escape="!busy"
      @close="close"
    >
      <template v-if="editor">
        <p class="dialog-description">{{ editor.row.description }}</p>
        <label class="field-label">快捷键</label>
        <HotkeyInput
          :key="editor.row.id + (editor.previous?.id || 'new')"
          v-model="shortcut"
          :platform="platform"
          placeholder="点击这里，然后按下组合键"
        />
        <p class="hint">例如 Ctrl + Alt + A。点击录制后按 Esc 可取消录制。</p>
        <label class="field-label" for="shortcut-scope">什么时候可以使用</label>
        <select id="shortcut-scope" v-model="scope" :disabled="!!editor.previous || busy">
          <option value="global">全局：sTools 在后台也能用</option>
          <option value="app">应用内：仅在 sTools 主搜索页</option>
        </select>
        <p v-if="editor.group.disabled" class="hint">
          插件已禁用，请先在「功能与插件」中启用。你仍可移除此快捷键。
        </p>
        <p v-if="editorError" class="error" role="alert">{{ editorError }}</p>
      </template>
      <template #footer>
        <button v-if="editor?.previous" class="remove" :disabled="busy" @click="remove">
          移除快捷键
        </button>
        <button class="quiet" :disabled="busy" @click="close">取消</button>
        <button
          class="primary"
          :disabled="busy || !shortcut || editor?.group.disabled || editor?.row.needsContent"
          @click="save"
        >
          {{ busy ? '正在保存…' : editor?.previous?.enabled === false ? '保存并启用' : '保存' }}
        </button>
      </template>
    </BaseDialog>
  </main>
</template>

<style scoped>
.launcher-card {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 20px;
  padding: 16px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: var(--card-bg);
}
.launcher-logo {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  border-radius: 50%;
  background: #008779;
  color: white;
  font-size: 24px;
  font-weight: 650;
}
.launcher-key {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 5px 8px;
  border: 1px solid color-mix(in srgb, var(--primary-color) 25%, transparent);
  border-radius: 6px;
  color: var(--primary-color);
  background: color-mix(in srgb, var(--primary-color) 6%, transparent);
}
.launcher-key span {
  font-size: 10px;
}
.restore-launcher {
  margin-top: 16px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--primary-color);
  font-size: 12px;
}

.plugin-shortcuts {
  height: 100%;
  overflow-y: auto;
  padding: 24px;
  box-sizing: border-box;
  color: var(--text-color);
}
.page-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
h1 {
  font-size: 22px;
  margin: 0 0 6px;
  font-weight: 650;
}
.page-heading p,
.function-copy p,
.hint,
.dialog-description {
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
}
button,
input,
select {
  font: inherit;
}
button {
  cursor: pointer;
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
button:focus-visible,
input:focus-visible,
select:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--primary-color, #008d75);
  outline-offset: 3px;
}
.overview {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 12px 24px;
  padding: 15px 18px;
  margin: 20px 0 18px;
  background: color-mix(in srgb, var(--primary-color, #008d75) 7%, transparent);
  border-radius: 12px;
  font-size: 12px;
  color: var(--text-secondary);
}
.overview strong {
  font-size: 23px;
  font-weight: 650;
  color: var(--primary-color, #008d75);
  padding-right: 3px;
}
.overview p {
  flex-basis: 100%;
  margin: 0;
}
.filters {
  display: flex;
  gap: 10px;
}
input,
select {
  box-sizing: border-box;
  min-width: 0;
  border: 1px solid var(--border-color, #ddd);
  background: var(--bg-color, transparent);
  color: inherit;
  border-radius: 8px;
  padding: 9px 10px;
  font-size: 13px;
}
input {
  flex: 1;
  width: 0;
}
.filters select {
  max-width: 190px;
}
.filter-tabs {
  display: flex;
  gap: 6px;
  margin: 14px 0;
}
.filter-tabs button {
  background: transparent;
  border: 0;
  border-radius: 7px;
  color: var(--text-secondary);
  padding: 8px 12px;
  font-size: 13px;
}
.filter-tabs button[aria-pressed='true'] {
  background: color-mix(in srgb, var(--primary-color, #008d75) 12%, transparent);
  color: var(--primary-color, #008d75);
  font-weight: 600;
}
.plugin-group {
  border: 1px solid var(--border-color, #e7e7e7);
  border-radius: 12px;
  margin-bottom: 14px;
  overflow: hidden;
  background: var(--bg-color, transparent);
}
summary {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  padding: 14px 16px;
  background: color-mix(in srgb, var(--text-color, #333) 3%, transparent);
}
summary::-webkit-details-marker {
  display: none;
}
.plugin-logo {
  width: 32px;
  height: 32px;
  object-fit: contain;
  border-radius: 8px;
}
.group-title {
  font-size: 15px;
  font-weight: 600;
}
.group-title small {
  display: block;
  font-size: 11px;
  font-weight: 400;
  color: var(--text-secondary);
  margin-top: 3px;
}
.expand-hint {
  margin-left: auto;
  color: var(--text-secondary);
  font-size: 11px;
}
.function-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-top: 1px solid var(--border-color, #e7e7e7);
}
.function-copy {
  flex: 1;
  min-width: 0;
}
h2 {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
}
.function-copy p {
  font-size: 12px;
  overflow-wrap: anywhere;
}
.bindings {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.binding {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  text-align: left;
  border: 1px solid color-mix(in srgb, var(--primary-color, #008d75) 25%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--primary-color, #008d75) 6%, transparent);
  color: var(--primary-color, #008d75);
  padding: 5px 8px;
}
kbd {
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.binding span {
  font-size: 10px;
  opacity: 0.8;
}
.binding.inactive {
  color: var(--text-secondary);
  border-color: var(--border-color);
  background: transparent;
}
.unset {
  display: block;
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 8px;
}
.set-key,
.quiet,
.primary,
.remove {
  padding: 8px 12px;
  border-radius: 7px;
  border: 1px solid var(--border-color, #ddd);
  background: transparent;
  color: inherit;
  font-size: 12px;
  white-space: nowrap;
}
.set-key {
  color: var(--primary-color, #008d75);
}
.primary {
  background: var(--primary-color, #008d75);
  border-color: transparent;
  color: white;
}
.remove {
  margin-right: auto;
  color: #c95454;
  border-color: transparent;
  padding-left: 0;
}
.field-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  margin: 18px 0 8px;
}
#shortcut-scope {
  width: 100%;
}
.hint {
  margin-top: 8px;
  font-size: 12px;
}
.error {
  color: #cc4545;
  font-size: 13px;
  line-height: 1.6;
}
.footer-note,
.empty {
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
  margin: 20px 0 8px;
}
@media (max-width: 600px) {
  .plugin-shortcuts {
    padding: 16px;
  }
  .filters {
    flex-wrap: wrap;
  }
  .filters select {
    max-width: 140px;
  }
  .function-row {
    padding: 12px;
  }
}
</style>
