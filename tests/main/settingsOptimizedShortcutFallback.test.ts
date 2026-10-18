import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  electronRegister: vi.fn(),
  isRegistered: vi.fn(),
  dbGet: vi.fn(),
  updateMain: vi.fn(),
  registerApp: vi.fn(),
  electronUnregister: vi.fn(),
  ensureListener: vi.fn(),
  registerShortcut: vi.fn(),
  unregisterShortcut: vi.fn(),
  stopListener: vi.fn(),
  prepareGlobalShortcut: vi.fn(),
  captureCurrentActiveWindow: vi.fn()
}))

vi.mock('electron', () => ({
  app: {},
  globalShortcut: {
    register: mocks.electronRegister,
    isRegistered: mocks.isRegistered,
    unregister: mocks.electronUnregister
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  nativeTheme: {}
}))

vi.mock('../../src/main/core/native/index.js', () => ({
  OptimizedShortcutManager: {
    ensureListener: mocks.ensureListener,
    registerShortcut: mocks.registerShortcut,
    unregisterShortcut: mocks.unregisterShortcut,
    stopListener: mocks.stopListener
  },
  WindowManager: {}
}))

vi.mock('../../src/main/appMain.js', () => ({
  getCurrentShortcut: vi.fn(() => 'Control+Alt+Space'),
  updateShortcut: mocks.updateMain
}))

vi.mock('../../src/main/core/dndManager.js', () => ({
  default: { shouldIgnoreHotkeys: vi.fn(() => false) }
}))

vi.mock('../../src/main/core/doubleTapManager.js', () => ({
  default: {
    acquireKeyboardState: vi.fn(() => vi.fn()),
    register: vi.fn(),
    unregister: vi.fn()
  }
}))

vi.mock('../../src/main/managers/proxyManager.js', () => ({ default: {} }))
vi.mock('../../src/main/managers/windowManager.js', () => ({
  default: {
    captureCurrentActiveWindow: mocks.captureCurrentActiveWindow,
    registerAppShortcut: mocks.registerApp,
    unregisterAppShortcut: vi.fn()
  }
}))
// 快捷键单测不应加载独立窗口管理器及真实用户数据库。
vi.mock('../../src/main/core/detachedWindowManager', () => ({ default: {} }))
vi.mock('../../src/main/core/screenCapture.js', () => ({ primeScreenCaptureFrame: vi.fn() }))
vi.mock('../../src/main/api/shared/database.js', () => ({
  default: { dbGet: mocks.dbGet, dbPut: vi.fn() }
}))
vi.mock('../../src/main/api/index.js', () => ({
  default: { prepareGlobalShortcut: mocks.prepareGlobalShortcut }
}))

const { SettingsAPI } = await import('../../src/main/api/renderer/settings')

describe('SettingsAPI optimized shortcut fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.dbGet.mockReturnValue(undefined)
    mocks.isRegistered.mockReturnValue(false)
    mocks.updateMain.mockReturnValue(true)
    mocks.registerApp.mockReturnValue(true)
    mocks.ensureListener.mockImplementation(() => {
      throw new Error('listener startup timed out')
    })
    mocks.unregisterShortcut.mockReturnValue({ success: true })
    mocks.electronRegister.mockReturnValue(true)
    mocks.prepareGlobalShortcut.mockResolvedValue({
      target: 'demo/action',
      shouldCaptureSelectedText: false
    })
  })

  it('native listener startup failure falls back to Electron globalShortcut', async () => {
    const settings = new SettingsAPI()

    const result = await settings.registerGlobalShortcut('Alt+F', 'demo/action', false, true)

    expect(result).toMatchObject({ success: true, degraded: true })
    expect(mocks.ensureListener).toHaveBeenCalledOnce()
    expect(mocks.unregisterShortcut).toHaveBeenCalledWith('Alt+F')
    expect(mocks.stopListener).toHaveBeenCalledOnce()
    expect(mocks.electronRegister).toHaveBeenCalledWith('Alt+F', expect.any(Function))
  })

  it('captures the active window before handling a global shortcut', async () => {
    const settings = new SettingsAPI()
    const handler = vi.fn()
    settings.setGlobalShortcutHandler(handler)

    await settings.registerGlobalShortcut('Alt+F', 'demo/action', false, false)
    const shortcutHandler = mocks.electronRegister.mock.calls.at(-1)?.[1]

    shortcutHandler()
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith('demo/action', undefined))

    expect(mocks.captureCurrentActiveWindow).toHaveBeenCalledOnce()
    expect(mocks.captureCurrentActiveWindow.mock.invocationCallOrder[0]).toBeLessThan(
      handler.mock.invocationCallOrder[0]
    )
  })

  it('protects the launcher across modifier aliases and does not unregister it', async () => {
    const settings = new SettingsAPI()
    expect(await settings.registerGlobalShortcut('Alt+Ctrl+Space', 'demo/action')).toMatchObject({
      success: false,
      error: expect.stringContaining('唤起')
    })
    expect(settings.registerAppShortcut('Ctrl+Alt+Space', 'demo/action').success).toBe(false)
    settings.unregisterGlobalShortcut('Ctrl+Alt+Space')
    expect(mocks.electronUnregister).not.toHaveBeenCalled()
  })

  it('rejects cross-scope, disabled and built-in collisions for all entry points', async () => {
    mocks.dbGet.mockImplementation((key) =>
      key === 'app-shortcuts'
        ? [{ id: '1', shortcut: 'Ctrl+Alt+F8', target: 'demo/已有功能', enabled: false }]
        : undefined
    )
    const settings = new SettingsAPI()
    expect(await settings.registerGlobalShortcut('Alt+Control+F8', 'demo/new')).toMatchObject({
      success: false,
      error: expect.stringContaining('已有功能')
    })
    expect(settings.updateShortcut('Alt+Control+F8').success).toBe(false)
    expect(settings.registerAppShortcut('Control+F', 'demo/new')).toMatchObject({
      success: false,
      error: expect.stringContaining('搜索筛选')
    })
    expect(mocks.updateMain).not.toHaveBeenCalled()
    mocks.dbGet.mockImplementation((key) =>
      key === 'settings-general' ? { builtinAppShortcutsEnabled: { search: false } } : undefined
    )
    expect(settings.registerAppShortcut('Control+F', 'demo/new').success).toBe(true)
    expect(settings.updateShortcut('Control+F').success).toBe(false)
  })

  it('reserves aliases while asynchronous target preparation is still running', async () => {
    let release!: (value: any) => void
    mocks.prepareGlobalShortcut.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const settings = new SettingsAPI()
    const first = settings.registerGlobalShortcut('Ctrl+Alt+F8', 'demo/first')
    expect(await settings.registerGlobalShortcut('Alt+Control+F8', 'demo/second')).toMatchObject({
      success: false,
      error: expect.stringContaining('正在保存')
    })
    expect(settings.registerAppShortcut('Control+Alt+F8', 'demo/app').success).toBe(false)
    expect(settings.updateShortcut('Alt+Ctrl+F8').success).toBe(false)
    release({ target: 'demo/first', shouldCaptureSelectedText: false })
    expect((await first).success).toBe(true)
    expect(mocks.prepareGlobalShortcut).toHaveBeenCalledTimes(1)
  })

  it('does not silently retarget an owned shortcut, but permits an explicit edit', async () => {
    const settings = new SettingsAPI()
    expect((await settings.registerGlobalShortcut('Alt+F8', 'demo/first')).success).toBe(true)
    expect((await settings.registerGlobalShortcut('Alt+F8', 'demo/second')).success).toBe(false)
    expect(
      (await settings.registerGlobalShortcut('Alt+F8', 'demo/second', false, false, 'demo/first'))
        .success
    ).toBe(true)
    expect(settings.registerAppShortcut('Alt+F8', 'demo/third').success).toBe(false)
  })

  it('keeps the original binding when another application owns the new key', async () => {
    const settings = new SettingsAPI()
    await settings.registerGlobalShortcut('Alt+F8', 'demo/first')
    mocks.electronUnregister.mockClear()
    mocks.electronRegister.mockReturnValue(false)
    expect((await settings.registerGlobalShortcut('Alt+F9', 'demo/first')).success).toBe(false)
    expect(mocks.electronUnregister).not.toHaveBeenCalledWith('Alt+F8')
    expect(settings.updateShortcut('Alt+F8').success).toBe(false)
  })

  it('prevents native optimized hooks from bypassing OS shortcut conflicts', async () => {
    mocks.electronRegister.mockReturnValue(false)
    const settings = new SettingsAPI()
    expect(
      await settings.registerGlobalShortcut('Alt+F8', 'demo/capture', false, true)
    ).toMatchObject({ success: false, error: expect.stringContaining('其它应用占用') })
    expect(mocks.ensureListener).not.toHaveBeenCalled()
    expect(mocks.prepareGlobalShortcut).not.toHaveBeenCalled()
  })

  it('restores the old target if preparation fails during a same-key edit', async () => {
    const settings = new SettingsAPI()
    await settings.registerGlobalShortcut('Alt+F8', 'demo/first')
    mocks.prepareGlobalShortcut.mockRejectedValueOnce(Error('prepare failed'))
    expect(
      (await settings.registerGlobalShortcut('Alt+F8', 'demo/second', false, false, 'demo/first'))
        .success
    ).toBe(false)
    expect((await settings.registerGlobalShortcut('Alt+F8', 'demo/third')).success).toBe(false)
    expect((await settings.registerGlobalShortcut('Alt+F8', 'demo/first')).success).toBe(true)
  })
})
