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

/**
 * Start only on the primary display covered by the test-owned fixture.
 * @param kind Capture workflow to enter.
 * @returns Host entry completion.
 */
async function startCapture(kind: 'capture' | 'record' | 'gif' | 'scroll'): Promise<void> {
  const displayId = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().id)
  await plugin('window.captureTools.start(' + JSON.stringify({ kind, displayId }) + ')')
}

/**
 * Hold the next child-window load so cancellation and repeated launch can occur mid-handoff.
 * @param suffix Child renderer to delay.
 * @returns Installation completion; the source selection itself is not intercepted.
 */
async function holdChildLoad(suffix: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, suffix) => {
    const original = BrowserWindow.prototype.loadFile
    const audit = { entered: false, settled: false, child: null as any, resume: null as any }
    ;(globalThis as any).transitionAudit = audit
    BrowserWindow.prototype.loadFile = function (file, ...args) {
      if (audit.entered || !file.replaceAll('\\', '/').endsWith('/' + suffix))
        return original.call(this, file, ...args)
      audit.entered = true
      audit.child = this
      return new Promise<void>((resolve, reject) => {
        audit.resume = async () => {
          try {
            await original.call(this, file, ...args)
            resolve()
          } catch (error) {
            reject(error)
          } finally {
            audit.settled = true
          }
        }
      })
    }
  }, suffix)
}

for (const kind of ['record', 'gif', 'scroll'] as const) {
  test(`${kind} 选区切换期间取消会销毁待加载窗口，重复入口不会恢复旧选区`, async () => {
    test.setTimeout(60000)
    await startCapture(kind)
    const editor = await captureWindow('editor.html')
    await drag(editor, [120, 120], [760, 520])
    const originId = await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find((win) =>
          win.webContents.getURL().endsWith('editor.html')
        )!.id
    )
    await holdChildLoad(kind === 'scroll' ? 'scroll.html' : 'recorder.html')
    await editor
      .getByRole('button', { name: kind === 'scroll' ? '开始长截图' : '确认录屏区域', exact: true })
      .click()
    await expect
      .poll(() => app.evaluate(() => (globalThis as any).transitionAudit.entered))
      .toBe(true)
    // The same host entry used by F1 must not expose a frozen source or an unloaded child.
    await startCapture('capture')
    expect(
      await app.evaluate(({ BrowserWindow }, id) => {
        const source = BrowserWindow.fromId(id)!
        const child = (globalThis as any).transitionAudit.child
        return { sourceVisible: source.isVisible(), childVisible: child.isVisible() }
      }, originId)
    ).toEqual({ sourceVisible: false, childVisible: false })
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.close(), originId)
    await expect
      .poll(() => app.evaluate(() => (globalThis as any).transitionAudit.child.isDestroyed()))
      .toBe(true)
    // Resolve the late load after cancellation; it must neither reopen a window nor hold the lock.
    await app.evaluate(async () => {
      await (globalThis as any).transitionAudit.resume()
    })
    await expect
      .poll(() => app.evaluate(() => (globalThis as any).transitionAudit.settled))
      .toBe(true)
    expect(
      await app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().filter((win) =>
            /\/(editor|recorder|scroll)\.html$/.test(win.webContents.getURL())
          ).length
      )
    ).toBe(0)
    await startCapture('capture')
    const retry = await captureWindow('editor.html')
    await expect(retry.locator('#hint')).toBeVisible()
    await retry.locator('#cancel').evaluate((button: HTMLButtonElement) => button.click())
  })
}

test('录屏子窗口加载失败恢复原选区，可在相同选区重新切换', async () => {
  test.setTimeout(60000)
  await startCapture('record')
  const editor = await captureWindow('editor.html')
  await drag(editor, [120, 120], [760, 520])
  const size = await editor.locator('#size-value').textContent()
  await app.evaluate(({ BrowserWindow }) => {
    const original = BrowserWindow.prototype.loadFile
    let failed = false
    BrowserWindow.prototype.loadFile = function (file, ...args) {
      if (!failed && file.replaceAll('\\', '/').endsWith('/recorder.html')) {
        failed = true
        return Promise.reject(new Error('测试录屏界面加载失败'))
      }
      return original.call(this, file, ...args)
    }
  })
  await editor.getByRole('button', { name: '确认录屏区域', exact: true }).click()
  await expect(editor.locator('#error')).toContainText('测试录屏界面加载失败')
  await expect(editor.locator('#size-value')).toHaveText(size!)
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((win) => win.webContents.getURL().endsWith('editor.html'))!
        .isVisible()
    )
  ).toBe(true)
  await editor.getByRole('button', { name: '确认录屏区域', exact: true }).click()
  const recorder = await captureWindow('recorder.html')
  await expect(recorder.locator('#start')).toBeEnabled()
})

test('长截图完成接口幂等，完成后重复调用仍可复制已验证结果', async () => {
  test.setTimeout(60000)
  await app.evaluate(async ({ clipboard }) => {
    clipboard.writeImage = (image) => {
      ;(globalThis as any).transitionCopied = image.getSize()
    }
    const fixture = (globalThis as any).captureFixture
    await fixture.loadURL(
      'data:text/html,<html style="margin:0;background:%23277d8b;color:white;font:40px sans-serif"><body><h1>sTools transition fixture</h1><p>Owned stable content</p></body></html>'
    )
    await fixture.webContents.executeJavaScript(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'
    )
  })
  await startCapture('scroll')
  const editor = await captureWindow('editor.html')
  await drag(editor, [120, 120], [760, 520])
  await editor.getByRole('button', { name: '开始长截图', exact: true }).click()
  const controller = await captureWindow('scroll.html')
  await expect(controller.locator('#finish')).toBeEnabled({ timeout: 20000 })
  await controller.locator('#finish').click()
  await expect(controller.locator('#status')).toContainText('长截图完成')
  await controller.evaluate(async () => {
    await Promise.all([
      (window as any).capture.scrollFinish(),
      (window as any).capture.scrollFinish()
    ])
  })
  await expect(controller.locator('#error')).toBeEmpty()
  await controller.locator('#copy').click()
  await expect
    .poll(() => app.evaluate(() => (globalThis as any).transitionCopied?.width || 0))
    .toBeGreaterThan(0)
})
