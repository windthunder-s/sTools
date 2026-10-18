import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getEverythingSDK } from './everything'
import { getZToolsRoot } from '../../core/appData/appDataPaths'
import type {
  FileSearchConfig,
  FileSearchResponse,
  FileSearchStatus,
  IndexState
} from '../../../shared/fileSearch'
import type { EverythingFilter } from '../../../shared/unifiedSearch'

const execute = promisify(execFile)
const defaults = [
  '$RECYCLE.BIN',
  'System Volume Information',
  'Windows',
  'AppData',
  'ProgramData',
  '.git',
  'node_modules',
  '.stools'
]

/**
 * 默认索引本地固定磁盘；测试仅使用显式提供的隔离范围。
 * @returns 可用搜索根目录。
 */
async function defaultRoots(): Promise<string[]> {
  if (process.env.ZTOOLS_E2E === '1') return []
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execute(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3').DeviceID | ConvertTo-Json -Compress"
        ],
        { windowsHide: true, timeout: 10000 }
      )
      const disks = JSON.parse(stdout.trim())
      const roots = (Array.isArray(disks) ? disks : [disks])
        .filter((value) => typeof value === 'string' && /^[a-z]:$/i.test(value))
        .map((value) => value + '\\')
      if (roots.length) return roots
    } catch {
      /* 无法枚举磁盘时仍提供用户文件夹内置搜索。 */
    }
  }
  return [os.homedir()]
}

/**
 * 校验用户配置，合并重复与重叠的根目录。
 * @param value 来自主窗口的配置。
 * @returns 校验后的配置。
 * @throws 配置字段或路径无效时抛错。
 */
function validateConfig(value: FileSearchConfig): FileSearchConfig {
  if (
    !value ||
    !['builtin', 'everything'].includes(value.engine) ||
    !Array.isArray(value.roots) ||
    !Array.isArray(value.excluded) ||
    value.roots.length > 32 ||
    value.excluded.length > 100
  )
    throw new Error('搜索配置无效')
  const roots: string[] = []
  for (const item of value.roots) {
    if (typeof item !== 'string' || !path.isAbsolute(item) || item.includes('\0'))
      throw new Error('请选择有效的绝对目录路径')
    const normalized = path.resolve(item)
    if (!roots.some((root) => root.toLowerCase() === normalized.toLowerCase()))
      roots.push(normalized)
  }
  const compactRoots = roots.filter(
    (root) =>
      !roots.some(
        (other) =>
          other !== root &&
          root.toLowerCase().startsWith(other.toLowerCase().replace(/[\\/]+$/, '') + path.sep)
      )
  )
  const excluded = value.excluded
    .map((item) => {
      if (typeof item !== 'string' || item.length > 1024 || item.includes('\0'))
        throw new Error('排除目录无效')
      return item.trim()
    })
    .filter(Boolean)
  const everything = {
    sort: 1,
    matchCase: false,
    matchPath: false,
    matchWholeWord: false,
    ...value.everything
  }
  if (
    ![1, 2, 3, 4, 5, 6, 13, 14].includes(everything.sort) ||
    ['matchCase', 'matchPath', 'matchWholeWord'].some((key) => typeof everything[key] !== 'boolean')
  )
    throw new Error('Everything 匹配或排序设置无效')
  return { engine: value.engine, roots: compactRoots, excluded: [...new Set(excluded)], everything }
}

/**
 * 注册宿主内置文件索引；扫描与 SQL 查询在独立工作线程执行。
 * @param mainWindow 唯一可调用搜索和配置接口的窗口。
 * @returns 无返回值。
 */
