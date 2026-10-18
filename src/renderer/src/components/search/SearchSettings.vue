<template>
  <section
    ref="panel"
    class="file-search-settings"
    role="dialog"
    aria-label="搜索设置"
    @keydown.stop="handleKeydown"
    @click.stop
  >
    <div class="settings-title">
      <strong>搜索设置</strong
      ><button aria-label="关闭搜索设置" @click="emit('close')">返回搜索</button>
    </div>
    <p class="intro">在主搜索框查找本机文件、文件夹和程序，插件与系统指令继续由 sTools 提供。</p>
    <label
      >搜索引擎<select v-model="draft.engine">
        <option value="builtin">sTools 内置搜索（备用）</option>
        <option value="everything">Everything SDK（推荐）</option>
      </select></label
    >
    <template v-if="draft.engine === 'builtin'">
      <div class="index-summary" role="status">
        <strong>{{ phaseLabel }}</strong
        ><span>已索引 {{ status?.index.count.toLocaleString() || 0 }} 项</span>
        <small v-if="status?.index.phase === 'scanning'"
          >首次扫描需要一些时间，已收录的文件可立即搜索。</small
        >
        <small v-if="status?.index.nativeVolumes?.length"
          >快速索引：{{ status.index.nativeVolumes.join('、') }} · 自动跟踪文件变化</small
        >
        <small v-if="status?.index.fallbackVolumes?.length"
          >普通扫描：{{ status.index.fallbackVolumes.join('、') }}</small
        >
        <small v-if="status?.index.warning">{{ status.index.warning }}</small>
        <button
          v-if="status?.index.fallbackVolumes?.length"
          :disabled="busy"
          @click="manageService('install')"
        >
          启用快速索引
        </button>
        <button
          v-if="status?.index.nativeVolumes?.length"
          :disabled="busy"
          @click="manageService('uninstall')"
        >
          停用快速索引服务
        </button>
        <small v-if="status?.index.fallbackVolumes?.length"
          >启用会安装 sTools 只读索引服务，需要 Windows 管理员授权；不读取文件内容。</small
        >
      </div>
      <div class="scope-heading">
        <strong>搜索范围</strong><button @click="addFolder">添加文件夹 / 磁盘</button>
      </div>
      <div v-if="!draft.roots.length" class="empty-scope">尚未添加目录，文件搜索暂无结果。</div>
      <ul class="scope-list">
        <li v-for="root in draft.roots" :key="root">
          <span :title="root">{{ root }}</span
          ><button
            :aria-label="'移除 ' + root"
            @click="draft.roots = draft.roots.filter((item) => item !== root)"
          >
            移除
          </button>
        </li>
      </ul>
      <label
        >排除目录<textarea
          v-model="excludedText"
          rows="3"
          placeholder="每行一个目录名或完整路径"
        ></textarea>
      </label>
      <small
        >目录名在所有层级生效；默认略过系统、缓存和依赖目录。目录联接及符号链接不会递归扫描。</small
      >
    </template>
    <template v-else>
      <div class="index-summary" role="status">
        <strong>{{ status?.config.engine === 'everything' ? phaseLabel : '保存后启用' }}</strong>
        <template v-if="status?.config.engine === 'everything'">
          <span>{{ status.index.current }}</span>
          <small>Everything 已索引 {{ status.index.count.toLocaleString() }} 项</small>
          <small v-if="status.index.warning">{{ status.index.warning }}</small>
        </template>
      </div>
      <p class="intro">
        需要 Everything 在后台运行；搜索范围与排除规则在 Everything 中设置。
        程序路径可在“本地工具设置”中修改，主搜索无需 es.exe。
      </p>
      <p class="intro">
        支持 Everything 原生语法：*.pdf、ext:txt;pdf、size:&gt;10mb、dm:today、regex:表达式、| 或、!
        排除及英文双引号短语。
      </p>
      <label
        >结果排序<select v-model.number="sdkDraft.sort">
          <option :value="1">名称升序</option>
          <option :value="2">名称降序</option>
          <option :value="3">路径升序</option>
          <option :value="4">路径降序</option>
          <option :value="5">大小升序</option>
          <option :value="6">大小降序</option>
          <option :value="13">修改时间升序</option>
          <option :value="14">修改时间降序</option>
        </select></label
      >
      <div class="match-options">
        <label><input v-model="sdkDraft.matchCase" type="checkbox" />区分大小写</label>
        <label><input v-model="sdkDraft.matchWholeWord" type="checkbox" />全字匹配</label>
        <label><input v-model="sdkDraft.matchPath" type="checkbox" />匹配完整路径</label>
      </div>
      <small>这些选项仅影响 sTools 查询，不会修改 Everything 窗口中的搜索设置。</small>
    </template>
    <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
    <div class="settings-actions">
      <button :disabled="busy" @click="save">{{ busy ? '正在保存…' : '保存设置' }}</button
      ><button :disabled="busy || status?.index.phase === 'scanning'" @click="refresh">
        {{ draft.engine === 'everything' ? '刷新连接与结果' : '刷新索引' }}</button
      ><span v-if="saved">已保存</span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { FileSearchConfig, FileSearchStatus } from '@shared/fileSearch'
