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
 * Replace the owned fixture with a deterministic vertically scrollable physical-pixel pattern.
 * @returns Completion after the fixture is painted and the cursor is outside the crop.
 */
async function preparePattern(): Promise<void> {
  await app.evaluate(async () => {
    const fixture = (globalThis as any).captureFixture
    const html = `<!doctype html><html style="margin:0;overflow-x:hidden;scroll-behavior:auto;background:#fff"><body style="margin:0"><canvas id="pattern" style="display:block;width:100vw;height:3200px"></canvas><script>
      const canvas=document.getElementById('pattern'), scale=devicePixelRatio;
      canvas.width=Math.round(innerWidth*scale); canvas.height=Math.round(3200*scale);
      const context=canvas.getContext('2d'), pixels=context.createImageData(canvas.width,canvas.height);
      for(let y=0;y<canvas.height;y++) for(let x=0;x<canvas.width;x++) {
        const p=(y*canvas.width+x)*4;
        pixels.data[p]=(x*17+y*31+(y>>>3)*43)&255;
        pixels.data[p+1]=(x*7+y*23+(y>>>5)*67)&255;
        pixels.data[p+2]=(x*29+y*11+(y>>>4)*101)&255;
        pixels.data[p+3]=255;
      }
      context.putImageData(pixels,0,0);
      document.body.dataset.ready='true';
    </script></body></html>`
    await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    await fixture.webContents.executeJavaScript(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'
    )
    ;(globalThis as any).modeReferenceFrames = []
  })
  await page.mouse.move(20, 20)
}

/**
 * Scroll the self-owned source document and wait until its new viewport has painted.
 * @param top Absolute vertical offset in display-independent pixels.
 * @returns Completion after the scroll position is applied.
 */
async function scrollFixture(top: number): Promise<void> {
  await app.evaluate(async (_electron, value) => {
    await (globalThis as any).captureFixture.webContents.executeJavaScript(
      `scrollTo(0, ${value});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`
    )
  }, top)
}

/**
 * Store an independent actual desktop frame for later native-bitmap comparison.
 * @param crop Display-relative capture rectangle.
 * @returns Physical dimensions of the captured reference frame.
 */
async function referenceFrame(crop: {
  x: number
  y: number
  width: number
  height: number
}): Promise<{ width: number; height: number }> {
  return app.evaluate(async ({ desktopCapturer, screen }, region) => {
    const display = screen.getPrimaryDisplay(),
      factor = display.scaleFactor
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * factor),
        height: Math.round(display.size.height * factor)
      }
    })
    const source = sources.find((item) => item.display_id === String(display.id))!
    const image = source.thumbnail.crop({
      x: Math.floor(region.x * factor),
      y: Math.floor(region.y * factor),
      width: Math.round(region.width * factor),
      height: Math.round(region.height * factor)
    })
    ;(globalThis as any).modeReferenceFrames.push(image.toPNG())
    return image.getSize()
  }, crop)
}

/**
 * Read the native-resolution output height exposed by the scrolling controller.
 * @param controller Actual scrolling capture page.
 * @returns Current output height, or zero before the first stable frame.
 */
async function resultHeight(controller: Page): Promise<number> {
  const text = await controller.locator('#size').textContent()
  return Number(text?.match(/×\s*(\d+)\s*px/)?.[1] || 0)
}

/**
 * Start scrolling capture through the shared screenshot mode selector.
 * @param crop Display-relative capture rectangle.
 * @returns Controller after its first stable frame is available.
 */
async function openScroll(crop: {
  x: number
  y: number
  width: number
  height: number
}): Promise<Page> {
  await plugin("window.captureTools.start({kind:'capture'})")
  const editor = await captureWindow('editor.html')
  await drag(editor, [crop.x, crop.y], [crop.x + crop.width, crop.y + crop.height])
  await editor.getByRole('button', { name: '长截图模式', exact: true }).click()
  await editor.getByRole('button', { name: '开始长截图', exact: true }).click()
  const controller = await captureWindow('scroll.html')
  await expect(controller.locator('#status')).toContainText(/已就绪|画面未变化/, { timeout: 20000 })
  await expect(controller.locator('#finish')).toBeEnabled()
  await expect(controller.locator('#result')).toBeVisible()
  return controller
}

