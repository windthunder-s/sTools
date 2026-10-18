import { app, BrowserWindow, ipcMain } from 'electron'
import { createRequire } from 'node:module'
import path from 'node:path'
import lmdbInstance from '../../core/lmdb/lmdbInstance'
import { getInternalPluginPath } from '../../core/internalPlugins'
import { getPluginDataPrefix } from '../../../shared/pluginRuntimeNamespace'
import type { EverythingFilter } from '../../../shared/unifiedSearch'
import type { EverythingOptions, FileSearchResponse, IndexState } from '../../../shared/fileSearch'

interface SDKBackend {
  search: (
    query: string,
    filter: EverythingFilter,
    page?: { offset?: number; version?: number },
    options?: EverythingOptions
  ) => Promise<FileSearchResponse>
  status: (options?: EverythingOptions, watchQuery?: boolean) => Promise<IndexState>
  cancelSearch: () => void
  refresh: () => void
  close: () => void
}
let backend: SDKBackend | undefined

/**
 * Load the shared SDK IPC adapter and resolve the user's configured Everything executable.
 * @returns The single host-owned SDK backend.
 * @throws If the platform or bundled SDK bridge is unavailable.
 */
export function getEverythingSDK(): SDKBackend {
  if (process.platform !== 'win32') throw new Error('Everything SDK 目前仅支持 Windows')
  if (!backend) {
    const require = createRequire(path.join(app.getAppPath(), 'package.json'))
    const directory = getInternalPluginPath('local-tools')
    const { detectTools } = require(
      path.join(directory, ...(app.isPackaged ? [] : ['public']), 'backend.cjs')
    )
    const resources = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked/resources/search')
      : path.join(app.getAppPath(), 'resources/search')
    const { createSDKBackend } = require(path.join(resources, 'everything-sdk.cjs'))
    backend = createSDKBackend({
      getConfig: () => {
        const doc = lmdbInstance.get(getPluginDataPrefix('local-tools') + 'local-tools-config')
        return detectTools(doc?.value ?? doc?.data ?? {})
      }
    })
  }
  return backend!
}

/**
 * Keep the legacy host API compatible while all file queries use the official SDK protocol.
 * @param mainWindow The only window authorized to search local files.
 * @returns No value.
 */
export function initEverythingSearch(mainWindow: BrowserWindow): void {
  ipcMain.handle('everything:search', async (event, query: string, filter: EverythingFilter) => {
    try {
      if (event.sender !== mainWindow.webContents) throw new Error('仅主搜索窗口可查询本机文件')
      return await getEverythingSDK().search(query, filter)
    } catch (error) {
      return {
        items: [],
        limited: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
  ipcMain.on('everything:cancel', (event) => {
    if (event.sender === mainWindow.webContents) backend?.cancelSearch()
  })
  mainWindow.on('closed', () => backend?.close())
  app.on('before-quit', () => backend?.close())
}
