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
 * Execute a DOM interaction in the real bundled capture plugin WebContentsView.
 * @param source Script evaluated in the plugin's own renderer.
 * @returns The renderer's result or null while its page is loading.
 */
async function plugin(source: string): Promise<any> {
  return app.evaluate(async ({ webContents }, script) => {
    const view = webContents
      .getAllWebContents()
      .find((item) => item.getURL().includes('/capture-tools/'))
    return view && !view.isLoading() ? view.executeJavaScript(script, true) : null
  }, source)
}

/**
 * Inspect the actual source settings plugin after the capture page redirects to it.
 * @param source Script evaluated in the settings WebContentsView.
 * @returns The renderer's result or null while it is loading.
 */
async function settings(source: string): Promise<any> {
  return app.evaluate(async ({ webContents }, script) => {
    const view = webContents
      .getAllWebContents()
      .find((item) => item.getURL().startsWith('http://127.0.0.1:15177'))
    return view && !view.isLoading() ? view.executeJavaScript(script, true) : null
  }, source)
}

/**
 * Wait for the real selection window to finish loading its screenshot and mode controls.
 * @returns Ready selection page controlled by this isolated Electron instance.
 */
async function editorWindow(): Promise<Page> {
  let editor: Page | undefined
  await expect
    .poll(async () => {
      editor = (await app.windows()).find((item) => item.url().endsWith('editor.html'))
      return !!editor
    })
    .toBe(true)
  await editor!.waitForLoadState('domcontentloaded')
  await expect(editor!.locator('body')).toHaveAttribute('data-ready', 'true')
  return editor!
}

/**
 * Draw a selection or annotation with real pointer events.
 * @param target Selection window.
 * @param from Pointer start in display-independent pixels.
 * @param to Pointer end in display-independent pixels.
 * @returns Completion of the pointer gesture.
 */
async function drag(target: Page, from: [number, number], to: [number, number]): Promise<void> {
  await target.mouse.move(...from)
  await target.mouse.down()
  await target.mouse.move(...to, { steps: 10 })
  await target.mouse.up()
}

/**
 * Cancel the actual selection with keydown; its destruction leaves no renderer for keyup.
 * @param editor Current selection page.
 * @returns Completion after the host destroys the selection window.
 * @throws If the expected owned selection window is missing or ambiguous.
 */
async function cancelEditor(editor: Page): Promise<void> {
  expect(editor.isClosed()).toBe(false)
  await app.evaluate(({ BrowserWindow }, url) => {
    const matches = BrowserWindow.getAllWindows().filter(
      (window) => window.webContents.getURL() === url
    )
    if (matches.length !== 1) throw new Error('Expected one owned capture selection window')
    matches[0].webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  }, editor.url())
  await expect
    .poll(
      async () => (await app.windows()).filter((item) => item.url().endsWith('editor.html')).length
    )
    .toBe(0)
}

/**
 * Change the preference through the actual select element and its persistence handler.
 * @param mode Capture, recording, GIF or scrolling default.
 * @returns Completion after the plugin confirms the value was persisted.
 */
async function chooseDefault(mode: string): Promise<void> {
  await plugin(
    `document.querySelector('#default-mode').value=${JSON.stringify(mode)};document.querySelector('#default-mode').dispatchEvent(new Event('change',{bubbles:true}))`
  )
  await expect.poll(() => plugin("window.ztools.dbStorage.getItem('default-mode')")).toBe(mode)
  await expect
    .poll(() => plugin("document.querySelector('#status').textContent"))
    .toContain('已保存')
}

/**
 * Capture the plugin's own current visible surface after its body and status have settled.
 * @param output Absolute PNG destination provided by the test runner.
 * @returns Completion after writing the actual WebContentsView pixels.
 */
async function captureHome(output: string): Promise<void> {
  await expect
    .poll(() => plugin("document.querySelector('[data-action=scroll]')?.innerText"))
    .toContain('框选可滚动正文')
  await expect
    .poll(() => plugin("document.querySelector('#shortcut-status')?.textContent"))
    .not.toContain('正在读取')
  await plugin('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const data = await app.evaluate(async ({ webContents }) => {
    const view = webContents
      .getAllWebContents()
      .find((item) => item.getURL().includes('/capture-tools/'))!
    return (await view.capturePage()).toPNG().toString('base64')
  })
  await fs.writeFile(output, Buffer.from(data, 'base64'))
}