const emit = defineEmits<{ (event: 'close'): void; (event: 'changed'): void }>()
const panel = ref<HTMLElement>()
const draft = ref<FileSearchConfig>({ engine: 'builtin', roots: [], excluded: [] })
const sdkDraft = ref({ sort: 1, matchCase: false, matchPath: false, matchWholeWord: false })
const excludedText = ref('')
const status = ref<FileSearchStatus>()
const busy = ref(false)
const saved = ref(false)
const error = ref('')
let timer: ReturnType<typeof setInterval> | undefined
let disposed = false
const phaseLabel = computed(
  () =>
    ({
      starting: '准备索引',
      scanning: '正在建立索引',
      ready: '索引已就绪',
      error: '索引需要处理',
      disabled: '内置索引未启用'
    })[status.value?.index.phase || 'starting']
)

/**
 * 获取索引进度；不覆盖用户尚未保存的输入。
 * @returns 状态更新完成后的 Promise。
 */
async function updateStatus(): Promise<void> {
  try {
    const value = await window.ztools.fileSearch.status()
    if (!disposed) status.value = value
  } catch (failure) {
    if (!disposed) error.value = String(failure)
  }
}

/**
 * 选择磁盘或目录并加入待保存的范围。
 * @returns 目录选择完成后的 Promise。
 */
async function addFolder(): Promise<void> {
  try {
    const folder = await window.ztools.fileSearch.chooseFolder()
    if (folder && !draft.value.roots.includes(folder)) draft.value.roots.push(folder)
    saved.value = false
  } catch (failure) {
    error.value = String(failure)
  }
}

/**
 * 保存引擎及范围配置，再通知主搜索丢弃旧缓存。
 * @returns 配置保存完成后的 Promise。
 */
async function save(): Promise<void> {
  busy.value = true
  error.value = ''
  saved.value = false
  try {
    const value = await window.ztools.fileSearch.configure({
      ...draft.value,
      everything: { ...sdkDraft.value },
      roots: [...draft.value.roots],
      excluded: excludedText.value
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean)
    })
    status.value = value
    draft.value = structuredClone(value.config)
    sdkDraft.value = { ...sdkDraft.value, ...value.config.everything }
    excludedText.value = value.config.excluded.join('\n')
    saved.value = true
    emit('changed')
  } catch (failure) {
    error.value = String(failure)
  } finally {
    busy.value = false
  }
}

/**
 * 请求协调当前范围，保留已有结果供查询。
 * @returns 刷新请求完成后的 Promise。
 */
async function refresh(): Promise<void> {
  try {
    await window.ztools.fileSearch.refresh()
    await updateStatus()
    emit('changed')
  } catch (failure) {
    error.value = String(failure)
  }
}

/**
 * Ask Windows to approve a service lifecycle action initiated in search settings.
 * @param action Install or remove the dedicated read-only index service.
 * @returns Service operation completion.
 */
async function manageService(action: 'install' | 'uninstall'): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await window.ztools.fileSearch.nativeService(action)
    await updateStatus()
    emit('changed')
  } catch (failure) {
    error.value = '快速索引服务操作未完成：' + String(failure)
  } finally {
    busy.value = false
  }
}

/**
 * 将键盘操作限制在设置面板内，避免误打开搜索结果。
 * @param event 当前键盘事件。
 * @returns 无返回值。
 */
function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
  if (event.key !== 'Tab') return
  const focusable = [
    ...(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled),select,textarea,input') ||
      [])
  ]
  const first = focusable[0],
    last = focusable.at(-1)
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}

onMounted(async () => {
  await updateStatus()
  if (disposed) return
  if (status.value) {
    draft.value = {
      ...status.value.config,
      roots: [...status.value.config.roots],
      excluded: [...status.value.config.excluded]
    }
    sdkDraft.value = { ...sdkDraft.value, ...status.value.config.everything }
    excludedText.value = draft.value.excluded.join('\n')
  }
  await nextTick()
  panel.value?.querySelector<HTMLElement>('button')?.focus()
  timer = setInterval(updateStatus, 1000)
})
onUnmounted(() => {
  disposed = true
  clearInterval(timer)
})
</script>

<style scoped>
.match-options {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
}
.match-options label {
  flex-direction: row;
  align-items: center;
}
.file-search-settings {
  height: 475px;
  overflow-y: auto;
  padding: 14px 20px 20px;
  color: var(--text-color);
  font-size: 13px;
}
.settings-title,
.scope-heading,
.settings-actions,
.scope-list li {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: space-between;
}
.settings-title strong {
  font-size: 18px;
}
.intro {
  line-height: 1.6;
  opacity: 0.75;
  margin: 10px 0 14px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 0;
}
select,
textarea {
  box-sizing: border-box;
  width: 100%;
  padding: 8px;
  border: 1px solid var(--divider-color);
  border-radius: 7px;
  color: inherit;
  background: var(--bg-color);
  font: inherit;
}
option {
  color: #222;
  background: white;
}
textarea {
  resize: vertical;
  min-height: 70px;
}
button {
  cursor: pointer;
  border: 1px solid var(--divider-color);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  padding: 6px 10px;
  font: inherit;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button:hover:not(:disabled) {
  background: rgba(0, 150, 120, 0.12);
}
.index-summary {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(0, 150, 120, 0.1);
  margin: 12px 0;
}
.index-summary small {
  flex-basis: 100%;
}
.scope-list {
  padding: 0;
  margin: 6px 0;
  list-style: none;
}
.scope-list li {
  padding: 5px 0;
}
.scope-list span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
small,
.empty-scope {
  opacity: 0.7;
  line-height: 1.5;
}
.settings-actions {
  justify-content: flex-start;
  padding-top: 14px;
}
.settings-actions button:first-child {
  color: white;
  background: #078473;
}
.settings-error {
  color: #d65b36;
}
</style>
