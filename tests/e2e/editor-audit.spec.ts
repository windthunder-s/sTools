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
import { createHash } from 'node:crypto'

const projectRoot = path.resolve(__dirname, '../..')
let app: ElectronApplication, page: Page, dataRoot: string

/**
 * Execute an expression in the bundled capture plugin's trusted view.
 * @param source Controlled test expression.
 * @returns Evaluated value, or null while the view is loading.
 */
async function plugin(source: string): Promise<any> {
  return app.evaluate(async ({ webContents }, expression) => {
    const view = webContents
      .getAllWebContents()
      .find((item) => item.getURL().includes('/capture-tools/'))
    return view && !view.isLoading() ? view.executeJavaScript(expression, true) : null
  }, source)
}

/**
 * Await a real isolated capture window and its complete input initialization.
 * @param suffix Local renderer filename.
 * @returns Ready Playwright page.
 */
async function captureWindow(suffix: string): Promise<Page> {
  let found: Page | undefined
  await expect
    .poll(async () => {
      found = (await app.windows()).find((item) => item.url().endsWith(suffix))
      return !!found
    })
    .toBe(true)
  await expect(found!.locator('body')).toHaveAttribute('data-ready', 'true')
  return found!
}

/**
 * Exercise a complete pointer path rather than changing editor internals.
 * @param target Actual capture page.
 * @param points Ordered display-relative coordinates.
 * @returns Completion after releasing the pointer.
 */
async function stroke(target: Page, points: [number, number][]): Promise<void> {
  await target.mouse.move(...points[0])
  await target.mouse.down()
  for (const point of points.slice(1)) await target.mouse.move(...point, { steps: 8 })
  await target.mouse.up()
}

/**
 * Activate a named visible tool without accidentally toggling it off.
 * @param target Actual capture page.
 * @param name Accessible toolbar label.
 * @returns Tool activation completion.
 */
async function choose(target: Page, name: string): Promise<void> {
  const button = target.getByRole('button', { name, exact: true })
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click()
}

/**
 * Open a fresh screenshot editor with a large crop and controlled white background.
 * @returns Ready editor with a selection.
 */
async function openEditor(): Promise<Page> {
  await plugin("window.captureTools.start({kind:'capture'})")
  const editor = await captureWindow('editor.html')
  await stroke(editor, [
    [120, 100],
    [900, 540]
  ])
  return editor
}

/**
 * Read rendered canvas content, including decorations, for before/after comparisons.
 * @param target Actual capture page.
 * @returns SHA-256 of the lossless canvas image, keeping assertion failures compact.
 */
async function snapshot(target: Page): Promise<string> {
  const png = await target
    .locator('#screen')
    .evaluate((node: HTMLCanvasElement) => node.toDataURL())
  return createHash('sha256').update(png).digest('hex')
}

/**
 * Sample actual image pixels under a display-relative point, accounting for DPI.
 * @param target Actual capture page.
 * @param point Display-relative sample point.
 * @returns Red, green, blue and alpha bytes.
 */
async function pixel(target: Page, point: [number, number]): Promise<number[]> {
  return target
    .locator('#screen')
    .evaluate(
      (node: HTMLCanvasElement, [x, y]) =>
        Array.from(
          node
            .getContext('2d')!
            .getImageData(
              Math.floor((x * node.width) / innerWidth),
              Math.floor((y * node.height) / innerHeight),
              1,
              1
            ).data
        ),
      point
    )
}

test.beforeEach(async () => {
  test.setTimeout(90000)
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stools-editor-audit-'))
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
  await app.evaluate(async ({ BrowserWindow, screen, clipboard }) => {
    // Cover the whole target display with our own fixture before taking any screen pixels.
    const fixture = new BrowserWindow({
      ...screen.getPrimaryDisplay().bounds,
      frame: false,
      show: true,
      webPreferences: { backgroundThrottling: false }
    })
    await fixture.loadURL(
      'data:text/html,<html style="background:white"><body style="margin:0"><canvas id="pattern" width="160" height="160" style="position:absolute;left:520px;top:200px"></canvas><script>const c=document.getElementById("pattern").getContext("2d");for(let y=0;y<160;y+=4)for(let x=0;x<160;x+=4){c.fillStyle=(x+y)%8?"black":"white";c.fillRect(x,y,4,4)}</script></body></html>'
    )
    ;(globalThis as any).auditFixture = fixture
    clipboard.writeImage = (image) => {
      ;(globalThis as any).auditCopiedImage = { size: image.getSize() }
    }
  })
  await page.locator('.search-input').fill('截图与录屏')
  await page.locator('.app-item').filter({ hasText: '截图与录屏' }).first().click()
  await expect.poll(() => plugin('document.body.innerText')).toContain('区域截图')
})