test('截图选区和标注在截图、录屏、长截图、GIF 模式之间保留', async () => {
  test.setTimeout(90000)
  await preparePattern()
  await app.evaluate(({ clipboard }) => {
    clipboard.writeImage = (image) => {
      ;(globalThis as any).modeCopied = image.toPNG()
    }
  })
  await plugin("window.captureTools.start({kind:'capture'})")
  const editor = await captureWindow('editor.html')
  await drag(editor, [120, 120], [760, 520])
  const size = await editor.locator('#size-value').textContent()
  await editor.getByRole('button', { name: '箭头', exact: true }).click()
  await drag(editor, [180, 180], [450, 300])
  const hash = await editor.locator('#screen').evaluate(async (node: HTMLCanvasElement) => {
    const data = new TextEncoder().encode(node.toDataURL())
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')
  })
  for (const [mode, label] of [
    ['record', '录屏模式'],
    ['scroll', '长截图模式'],
    ['gif', 'GIF 模式'],
    ['capture', '截图模式']
  ]) {
    await editor.getByRole('button', { name: label, exact: true }).click()
    await expect(editor.locator('#modebar [data-mode=' + mode + ']')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expect(editor.locator('#size-value')).toHaveText(size!)
    if (mode !== 'capture') await expect(editor.locator('#draw-tools')).toBeHidden()
  }
  await expect(editor.locator('#draw-tools')).toBeVisible()
  const after = await editor.locator('#screen').evaluate(async (node: HTMLCanvasElement) => {
    const data = new TextEncoder().encode(node.toDataURL())
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')
  })
  expect(after).toBe(hash)
  await editor.getByRole('button', { name: '复制截图', exact: true }).click()
  await expect
    .poll(() =>
      app.evaluate(
        ({ nativeImage }) =>
          nativeImage.createFromBuffer((globalThis as any).modeCopied || Buffer.alloc(0)).getSize()
            .width
      )
    )
    .toBeGreaterThan(0)
})

for (const [kind, label] of [
  ['record', '录屏模式'],
  ['gif', 'GIF 模式']
]) {
  test(kind + ' 准备窗口重复调用入口只聚焦原窗口', async () => {
    test.setTimeout(90000)
    await preparePattern()
    await plugin("window.captureTools.start({kind:'capture'})")
    const editor = await captureWindow('editor.html')
    await drag(editor, [120, 120], [760, 520])
    await editor.getByRole('button', { name: label, exact: true }).click()
    await editor.getByRole('button', { name: '确认录屏区域', exact: true }).click()
    const recorder = await captureWindow('recorder.html')
    const originalId = await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find((win) =>
          win.webContents.getURL().endsWith('recorder.html')
        )!.id
    )
    for (let attempt = 0; attempt < 3; attempt++) {
      await plugin(`window.captureTools.start({kind:'${kind}'})`)
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => {
            const windows = BrowserWindow.getAllWindows(),
              recorder = windows.filter((win) => win.webContents.getURL().endsWith('recorder.html'))
            return {
              count: recorder.length,
              id: recorder[0]?.id,
              focused: recorder[0]?.isFocused(),
              editors: windows.filter((win) => win.webContents.getURL().endsWith('editor.html'))
                .length
            }
          })
        )
        .toEqual({ count: 1, id: originalId, focused: true, editors: 0 })
    }
    await expect(recorder.getByRole('button', { name: '开始录制', exact: true })).toBeEnabled()
    await recorder.getByRole('button', { name: '关闭录屏', exact: true }).click()
  })
}

