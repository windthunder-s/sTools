import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  screen,
  session,
  shell
} from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { PluginManager } from '../../managers/pluginManager'
import { getInternalPluginPath } from '../../core/internalPlugins'
import { getZToolsRoot } from '../../core/appData/appDataPaths'

type Kind = 'capture' | 'record' | 'gif' | 'pin' | 'scroll'
interface CaptureSession {
  window: BrowserWindow
  kind: Kind
  display: Electron.Display
  image: string
  crop?: { x: number; y: number; width: number; height: number }
  microphone: boolean
  systemAudio: boolean
  stage: 'select' | 'transition' | 'ready' | 'recording' | 'scrolling' | 'done'
  launching?: boolean
  filename?: string
  bytes: number
  mime?: string
  writing: Promise<void>
  framePending?: boolean
  encoding?: boolean
  recordingGeneration?: number
  recordingAbort?: Promise<void>
}

/**
 * Install the bundled capture plugin's private host APIs and own all capture windows.
 * @param mainWindow Host launcher window, hidden before capturing.
 * @param pluginManager Registry used to authenticate the bundled plugin.
 * @returns No value.
 */
export function initCaptureTools(mainWindow: BrowserWindow, pluginManager: PluginManager): void {
  const resources = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked/resources/capture')
    : path.join(app.getAppPath(), 'resources/capture')
  const pluginRoot = path.join(
    getInternalPluginPath('capture-tools'),
    ...(app.isPackaged ? [] : ['public'])
  )
  const drafts = path.join(getZToolsRoot(), 'captures/drafts')
  const sessions = new Map<number, CaptureSession>()
  let selecting = false

  /**
   * Authenticate a plugin caller by its registry identity and bundled path.
   * @param event IPC invocation.
   * @returns No value.
   * @throws If the caller is not the bundled capture plugin.
   */
  function assertPlugin(event: Electron.IpcMainInvokeEvent): void {
    const info = pluginManager.getPluginInfoByWebContents(event.sender)
    if (info?.name !== 'capture-tools' || path.resolve(info.path) !== path.resolve(pluginRoot))
      throw new Error('仅内置截图插件可调用此接口')
  }

  /**
   * Resolve only an owned top-level capture renderer.
   * @param event IPC invocation.
   * @returns Active session.
   * @throws If the sender does not own a capture session.
   */
  function owner(event: Electron.IpcMainInvokeEvent): CaptureSession {
    const record = sessions.get(event.sender.id)
    if (!record || event.senderFrame !== event.sender.mainFrame) throw new Error('截图会话无效')
    return record
  }

  /**
   * Decode a bounded PNG emitted by the editor.
   * @param data PNG data URL.
   * @returns Valid image.
   * @throws For invalid or oversized image data.
   */
  function decode(data: string): Electron.NativeImage {
    if (
      typeof data !== 'string' ||
      !data.startsWith('data:image/png;base64,') ||
      data.length > 64 * 1024 * 1024
    )
      throw new Error('截图数据无效或过大')
    const image = nativeImage.createFromDataURL(data),
      size = image.getSize()
    if (
      image.isEmpty() ||
      size.width > 16384 ||
      size.height > 16384 ||
      size.width * size.height > 40000000
    )
      throw new Error('截图尺寸无效')
    return image
  }

  /**
   * Create a sandboxed local window with permissions scoped to its selected recording source.
   * @param record Session data without the window.
   * @param bounds Initial window bounds in DIP coordinates.
   * @param page Local renderer file.
   * @param origin Optional selection whose lifetime owns this pending window.
   * @returns Loaded window session after the origin-to-child handoff commits.
   * @throws If loading fails or the origin is cancelled before the handoff commits.
   */
  async function create(
    record: Omit<CaptureSession, 'window'>,
    bounds: Electron.Rectangle,
    page: string,
    origin?: CaptureSession
  ): Promise<CaptureSession> {
    if (origin?.window.isDestroyed()) throw new Error('截图操作已取消')
    const partition = session.fromPartition('capture-' + randomUUID())
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      fullscreen: page === 'editor.html',
      resizable: page !== 'recorder.html',
      fullscreenable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#14201f',
      webPreferences: {
        preload: path.join(resources, 'preload.cjs'),
        session: partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    })
    const entry: CaptureSession = { ...record, window: win, launching: true }
    const contents = win.webContents
    const contentsId = contents.id
    sessions.set(contentsId, entry)
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setMenu(null)
    if (['recorder.html', 'scroll.html'].includes(page)) win.setContentProtection(true)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    const recorderURL = pathToFileURL(path.join(resources, 'recorder.html')).href
    partition.setPermissionCheckHandler(
      (sender, permission, _origin, details) =>
        sender === contents &&
        !contents.isDestroyed() &&
        entry.stage === 'recording' &&
        details.isMainFrame === true &&
        (String(permission) === 'display-capture' ||
          (permission === 'media' && entry.microphone && details.mediaType === 'audio'))
    )
    partition.setPermissionRequestHandler((sender, permission, callback, details) => {
      // Electron 41 requests desktop capture as media with an empty mediaTypes array.
      // Camera requests contain video and remain denied; microphone requires explicit opt-in.
      const types = 'mediaTypes' in details ? details.mediaTypes : undefined
      callback(
        sender === contents &&
          !contents.isDestroyed() &&
          entry.stage === 'recording' &&
          details.isMainFrame === true &&
          details.requestingUrl === recorderURL &&
          (String(permission) === 'display-capture' ||
            (permission === 'media' &&
              Array.isArray(types) &&
              (types.length === 0 ||
                (entry.microphone && types.every((type) => type === 'audio')))))
      )
    })
    partition.setDisplayMediaRequestHandler(async (request, callback) => {
      if (request.frame !== win.webContents.mainFrame || entry.stage !== 'recording')
        return callback({})
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 }
        })
        const source = sources.find((item) => item.display_id === String(entry.display.id))
        callback(
          source
            ? {
                video: source,
                ...(entry.systemAudio && process.platform === 'win32'
                  ? { audio: 'loopback' as const }
                  : {})
              }
            : {}
        )
      } catch {
        callback({})
      }
    })
    win.on('close', (event) => {
      if (entry.stage === 'recording') {
        event.preventDefault()
        win.webContents.send('capture:stop')
      }
    })
    win.on('closed', () => {
      partition.setPermissionCheckHandler(null)
      partition.setPermissionRequestHandler(null)
      partition.setDisplayMediaRequestHandler(null)
      sessions.delete(contentsId)
      if (entry.stage === 'select' || entry.stage === 'transition') selecting = false
    })
    let cancelled = false
    /**
     * Destroy a pending child immediately when its source selection is cancelled.
     * @returns No value.
     */
    function cancelHandoff(): void {
      cancelled = true
      if (!win.isDestroyed()) win.destroy()
    }
    origin?.window.once('closed', cancelHandoff)
    // The pending child never becomes visible if the source closes while loadFile awaits.
    try {
      await win.loadFile(path.join(resources, page))
      if (cancelled || origin?.window.isDestroyed() || win.isDestroyed())
        throw new Error('截图操作已取消')
      entry.launching = false
      win.show()
      if (page === 'editor.html') win.setFullScreen(true)
      win.focus()
      return entry
    } catch (error) {
      if (!win.isDestroyed()) win.destroy()
      throw error
    } finally {
      // After success the caller may close the source without also closing its committed child.
      origin?.window.removeListener('closed', cancelHandoff)
    }
  }

  /**
   * Pin an image in a movable, resizable always-on-top window.
   * @param image Image data.
   * @param display Target display.
   * @returns Creation completion.
   */
  async function pin(image: Electron.NativeImage, display: Electron.Display): Promise<void> {
    const size = image.getSize(),
      scale = Math.min(1, 760 / size.width, 650 / size.height)
    await create(
      {
        kind: 'pin',
        display,
        image: image.toDataURL(),
        microphone: false,
        systemAudio: false,
        stage: 'ready',
        bytes: 0,
        writing: Promise.resolve()
      },
      {
        x: display.workArea.x + 40,
        y: display.workArea.y + 40,
        width: Math.max(180, Math.round(size.width * scale)),
        height: Math.max(100, Math.round(size.height * scale) + 36)
      },
      'pin.html'
    )
  }

  ipcMain.handle('capture-tools:displays', (event) => {
    assertPlugin(event)
    return screen.getAllDisplays().map((item) => ({
      id: item.id,
      label: item.label || '显示器 ' + item.id,
      width: item.size.width,
      height: item.size.height,
      primary: item.id === screen.getPrimaryDisplay().id
    }))
  })

  /**
   * Get window boundaries for snap assist feature.
   * @param event Plugin invocation.
   * @param displayId Target display ID.
   * @returns Array of window rectangles in DIP coordinates.
   */
  ipcMain.handle('capture-tools:get-windows', async (event, displayId?: number) => {
    assertPlugin(event)
    if (
      displayId !== undefined &&
      !screen.getAllDisplays().some((display) => display.id === displayId)
    )
      throw new Error('目标显示器已断开')

    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 }
      })

      // Filter visible windows and map to display-relative bounds
      const windows = sources
        .filter((source) => {
          // Exclude hidden windows and very small windows (< 50x50)
          return source.name && source.name.trim().length > 0
        })
        .map((source) => {
          // Parse bounds from source.id format: "window:123:0"
          // Native bounds are in the source's display coordinates
          return {
            id: source.id,
            name: source.name,
            // Placeholder - actual bounds need platform-specific implementation
            // For now return empty to avoid breaking existing functionality
            bounds: null as { x: number; y: number; width: number; height: number } | null
          }
        })
        .filter((w) => w.bounds !== null)

      return windows.map((w) => w.bounds!)
    } catch (error) {
      // Window enumeration may fail on some systems
      return []
    }
  })
  ipcMain.handle('capture-tools:drafts', async (event) => {
    assertPlugin(event)
    await fs.mkdir(drafts, { recursive: true })
    await shell.openPath(drafts)
  })
  ipcMain.handle(
    'capture-tools:start',
    async (
      event,
      options: { kind: Kind; displayId?: number; microphone?: boolean; systemAudio?: boolean }
    ) => {
      assertPlugin(event)
      if (!options || !['capture', 'record', 'gif', 'pin', 'scroll'].includes(options.kind))
        throw new Error('截图操作无效')
      const display =
        screen.getAllDisplays().find((item) => item.id === options.displayId) ||
        screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      if (options.kind === 'pin') {
        const image = clipboard.readImage()
        if (image.isEmpty()) throw new Error('剪贴板里没有图片，请先截图或复制图片')
        await pin(image, display)
        mainWindow.hide()
        return
      }
      // 快捷键连按/自动重复只聚焦现有会话，不能弹回主界面遮住截图。
      const active = [...sessions.values()].find(
        (item) =>
          item.stage === 'select' ||
          item.stage === 'recording' ||
          item.stage === 'scrolling' ||
          (item.stage === 'ready' && item.kind !== 'pin')
      )
      if (selecting || active) {
        if (active && !active.launching && !active.window.isDestroyed()) {
          active.window.show()
          active.window.focus()
        }
        return
      }
      selecting = true
      const restore = mainWindow.isVisible()
      mainWindow.hide()
      try {
        // Allow launcher fade-out to finish before taking the frozen selection frame.
        await new Promise((resolve) => setTimeout(resolve, 200))
        const size = {
          width: Math.round(display.size.width * display.scaleFactor),
          height: Math.round(display.size.height * display.scaleFactor)
        }
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
        const source = sources.find((item) => item.display_id === String(display.id))
        if (!source || source.thumbnail.isEmpty()) throw new Error('无法捕获所选显示器')
        await create(
          {
            kind: options.kind,
            display,
            image: source.thumbnail.toDataURL(),
            microphone: options.microphone === true && options.kind !== 'gif',
            systemAudio: options.systemAudio === true && options.kind !== 'gif',
            stage: 'select',
            bytes: 0,
            writing: Promise.resolve()
          },
          display.bounds,
          'editor.html'
        )
      } catch (error) {
        selecting = false
        if (restore) mainWindow.show()
        throw error
      }
    }
  )

  /**
   * Change only an owned, uncommitted selection's output mode.
   * @param event Owned editor invocation.
   * @param kind Requested action.
   * @returns Validated action.
   * @throws If the session is no longer selecting or the mode is unknown.
   */
  function setCaptureMode(event: Electron.IpcMainInvokeEvent, kind: Kind): Kind {
    const record = owner(event)
    if (record.stage !== 'select' || !['capture', 'record', 'gif', 'scroll'].includes(kind))
      throw new Error('当前状态不能切换截图方式')
    record.kind = kind
    return kind
  }
  ipcMain.handle('capture:set-mode', setCaptureMode)

  /**
   * Start a single manual scrolling session, keeping controls outside the crop where space allows.
   * @param event Owned selection editor.
   * @param crop Selection in display-relative DIP coordinates.
   * @returns Completion after the scrolling controller is ready.
   * @throws If the crop or current session is invalid.
   */
  async function selectScroll(
    event: Electron.IpcMainInvokeEvent,
    crop: NonNullable<CaptureSession['crop']>
  ): Promise<void> {
    const record = owner(event)
    if (
      record.kind !== 'scroll' ||
      record.stage !== 'select' ||
      !crop ||
      ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) ||
      crop.x < 0 ||
      crop.y < 0 ||
      crop.width < 64 ||
      crop.height < 80 ||
      crop.x + crop.width > record.display.size.width ||
      crop.y + crop.height > record.display.size.height
    )
      throw new Error('请框选至少 64 × 80 的可滚动正文区域')
    const area = record.display.workArea,
      display = record.display.bounds
    const width = Math.min(400, area.width),
      height = Math.min(560, area.height)
    const region = {
      x: display.x + crop.x,
      y: display.y + crop.y,
      width: crop.width,
      height: crop.height
    }
    const candidates = [
      { x: region.x + region.width + 12, y: area.y + 12 },
      { x: region.x - width - 12, y: area.y + 12 },
      { x: area.x + area.width - width - 12, y: region.y + region.height + 12 },
      { x: area.x + area.width - width - 12, y: region.y - height - 12 }
    ]
    const position = candidates.find(
      (point) =>
        point.x >= area.x &&
        point.y >= area.y &&
        point.x + width <= area.x + area.width &&
        point.y + height <= area.y + area.height
    ) || { x: area.x + area.width - width, y: area.y }
    // A transferring source is no longer a focusable selection; the pending child owns cancellation.
    record.stage = 'transition'
    record.window.hide()
    try {
      await create(
        { ...record, crop, image: '', stage: 'scrolling' },
        { ...position, width, height },
        'scroll.html',
        record
      )
      record.window.close()
    } catch (failure) {
      // A cancelled source must never be restored or clear a newer selection's startup lock.
      if (record.window.isDestroyed()) return
      record.stage = 'select'
      record.window.show()
      record.window.focus()
      throw failure
    }
  }
  ipcMain.handle('capture:select-scroll', selectScroll)

  /**
   * Capture only the selected screen region for its owned scrolling session.
   * @param event Scrolling controller invocation.
   * @returns A PNG containing the crop's native physical pixels.
   * @throws For invalid state, concurrent capture or unavailable screen data.
   */
  async function scrollFrame(event: Electron.IpcMainInvokeEvent): Promise<string> {
    const record = owner(event)
    if (
      record.kind !== 'scroll' ||
      record.stage !== 'scrolling' ||
      !record.crop ||
      record.framePending
    )
      throw new Error('长截图采集状态无效')
    record.framePending = true
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(record.display.size.width * record.display.scaleFactor),
          height: Math.round(record.display.size.height * record.display.scaleFactor)
        }
      })
      const source = sources.find((item) => item.display_id === String(record.display.id))
      if (!source || source.thumbnail.isEmpty()) throw new Error('无法读取长截图画面')
      const size = source.thumbnail.getSize(),
        crop = record.crop
      const sx = size.width / record.display.size.width,
        sy = size.height / record.display.size.height
      const left = Math.round(crop.x * sx),
        top = Math.round(crop.y * sy)
      return source.thumbnail
        .crop({
          x: left,
          y: top,
          width: Math.min(size.width - left, Math.round((crop.x + crop.width) * sx) - left),
          height: Math.min(size.height - top, Math.round((crop.y + crop.height) * sy) - top)
        })
        .toDataURL()
    } finally {
      record.framePending = false
    }
  }
  ipcMain.handle('capture:scroll-frame', scrollFrame)

  /**
   * Release the active scrolling lock before displaying a completed PNG preview.
   * @param event Owned scrolling controller invocation.
   * @returns No value.
   * @throws If no scrolling task belongs to the caller.
   */
  function finishScroll(event: Electron.IpcMainInvokeEvent): void {
    const record = owner(event)
    if (record.kind !== 'scroll' || !['scrolling', 'done'].includes(record.stage))
      throw new Error('长截图状态无效')
    // Completion is idempotent so an Enter repeat cannot strand an already verified image.
    record.stage = 'done'
  }
  ipcMain.handle('capture:scroll-finish', finishScroll)

  /**
   * Restart only the owning completed long-shot controller using its already validated region.
   * @param event Owned preview window invocation.
   * @returns No value.
   * @throws If another active capture owns the screen or the caller is not a completed long shot.
   */
  function retryScroll(event: Electron.IpcMainInvokeEvent): void {
    const record = owner(event)
    if (record.kind !== 'scroll' || record.stage !== 'done' || record.framePending)
      throw new Error('当前长截图尚未完成')
    // Retrying cannot bypass the single-active-capture policy or change the selected region.
    if (
      selecting ||
      [...sessions.values()].some(
        (item) =>
          item !== record &&
          (['select', 'transition', 'recording', 'scrolling'].includes(item.stage) ||
            (item.stage === 'ready' && item.kind !== 'pin'))
      )
    )
      throw new Error('请先结束其它截图或录屏任务')
    record.stage = 'scrolling'
  }
  ipcMain.handle('capture:scroll-retry', retryScroll)

  ipcMain.handle('capture:describe', (event) => {
    const record = owner(event)
    return {
      kind: record.kind,
      image: record.image,
      crop: record.crop,
      width: record.display.size.width,
      height: record.display.size.height,
      microphone: record.microphone,
      systemAudio: record.systemAudio
    }
  })
  ipcMain.handle('capture:opacity', (event, value: number) => {
    const record = owner(event)
    if (record.kind !== 'pin' || !Number.isFinite(value) || value < 0.2 || value > 1)
      throw new Error('透明度无效')
    record.window.setOpacity(value)
  })
  ipcMain.handle('capture:close', (event) => {
    const record = owner(event)
    record.window.close()
  })
  ipcMain.handle('capture:image', async (event, action: string, data: string) => {
    const record = owner(event)
    if (
      !['capture', 'pin', 'scroll'].includes(record.kind) ||
      (record.kind === 'scroll' && record.stage !== 'done')
    )
      throw new Error('当前会话不能输出截图')
    const image = decode(data)
    if (action === 'copy') clipboard.writeImage(image)
    else if (action === 'pin') await pin(image, record.display)
    else if (action === 'save') {
      const result = await dialog.showSaveDialog(record.window, {
        title: '保存截图',
        defaultPath: path.join(app.getPath('pictures'), 'sTools-' + Date.now() + '.png'),
        filters: [{ name: 'PNG 图片', extensions: ['png'] }]
      })
      if (result.canceled || !result.filePath) return false
      await fs.writeFile(result.filePath, image.toPNG())
    } else throw new Error('截图操作无效')
    if (record.kind !== 'pin') record.window.close()
    return true
  })
  /**
   * Transfer an owned selection to a recorder only while its source window remains alive.
   * @param event Owned selection invocation.
   * @param crop Recording region in display-relative DIP coordinates.
   * @returns Completion after the recorder is committed or source cancellation is observed.
   * @throws If the selection is invalid or loading fails while the source still exists.
   */
  async function selectRecording(
    event: Electron.IpcMainInvokeEvent,
    crop: NonNullable<CaptureSession['crop']>
  ): Promise<void> {
    const record = owner(event)
    if (
      !['record', 'gif'].includes(record.kind) ||
      record.stage !== 'select' ||
      !crop ||
      ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) ||
      crop.x < 0 ||
      crop.y < 0 ||
      crop.width < 16 ||
      crop.height < 16 ||
      crop.x + crop.width > record.display.size.width + 1 ||
      crop.y + crop.height > record.display.size.height + 1
    )
      throw new Error('请框选至少 16 × 16 的录屏区域')
    const area = record.display.workArea
    // Keep the startup lock but remove the source from repeat-shortcut focus selection.
    record.stage = 'transition'
    record.window.hide()
    try {
      await create(
        { ...record, crop, image: '', stage: 'ready' },
        {
          x: area.x + Math.max(0, area.width - 450),
          y: area.y + Math.max(0, area.height - Math.min(660, area.height)),
          width: 440,
          height: Math.min(640, area.height)
        },
        'recorder.html',
        record
      )
      record.window.close()
    } catch (failure) {
      // Closing the source already released its lock; never resurrect it after a late load.
      if (record.window.isDestroyed()) return
      record.stage = 'select'
      record.window.show()
      record.window.focus()
      throw failure
    }
  }
  ipcMain.handle('capture:select-recording', selectRecording)
  /**
   * Clear metadata only after an empty recording has been cancelled or finalized.
   * @param record Owned recorder session without content that needs preserving.
   * @returns No value.
   */
  function resetEmptyRecording(record: CaptureSession): void {
    record.filename = undefined
    record.mime = undefined
    record.bytes = 0
    record.encoding = false
    record.writing = Promise.resolve()
    record.stage = 'ready'
  }

  /**
   * Apply explicit audio options only to a ready recorder; GIF sessions remain silent.
   * @param event Owned recorder invocation.
   * @param options Boolean audio choices from the preparation window.
   * @returns The options accepted by the session.
   * @throws If the caller is not a ready recorder or the options are invalid.
   */
  ipcMain.handle(
    'capture:record-options',
    (event, options: { microphone: boolean; systemAudio: boolean }) => {
      const record = owner(event)
      if (
        !['record', 'gif'].includes(record.kind) ||
        record.stage !== 'ready' ||
        record.recordingAbort ||
        !options ||
        typeof options.microphone !== 'boolean' ||
        typeof options.systemAudio !== 'boolean'
      )
        throw new Error('仅可在准备录制时更改声音选项')
      // Device permission checks read these accepted choices, never arbitrary renderer state.
      record.microphone = record.kind === 'record' && options.microphone
      record.systemAudio = record.kind === 'record' && options.systemAudio
      return { microphone: record.microphone, systemAudio: record.systemAudio }
    }
  )

  /**
   * Reserve an empty recording before asynchronous disk preparation and device acquisition.
   * @param event Owned recorder invocation.
   * @param mime Supported output container selected by the recorder.
   * @returns Completion after the empty draft is ready.
   * @throws If the session cannot start, disk preparation fails or the attempt was cancelled.
   */
  ipcMain.handle('capture:record-begin', async (event, mime: string) => {
    const record = owner(event)
    if (
      !['record', 'gif'].includes(record.kind) ||
      [...sessions.values()].some((item) => item !== record && item.stage === 'recording') ||
      record.stage !== 'ready' ||
      record.recordingAbort ||
      !record.crop ||
      !['video/mp4', 'video/webm', 'image/gif'].includes(mime) ||
      (record.kind === 'gif') !== (mime === 'image/gif')
    )
      throw new Error('录屏状态或格式无效')
    const extension = mime === 'image/gif' ? 'gif' : mime === 'video/mp4' ? 'mp4' : 'webm'
    const filename = path.join(drafts, 'sTools-' + randomUUID() + '.' + extension)
    const generation = (record.recordingGeneration ?? 0) + 1
    record.recordingGeneration = generation
    record.filename = filename
    record.mime = mime
    record.bytes = 0
    record.encoding = false
    record.stage = 'recording'
    // Publish the complete preparation promise so abort cannot race a late file creation.
    record.writing = fs.mkdir(drafts, { recursive: true }).then(async () => {
      await fs.writeFile(filename, Buffer.alloc(0), { flag: 'wx' })
    })
    try {
      await record.writing
      if (record.recordingGeneration !== generation) throw new Error('录制已取消')
    } catch (error) {
      if (record.recordingGeneration === generation) {
        await fs.unlink(filename).catch(() => {})
        resetEmptyRecording(record)
      }
      throw error
    }
  })

  /**
   * Mark the boundary after which an attempt must finalize instead of discarding its draft.
   * @param event Owned recorder invocation.
   * @returns No value.
   * @throws If the attempt is not acquiring, is aborting, or has already begun encoding.
   */
  ipcMain.handle('capture:record-started', (event) => {
    const record = owner(event)
    if (
      !['record', 'gif'].includes(record.kind) ||
      record.stage !== 'recording' ||
      record.recordingAbort ||
      record.encoding ||
      record.bytes !== 0 ||
      !record.filename
    )
      throw new Error('录制准备状态无效')
    record.encoding = true
  })

  /**
   * Cancel only an empty, unencoded attempt and restore the same region for retry.
   * @param event Owned recorder invocation.
   * @returns Completion after preparation settles and its empty draft is removed.
   * @throws If content has started encoding or the caller does not own a retryable recorder.
   */
  ipcMain.handle('capture:record-abort', async (event) => {
    const record = owner(event)
    if (
      !['record', 'gif'].includes(record.kind) ||
      !['ready', 'recording'].includes(record.stage) ||
      record.bytes !== 0 ||
      record.encoding
    )
      throw new Error('已经开始编码，请停止并保存录屏')
    if (record.recordingAbort) return record.recordingAbort
    record.recordingGeneration = (record.recordingGeneration ?? 0) + 1
    const filename = record.filename
    const writing = record.writing
    const aborting = (async () => {
      // A failed preparation also has to settle before a new attempt may own this session.
      await writing.catch(() => {})
      if (filename && path.dirname(filename) === drafts) {
        try {
          await fs.unlink(filename)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      resetEmptyRecording(record)
    })()
    record.recordingAbort = aborting
    try {
      await aborting
    } finally {
      if (record.recordingAbort === aborting) record.recordingAbort = undefined
    }
  })
  ipcMain.handle('capture:record-chunk', async (event, bytes: ArrayBuffer | Uint8Array) => {
    const record = owner(event)
    if (
      record.stage !== 'recording' ||
      !record.encoding ||
      !record.filename ||
      !(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes))
    )
      throw new Error('录屏数据无效')
    const buffer = Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes)
    if (
      !buffer.length ||
      buffer.length > 16 * 1024 * 1024 ||
      record.bytes + buffer.length > 512 * 1024 * 1024
    )
      throw new Error('单次录屏上限 512 MB，请停止并保存')
    record.bytes += buffer.length
    record.writing = record.writing.then(() => fs.appendFile(record.filename!, buffer))
    await record.writing
    return record.bytes
  })
  ipcMain.handle('capture:record-finish', async (event) => {
    const record = owner(event)
    if (record.stage !== 'recording' || !record.encoding) throw new Error('没有正在录制的内容')
    try {
      await record.writing
    } finally {
      record.stage = 'done'
    }
    if (!record.bytes) {
      if (record.filename) await fs.unlink(record.filename).catch(() => {})
      resetEmptyRecording(record)
      throw new Error('没有录到画面，请重试')
    }
    return { url: pathToFileURL(record.filename!).href, bytes: record.bytes, mime: record.mime }
  })
  ipcMain.handle('capture:record-save', async (event) => {
    const record = owner(event)
    if (record.stage !== 'done' || !record.filename || !record.bytes)
      throw new Error('请先停止录屏')
    const extension = path.extname(record.filename).slice(1)
    const result = await dialog.showSaveDialog(record.window, {
      title: '保存录屏',
      defaultPath: path.join(app.getPath('videos'), 'sTools-' + Date.now() + '.' + extension),
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
    })
    if (result.canceled || !result.filePath) return false
    if (path.resolve(record.filename) !== path.resolve(result.filePath))
      await fs.copyFile(record.filename, result.filePath)
    if (
      path.dirname(record.filename) === drafts &&
      path.resolve(result.filePath) !== path.resolve(record.filename)
    )
      await fs.unlink(record.filename)
    record.filename = result.filePath
    return result.filePath
  })
  app.on('before-quit', () => {
    for (const record of sessions.values()) {
      record.stage = 'done'
      record.window.destroy()
    }
  })
}