test.afterEach(async () => {
  await app?.close()
  // Delete only the test-owned directory created under the OS temporary root.
  if (
    path.dirname(dataRoot) !== os.tmpdir() ||
    !path.basename(dataRoot).startsWith('stools-editor-audit-')
  )
    throw Error('Unsafe cleanup')
  await fs.rm(dataRoot, { recursive: true, force: true })
})

test('审查：六色色板与自定义颜色必须真正绘制为选定 RGB', async () => {
  const editor = await openEditor()
  await choose(editor, '画笔')
  await editor.getByLabel('线条粗细').fill('8')
  const colors: [string, number[]][] = [
    ['红色', [255, 71, 61]],
    ['黄色', [255, 191, 0]],
    ['绿色', [23, 185, 120]],
    ['蓝色', [33, 133, 245]],
    ['白色', [255, 255, 255]],
    ['黑色', [34, 34, 34]]
  ]
  for (const [name, expected] of colors) {
    await editor.getByRole('button', { name, exact: true }).click()
    await stroke(editor, [
      [220, 250],
      [450, 250]
    ])
    expect((await pixel(editor, [330, 250])).slice(0, 3), name).toEqual(expected)
    await editor.getByRole('button', { name: '撤销', exact: true }).click()
  }
  await editor.getByLabel('自定义颜色').fill('#7624ab')
  await stroke(editor, [
    [220, 250],
    [450, 250]
  ])
  expect((await pixel(editor, [330, 250])).slice(0, 3)).toEqual([118, 36, 171])
})

test('审查：从 1 px 起的任意整数笔宽实际生效且颜色不变', async () => {
  const editor = await openEditor()
  await choose(editor, '画笔')
  await editor.getByRole('button', { name: '黑色', exact: true }).click()
  const thickness: number[] = []
  for (const width of ['1', '3', '9', '16']) {
    await editor.getByLabel('线条粗细').fill(width)
    await stroke(editor, [
      [220, 250],
      [450, 250]
    ])
    thickness.push(
      await editor.locator('#screen').evaluate((node: HTMLCanvasElement) => {
        const ctx = node.getContext('2d')!,
          factor = node.height / innerHeight
        const x = Math.floor((330 * node.width) / innerWidth),
          start = Math.floor(230 * factor),
          end = Math.ceil(270 * factor)
        let count = 0
        for (let y = start; y < end; y++) if (ctx.getImageData(x, y, 1, 1).data[0] < 100) count++
        return count
      })
    )
    await editor.getByRole('button', { name: '撤销', exact: true }).click()
  }
  expect(thickness[0]).toBeGreaterThan(0)
  expect(thickness[1]).toBeGreaterThan(thickness[0])
  expect(thickness[2]).toBeGreaterThan(thickness[1])
  expect(thickness[3]).toBeGreaterThan(thickness[2])
})

test('审查：滚轮逐像素调笔宽、突破三档并保持 1 px 下限', async () => {
  const editor = await openEditor()
  await choose(editor, '画笔')
  const width = editor.getByLabel('线条粗细')
  await expect(width).toHaveValue('4')

  // Drive real wheel input over the canvas and the numeric control, checking every step.
  await editor.mouse.move(330, 250)
  for (let value = 5; value <= 12; value++) {
    await editor.mouse.wheel(0, -100)
    await expect(width).toHaveValue(String(value))
  }
  await width.hover()
  await width.focus()
  await editor.mouse.wheel(0, 100)
  await expect(width).toHaveValue('11')
  await expect(editor.locator('#stroke-dot')).toHaveAttribute('r', '5.5')
  await expect(editor.locator('.width-feedback')).toHaveCount(0)

  // A lower-bound gesture remains at one pixel; horizontal scrolling does not change it.
  await width.fill('1')
  await editor.mouse.move(330, 250)
  await editor.mouse.wheel(0, 100)
  await expect(width).toHaveValue('1')
  await editor.mouse.wheel(100, 0)
  await expect(width).toHaveValue('1')
  await editor.mouse.wheel(0, -100)
  await expect(width).toHaveValue('2')

  // Numeric edits keep native text selection; Enter validates without copying or closing.
  const cropSize = await editor.locator('#size-value').textContent()
  await width.focus()
  await width.press('Control+a')
  await expect(width).toHaveValue('2')
  await expect(editor.locator('#size-value')).toHaveText(cropSize!)
  await width.fill('0')
  await width.press('Enter')
  await expect(width).toHaveValue('1')
  await width.fill('')
  await width.press('Enter')
  await expect(width).toHaveValue('1')
  await width.fill('6.6')
  await width.press('Enter')
  await expect(width).toHaveValue('7')
  expect(editor.isClosed()).toBe(false)

  // Persist a visible editor viewport only after its final value and annotation are ready.
  await stroke(editor, [
    [220, 250],
    [450, 250]
  ])
  await expect(editor.locator('body')).toHaveAttribute('data-editing-annotation', 'true')
  await editor.screenshot({ path: test.info().outputPath('pixel-stroke-width.png') })
})