test('手动滚动长截图：真实物理位图无重复、无上滚追加、接缝无丢行', async ({}, info) => {
  test.setTimeout(120000)
  await preparePattern()
  await app.evaluate(({ clipboard }) => {
    clipboard.writeImage = (image) => {
      ;(globalThis as any).modeCopied = image.toPNG()
    }
  })
  const crop = { x: 120, y: 120, width: 640, height: 400 }
  const controller = await openScroll(crop)
  const placement = await app.evaluate(({ BrowserWindow, screen }, region) => {
    const bounds = BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().endsWith('scroll.html'))!
      .getBounds()
    const display = screen.getPrimaryDisplay()
    const selected = {
      ...region,
      x: region.x + display.bounds.x,
      y: region.y + display.bounds.y
    }
    return {
      overlaps:
        bounds.x < selected.x + selected.width &&
        bounds.x + bounds.width > selected.x &&
        bounds.y < selected.y + selected.height &&
        bounds.y + bounds.height > selected.y,
      scale: display.scaleFactor
    }
  }, crop)
  expect(placement.overlaps).toBe(false)
  const frame = await referenceFrame(crop)
  const initialHeight = frame.height
  await expect.poll(() => resultHeight(controller)).toBe(initialHeight)
  await expect(controller.locator('#status')).toContainText('画面未变化', {
    timeout: 15000
  })
  expect(await resultHeight(controller)).toBe(initialHeight)
  // 148 DIP is approximately 150; it gives an integer 185-pixel scroll at this host's 125% DPI.
  const step = 148,
    delta = Math.round(step * placement.scale)
  await scrollFixture(step)
  await expect.poll(() => resultHeight(controller), { timeout: 20000 }).toBe(initialHeight + delta)
  await referenceFrame(crop)
  const firstAppend = await controller.locator('#size').textContent()
  await expect(controller.locator('#status')).toContainText('画面未变化', {
    timeout: 15000
  })
  await expect(controller.locator('#size')).toHaveText(firstAppend!)
  await scrollFixture(0)
  await expect(controller.locator('#status')).toContainText('向上滚动', {
    timeout: 20000
  })
  await expect(controller.locator('#size')).toHaveText(firstAppend!)
  await scrollFixture(step)
  await expect(controller.locator('#status')).toContainText('画面未变化', {
    timeout: 20000
  })
  await expect(controller.locator('#size')).toHaveText(firstAppend!)
  await scrollFixture(step * 2)
  await expect
    .poll(() => resultHeight(controller), { timeout: 20000 })
    .toBe(initialHeight + 2 * delta)
  await referenceFrame(crop)
  await controller.locator('#finish').click()
  await expect(controller.locator('#status')).toContainText('长截图完成')
  await expect(controller.locator('#copy')).toBeVisible()
  await controller.locator('#copy').click()
  const comparison = await app.evaluate(({ nativeImage }, addedRows) => {
    const output = nativeImage.createFromBuffer((globalThis as any).modeCopied)
    const references = (globalThis as any).modeReferenceFrames.map((png: Buffer) =>
      nativeImage.createFromBuffer(png)
    )
    const first = references[0],
      size = first.getSize(),
      checks: boolean[] = []
    checks.push(
      output
        .crop({ x: 0, y: 0, width: size.width, height: size.height })
        .toBitmap()
        .equals(first.toBitmap())
    )
    for (let index = 1; index < references.length; index++) {
      const expected = references[index].crop({
        x: 0,
        y: size.height - addedRows,
        width: size.width,
        height: addedRows
      })
      const actual = output.crop({
        x: 0,
        y: size.height + (index - 1) * addedRows,
        width: size.width,
        height: addedRows
      })
      checks.push(actual.toBitmap().equals(expected.toBitmap()))
    }
    return {
      size: output.getSize(),
      checks,
      png: output.toPNG().toString('base64')
    }
  }, delta)
  expect(comparison.size).toEqual({
    width: frame.width,
    height: initialHeight + 2 * delta
  })
  expect(comparison.checks).toEqual([true, true, true])
  await fs.writeFile(info.outputPath('verified-long.png'), Buffer.from(comparison.png, 'base64'))
})