export function initFileSearch(mainWindow: BrowserWindow): void {
  const directory = path.join(getZToolsRoot(), 'search')
  const configPath = path.join(directory, 'config.json')
  let config: FileSearchConfig
  let worker: Worker | undefined
  let sequence = 0
  let stopped = false
  let workerError = ''
  let generation = 0
  const pending = new Map<
    number,
    { resolve: (result: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()

  /**
   * 拒绝工作线程故障后尚未完成的调用，释放超时定时器。
   * @param message 故障或关闭原因。
   * @returns 无返回值。
   */
  function rejectPending(message: string): void {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error(message))
    }
    pending.clear()
  }

  /**
   * 安全关闭旧工作线程，再按当前配置启动新的索引。
   * @returns 索引可接受请求后的 Promise。
   */
  async function startWorker(): Promise<void> {
    const current = ++generation
    rejectPending('搜索配置已更新，请重试')
    const oldWorker = worker
    worker = undefined
    if (oldWorker) await oldWorker.terminate()
    if (stopped || current !== generation || config.engine !== 'builtin') return
    workerError = ''
    const filename = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked/resources/search/index-worker.cjs')
      : path.join(app.getAppPath(), 'resources/search/index-worker.cjs')
    const instance = new Worker(filename, {
      workerData: {
        filename: path.join(directory, 'index.sqlite'),
        config: {
          ...config,
          dataDirectory: getZToolsRoot(),
          nativeDisabled: process.env.ZTOOLS_E2E === '1'
        }
      }
    })
    worker = instance
    await new Promise<void>((resolve) => {
      instance.on('message', (message) => {
        if (current !== generation) return
        if (message.ready) {
          resolve()
          return
        }
        if (message.fatal) {
          workerError = message.fatal
          rejectPending(workerError)
          resolve()
          return
        }
        const request = pending.get(message.id)
        if (!request) return
        clearTimeout(request.timer)
        pending.delete(message.id)
        if (message.error) request.reject(new Error(message.error))
        else request.resolve(message.result)
      })
      instance.on('error', (error) => {
        if (current === generation) {
          workerError = error.message
          rejectPending(workerError)
        }
        resolve()
      })
      instance.on('exit', (code) => {
        if (current === generation && !stopped) {
          workerError ||= `内置索引进程已退出（${code}）`
          rejectPending(workerError)
        }
        resolve()
      })
    })
  }

  /**
   * 读取设备本地配置；首次安装自动选择搜索范围。
   * @returns 初始化完成后的 Promise。
   */
  async function initialize(): Promise<void> {
    await fs.mkdir(directory, { recursive: true })
    try {
      config = validateConfig(JSON.parse(await fs.readFile(configPath, 'utf8')))
    } catch {
      config = validateConfig({
        engine:
          process.platform === 'win32' && process.env.ZTOOLS_E2E !== '1' ? 'everything' : 'builtin',
        roots: await defaultRoots(),
        excluded: defaults
      })
    }
    await fs.writeFile(configPath, JSON.stringify(config, null, 2))
    await startWorker()
  }
  const ready = initialize().catch((error) => {
    config ||= { engine: 'builtin', roots: [], excluded: defaults }
    workerError = String(error)
  })

  /**
   * 向工作线程发出带超时的请求。
   * @param action 索引操作。
   * @param query 可选关键词。
   * @param options 分类、分页偏移和快照版本。
   * @returns 工作线程返回值。
   * @throws 索引不可用或响应超时会拒绝。
   */
  async function request(
    action: string,
    query?: string,
    options: { filter?: string; offset?: number; version?: number } = {}
  ): Promise<any> {
    await ready
    if (workerError || !worker) throw new Error(workerError || '内置搜索未启用')
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('本地索引响应超时，请稍后重试'))
      }, 15000)
      pending.set(id, { resolve, reject, timer })
      worker!.postMessage({ id, action, query, ...options })
    })
  }

  /**
   * 返回配置及扫描进度，错误以可见状态反馈到界面。
   * @param watchQuery 是否刷新当前可见的 SDK 查询。
   * @returns 当前索引状态。
   */
  async function status(watchQuery = false): Promise<FileSearchStatus> {
    await ready
    let index: IndexState = {
      phase: config.engine === 'builtin' ? 'starting' : 'disabled',
      count: 0,
      scanned: 0,
      skipped: 0,
      current: '',
      warning: workerError,
      version: generation
    }
    if (config.engine === 'builtin') {
      try {
        index = await request('status')
      } catch (error) {
        index.phase = 'error'
        index.warning = String(error)
      }
    }
    if (config.engine === 'everything') {
      try {
        index = await getEverythingSDK().status(config.everything, watchQuery)
      } catch (error) {
        index.phase = 'error'
        index.warning = String(error)
      }
    }
    return { config, index }
  }

  // 配置只对主窗口开放，避免插件任意修改扫描范围。
  ipcMain.handle('file-search:status', (event, options?: { watchQuery?: boolean }) =>
    event.sender === mainWindow.webContents
      ? status(options?.watchQuery === true)
      : Promise.reject(new Error('仅主搜索窗口可访问'))
  )
  ipcMain.handle(
    'file-search:search',
    async (
      event,
      query: string,
      filter: EverythingFilter,
      options: { offset?: number; version?: number } = {}
    ): Promise<FileSearchResponse> => {
      try {
        if (event.sender !== mainWindow.webContents) throw new Error('仅主搜索窗口可查询本机文件')
        if (
          typeof query !== 'string' ||
          query.length > 512 ||
          !['all', 'app', 'file', 'folder'].includes(filter) ||
          !options ||
          !Number.isSafeInteger(options.offset ?? 0) ||
          (options.offset ?? 0) < 0 ||
          (options.version !== undefined && !Number.isSafeInteger(options.version))
        )
          throw new Error('无效的搜索参数')
        await ready
        if (config.engine !== 'builtin')
          return await getEverythingSDK().search(query, filter, options, config.everything)
        const result = await request('search', query, {
          filter,
          offset: options.offset ?? 0,
          version: options.version
        })
        return { ...result, ...(result.buckets[filter] || {}) }
      } catch (error) {
        return {
          items: [],
          limited: false,
          engine: config?.engine || 'builtin',
          version: generation,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )
  ipcMain.handle('file-search:configure', async (event, value: FileSearchConfig) => {
    if (event.sender !== mainWindow.webContents) throw new Error('仅主搜索窗口可修改配置')
    await ready
    const next = validateConfig(value)
    // 先原子保存配置，再替换工作线程；保留磁盘文件和已有索引快照。
    const temp = configPath + '.tmp'
    await fs.writeFile(temp, JSON.stringify(next, null, 2))
    await fs.rename(temp, configPath)
    config = next
    if (process.platform === 'win32') getEverythingSDK().refresh()
    await startWorker()
    return status()
  })
  ipcMain.handle('file-search:choose-folder', async (event) => {
    if (event.sender !== mainWindow.webContents) throw new Error('仅主搜索窗口可选择目录')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '添加搜索文件夹或磁盘',
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0] || null
  })
  ipcMain.handle('file-search:refresh', async (event) => {
    if (event.sender !== mainWindow.webContents) throw new Error('仅主搜索窗口可刷新索引')
    await ready
    if (config.engine === 'everything') getEverythingSDK().refresh()
    else if (workerError) await startWorker()
    else if (config.engine === 'builtin') await request('refresh')
  })
  ipcMain.handle('file-search:native-service', async (event, action: 'install' | 'uninstall') => {
    if (event.sender !== mainWindow.webContents) throw new Error('仅主搜索窗口可管理索引服务')
    if (
      process.platform !== 'win32' ||
      process.env.ZTOOLS_E2E === '1' ||
      !['install', 'uninstall'].includes(action)
    )
      throw new Error('当前环境不可管理索引服务')
    const helper = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked/resources/search/stools-ntfs.exe')
      : path.join(app.getAppPath(), 'resources/search/stools-ntfs.exe')
    const { stdout } = await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'
      ],
      { windowsHide: true, timeout: 10000 }
    )
    const sid = stdout.trim()
    if (!/^S-1-[0-9-]+$/.test(sid)) throw new Error('无法确认本机用户')
    // Windows displays its own UAC consent; only the small read-only helper receives elevation.
    const command =
      "$ErrorActionPreference='Stop'; $p=Start-Process -FilePath '" +
      helper.replace(/'/g, "''") +
      "' -ArgumentList @('" +
      action +
      "'" +
      (action === 'install' ? ",'" + sid + "'" : '') +
      ') -Verb RunAs -WindowStyle Hidden -PassThru; $p.WaitForExit(); exit $p.ExitCode'
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      timeout: 180000
    })
    await ready
    await startWorker()
  })
  app.once('will-quit', () => {
    stopped = true
    generation++
    rejectPending('应用退出')
    void worker?.terminate()
  })
}
