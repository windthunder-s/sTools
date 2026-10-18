import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
const projectRoot = path.resolve(__dirname, '../..')
let app: ElectronApplication, page: Page, dataRoot: string

/**
 * Execute a controlled script in the actual bundled plugin view.
 * @param script Test expression.
 * @returns Plugin expression result.
 */
async function plugin(script: string): Promise<any> {
  return app.evaluate(async ({ webContents }, script) => {
    const view = webContents
      .getAllWebContents()
      .find((item) => item.getURL().includes('/capture-tools/'))
    return view && !view.isLoading() ? view.executeJavaScript(script, true) : null
  }, script)
}

/**
 * Wait for a real owned capture window to load its local page.
 * @param suffix Renderer filename.
 * @returns Loaded Playwright page.
 */
async function captureWindow(suffix: string): Promise<Page> {
  let found: Page | undefined
  await expect
    .poll(async () => {
      found = (await app.windows()).find((item) => item.url().endsWith(suffix))
      return !!found
    })
    .toBe(true)
  await found!.waitForLoadState('domcontentloaded')
  await expect(found!.locator('body')).toHaveAttribute('data-ready', 'true')
  return found!
}

/**
 * Draw a selection or annotation through actual pointer input.
 * @param target Capture overlay.
 * @param from Start point.
 * @param to End point.
 * @returns Pointer operation completion.
 */
async function drag(target: Page, from: [number, number], to: [number, number]): Promise<void> {
  await target.mouse.move(...from)
  await target.mouse.down()
  await target.mouse.move(...to, { steps: 8 })
  await target.mouse.up()
}

test.beforeEach(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stools-capture-e2e-'))
  await fs.mkdir(path.join(dataRoot, 'legacy'))
  await fs.mkdir(path.join(dataRoot, 'search'))
  await fs.writeFile(
    path.join(dataRoot, 'search/config.json'),
    JSON.stringify({ engine: 'builtin', roots: [], excluded: [] })
  )
  app = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      ZTOOLS_E2E: '1',
      STOOLS_DATA_ROOT: dataRoot,
      STOOLS_LEGACY_USER_DATA_PATH: path.join(dataRoot, 'legacy'),
      ZTOOLS_SETTING_DEV_SERVER_URL: 'http://127.0.0.1:15177'
    }
  })
  page = await app.firstWindow()
  await expect(page.locator('.search-input')).toBeVisible()
  await app.evaluate(async ({ BrowserWindow, screen, session }, dataRoot) => {
    const diagnostics: any[] = []
    ;(globalThis as any).captureDiagnostics = diagnostics
    const original = session.fromPartition.bind(session)
    session.fromPartition = (name, options) => {
      const part = original(name, options)
      const check = part.setPermissionCheckHandler.bind(part)
      part.setPermissionCheckHandler = (handler) =>
        check(
          handler &&
            ((...args) => {
              const result = handler(...args)
              diagnostics.push({
                type: 'check',
                permission: args[1],
                origin: args[2],
                details: args[3],
                allowed: result
              })
              return result
            })
        )
      const request = part.setPermissionRequestHandler.bind(part)
      part.setPermissionRequestHandler = (handler) =>
        request(
          handler &&
            ((contents, permission, cb, details) => {
              handler(
                contents,
                permission,
                (allowed) => {
                  diagnostics.push({
                    type: 'request',
                    permission,
                    details,
                    allowed
                  })
                  cb(allowed)
                },
                details
              )
            })
        )
      return part
    }

    // Cover the selected display with our own generated fixture before any real screen capture.
    const display = screen.getPrimaryDisplay()
    const fixture = new BrowserWindow({
      ...display.bounds,
      frame: false,
      show: true,
      webPreferences: { backgroundThrottling: false }
    })
    await fixture.loadURL(
      'data:text/html,<html style="background:%231b6d9e;color:white;font:40px sans-serif"><body><h1>sTools Capture Fixture</h1><p>Local controlled test</p><canvas id="c" width="800" height="450"></canvas><script>let n=0;setInterval(()=>{const c=document.getElementById("c").getContext("2d");c.fillStyle=n++%2?"%23d4e9d7":"%23e5b85c";c.fillRect(0,0,800,450)},200)</script></body></html>'
    )
    ;(globalThis as any).captureFixture = fixture
    ;(globalThis as any).captureOutput = dataRoot
  }, dataRoot)
  await page.locator('.search-input').fill('截图与录屏')
  await page.locator('.app-item').filter({ hasText: '截图与录屏' }).first().click()
  await expect.poll(() => plugin('document.body.innerText')).toContain('区域截图')
})
test.afterEach(async () => {
  // Closing a utility window must leave the launcher process available for the next shortcut.
  try {
    expect(page.isClosed()).toBe(false)
    expect(await page.evaluate(() => document.querySelector('.search-box') !== null)).toBe(true)
  } finally {
    await app?.close()
  }
  if (
    path.dirname(dataRoot) !== os.tmpdir() ||
    !path.basename(dataRoot).startsWith('stools-capture-e2e-')
  )
    throw Error('Unsafe cleanup')
  await fs.rm(dataRoot, { recursive: true, force: true })
})

