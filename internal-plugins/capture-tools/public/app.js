const status = document.querySelector('#status')
const display = document.querySelector('#display')
const defaultMode = document.querySelector('#default-mode')
const modeNames = { capture: '截图', record: '录屏', gif: 'GIF 动图', scroll: '长截图' }
let starting = false

/**
 * Read the explicitly chosen quick-entry mode; older installations default to screenshots.
 * @returns {string} Supported capture mode.
 */
function readDefaultMode() {
  const saved = window.ztools.dbStorage.getItem('default-mode')
  return Object.hasOwn(modeNames, saved) ? saved : 'capture'
}

/**
 * Persist an explicit preference without changing a direct screenshot or recording command.
 * @returns {void} No return value.
 */
function saveDefaultMode() {
  const previous = readDefaultMode()
  const next = defaultMode.value
  if (!Object.hasOwn(modeNames, next)) return
  try {
    const result = window.ztools.dbStorage.setItem('default-mode', next)
    if (result?.error || result?.ok === false || readDefaultMode() !== next)
      throw new Error('默认功能未能保存，请重试。')
    status.textContent = `已保存：快速入口默认打开${modeNames[next]}。`
  } catch (error) {
    defaultMode.value = previous
    status.textContent = error.message || '默认功能未能保存，请重试。'
  }
}

/**
 * Launch a concrete mode, resolving only the quick command through the user's preference.
 * @param {string} command Quick entry, capture, recording, GIF, scroll or pin command.
 * @returns {Promise<void>} Launch completion with visible failures.
 */
async function start(command) {
  if (starting) return
  starting = true
  status.textContent = ''
  try {
    const kind = command === 'quick' ? readDefaultMode() : command
    await window.captureTools.start({
      kind,
      displayId: display.value ? Number(display.value) : undefined,
      microphone: document.querySelector('#microphone').checked,
      systemAudio: document.querySelector('#system-audio').checked
    })
  } catch (error) {
    status.textContent = error.message || '启动失败，请重试。'
    window.ztools.showMainWindow()
  } finally {
    starting = false
  }
}

/**
 * Show the same saved shortcut and initialization conflict used by the central shortcut manager.
 * @returns {Promise<void>} Status refresh completion.
 */
async function refreshShortcutStatus() {
  const label = document.querySelector('#shortcut-status')
  try {
    const [globalKeys, appKeys, initialization] = await Promise.all([
      window.ztools.internal.dbGet('global-shortcuts'),
      window.ztools.internal.dbGet('app-shortcuts'),
      window.ztools.internal.dbGet('capture-quick-shortcut-initialized')
    ])
    const rows = [
      ...(Array.isArray(globalKeys) ? globalKeys.map((key) => ({ ...key, scope: '全局' })) : []),
      ...(Array.isArray(appKeys) ? appKeys.map((key) => ({ ...key, scope: '主搜索页内' })) : [])
    ]
    const shortcuts = rows.filter(
      (key) =>
        key.enabled &&
        typeof key.target === 'string' &&
        /^(capture-tools|截图与录屏)\/(快速截图|快速截图入口)$/.test(
          key.target.replace(/\s*\/\s*/g, '/')
        )
    )
    if (shortcuts.length) {
      label.textContent = `快速入口：${shortcuts.map((key) => `${key.shortcut}（${key.scope}）`).join('、')}`
    } else if (initialization?.status === 'failed') {
      label.textContent = `F1 未启用：${initialization.error || '快捷键注册失败。'} 请点击「设置快捷键」选择其它组合键。`
    } else if (initialization?.status === 'preserved') {
      label.textContent = '已保留你原有的截图/录屏快捷键。可为快速入口另设快捷键。'
    } else {
      label.textContent = '快速入口尚未设置快捷键。点击「设置快捷键」即可添加。'
    }
  } catch {
    label.textContent = '快捷键状态读取失败，请到「插件快捷键」中查看。'
  }
}

/**
 * Open the existing per-plugin shortcut editor instead of creating another key listener.
 * @returns {void} No return value.
 */
function openShortcuts() {
  const opened = window.ztools.redirect(['设置', '插件快捷键'])
  if (!opened) status.textContent = '快捷键设置未能打开，请搜索「插件快捷键」。'
}

for (const button of document.querySelectorAll('[data-action]'))
  button.onclick = () => start(button.dataset.action)
document.querySelector('#shortcuts').onclick = openShortcuts
document.querySelector('#drafts').onclick = () => window.captureTools.drafts()
defaultMode.onchange = saveDefaultMode
defaultMode.value = readDefaultMode()
window.captureTools
  .displays()
  .then((displays) => {
    for (const item of displays) {
      const option = document.createElement('option')
      option.value = String(item.id)
      option.textContent = `${item.label} · ${item.width} × ${item.height}${item.primary ? ' · 主屏' : ''}`
      display.append(option)
    }
  })
  .catch((error) => {
    status.textContent = error.message
  })
window.ztools.onPluginEnter(({ code }) => {
  window.ztools.setExpendHeight(640)
  defaultMode.value = readDefaultMode()
  void refreshShortcutStatus()
  if (code !== 'home') void start(code)
})
