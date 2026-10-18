import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  electronRegister: vi.fn(),
  isRegistered: vi.fn(),
  dbGet: vi.fn(),
  dbPut: vi.fn(),
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
  default: { dbGet: mocks.dbGet, dbPut: mocks.dbPut }
}))
vi.mock('../../src/main/api/index.js', () => ({
  default: { prepareGlobalShortcut: mocks.prepareGlobalShortcut }
}))

const { SettingsAPI } = await import('../../src/main/api/renderer/settings')

const stateKey = 'capture-quick-shortcut-initialized'
const records = new Map<string, any>()

/**
 * Exercise the startup-only initializer without starting Electron or registering a real key.
 * @param settings Isolated settings instance with mocked platform services.
 * @returns Initialization completion.
 */
function initialize(settings = new SettingsAPI()): Promise<void> {
  return (
    settings as unknown as { initializeCaptureQuickShortcut(): Promise<void> }
  ).initializeCaptureQuickShortcut()
}

describe('capture quick-entry default F1', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('ZTOOLS_E2E', '')
    records.clear()
    mocks.dbGet.mockImplementation((key) =>
      records.has(key) ? structuredClone(records.get(key)) : null
    )
    mocks.dbPut.mockImplementation((key, value) => {
      records.set(key, structuredClone(value))
      return { ok: true }
    })
    mocks.isRegistered.mockReturnValue(false)
    mocks.electronRegister.mockReturnValue(true)
    mocks.prepareGlobalShortcut.mockResolvedValue({
      target: 'capture-tools/快速截图',
      shouldCaptureSelectedText: false
    })
  })
  afterEach(() => vi.unstubAllEnvs())

  it('uses central registration and the existing global-shortcuts store once', async () => {
    const settings = new SettingsAPI()
    const central = vi.spyOn(settings, 'registerGlobalShortcut')
    await initialize(settings)
    expect(central).toHaveBeenCalledWith('F1', 'capture-tools/快速截图', false, false)
    expect(mocks.electronRegister).toHaveBeenCalledWith('F1', expect.any(Function))
    expect(records.get('global-shortcuts')).toEqual([
      {
        id: 'stools-capture-quick-default',
        shortcut: 'F1',
        target: 'capture-tools/快速截图',
        enabled: true,
        autoCopy: false,
        preScreenshotOptimization: false
      }
    ])
    expect(records.get(stateKey).status).toBe('registered')
    await initialize(settings)
    expect(central).toHaveBeenCalledTimes(1)
  })

  it.each(['global-shortcuts', 'app-shortcuts'])(
    'preserves disabled existing capture bindings in %s',
    async (scope) => {
      const previous = [
        {
          id: 'existing',
          shortcut: 'Ctrl+Alt+A',
          target: '截图与录屏 / sTools 截图',
          enabled: false
        }
      ]
      records.set(scope, previous)
      await initialize()
      expect(mocks.electronRegister).not.toHaveBeenCalled()
      expect(records.get(scope)).toEqual(previous)
      expect(records.get(stateKey).status).toBe('preserved')
    }
  )

  it('never recreates a default key removed by the user on restart', async () => {
    await initialize()
    records.set('global-shortcuts', [])
    mocks.electronRegister.mockClear()
    await initialize(new SettingsAPI())
    expect(mocks.electronRegister).not.toHaveBeenCalled()
    expect(records.get('global-shortcuts')).toEqual([])
  })

  it('keeps another plugin F1 untouched and persists the conflict message', async () => {
    const previous = [{ id: 'other', shortcut: 'F1', target: 'other/已有功能', enabled: false }]
    records.set('global-shortcuts', previous)
    await initialize()
    expect(mocks.electronRegister).not.toHaveBeenCalled()
    expect(mocks.electronUnregister).not.toHaveBeenCalled()
    expect(records.get('global-shortcuts')).toEqual(previous)
    expect(records.get(stateKey)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('已有功能')
    })
  })

  it('reports an OS conflict without saving a fake successful binding or retrying on restart', async () => {
    mocks.electronRegister.mockReturnValue(false)
    await initialize()
    expect(records.has('global-shortcuts')).toBe(false)
    expect(records.get(stateKey)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('占用')
    })
    mocks.electronRegister.mockClear()
    await initialize()
    expect(mocks.electronRegister).not.toHaveBeenCalled()
  })

  it('rolls back registration when shortcut storage fails', async () => {
    mocks.dbPut.mockImplementation((key, value) => {
      if (key === 'global-shortcuts') return { ok: false, error: 'disk failure' }
      records.set(key, structuredClone(value))
      return { ok: true }
    })
    await initialize()
    expect(mocks.electronUnregister).toHaveBeenCalledWith('F1')
    expect(records.has('global-shortcuts')).toBe(false)
    expect(records.get(stateKey)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('未能保存')
    })
  })

  it('does not overwrite edits made while asynchronous command preparation was pending', async () => {
    const changed = [
      { id: 'edited', shortcut: 'Ctrl+Alt+R', target: 'other/action', enabled: true }
    ]
    mocks.prepareGlobalShortcut.mockImplementationOnce(async () => {
      records.set('global-shortcuts', changed)
      return { target: 'capture-tools/快速截图', shouldCaptureSelectedText: false }
    })
    await initialize()
    expect(records.get('global-shortcuts')).toEqual(changed)
    expect(mocks.electronUnregister).toHaveBeenCalledWith('F1')
    expect(records.get(stateKey).status).toBe('failed')
  })

  it('does not claim F1 in an isolated source Electron E2E run', async () => {
    vi.stubEnv('ZTOOLS_E2E', '1')
    await initialize()
    expect(mocks.dbPut).not.toHaveBeenCalled()
    expect(mocks.electronRegister).not.toHaveBeenCalled()
  })
})