/**
 * Open a real owned recorder through the bundled plugin and its real region-selection window.
 * @param kind Recording container workflow to open.
 * @returns Loaded recorder page.
 */
async function openRecorder(kind: 'record' | 'gif' = 'record'): Promise<Page> {
  await plugin(`window.captureTools.start({kind:'${kind}',microphone:false,systemAudio:false})`)
  const editor = await captureWindow('editor.html')
  await drag(editor, [100, 100], [740, 460])
  await editor.getByRole('button', { name: '确认录屏区域', exact: true }).click()
  return captureWindow('recorder.html')
}

/**
 * Replace only the recorder's media request with owned canvas streams for lifecycle assertions.
 * @param recorder Owned preparation window.
 * @param behavior Whether the first request resolves, rejects, or waits until explicitly released.
 * @returns Test media-provider installation completion.
 */
async function installMediaFixture(
  recorder: Page,
  behavior: 'normal' | 'reject' | 'delay'
): Promise<void> {
  await recorder.evaluate((behavior) => {
    const state = {
      calls: 0,
      streams: {} as Record<string, MediaStream>,
      release: undefined as (() => void) | undefined
    }
    ;(window as any).recordAudit = state
    /**
     * Create a local test stream and retain its tracks for cleanup assertions.
     * @param name Test stream identity.
     * @returns Owned canvas stream.
     */
    function stream(name: string): MediaStream {
      const canvas = document.createElement('canvas')
      canvas.width = 1280
      canvas.height = 720
      const context = canvas.getContext('2d')!
      context.fillStyle = '#267d8a'
      context.fillRect(0, 0, canvas.width, canvas.height)
      const result = canvas.captureStream(30)
      state.streams[name] = result
      return result
    }
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: () => {
        state.calls++
        if (state.calls === 1 && behavior === 'reject')
          return Promise.reject(new DOMException('测试拒绝屏幕权限', 'NotAllowedError'))
        if (state.calls === 1 && behavior === 'delay')
          return new Promise<MediaStream>((resolve) => {
            state.release = () => resolve(stream('late'))
          })
        return Promise.resolve(stream('attempt-' + state.calls))
      }
    })
  }, behavior)
}

/**
 * Read track liveness without inspecting the user's devices or actual screen.
 * @param recorder Owned test recorder.
 * @returns Track states grouped by request identity.
 */
async function tracks(recorder: Page): Promise<Record<string, string[]>> {
  return recorder.evaluate(() =>
    Object.fromEntries(
      Object.entries((window as any).recordAudit.streams as Record<string, MediaStream>).map(
        ([name, stream]) => [name, stream.getTracks().map((track) => track.readyState)]
      )
    )
  )
}

test('录屏准备窗重复触发仍只有一个会话，声音选项仅归属会话可更改', async () => {
  const recorder = await openRecorder()
  await plugin("window.captureTools.start({kind:'capture'})")
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows()
        return {
          editors: windows.filter((win) => win.webContents.getURL().endsWith('editor.html')).length,
          recorders: windows.filter((win) => win.webContents.getURL().endsWith('recorder.html'))
            .length,
          focused: windows
            .find((win) => win.webContents.getURL().endsWith('recorder.html'))
            ?.isFocused()
        }
      })
    )
    .toEqual({ editors: 0, recorders: 1, focused: true })
  await recorder.getByLabel('系统声音', { exact: true }).check()
  await recorder.getByLabel('麦克风', { exact: true }).check()
  await expect
    .poll(() =>
      recorder.evaluate(async () => {
        const info = await (window as any).capture.describe()
        return { microphone: info.microphone, systemAudio: info.systemAudio }
      })
    )
    .toEqual({ microphone: true, systemAudio: true })
  const denied = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const sender = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().includes('/renderer/index.html')
    )!.webContents
    const handler = (ipcMain as any)._invokeHandlers.get('capture:record-options')
    try {
      await handler(
        { sender, senderFrame: sender.mainFrame },
        { microphone: true, systemAudio: true }
      )
      return false
    } catch {
      return true
    }
  })
  expect(denied).toBe(true)
})

