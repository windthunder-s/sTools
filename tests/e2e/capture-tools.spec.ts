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
                  diagnostics.push({ type: 'request', permission, details, allowed })
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

test('真实截图选区、箭头撤销重做、PNG 保存、贴图和取消', async ({}, info) => {
  test.setTimeout(60000)
  await app.evaluate(({ dialog, clipboard }) => {
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: (globalThis as any).captureOutput + '/capture.png'
    })
    clipboard.writeImage = (image) => {
      ;(globalThis as any).copiedCapture = {
        size: image.getSize(),
        png: image.toPNG().toString('base64')
      }
    }
  })
  await plugin("window.captureTools.start({kind:'capture'})")
  const editor = await captureWindow('editor.html')
  await expect(editor.locator('#screen')).toBeVisible()
  await drag(editor, [100, 100], [500, 400])
  await expect(editor.locator('#toolbar')).toBeVisible()
  await editor.getByRole('button', { name: '箭头', exact: true }).click()
  await drag(editor, [150, 150], [400, 300])
  const annotated = await editor
    .locator('canvas')
    .evaluate((node: HTMLCanvasElement) => node.toDataURL())
  await editor.getByRole('button', { name: '撤销', exact: true }).click()
  const undone = await editor
    .locator('canvas')
    .evaluate((node: HTMLCanvasElement) => node.toDataURL())
  expect(annotated).not.toBe(undone)
  await editor.getByRole('button', { name: '重做', exact: true }).click()
  expect(
    await editor.locator('canvas').evaluate((node: HTMLCanvasElement) => node.toDataURL())
  ).toBe(annotated)
  await editor.screenshot({ path: info.outputPath('capture-editor.png') })
  await editor.getByRole('button', { name: '保存 PNG', exact: true }).click()
  await expect
    .poll(() =>
      fs
        .stat(path.join(dataRoot, 'capture.png'))
        .then((s) => s.size)
        .catch(() => 0)
    )
    .toBeGreaterThan(100)
  const dimensions = await app.evaluate(
    async ({ nativeImage, screen }, filename) => ({
      size: nativeImage.createFromPath(filename).getSize(),
      scale: screen.getPrimaryDisplay().scaleFactor
    }),
    path.join(dataRoot, 'capture.png')
  )
  expect(dimensions.size).toEqual({
    width: Math.round(400 * dimensions.scale),
    height: Math.round(300 * dimensions.scale)
  })
  await plugin("window.captureTools.start({kind:'capture'})")
  const second = await captureWindow('editor.html')
  await drag(second, [100, 100], [450, 350])
  await second.getByRole('button', { name: '贴图', exact: true }).click()
  const pin = await captureWindow('pin.html')
  await expect(pin.getByAltText('置顶截图')).toBeVisible()
  await pin.getByRole('button', { name: '复制', exact: true }).click()
  expect(await app.evaluate(() => (globalThis as any).copiedCapture.size.width)).toBeGreaterThan(
    300
  )
  await pin.getByLabel('贴图透明度').fill('50')
  await pin.screenshot({ path: info.outputPath('capture-pin.png') })
  await pin.getByRole('button', { name: '关闭贴图', exact: true }).click()
  await plugin("window.captureTools.start({kind:'capture'})")
  const cancelled = await captureWindow('editor.html')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().endsWith('editor.html'))!
      .webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  })
  await expect
    .poll(async () => (await app.windows()).filter((w) => w.url().endsWith('editor.html')).length)
    .toBe(0)
})

