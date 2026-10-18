const api = window.localTools
const query = document.querySelector('#query')
const filter = document.querySelector('#filter')
const results = document.querySelector('#results')
let rows = []
let selected = 0
let revision = 0
let timer

/**
 * 显示可读的操作反馈。
 * @param {string} text 提示文字。
 * @returns {void} 无返回值。
 */
function message(text) {
  const el = document.querySelector('#message')
  el.textContent = text
  el.hidden = !text
}

/**
 * 更新配置输入框和软件检测状态。
 * @returns {void} 无返回值。
 */
function refreshConfig() {
  const state = api.status()
  for (const key of ['everything', 'es', 'snipaste', 'instance'])
    document.querySelector(`[name="${key}"]`).value = state[key]
  document.querySelector('#tool-status').textContent = ['everything', 'snipaste']
    .map(
      (key) =>
        `${key === 'es' ? 'ES 查询组件' : key}：${state[key + 'Ready'] ? '已找到' : '未找到'}`
    )
    .join('　')
}

/**
 * 切换搜索与工具设置面板。
 * @param {boolean} settings 是否显示设置。
 * @returns {void} 无返回值。
 */
function showPanel(settings) {
  document.querySelector('#search-panel').hidden = settings
  document.querySelector('#settings-panel').hidden = !settings
  document.querySelector('#search-tab').classList.toggle('selected', !settings)
  document.querySelector('#settings-tab').classList.toggle('selected', settings)
  message('')
  if (settings) refreshConfig()
  else query.focus()
}

/**
 * 打开、定位或复制指定结果。
 * @param {string} action 操作名称。
 * @param {number} index 结果序号。
 * @returns {Promise<void>} 操作完成后结束。
 */
async function act(action, index = selected) {
  if (!rows[index]) return
  try {
    await api.fileAction(action, rows[index].path)
    if (action === 'copy') message('路径已复制')
  } catch (error) {
    message(error.message)
  }
}

/**
 * 切换键盘选中项并滚动到可见区域。
 * @param {number} index 结果序号。
 * @returns {void} 无返回值。
 */
function select(index) {
  selected = Math.max(0, Math.min(index, rows.length - 1))
  Array.from(results.children).forEach((el, i) =>
    el.setAttribute('aria-selected', String(i === selected))
  )
  results.children[selected]?.scrollIntoView({ block: 'nearest' })
}

/**
 * 以文本节点显示文件名，避免文件名中的 HTML 被解释。
 * @returns {void} 无返回值。
 */
function render() {
  results.replaceChildren()
  if (!rows.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = query.value.trim()
      ? '没有匹配结果，请换个关键词或检查索引'
      : '搜索本机文件和文件夹'
    results.append(empty)
    return
  }
  rows.forEach((row, index) => {
    const el = document.createElement('div')
    el.className = 'result'
    el.setAttribute('role', 'option')
    const icon = document.createElement('span')
    icon.className = 'file-icon'
    icon.textContent = row.directory ? '📁' : '📄'
    const body = document.createElement('div')
    body.className = 'result-body'
    const name = document.createElement('div')
    name.className = 'result-name'
    name.textContent = row.name
    const file = document.createElement('div')
    file.className = 'result-path'
    file.textContent = row.path
    file.title = row.path
    body.append(name, file)
    el.append(icon, body)
    for (const [action, label] of [
      ['open', '打开'],
      ['reveal', '定位'],
      ['copy', '路径']
    ]) {
      const button = document.createElement('button')
      button.textContent = label
      button.title = label + ' ' + row.name
      button.onclick = (event) => {
        event.stopPropagation()
        void act(action, index)
      }
      el.append(button)
    }
    el.onclick = () => select(index)
    el.ondblclick = () => void act('open', index)
    results.append(el)
  })
  select(0)
}

/**
 * 延时查询并丢弃旧查询结果；清空输入时也立即取消前一次查询。
 * @returns {void} 无返回值。
 */
function scheduleSearch() {
  clearTimeout(timer)
  api.cancelSearch()
  const current = ++revision
  rows = []
  render()
  message('')
  document.querySelector('#search-status').textContent = query.value.trim()
    ? '正在搜索…'
    : '输入关键词开始搜索'
  if (!query.value.trim()) return
  timer = setTimeout(async () => {
    try {
      const found = await api.search(query.value, filter.value)
      if (current !== revision) return
      rows = found
      render()
      document.querySelector('#search-status').textContent =
        `找到 ${rows.length}${rows.length === 100 ? '+' : ''} 项`
    } catch (error) {
      if (current !== revision) return
      document.querySelector('#search-status').textContent = '搜索不可用'
      message(error.message)
    }
  }, 180)
}

/**
 * 调用 Snipaste，缺失配置时展示设置入口。
 * @param {string} action snip 或 paste。
 * @returns {Promise<void>} 请求结束。
 */
async function snipaste(action) {
  message('')
  try {
    await api.snipaste(action)
  } catch (error) {
    showPanel(true)
    await window.ztools.showMainWindow()
    message(error.message)
  }
}

document.querySelector('#search-tab').onclick = () => showPanel(false)
document.querySelector('#settings-tab').onclick = () => showPanel(true)
document.querySelector('#detect').onclick = refreshConfig
document.querySelector('#snip').onclick = () => void snipaste('snip')
document.querySelector('#paste').onclick = () => void snipaste('paste')
document.querySelector('#config-form').onsubmit = (event) => {
  event.preventDefault()
  try {
    api.configure(Object.fromEntries(new FormData(event.target)))
    refreshConfig()
    message('配置已保存')
  } catch (error) {
    message(error.message)
  }
}
query.oninput = scheduleSearch
filter.onchange = scheduleSearch
document.addEventListener('keydown', (event) => {
  if (document.querySelector('#search-panel').hidden || event.target === filter) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    select(selected + (event.key === 'ArrowDown' ? 1 : -1))
  } else if (event.key === 'Enter') {
    event.preventDefault()
    void act(event.ctrlKey ? 'reveal' : 'open')
  } else if (event.ctrlKey && event.shiftKey && event.code === 'KeyC') {
    event.preventDefault()
    void act('copy')
  }
})
window.ztools.onPluginEnter(({ code }) => {
  window.ztools.setExpendHeight(510)
  if (code === 'configure') showPanel(true)
  else if (code === 'snipaste-snip' || code === 'snipaste-paste')
    void snipaste(code === 'snipaste-snip' ? 'snip' : 'paste')
  else {
    showPanel(false)
    query.focus()
    query.select()
  }
})
window.ztools.onPluginOut(() => {
  clearTimeout(timer)
  revision++
  api.cancelSearch()
})
render()
