import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const projectRoot = path.resolve(__dirname, '../..')
const settingsUrl = 'http://127.0.0.1:15177'

/**
 * 在测试实例的真实设置插件页面执行代码。
 * @param app 隔离 Electron 实例。
 * @param source 页面脚本。
 * @returns 页面脚本结果，未加载时返回空字符串。
 */
async function inSettings(app: ElectronApplication, source: string): Promise<any> {
  return app.evaluate(
    async ({ webContents }, { url, script }) => {
      const view = webContents.getAllWebContents().find((item) => item.getURL().startsWith(url))
      return view && !view.isLoading() ? view.executeJavaScript(script) : ''
    },
    { url: settingsUrl, script: source }
  )
}

let app: ElectronApplication
let dataRoot: string
test.beforeEach(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stools-local-e2e-'))
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
      ZTOOLS_SETTING_DEV_SERVER_URL: settingsUrl
    }
  })
  const page = await app.firstWindow()
  await expect(page.locator('.search-input')).toBeVisible()
  await page.locator('.search-input').fill('快捷键管理')
  await page.locator('.app-item, .list-item').filter({ hasText: '快捷键管理' }).first().click()
  await expect.poll(() => inSettings(app, 'document.body.innerText')).toContain('浏览全部功能')
})
test.afterEach(async () => {
  await app?.close()
  const target = path.resolve(dataRoot)
  // 仅清理本用例创建的目录，不接触真实用户数据。
  if (
    !target.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
    !path.basename(target).startsWith('stools-local-e2e-')
  )
    throw new Error('Unsafe test cleanup')
  await fs.rm(target, { recursive: true, force: true })
})

test('市场入口可见，云账号、同步及社区接口继续隔离', async () => {
  const text = await inSettings(app, 'document.body.innerText')
  expect(text).toContain('插件市场')
  for (const removed of ['注册/登录 ZTools', '数据同步', '消息中心'])
    expect(text).not.toContain(removed)
  const results = await inSettings(
    app,
    'Promise.all([window.ztools.internal.syncGetConfig(),window.ztools.internal.accountGetSession(),window.ztools.internal.aiProviders.getOfficial()])'
  )
  for (const result of results)
    expect(result).toMatchObject({ success: false, code: 'SERVICE_REMOVED' })
  const commands = await inSettings(app, 'window.ztools.internal.getCommands()')
  expect(JSON.stringify(commands)).toContain('插件市场')
})

test('微信和手机号入口明确未接入，支持继续免登录使用', async ({}, testInfo) => {
  await inSettings(app, "location.hash = '#/account'")
  await expect.poll(() => inSettings(app, 'document.body.innerText')).toContain('微信登录暂未接入')
  expect(await inSettings(app, "document.querySelectorAll('input, iframe').length")).toBe(0)
  await inSettings(
    app,
    "Array.from(document.querySelectorAll('[role=tab]')).find(item => item.textContent.includes('手机号')).click()"
  )
  await expect
    .poll(() => inSettings(app, 'document.body.innerText'))
    .toContain('手机号登录暂未接入')
  // 截取插件 WebContentsView 本身，避免宿主与插件拼接。
  const screenshot = await app.evaluate(async ({ webContents }, url) => {
    const view = webContents.getAllWebContents().find((item) => item.getURL().startsWith(url))!
    return (await view.capturePage()).toPNG().toString('base64')
  }, settingsUrl)
  await fs.writeFile(
    testInfo.outputPath('login-placeholder.png'),
    Buffer.from(screenshot, 'base64')
  )
  await inSettings(
    app,
    "Array.from(document.querySelectorAll('button')).find(item => item.textContent.includes('继续免登录使用')).click()"
  )
  await expect.poll(() => inSettings(app, 'location.hash')).toBe('#/shortcuts')
})

test('免登录安装并运行本地插件，搜索默认图标为 S', async ({}, testInfo) => {
  const pluginRoot = path.join(dataRoot, 'local-fixture')
  await fs.mkdir(pluginRoot)
  await fs.writeFile(
    path.join(pluginRoot, 'plugin.json'),
    JSON.stringify({
      name: 'stools-local-fixture',
      version: '1.0.0',
      title: '本地测试工具',
      main: 'index.html',
      logo: 'logo.png',
      features: [{ code: 'open', cmds: ['本地测试工具'] }]
    })
  )
  await fs.writeFile(
    path.join(pluginRoot, 'index.html'),
    '<!doctype html><html><body><h1>本地插件运行成功</h1></body></html>'
  )
  await fs.copyFile(path.join(projectRoot, 'build/icon.png'), path.join(pluginRoot, 'logo.png'))
  const imported = await inSettings(
    app,
    `window.ztools.internal.importDevPlugin(${JSON.stringify(path.join(pluginRoot, 'plugin.json'))})`
  )
  expect(imported.success).toBe(true)
  const installed = await inSettings(
    app,
    "window.ztools.internal.installDevPlugin('stools-local-fixture')"
  )
  expect(installed.success).toBe(true)
  const page = await app.firstWindow()
  await page.locator('.plugin-tag-close').click()
  await expect(page.locator('.search-input')).toBeVisible()
  const avatar = page.locator('.avatar-container img').first()
  await expect(avatar).toBeVisible()
  const imagePath = await avatar.getAttribute('src')
  expect(imagePath).toBeTruthy()
  // 比较实际加载资源与 S 图标，防止只改应用图标而遗漏搜索页默认头像。
  const actualImage = await page.evaluate(
    async (src) => Array.from(new Uint8Array(await (await fetch(src!)).arrayBuffer())),
    imagePath
  )
  expect(Buffer.from(actualImage)).toEqual(
    await fs.readFile(path.join(projectRoot, 'build/icon.png'))
  )
  await page.screenshot({ path: testInfo.outputPath('search-s-logo.png') })
  await page.locator('.search-input').fill('本地测试工具')
  const result = page.locator('.app-item, .list-item').filter({ hasText: '本地测试工具' }).first()
  await expect(result).toBeVisible()
  await result.click()
  await expect
    .poll(() =>
      app.evaluate(async ({ webContents }) => {
        for (const view of webContents.getAllWebContents()) {
          if (
            !view.isLoading() &&
            view.getURL().startsWith('file:') &&
            view.getURL().endsWith('/index.html')
          ) {
            const text = await view.executeJavaScript('document.body.innerText')
            if (text.includes('本地插件运行成功')) return text
          }
        }
        return ''
      })
    )
    .toContain('本地插件运行成功')
})