test('审查：滚轮修改当前笔迹后像素、预览及撤销重做保持一致', async () => {
  const editor = await openEditor()
  await choose(editor, '画笔')
  const width = editor.getByLabel('线条粗细')
  await width.fill('1')
  await stroke(editor, [
    [220, 250],
    [450, 250]
  ])
  const thin = await snapshot(editor)

  // Increasing the active annotation must repaint the exported canvas, not just the control.
  await editor.mouse.move(330, 250)
  await editor.mouse.wheel(0, -100)
  await expect(width).toHaveValue('2')
  await expect(editor.locator('#stroke-dot')).toHaveAttribute('r', '1')
  const thicker = await snapshot(editor)
  expect(thicker).not.toBe(thin)
  await width.press('Control+z')
  await expect(width).toHaveValue('1')
  await expect(editor.locator('#stroke-dot')).toHaveAttribute('r', '0.5')
  expect(await snapshot(editor)).toBe(thin)
  await width.press('Control+y')
  await expect(width).toHaveValue('2')
  expect(await snapshot(editor)).toBe(thicker)

  // A wheel gesture during a drag cannot silently change the next stroke or its undo state.
  await editor.mouse.move(220, 320)
  await editor.mouse.down()
  await editor.mouse.move(450, 320, { steps: 8 })
  await editor.mouse.wheel(0, -100)
  await editor.mouse.up()
  await expect(width).toHaveValue('2')
})

test('审查：矩形圆形箭头画笔荧光笔马赛克逐个绘制及撤销重做', async () => {
  const editor = await openEditor()
  const original = await snapshot(editor)
  for (const name of ['矩形', '圆形', '箭头', '画笔', '荧光笔', '马赛克']) {
    if (['矩形', '圆形'].includes(name)) await choose(editor, '形状')
    await choose(editor, name)
    await stroke(
      editor,
      name === '马赛克'
        ? [
            [525, 205],
            [670, 350]
          ]
        : [
            [230, 200],
            [430, 340]
          ]
    )
    const drawn = await snapshot(editor)
    expect(drawn, name + ' must change image').not.toBe(original)
    await editor.getByRole('button', { name: '撤销', exact: true }).click()
    expect(await snapshot(editor), name + ' undo').toBe(original)
    await editor.getByRole('button', { name: '重做', exact: true }).click()
    expect(await snapshot(editor), name + ' redo').toBe(drawn)
    await editor.getByRole('button', { name: '撤销', exact: true }).click()
  }
})

for (const name of ['画笔', '荧光笔', '橡皮擦']) {
  test('审查：' + name + '闭合路径回到起点不丢失整笔', async () => {
    const editor = await openEditor()
    if (name === '橡皮擦') {
      await choose(editor, '画笔')
      await stroke(editor, [
        [240, 230],
        [460, 230]
      ])
    }
    const before = await snapshot(editor)
    await choose(editor, name)
    await stroke(editor, [
      [240, 230],
      [460, 230],
      [460, 350],
      [240, 350],
      [240, 230]
    ])
    expect(await snapshot(editor)).not.toBe(before)
    await editor.getByRole('button', { name: '撤销', exact: true }).click()
    expect(await snapshot(editor)).toBe(before)
  })
}

