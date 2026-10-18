import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const projectRoot = path.resolve(__dirname, '../..')
let app: ElectronApplication
let dataRoot: string

/**
 * 在指定插件的真实 WebContentsView 中运行检查。
 * @param plugin 插件 URL 片段。
 * @param script 检查脚本。
 * @returns 脚本结果或尚未加载的空字符串。
 */
async function inPlugin(plugin: string, script: string): Promise<any> {
  return app.evaluate(
    async ({ webContents }, { plugin, script }) => {
      const view = webContents.getAllWebContents().find((w) => w.getURL().includes(plugin))
      return view && !view.isLoading() ? view.executeJavaScript(script) : ''
    },
    { plugin, script }
  )
}

test.beforeEach(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stools-tools-e2e-'))
  const legacy = path.join(dataRoot, 'legacy')
  await fs.mkdir(legacy)
  app = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      STOOLS_DATA_ROOT: dataRoot,
      STOOLS_LEGACY_USER_DATA_PATH: legacy,
      ZTOOLS_E2E: '1',
      ZTOOLS_SETTING_DEV_SERVER_URL: 'http://127.0.0.1:15177'
    }
  })
})
test.afterEach(async () => {
  await app?.close()
  if (
    !path.resolve(dataRoot).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
    !path.basename(dataRoot).startsWith('stools-tools-e2e-')
  )
    throw new Error('Unsafe cleanup')
  await fs.rm(dataRoot, { recursive: true, force: true })
})

test('本地工具指令可搜索且可绑定全局快捷键', async () => {
  const page = await app.firstWindow()
  await page.locator('.search-input').fill('快捷键管理')
  await page.locator('.app-item, .list-item').filter({ hasText: '快捷键管理' }).first().click()
  await expect.poll(() => inPlugin('15177', 'document.body.innerText')).toContain('浏览全部功能')
  const commands = await inPlugin('15177', 'window.ztools.internal.getCommands()')
  for (const label of ['Everything 搜索', 'Snipaste 截图', 'Snipaste 贴图', '本地工具设置'])
    expect(JSON.stringify(commands)).toContain(label)
  const bindings = await inPlugin(
    '15177',
    `Promise.all([
    window.ztools.internal.registerGlobalShortcut('Control+Alt+Shift+F7', 'local-tools/Everything 搜索', false, false),
    window.ztools.internal.registerGlobalShortcut('Control+Alt+Shift+F8', 'local-tools/Snipaste 截图', false, false)
  ])`
  )
  expect(bindings.map((item: any) => item.success)).toEqual([true, true])
  expect(
    await app.evaluate(
      ({ globalShortcut }) =>
        globalShortcut.isRegistered('Control+Alt+Shift+F7') &&
        globalShortcut.isRegistered('Control+Alt+Shift+F8')
    )
  ).toBe(true)
})

test('内嵌搜索能显示中文路径、筛选、键盘操作，设置缺失可恢复', async ({}, testInfo) => {
  const page = await app.firstWindow()
  await page.locator('.search-input').fill('Everything 搜索')
  await page.locator('.app-item, .list-item').filter({ hasText: 'Everything 搜索' }).first().click()
  await expect
    .poll(() => inPlugin('/local-tools/', 'document.body.innerText'))
    .toContain('输入关键词开始搜索')
  const plugin = '/local-tools/'
  await inPlugin(
    plugin,
    `window.localTools.search = async (query, filter) => {
    window.lastFilter = filter;
    return [{ name: '中文 文件夹', path: 'E:\\资料\\中文 文件夹', directory: true }, { name: '<b>文件</b>.txt', path: 'E:\\资料\\文件.txt', directory: false }]
  }; window.actions=[]; window.localTools.fileAction=async (...args)=>window.actions.push(args);
  document.querySelector('#query').value='中文'; document.querySelector('#query').dispatchEvent(new Event('input'))`
  )
  await expect.poll(() => inPlugin(plugin, 'document.querySelectorAll(".result").length')).toBe(2)
  expect(await inPlugin(plugin, 'document.querySelectorAll(".result-name b").length')).toBe(0)
  await inPlugin(
    plugin,
    `document.querySelector('#filter').value='folder'; document.querySelector('#filter').dispatchEvent(new Event('change'))`
  )
  await expect.poll(() => inPlugin(plugin, 'window.lastFilter')).toBe('folder')
  await inPlugin(
    plugin,
    `document.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown'})); document.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',ctrlKey:true}))`
  )
  await expect.poll(() => inPlugin(plugin, 'window.actions.length')).toBe(1)
  expect((await inPlugin(plugin, 'window.actions'))[0][0]).toBe('reveal')
  const screenshot = await app.evaluate(async ({ webContents }) =>
    (
      await webContents
        .getAllWebContents()
        .find((w) => w.getURL().includes('/local-tools/'))!
        .capturePage()
    )
      .toPNG()
      .toString('base64')
  )
  await fs.writeFile(
    testInfo.outputPath('everything-search.png'),
    Buffer.from(screenshot, 'base64')
  )
  await inPlugin(
    plugin,
    `document.querySelector('#settings-tab').click(); document.querySelector('[name=snipaste]').value='C:\\missing\\Snipaste.exe'; document.querySelector('#config-form').dispatchEvent(new Event('submit',{cancelable:true}))`
  )
  await expect
    .poll(() => inPlugin(plugin, 'document.querySelector("#message").textContent'))
    .toContain('请选择有效的 Snipaste.exe')
})

