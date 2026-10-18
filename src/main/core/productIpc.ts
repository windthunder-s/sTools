import { ipcMain } from 'electron'
import { ECOSYSTEM_REMOVED_MESSAGE, isRemovedEcosystemChannel } from '../../shared/ecosystemPolicy'

/**
 * 注册产品实际提供的 IPC；旧生态入口在执行原处理器前返回明确的移除状态。
 * @param channel IPC 通道名称。
 * @param handler 本地功能处理器。
 * @returns 无返回值。
 */
export function registerProductHandler(
  channel: string,
  handler: Parameters<typeof ipcMain.handle>[1]
): void {
  if (isRemovedEcosystemChannel(channel)) {
    ipcMain.handle(channel, () => ({
      success: false,
      code: 'SERVICE_REMOVED',
      error: ECOSYSTEM_REMOVED_MESSAGE
    }))
    return
  }
  ipcMain.handle(channel, handler)
}
