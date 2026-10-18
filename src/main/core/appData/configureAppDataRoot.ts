import { app } from 'electron'
import { getZToolsRoot } from './appDataPaths'

const LEGACY_USER_DATA_ENV = 'STOOLS_LEGACY_USER_DATA_PATH'

/**
 * 设置独立的 sTools 应用名称、旧数据路径和当前数据目录。
 * @returns 无返回值。
 */
export function configureAppDataRoot(): void {
  // 在读取 Electron 默认 userData 之前设置产品名，避免接入上游的数据目录。
  app.setName('sTools')
  if (!process.env[LEGACY_USER_DATA_ENV]) {
    process.env[LEGACY_USER_DATA_ENV] = app.getPath('userData')
  }
  const root = getZToolsRoot()
  if (app.getPath('userData') !== root) {
    app.setPath('userData', root)
  }
}

configureAppDataRoot()