test('长截图完成后取消保存保留结果，再次保存输出有效 PNG', async () => {
  test.setTimeout(90000)
  await preparePattern()
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({
      canceled: true,
      filePath: undefined
    })
  })
  const crop = { x: 120, y: 120, width: 640, height: 400 }
  const controller = await openScroll(crop)
  const frame = await referenceFrame(crop)
  await controller.locator('#finish').click()
  await expect(controller.locator('#save')).toBeVisible()
  await controller.locator('#save').click()
  await expect(controller.locator('#save')).toBeVisible()
  await expect(controller.locator('#error')).toBeEmpty()
  await expect.poll(() => resultHeight(controller)).toBe(frame.height)
  await app.evaluate(
    ({ dialog }, filename) => {
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: filename
      })
    },
    path.join(dataRoot, 'scroll.png')
  )
  await controller.locator('#save').click()
  await expect
    .poll(() =>
      fs
        .stat(path.join(dataRoot, 'scroll.png'))
        .then((stat) => stat.size)
        .catch(() => 0)
    )
    .toBeGreaterThan(100)
  const valid = await app.evaluate(
    ({ nativeImage }, filename) => {
      const image = nativeImage.createFromPath(filename),
        expected = nativeImage.createFromBuffer((globalThis as any).modeReferenceFrames[0])
      return {
        size: image.getSize(),
        same: image.toBitmap().equals(expected.toBitmap())
      }
    },
    path.join(dataRoot, 'scroll.png')
  )
  expect(valid).toEqual({ size: frame, same: true })
})

test('主窗口和插件视图不能越权改变截图模式或读取长截图帧', async () => {
  const denied = await app.evaluate(async ({ ipcMain, webContents }) => {
    const owners = [
      webContents
        .getAllWebContents()
        .find((view) => view.getURL().includes('/renderer/index.html'))!,
      webContents.getAllWebContents().find((view) => view.getURL().includes('/capture-tools/'))!
    ]
    const results: boolean[] = []
    for (const sender of owners)
      for (const [channel, args] of [
        ['capture:set-mode', ['record']],
        ['capture:scroll-frame', []]
      ] as const) {
        const handler = (ipcMain as any)._invokeHandlers.get(channel)
        if (!handler) {
          results.push(false)
          continue
        }
        try {
          await handler({ sender, senderFrame: sender.mainFrame }, ...args)
          results.push(false)
        } catch {
          results.push(true)
        }
      }
    return results
  })
  expect(denied).toEqual([true, true, true, true])
})

test('长截图完成按钮连按和 Enter 重复事件只结束一次，仍能复制结果', async () => {
  test.setTimeout(90000)
  await preparePattern()
  await app.evaluate(({ ipcMain, clipboard }) => {
    const handlers = (ipcMain as any)._invokeHandlers
    const original = handlers.get('capture:scroll-finish')
    ;(globalThis as any).scrollFinishInvocations = 0
    // Keep the first real completion pending long enough to exercise same-turn repeated input.
    handlers.set('capture:scroll-finish', async (...args: any[]) => {
      ;(globalThis as any).scrollFinishInvocations++
      await new Promise((resolve) => setTimeout(resolve, 75))
      return original(...args)
    })
    clipboard.writeImage = (image) => {
      ;(globalThis as any).modeCopied = image.toPNG()
    }
  })
  const crop = { x: 120, y: 120, width: 640, height: 400 }
  const controller = await openScroll(crop)
  const frame = await referenceFrame(crop)
  await controller.evaluate(async () => {
    const button = document.querySelector<HTMLButtonElement>('#finish')!
    const first = button.onclick!.call(button, new MouseEvent('click'))
    const repeated = button.onclick!.call(button, new MouseEvent('click'))
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        repeat: true,
        bubbles: true,
        cancelable: true
      })
    )
    await Promise.allSettled([first, repeated])
  })
  await expect(controller.locator('#status')).toContainText('长截图完成')
  await expect(controller.locator('#error')).toBeEmpty()
  await expect(controller.locator('#finish')).toBeHidden()
  await expect(controller.locator('#copy')).toBeVisible()
  expect(await app.evaluate(() => (globalThis as any).scrollFinishInvocations)).toBe(1)
  await controller.locator('#copy').click()
  const output = await app.evaluate(({ nativeImage }) => {
    const image = nativeImage.createFromBuffer((globalThis as any).modeCopied)
    const expected = nativeImage.createFromBuffer((globalThis as any).modeReferenceFrames[0])
    return { size: image.getSize(), same: image.toBitmap().equals(expected.toBitmap()) }
  })
  expect(output).toEqual({ size: frame, same: true })
})