for (const kind of ['record', 'gif'] as const) {
  test('真实区域录制、暂停、结束与文件导出：' + kind, async ({}, info) => {
    test.setTimeout(60000)
    await app.evaluate(({ dialog }, kind) => {
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath:
          (globalThis as any).captureOutput + (kind === 'gif' ? '/recording.gif' : '/recording.mp4')
      })
    }, kind)
    await plugin(
      'window.captureTools.start(' +
        JSON.stringify({ kind, microphone: false, systemAudio: false }) +
        ')'
    )
    const editor = await captureWindow('editor.html')
    await drag(editor, [100, 100], [740, 460])
    await editor.getByRole('button', { name: '确认录屏区域', exact: true }).click()
    const recorder = await captureWindow('recorder.html')
    await recorder.getByRole('button', { name: '开始录制', exact: true }).click()
    try {
      await expect(recorder.getByRole('status')).toContainText('正在录制', { timeout: 15000 })
    } catch (error) {
      throw new Error((await recorder.locator('#error').textContent()) + '\n' + String(error))
    }
    await expect(recorder.locator('#timer')).toHaveText('00:01', { timeout: 5000 })
    await recorder.getByRole('button', { name: '暂停', exact: true }).click()
    await expect(recorder.getByRole('status')).toHaveText('已暂停')
    await recorder.getByRole('button', { name: '继续', exact: true }).click()
    await expect(recorder.locator('#timer')).toHaveText('00:02', { timeout: 5000 })
    await recorder.getByRole('button', { name: '停止', exact: true }).click()
    await expect(recorder.getByRole('status')).toHaveText('录制完成', { timeout: 15000 })
    await recorder.screenshot({ path: info.outputPath('recording-' + kind + '.png') })
    await recorder.getByRole('button', { name: '保存文件', exact: true }).click()
    await expect(recorder.getByRole('status')).toHaveText('已保存')
    const filename = path.join(dataRoot, kind === 'gif' ? 'recording.gif' : 'recording.mp4'),
      bytes = await fs.readFile(filename)
    expect(bytes.length).toBeGreaterThan(1000)
    if (kind === 'gif') expect(bytes.subarray(0, 6).toString()).toBe('GIF89a')
    else {
      expect(bytes.subarray(4, 8).toString()).toBe('ftyp')
      const video = recorder.locator('#playback')
      await expect
        .poll(() => video.evaluate((node: HTMLVideoElement) => node.videoWidth))
        .toBeGreaterThan(0)
      expect(
        await video.evaluate((node: HTMLVideoElement) => node.videoWidth / node.videoHeight)
      ).toBeCloseTo(640 / 360, 1)
    }
    await fs.copyFile(filename, info.outputPath(kind === 'gif' ? 'verified.gif' : 'verified.mp4'))
    await recorder.getByRole('button', { name: '关闭录屏', exact: true }).click()
    await expect
      .poll(
        async () => (await app.windows()).filter((w) => w.url().endsWith('recorder.html')).length
      )
      .toBe(0)
  })
}

test('截图入口已注册为可绑定快捷键的独立插件功能，其他窗口不能调用', async () => {
  const result = await page.evaluate(async () =>
    (await window.ztools.getAllPlugins()).find((item: any) => item.name === 'capture-tools')
  )
  expect(result.features.map((feature: any) => feature.code)).toEqual([
    'home',
    'quick',
    'capture',
    'scroll',
    'record',
    'gif',
    'pin'
  ])
  const denied = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const handler = (ipcMain as any)._invokeHandlers.get('capture-tools:start')
    const sender = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().includes('/renderer/index.html')
    )!.webContents
    try {
      await handler({ sender, senderFrame: sender.mainFrame }, { kind: 'capture' })
      return false
    } catch {
      return true
    }
  })
  expect(denied).toBe(true)
  await page.getByTitle('返回搜索').click()
  await page.locator('.search-input').fill('快捷键管理')
  await page.locator('.app-item').filter({ hasText: '快捷键管理' }).first().click()
  /**
   * Execute a settings API call in its own trusted view.
   * @param source Settings expression.
   * @returns Expression result after the settings view loads.
   */
  async function settings(source: string): Promise<any> {
    return app.evaluate(async ({ webContents }, source) => {
      const view = webContents
        .getAllWebContents()
        .find((w) => w.getURL().startsWith('http://127.0.0.1:15177'))
      return view && !view.isLoading() ? view.executeJavaScript(source) : null
    }, source)
  }
  await expect.poll(() => settings('document.body.innerText')).toContain('浏览全部功能')
  const resultBindings = await settings(`Promise.all([
    window.ztools.internal.registerGlobalShortcut('Control+Alt+Shift+F9','capture-tools/sTools 截图',false,false),
    window.ztools.internal.registerGlobalShortcut('Control+Alt+Shift+F10','capture-tools/sTools 录屏',false,false)
  ])`)
  expect(resultBindings.map((r: any) => r.success)).toEqual([true, true])
  expect(
    await app.evaluate(({ globalShortcut }) => [
      globalShortcut.isRegistered('Control+Alt+Shift+F9'),
      globalShortcut.isRegistered('Control+Alt+Shift+F10')
    ])
  ).toEqual([true, true])
})