test('审查：中文多行文字、组合输入 Enter、颜色字号与取消', async () => {
  const editor = await openEditor()
  const original = await snapshot(editor)
  await choose(editor, '文字')
  await editor.getByRole('button', { name: '蓝色', exact: true }).click()
  await editor.getByLabel('线条粗细').fill('8')
  await editor.mouse.click(220, 190)
  const input = editor.getByLabel('标注文字')
  await input.fill('中文截图测试\n第二行文字')
  await expect(input).toHaveCSS('color', 'rgb(33, 133, 245)')
  await expect(input).toHaveCSS('font-size', '34px')
  await input.dispatchEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    isComposing: true
  })
  await expect(input).toBeVisible()
  await input.press('Enter')
  await expect(input).toBeHidden()
  const annotated = await snapshot(editor)
  expect(annotated).not.toBe(original)
  await editor.getByRole('button', { name: '撤销', exact: true }).click()
  expect(await snapshot(editor)).toBe(original)
  await editor.getByRole('button', { name: '重做', exact: true }).click()
  expect(await snapshot(editor)).toBe(annotated)
  await editor.mouse.click(230, 330)
  await input.fill('应取消的文字')
  await input.press('Escape')
  await expect(input).toBeHidden()
  expect(await snapshot(editor)).toBe(annotated)
  expect(editor.isClosed()).toBe(false)
})

test('审查：右键退出画笔但保留截图，Enter 复制后关闭', async () => {
  const editor = await openEditor()
  await choose(editor, '画笔')
  await stroke(editor, [
    [220, 230],
    [450, 300]
  ])
  const annotated = await snapshot(editor)
  await editor.mouse.click(300, 400, { button: 'right' })
  await expect(editor.locator('[data-tool=select]')).toHaveAttribute('aria-pressed', 'true')
  expect(await snapshot(editor)).toBe(annotated)
  // The keydown closes the window; delivering keyup through Playwright would race its teardown.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().endsWith('editor.html'))!
      .webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  })
  await expect
    .poll(() => app.evaluate(() => (globalThis as any).auditCopiedImage?.size.width))
    .toBeGreaterThan(0)
  await expect.poll(() => editor.isClosed()).toBe(true)
})

test('审查：录屏倒计时停止后能在同一窗口重新开始', async () => {
  await plugin("window.captureTools.start({kind:'record', microphone:false, systemAudio:false})")
  const editor = await captureWindow('editor.html')
  await stroke(editor, [
    [120, 100],
    [760, 460]
  ])
  await editor.getByRole('button', { name: '确认录屏区域', exact: true }).click()
  const recorder = await captureWindow('recorder.html')
  await recorder.getByRole('button', { name: '开始录制', exact: true }).click()
  await expect(recorder.getByRole('status')).toContainText('秒后开始', {
    timeout: 15000
  })
  await recorder.getByRole('button', { name: '取消', exact: true }).click()
  await expect(recorder.getByRole('button', { name: '开始录制', exact: true })).toBeEnabled()
  await expect(recorder.locator('#error')).toBeEmpty()
})

test('审查：小尺寸贴图的复制保存与关闭按钮均在窗口内可用', async () => {
  const editor = await openEditor()
  // Select a very small source image; pin controls must not inherit an unusably small width.
  await stroke(editor, [
    [20, 20],
    [70, 60]
  ])
  await editor.getByRole('button', { name: '贴图', exact: true }).click()
  const pin = await captureWindow('pin.html')
  const controls = await pin.locator('.pin-tools button').evaluateAll((buttons) =>
    buttons.map((button) => {
      const box = button.getBoundingClientRect()
      return {
        label: button.getAttribute('aria-label') || button.textContent,
        left: box.left,
        right: box.right,
        width: innerWidth
      }
    })
  )
  for (const control of controls) {
    expect(control.left, String(control.label)).toBeGreaterThanOrEqual(0)
    expect(control.right, String(control.label)).toBeLessThanOrEqual(control.width)
  }
})

