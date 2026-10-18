const { createBackend } = require('./backend.cjs')
const { shell, clipboard } = require('electron')

window.localTools = createBackend({
  getConfig: () => window.ztools.dbStorage.getItem('local-tools-config'),
  saveConfig: (config) => window.ztools.dbStorage.setItem('local-tools-config', config),
  hide: () => window.ztools.hideMainWindow(),
  show: () => window.ztools.showMainWindow()
})

// Reuse the same SDK protocol as the main search; ES is retained only for legacy compatibility.
const path = require('node:path')
const fs = require('node:fs')
const packaged = path.join(process.resourcesPath, 'app.asar.unpacked/resources/search')
const sdkRoot = fs.existsSync(path.join(packaged, 'everything-sdk.cjs'))
  ? packaged
  : path.resolve(__dirname, '../../../resources/search')
const { createSDKBackend } = require(path.join(sdkRoot, 'everything-sdk.cjs'))
const sdk = createSDKBackend({ getConfig: () => window.localTools.status() })

/**
 * Pass the original Everything expression to the official IPC adapter.
 * @param {string} query Raw expression.
 * @param {string} filter Local panel category; file includes executable files.
 * @returns {Promise<object[]>} First result page; main search supports continuation.
 * @throws {Error} Invalid query or unavailable Everything connection.
 */
window.localTools.search = async function (query, filter = 'all') {
  if (!query.trim()) return []
  const expression = filter === 'file' ? `<${query}> file:` : query
  const result = await sdk.search(expression, filter === 'file' ? 'all' : filter)
  return result.items
}
window.localTools.cancelSearch = () => sdk.cancelSearch()
window.addEventListener('unload', () => sdk.close())

/**
 * 对选中的本地结果执行打开、定位或复制路径操作。
 * @param {string} action 操作名称。
 * @param {string} filename 结果中的绝对路径。
 * @returns {Promise<void>} 操作完成后结束。
 * @throws {Error} 路径无效或打开失败时抛出错误。
 */
window.localTools.fileAction = async function (action, filename) {
  if (!require('node:path').isAbsolute(filename)) throw new Error('文件路径无效')
  if (action === 'copy') clipboard.writeText(filename)
  else if (action === 'reveal') shell.showItemInFolder(filename)
  else if (action === 'open') {
    const error = await shell.openPath(filename)
    if (error) throw new Error('打开失败：' + error)
    await window.ztools.hideMainWindow()
  } else throw new Error('操作无效')
}