test('真实 Everything 索引返回中文文件和文件夹', async ({}, testInfo) => {
  const everything = process.env.STOOLS_EVERYTHING_TEST_EXE
  const es = process.env.STOOLS_ES_TEST_EXE
  test.skip(!everything || !es, '需通过环境变量提供官方 Everything 与 ES 用于隔离集成测试')
  const { spawn, execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const instance = 'stools-test-' + process.pid
  const folder = path.join(dataRoot, '真实中文 资料夹')
  await fs.mkdir(folder)
  const file = path.join(dataRoot, '真实中文 文档.txt')
  await fs.writeFile(file, 'local file search fixture')
  const ini = path.join(dataRoot, 'Everything.ini')
  await fs.writeFile(
    ini,
    '[Everything]\napp_data=0\nrun_as_admin=0\ncheck_for_updates_on_startup=0\nauto_include_fixed_volumes=0\nauto_include_removable_volumes=0\nauto_include_fixed_refs_volumes=0\nauto_include_removable_refs_volumes=0\nfolders=' +
      dataRoot +
      '\n'
  )
  const helper = spawn(
    everything!,
    [
      '-instance',
      instance,
      '-config',
      ini,
      '-db',
      path.join(dataRoot, 'Everything.db'),
      '-startup'
    ],
    { windowsHide: true, stdio: 'ignore', shell: false }
  )
  try {
    const page = await app.firstWindow()
    await page.locator('.search-input').fill('Everything 搜索')
    await page
      .locator('.app-item, .list-item')
      .filter({ hasText: 'Everything 搜索' })
      .first()
      .click()
    await expect
      .poll(() => inPlugin('/local-tools/', 'document.body.innerText'))
      .toContain('输入关键词开始搜索')
    await inPlugin(
      '/local-tools/',
      `window.localTools.configure(${JSON.stringify({ everything, es, instance })})`
    )
    await inPlugin(
      '/local-tools/',
      `document.querySelector('#query').value='真实中文'; document.querySelector('#query').dispatchEvent(new Event('input'))`
    )
    await expect
      .poll(() => inPlugin('/local-tools/', 'document.querySelector("#results").innerText'), {
        timeout: 15000
      })
      .toContain('真实中文 文档.txt')
    expect(
      await inPlugin('/local-tools/', 'document.querySelector("#results").innerText')
    ).toContain('真实中文 资料夹')
    await inPlugin(
      '/local-tools/',
      `document.querySelector('#filter').value='folder'; document.querySelector('#filter').dispatchEvent(new Event('change'))`
    )
    await expect
      .poll(() => inPlugin('/local-tools/', 'document.querySelectorAll(".result").length'))
      .toBe(1)
    expect(
      await inPlugin('/local-tools/', 'document.querySelector(".result-path").textContent')
    ).toBe(folder)
    const screenshot = await app.evaluate(async ({ webContents }) =>
      (
        await webContents
          .getAllWebContents()
          .find((w) => w.getURL().includes('/local-tools/'))!
          .capturePage()
      )
        .toPNG()
        .toString('base64')
    )
    await fs.writeFile(
      testInfo.outputPath('everything-real-search.png'),
      Buffer.from(screenshot, 'base64')
    )
  } finally {
    // 仅结束本用例命名的 Everything；不接触用户的默认实例。
    await exec(everything!, ['-instance', instance, '-exit'], {
      windowsHide: true,
      timeout: 5000
    }).catch(() => helper.kill())
    if (helper.exitCode === null)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000)
        helper.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
  }
})