test('审查：当前笔迹改色改粗细立即生效，面板焦点仍支持撤销重做', async () => {
  const editor = await openEditor()
  await choose(editor, '画笔')
  await editor.getByLabel('线条粗细').fill('2')
  await stroke(editor, [
    [220, 250],
    [450, 250]
  ])
  const red = await snapshot(editor)
  await expect(editor.locator('body')).toHaveAttribute('data-editing-annotation', 'true')
  await editor.getByRole('button', { name: '蓝色', exact: true }).click()
  expect((await pixel(editor, [330, 250])).slice(0, 3)).toEqual([33, 133, 245])
  await expect(editor.getByRole('button', { name: '蓝色', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  const blueThin = await snapshot(editor)
  await editor.getByLabel('线条粗细').fill('8')
  const blueThick = await snapshot(editor)
  expect(blueThick).not.toBe(blueThin)
  expect((await pixel(editor, [330, 253])).slice(0, 3)).toEqual([33, 133, 245])
  await editor.getByLabel('线条粗细').focus()
  await editor.keyboard.press('Control+z')
  expect(await snapshot(editor)).toBe(blueThin)
  await expect(editor.getByLabel('线条粗细')).toHaveValue('2')
  await editor.keyboard.press('Control+z')
  expect(await snapshot(editor)).toBe(red)
  await expect(editor.getByRole('button', { name: '红色', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await editor.keyboard.press('Control+y')
  expect(await snapshot(editor)).toBe(blueThin)
  await editor.keyboard.press('Control+Shift+z')
  expect(await snapshot(editor)).toBe(blueThick)
  await editor.getByLabel('自定义颜色').fill('#7624ab')
  expect((await pixel(editor, [330, 250])).slice(0, 3)).toEqual([118, 36, 171])
  await expect(editor.locator('[data-color][aria-pressed=true]')).toHaveCount(0)
})

test('审查：右键提交后改色只影响新笔迹，撤销恢复前一可编辑对象', async () => {
  const editor = await openEditor()
  await choose(editor, '画笔')
  await stroke(editor, [
    [220, 230],
    [450, 230]
  ])
  await editor.mouse.click(300, 400, { button: 'right' })
  await expect(editor.locator('body')).toHaveAttribute('data-editing-annotation', 'false')
  await choose(editor, '画笔')
  await editor.getByRole('button', { name: '蓝色', exact: true }).click()
  expect((await pixel(editor, [330, 230])).slice(0, 3)).toEqual([255, 71, 61])
  await stroke(editor, [
    [220, 300],
    [450, 300]
  ])
  const twoLines = await snapshot(editor)
  await editor.getByRole('button', { name: '撤销', exact: true }).click()
  expect((await pixel(editor, [330, 300])).slice(0, 3)).toEqual([255, 255, 255])
  await editor.getByRole('button', { name: '重做', exact: true }).click()
  expect(await snapshot(editor)).toBe(twoLines)
  await editor.getByRole('button', { name: '绿色', exact: true }).click()
  expect((await pixel(editor, [330, 300])).slice(0, 3)).toEqual([23, 185, 120])
  expect((await pixel(editor, [330, 230])).slice(0, 3)).toEqual([255, 71, 61])
})

test('审查：画笔荧光笔单击成点，橡皮擦单击可擦除', async () => {
  const editor = await openEditor()
  const original = await snapshot(editor)
  for (const name of ['画笔', '荧光笔']) {
    await choose(editor, name)
    await editor.mouse.click(330, 250)
    expect(await snapshot(editor), name + ' dot').not.toBe(original)
    await editor.getByRole('button', { name: '撤销', exact: true }).click()
    expect(await snapshot(editor)).toBe(original)
  }
  await choose(editor, '画笔')
  await editor.mouse.click(330, 250)
  const dot = await snapshot(editor)
  await choose(editor, '橡皮擦')
  await editor.mouse.click(330, 250)
  expect(await snapshot(editor)).toBe(original)
  await editor.getByRole('button', { name: '撤销', exact: true }).click()
  expect(await snapshot(editor)).toBe(dot)
})

test('审查：完成输入的文字仍可调颜色和字号，Ctrl+Y 恢复编辑状态', async () => {
  const editor = await openEditor()
  await choose(editor, '文字')
  await editor.mouse.click(220, 190)
  await editor.getByLabel('标注文字').fill('文字编辑状态')
  await editor.getByLabel('标注文字').press('Enter')
  const red = await snapshot(editor)
  await editor.getByRole('button', { name: '蓝色', exact: true }).click()
  const blue = await snapshot(editor)
  expect(blue).not.toBe(red)
  await editor.getByLabel('线条粗细').fill('8')
  const largeBlue = await snapshot(editor)
  expect(largeBlue).not.toBe(blue)
  await editor.getByLabel('线条粗细').press('Control+z')
  expect(await snapshot(editor)).toBe(blue)
  await editor.getByLabel('线条粗细').press('Control+y')
  expect(await snapshot(editor)).toBe(largeBlue)
  await expect(editor.locator('body')).toHaveAttribute('data-editing-annotation', 'true')
})