test('长截图候选 PNG 超过 64 MiB 时停止采集并保留上一帧可保存结果', async () => {
  test.setTimeout(90000)
  await preparePattern()
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as any)._invokeHandlers
    const original = handlers.get('capture:scroll-frame')
    ;(globalThis as any).scrollFrameInvocations = 0
    // Count actual host captures so the test can verify acquisition stops after reaching the limit.
    handlers.set('capture:scroll-frame', async (...args: any[]) => {
      ;(globalThis as any).scrollFrameInvocations++
      return original(...args)
    })
  })
  const crop = { x: 120, y: 120, width: 640, height: 400 }
  const controller = await openScroll(crop)
  const frame = await referenceFrame(crop)
  const acceptedSize = await controller.locator('#size').textContent()
  await controller.evaluate((initialHeight) => {
    const encode = HTMLCanvasElement.prototype.toDataURL
    ;(globalThis as any).oversizedCandidateEncodes = 0
    // Only an enlarged candidate is oversized; the real accepted image remains exportable.
    /**
     * Inject an encoded-size failure only for a new, larger candidate canvas.
     * @param this Canvas being encoded.
     * @param type Requested output image format.
     * @param quality Requested encoder quality.
     * @returns Oversized candidate URL or the original accepted canvas encoding.
     */
    HTMLCanvasElement.prototype.toDataURL = function (
      this: HTMLCanvasElement,
      type?: string,
      quality?: any
    ): string {
      if (this.height > initialHeight) {
        ;(globalThis as any).oversizedCandidateEncodes++
        return 'data:image/png;base64,' + 'A'.repeat(64 * 1024 * 1024)
      }
      return encode.call(this, type, quality)
    }
  }, frame.height)
  await scrollFixture(148)
  await expect(controller.locator('#status')).toContainText('上限', { timeout: 20000 })
  await expect(controller.locator('#size')).toHaveText(acceptedSize!)
  await expect(controller.locator('#finish')).toBeEnabled()
  expect(await controller.evaluate(() => (globalThis as any).oversizedCandidateEncodes)).toBe(1)
  const stoppedAt = await app.evaluate(() => (globalThis as any).scrollFrameInvocations)
  await scrollFixture(296)
  // Observe three normal 350 ms sampling periods; no background capture may resume at the limit.
  await controller.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1100)))
  expect(await app.evaluate(() => (globalThis as any).scrollFrameInvocations)).toBe(stoppedAt)
  await expect(controller.locator('#size')).toHaveText(acceptedSize!)
  await controller.locator('#finish').click()
  await expect(controller.locator('#save')).toBeVisible()
  const filename = path.join(dataRoot, 'scroll-limit.png')
  await app.evaluate(({ dialog }, outputPath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: outputPath })
  }, filename)
  await controller.locator('#save').click()
  await expect
    .poll(() =>
      fs
        .stat(filename)
        .then((stat) => stat.size)
        .catch(() => 0)
    )
    .toBeGreaterThan(100)
  const saved = await app.evaluate(({ nativeImage }, outputPath) => {
    const image = nativeImage.createFromPath(outputPath)
    const expected = nativeImage.createFromBuffer((globalThis as any).modeReferenceFrames[0])
    return { size: image.getSize(), same: image.toBitmap().equals(expected.toBitmap()) }
  }, filename)
  expect(saved).toEqual({ size: frame, same: true })
})