test('工具栏跟随选区、八点缩放、就地文字输入、保存取消与双击复制', async ({}, info) => {
  test.setTimeout(60000)
  await app.evaluate(({ clipboard, dialog }) => {
    clipboard.writeImage = (image) => {
      ;(globalThis as any).copiedCapture = { size: image.getSize() }
    }
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined })
  })
  await plugin("window.captureTools.start({kind:'capture'})")
  const editor = await captureWindow('editor.html')
  const viewport = await editor.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  const top = viewport.height - 240
  await drag(editor, [120, top], [620, viewport.height - 30])
  await expect(editor.locator('#toolbar')).toHaveAttribute('data-placement', 'above')
  const toolbar = await editor.locator('#toolbar').boundingBox()
  expect(toolbar!.y + toolbar!.height).toBeLessThan(top)
  expect(toolbar!.x).toBeGreaterThanOrEqual(0)
  // Drag the right edge midpoint, not a corner; height must remain unchanged.
  await drag(editor, [620, top + 105], [680, top + 105])
  const size = await editor.locator('#size-value').textContent()
  const scale = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor)
  expect(size).toBe(`${Math.round(560 * scale)} × ${Math.round(210 * scale)}`)
  await editor.getByRole('button', { name: '文字', exact: true }).click()
  const beforeText = await editor
    .locator('canvas')
    .evaluate((node: HTMLCanvasElement) => node.toDataURL())
  await editor.mouse.click(160, top + 40)
  await editor.getByLabel('标注文字').fill('测试文字\n第二行')
  await editor.getByLabel('标注文字').press('Enter')
  await expect(editor.getByLabel('标注文字')).toBeHidden()
  const withText = await editor
    .locator('canvas')
    .evaluate((node: HTMLCanvasElement) => node.toDataURL())
  expect(withText).not.toBe(beforeText)
  await editor.getByRole('button', { name: '撤销', exact: true }).click()
  expect(
    await editor.locator('canvas').evaluate((node: HTMLCanvasElement) => node.toDataURL())
  ).toBe(beforeText)
  await editor.getByRole('button', { name: '重做', exact: true }).click()
  await editor.getByRole('button', { name: '保存 PNG', exact: true }).click()
  await expect(editor.locator('#toolbar')).toBeVisible()
  await expect(editor.locator('#error')).toBeEmpty()
  await editor.screenshot({ path: info.outputPath('snipaste-layout.png') })
  await editor.mouse.click(180, top + 80, { button: 'right' })
  await expect(editor.locator('[data-tool=select]')).toHaveAttribute('aria-pressed', 'true')
  await editor.mouse.dblclick(200, top + 100)
  await expect
    .poll(() => app.evaluate(() => (globalThis as any).copiedCapture?.size))
    .toEqual({ width: Math.round(560 * scale), height: Math.round(210 * scale) })
  await expect
    .poll(async () => (await app.windows()).filter((w) => w.url().endsWith('editor.html')).length)
    .toBe(0)
})

test('实际注册的截图快捷键可连续启动，重复触发不抢焦点也不重复打开', async ({}, info) => {
  test.setTimeout(90000)
  await page.getByTitle('返回搜索').click()
  await page.locator('.search-input').fill('快捷键管理')
  await page.locator('.app-item').filter({ hasText: '快捷键管理' }).first().click()
  // Capture the actual Electron registration callback, exercising the complete launch chain.
  await app.evaluate(({ globalShortcut }) => {
    const original = globalShortcut.register.bind(globalShortcut)
    globalShortcut.register = (key, handler) => {
      if (key === 'Control+Alt+Shift+F8') (globalThis as any).captureHotkey = handler
      return original(key, handler)
    }
  })
  await expect
    .poll(async () =>
      app.evaluate(async ({ webContents }) => {
        const view = webContents
          .getAllWebContents()
          .find((w) => w.getURL().startsWith('http://127.0.0.1:15177'))
        return view && !view.isLoading()
          ? view.executeJavaScript('!!window.ztools?.internal')
          : false
      })
    )
    .toBe(true)
  const result = await app.evaluate(async ({ webContents }) => {
    const view = webContents
      .getAllWebContents()
      .find((w) => w.getURL().startsWith('http://127.0.0.1:15177'))!
    return view.executeJavaScript(
      "window.ztools.internal.registerGlobalShortcut('Control+Alt+Shift+F8','capture-tools/sTools 截图',false,false)"
    )
  })
  expect(result.success).toBe(true)
  for (let attempt = 0; attempt < 4; attempt++) {
    await app.evaluate(() => (globalThis as any).captureHotkey())
    const editor = await captureWindow('editor.html')
    await expect(editor.locator('#hint')).toContainText('拖动选择区域')
    // A repeat while selection is open must not surface the hidden plugin or create another overlay.
    await app.evaluate(() => (globalThis as any).captureHotkey())
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const overlays = BrowserWindow.getAllWindows().filter((w) =>
            w.webContents.getURL().endsWith('editor.html')
          )
          const host = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().includes('/renderer/index.html')
          )!
          return {
            count: overlays.length,
            hostVisible: host.isVisible(),
            focused: overlays[0]?.isFocused()
          }
        })
      )
      .toEqual({ count: 1, hostVisible: false, focused: true })
    await drag(editor, [100, 100], [600, 400])
    if (attempt === 0) await editor.screenshot({ path: info.outputPath('shortcut-capture.png') })
    await editor.getByRole('button', { name: '取消', exact: true }).click()
    await expect
      .poll(async () => (await app.windows()).filter((w) => w.url().endsWith('editor.html')).length)
      .toBe(0)
  }
})