test.beforeEach(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stools-capture-quick-e2e-'))
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
  await app.evaluate(async ({ BrowserWindow, screen }) => {
    // The primary display is covered with generated content before any desktop frame is captured.
    const display = screen.getPrimaryDisplay()
    const fixture = new BrowserWindow({
      ...display.bounds,
      frame: false,
      show: true,
      webPreferences: { backgroundThrottling: false }
    })
    const html = `<!doctype html><html lang="zh-CN" style="height:100%;background:#e9f0ee;color:#233c35;font:20px 'Segoe UI',sans-serif"><body style="margin:0;padding:64px;min-height:100vh;box-sizing:border-box;background:linear-gradient(90deg,#dbe9e3 1px,transparent 1px),linear-gradient(#dbe9e3 1px,transparent 1px);background-size:32px 32px"><main style="background:white;border:1px solid #ccdcd5;border-radius:16px;padding:36px;width:840px;max-width:75vw"><p style="color:#078473;margin:0 0 18px">sTools · 自有测试画面</p><h1 style="font-size:38px;margin:0 0 20px">快速截图与标注</h1><p>拖动选区，选择画笔和颜色，再复制或保存。</p><div style="display:flex;gap:16px;margin-top:28px"><div style="padding:24px;background:#e3f2ea;border-radius:10px;flex:1">截图 · 录屏</div><div style="padding:24px;background:#e8effa;border-radius:10px;flex:1">长截图 · GIF</div></div><p style="margin-top:28px;color:#60756d">此画面由测试生成，不包含桌面上的个人内容。</p></main></body></html>`
    await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    await fixture.webContents.executeJavaScript(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'
    )
    ;(globalThis as any).captureQuickFixture = fixture
  })
  await page.locator('.search-input').fill('截图与录屏')
  await page.locator('.app-item').filter({ hasText: '截图与录屏' }).first().click()
  await expect
    .poll(() => plugin("document.querySelector('[data-action=quick]')?.textContent"))
    .toBe('立即开始')
  await expect
    .poll(() => plugin("document.querySelector('#display')?.options.length"))
    .toBeGreaterThan(1)
  const primary = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().id)
  await plugin(`document.querySelector('#display').value=${JSON.stringify(String(primary))}`)
  // Source E2E must not initialize the real global F1 key, even while the installed app is running.
  expect(
    await plugin("window.ztools.internal.dbGet('capture-quick-shortcut-initialized')")
  ).toBeNull()
})

test.afterEach(async () => {
  try {
    await app?.close()
  } finally {
    const resolved = path.resolve(dataRoot)
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith('stools-capture-quick-e2e-')
    )
      throw new Error('Unsafe cleanup')
    await fs.rm(resolved, { recursive: true, force: true })
  }
})

test('快速入口默认截图，实际主页与选区颜色工作流', async ({}, info) => {
  test.setTimeout(60000)
  expect(await plugin("document.querySelector('#default-mode').value")).toBe('capture')
  await captureHome(info.outputPath('capture-home.png'))
  await plugin("document.querySelector('[data-action=quick]').click()")
  const editor = await editorWindow()
  await expect(editor.locator('#modebar [data-mode=capture]')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await drag(editor, [120, 120], [900, 570])
  await expect(editor.locator('#toolbar')).toBeVisible()
  await editor.getByRole('button', { name: '画笔', exact: true }).click()
  await editor.getByRole('button', { name: '蓝色', exact: true }).click()
  await editor.locator('#stroke').fill('8')
  await expect(editor.locator('#color')).toHaveValue('#2185f5')
  await drag(editor, [200, 200], [700, 300])
  // Verify actual rendered pixels rather than only the selected color control.
  const color = await editor.locator('#screen').evaluate((canvas: HTMLCanvasElement) => {
    const ratio = canvas.width / window.innerWidth
    return Array.from(
      canvas.getContext('2d')!.getImageData(Math.round(450 * ratio), Math.round(250 * ratio), 1, 1)
        .data
    ).slice(0, 3)
  })
  expect(color).toEqual([33, 133, 245])
  await editor.mouse.move(1020, 690)
  await editor.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  await editor.screenshot({ path: info.outputPath('capture-workflow.png') })
  await cancelEditor(editor)
})

for (const mode of ['record', 'scroll', 'gif']) {
  test(`默认 ${mode} 后快速入口采用对应模式，直接截图仍是截图`, async () => {
    test.setTimeout(60000)
    await chooseDefault(mode)
    await plugin("document.querySelector('[data-action=quick]').click()")
    const quickEditor = await editorWindow()
    await expect(quickEditor.locator(`#modebar [data-mode=${mode}]`)).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await drag(quickEditor, [120, 120], [760, 520])
    await expect(quickEditor.locator('#confirm')).toHaveAttribute(
      'aria-label',
      mode === 'scroll' ? '开始长截图' : '确认录屏区域'
    )
    await cancelEditor(quickEditor)
    await plugin("document.querySelector('[data-action=capture]').click()")
    const fixedEditor = await editorWindow()
    await expect(fixedEditor.locator('#modebar [data-mode=capture]')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await cancelEditor(fixedEditor)
    expect(await plugin("window.ztools.dbStorage.getItem('default-mode')")).toBe(mode)
  })
}

test('默认模式重载后保留，设置按钮打开统一插件快捷键页', async () => {
  test.setTimeout(60000)
  await chooseDefault('scroll')
  await plugin("location.reload(); 'reload requested'")
  await expect.poll(() => plugin("document.querySelector('#default-mode')?.value")).toBe('scroll')
  expect(await plugin("window.ztools.dbStorage.getItem('default-mode')")).toBe('scroll')
  await plugin("document.querySelector('#shortcuts').click()")
  await expect
    .poll(() => settings("document.querySelector('.plugin-shortcuts h1')?.textContent"))
    .toBe('插件快捷键')
  await expect
    .poll(() =>
      settings(
        'document.querySelector(\'[data-plugin="capture-tools"] [data-feature="quick"]\')?.innerText'
      )
    )
    .toContain('快速截图入口')
  await expect
    .poll(() =>
      settings(
        'document.querySelector(\'[data-plugin="capture-tools"] [data-feature="scroll"]\')?.innerText'
      )
    )
    .toContain('长截图')
  await settings(
    "document.querySelector('[data-feature=\"scroll\"]').scrollIntoView({block:'center'})"
  )
  expect(
    await settings(
      '(()=>{const r=document.querySelector(\'[data-feature="scroll"]\').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()'
    )
  ).toBe(true)
})
