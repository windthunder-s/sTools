import { app, dialog } from 'electron'
import './core/appData/configureAppDataRoot'
import { checkRuntimeCompatibility, EXPECTED_ELECTRON_VERSION } from './runtimeCompatibility'

if (process.platform === 'win32') app.setAppUserModelId('dev.stools.desktop')

const gotTheLock = app.requestSingleInstanceLock()
const runtimeCompatibility = checkRuntimeCompatibility({
  platform: process.platform,
  isPackaged: app.isPackaged,
  runtimeElectronVersion: process.versions.electron
})

/**
 * 提示 sTools 运行时不匹配并退出，避免引导安装上游产品。
 * @returns 提示关闭且应用退出后结束的 Promise。
 */
async function showBlockingRuntimePrompt(): Promise<void> {
  try {
    await app.whenReady()
    await dialog.showMessageBox({
      type: 'warning',
      title: '需要重新安装 sTools',
      message: '当前版本需要升级后才能继续使用',
      detail: 'sTools 的 Electron 运行时与源码版本不匹配。请使用本项目生成的完整安装包重新安装。',
      buttons: ['退出应用'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
  } catch (error) {
    console.error('[Bootstrap] 显示 Electron 兼容性提示失败:', error)
  } finally {
    app.exit(0)
  }
}

if (!gotTheLock) {
  app.exit(0)
} else if (runtimeCompatibility.blocked) {
  console.error(
    `[Bootstrap] 阻止启动: ${runtimeCompatibility.reason}; target=${EXPECTED_ELECTRON_VERSION}`
  )
  void showBlockingRuntimePrompt()
} else {
  void import('./appMain').catch((error) => {
    console.error('[Bootstrap] 加载主程序失败:', error)
    app.exit(1)
  })
}