test('参考图工具栏、形状选择、荧光笔与橡皮擦不破坏原图', async ({}, info) => {
  test.setTimeout(60000)
  const scale = await app.evaluate(async ({ screen, clipboard }) => {
    clipboard.writeImage = (image) => {
      ;(globalThis as any).copiedCapture = { size: image.getSize() }
    }
    const factor = screen.getPrimaryDisplay().scaleFactor
    // Match the supplied reference with a neutral fixture and a 237 × 61 physical-pixel crop.
    await (globalThis as any).captureFixture.webContents.executeJavaScript(`
      document.documentElement.style.cssText='background:#b1b1b1';
      document.body.style.cssText='margin:0;background:#b1b1b1';
      document.body.innerHTML='<div style="position:absolute;left:700px;top:180px;width:${237 / factor}px;height:${61 / factor}px;background:#fffef5"></div>';
    `)
    return factor
  })
  await plugin("window.captureTools.start({kind:'capture'})")
  const editor = await captureWindow('editor.html')
  await drag(editor, [700, 180], [700 + 237 / scale, 180 + 61 / scale])
  await expect(editor.locator('#size-value')).toHaveText('237 × 61')
  await expect(editor.locator('.size-unit')).toHaveText('px')
  await expect(editor.locator('#tool-options')).toBeHidden()
  const buttons = await editor.locator('#toolbar button:visible').evaluateAll((nodes) =>
    nodes.map((node) => ({
      label: node.getAttribute('aria-label'),
      top: node.getBoundingClientRect().top
    }))
  )
  expect(buttons.map((item) => item.label)).toEqual([
    '形状',
    '箭头',
    '画笔',
    '荧光笔',
    '马赛克',
    '文字',
    '橡皮擦',
    '撤销',
    '重做',
    '取消',
    '贴图',
    '保存 PNG',
    '复制截图'
  ])
  expect(new Set(buttons.map((item) => item.top)).size).toBe(1)
  await editor.mouse.move(1100, 600)
  const bar = await editor.locator('#toolbar').boundingBox()
  const badge = await editor.locator('#dimensions').boundingBox()
  await editor.screenshot({
    path: info.outputPath('reference-style.png'),
    clip: {
      x: Math.floor(bar!.x - 12),
      y: Math.floor(badge!.y - 12),
      width: Math.ceil(bar!.width + 24),
      height: Math.ceil(bar!.y + bar!.height - badge!.y + 24)
    }
  })
  // Work on a larger neutral region, keeping original pixels separate from annotation pixels.
  await drag(editor, [200, 160], [900, 480])
  const original = await editor
    .locator('#screen')
    .evaluate((node: HTMLCanvasElement) => node.toDataURL())
  await editor.getByRole('button', { name: '形状', exact: true }).click()
  await editor.getByRole('button', { name: '圆形', exact: true }).click()
  await drag(editor, [240, 200], [330, 290])
  expect(
    await editor.locator('#screen').evaluate((node: HTMLCanvasElement) => node.toDataURL())
  ).not.toBe(original)
  await editor.getByRole('button', { name: '撤销', exact: true }).click()
  expect(
    await editor.locator('#screen').evaluate((node: HTMLCanvasElement) => node.toDataURL())
  ).toBe(original)
  await editor.getByRole('button', { name: '荧光笔', exact: true }).click()
  await editor.getByRole('button', { name: '黄色', exact: true }).click()
  await drag(editor, [400, 260], [600, 260])
  const highlighted = await editor
    .locator('#screen')
    .evaluate((node: HTMLCanvasElement) => node.toDataURL())
  expect(highlighted).not.toBe(original)
  await editor.getByRole('button', { name: '橡皮擦', exact: true }).click()
  await expect(editor.locator('#color-options')).toBeHidden()
  await editor.getByLabel('线条粗细').fill('8')
  await drag(editor, [380, 260], [620, 260])
  expect(
    await editor.locator('#screen').evaluate((node: HTMLCanvasElement) => node.toDataURL())
  ).toBe(original)
  await editor.getByRole('button', { name: '撤销', exact: true }).click()
  expect(
    await editor.locator('#screen').evaluate((node: HTMLCanvasElement) => node.toDataURL())
  ).toBe(highlighted)
  await editor.getByRole('button', { name: '重做', exact: true }).click()
  expect(
    await editor.locator('#screen').evaluate((node: HTMLCanvasElement) => node.toDataURL())
  ).toBe(original)
  await editor.getByRole('button', { name: '复制截图', exact: true }).click()
  await expect
    .poll(() => app.evaluate(() => (globalThis as any).copiedCapture?.size))
    .toEqual({ width: Math.round(700 * scale), height: Math.round(320 * scale) })
})