test('倒计时取消释放轨道和空草稿，并可在相同选区重试', async () => {
  test.setTimeout(45000)
  const recorder = await openRecorder()
  await installMediaFixture(recorder, 'normal')
  for (let attempt = 1; attempt <= 2; attempt++) {
    await recorder.locator('#start').click()
    await expect(recorder.getByRole('status')).toContainText('秒后开始')
    await recorder.locator('#stop').click()
    await expect(recorder.getByRole('status')).toHaveText('准备就绪')
    await expect(recorder.locator('#start')).toBeEnabled()
    await expect(recorder.locator('#error')).toHaveText('')
    await expect
      .poll(async () =>
        Object.values(await tracks(recorder))
          .flat()
          .every((state) => state === 'ended')
      )
      .toBe(true)
  }
  expect(await fs.readdir(path.join(dataRoot, 'captures/drafts'))).toEqual([])
})

test('迟到的屏幕媒体在取消后结束，不会停止重试会话的媒体', async () => {
  test.setTimeout(45000)
  const recorder = await openRecorder()
  await installMediaFixture(recorder, 'delay')
  await recorder.locator('#start').click()
  await expect.poll(() => recorder.evaluate(() => (window as any).recordAudit.calls)).toBe(1)
  await recorder.locator('#stop').click()
  await expect(recorder.getByRole('status')).toHaveText('准备就绪')
  await recorder.locator('#start').click()
  await expect(recorder.getByRole('status')).toContainText('秒后开始')
  await recorder.evaluate(() => (window as any).recordAudit.release())
  await expect.poll(() => tracks(recorder)).toEqual({ 'attempt-2': ['live'], late: ['ended'] })
  await recorder.locator('#stop').click()
  await expect(recorder.getByRole('status')).toHaveText('准备就绪')
  await expect.poll(() => tracks(recorder)).toEqual({ 'attempt-2': ['ended'], late: ['ended'] })
})

test('屏幕权限请求失败后可重试，已开始编码不可清空或改声音', async () => {
  test.setTimeout(45000)
  const recorder = await openRecorder()
  await installMediaFixture(recorder, 'reject')
  await recorder.locator('#start').click()
  await expect(recorder.getByRole('status')).toHaveText('准备就绪')
  await expect(recorder.locator('#error')).toContainText('可以重试')
  await expect(recorder.locator('#start')).toBeEnabled()
  await recorder.locator('#start').click()
  await expect(recorder.getByRole('status')).toContainText('正在录制', {
    timeout: 12000
  })
  const messages = await recorder.evaluate(async () => {
    const api = (window as any).capture
    return Promise.all([
      api.abort().then(
        () => 'accepted',
        (error: Error) => error.message
      ),
      api.options({ microphone: true, systemAudio: true }).then(
        () => 'accepted',
        (error: Error) => error.message
      )
    ])
  })
  expect(messages[0]).toContain('已经开始编码')
  expect(messages[1]).toContain('准备录制')
  await recorder.locator('#stop').click()
  await expect(recorder.getByRole('status')).toHaveText('录制完成', {
    timeout: 12000
  })
  await expect.poll(() => tracks(recorder)).toEqual({ 'attempt-2': ['ended'] })
})

test('GIF 准备界面不开放音频权限，归属接口强制保持无声', async () => {
  const recorder = await openRecorder('gif')
  await expect(recorder.locator('#audio-options')).toBeHidden()
  expect(
    await recorder.evaluate(() =>
      (window as any).capture.options({ microphone: true, systemAudio: true })
    )
  ).toEqual({ microphone: false, systemAudio: false })
})
