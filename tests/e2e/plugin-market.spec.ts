import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type TestInfo
} from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createServer, type Server } from 'node:http'
import AdmZip from 'adm-zip'
let server: Server | undefined
const root = path.resolve(__dirname, '../..')
const settingsUrl = 'http://127.0.0.1:15177'
let app: ElectronApplication
let dataRoot: string

/**
 * 在源码启动的设置插件中操作真实界面。
 * @param source 浏览器脚本。
 * @returns 脚本结果。
 */
async function ui(source: string): Promise<any> {
  return app.evaluate(
    async ({ webContents }, { source, url }) => {
      const view = webContents.getAllWebContents().find((w) => w.getURL().startsWith(url))
      return view && !view.isLoading() ? view.executeJavaScript(source) : ''
    },
    { source, url: settingsUrl }
  )
}

/**
 * 直接保存设置插件可见区域截图。
 * @param info 当前用例输出信息。
 * @param name 截图名。
 * @returns 保存完成的 Promise。
 */
async function screenshot(info: TestInfo, name: string): Promise<void> {
  const png = await app.evaluate(
    async ({ webContents }, url) =>
      (
        await webContents
          .getAllWebContents()
          .find((w) => w.getURL().startsWith(url))!
          .capturePage()
      )
        .toPNG()
        .toString('base64'),
    settingsUrl
  )
  await fs.writeFile(info.outputPath(name), Buffer.from(png, 'base64'))
}

test.beforeEach(async ({}, info) => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stools-market-e2e-'))
  const legacy = path.join(dataRoot, 'legacy')
  await fs.mkdir(legacy)
  app = await electron.launch({
    args: [root],
    cwd: root,
    env: {
      ...process.env,
      STOOLS_DATA_ROOT: dataRoot,
      STOOLS_LEGACY_USER_DATA_PATH: legacy,
      ZTOOLS_E2E: '1',
      ZTOOLS_SETTING_DEV_SERVER_URL: settingsUrl
    }
  })
  // 普通用例隔离外网；仅显式开启的真实市场用例连接上游。
  if (!info.title.includes('真实市场目录'))
    await app.evaluate(({ session }) => {
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ['https://z.zosen.link/*'] },
        (_details, callback) => callback({ cancel: true })
      )
    })
  const page = await app.firstWindow()
  await page.locator('.search-input').fill('功能与插件')
  await page.locator('.app-item, .list-item').filter({ hasText: '功能与插件' }).first().click()
  await expect.poll(() => ui('document.body.innerText')).toContain('统一管理内置功能')
  await expect.poll(() => ui('document.querySelectorAll(".plugin-item").length')).toBe(4)
  // 使用产品自己的外观设置获得不透明截图，随后重新加载设置页面。
  await ui(
    'window.ztools.internal.dbGet("settings-general").then(s=>window.ztools.internal.dbPut("settings-general",{...s,windowMaterial:"none",theme:"light"}))'
  )
  await app.evaluate(
    ({ webContents }, url) =>
      webContents
        .getAllWebContents()
        .find((w) => w.getURL().startsWith(url))!
        .reload(),
    settingsUrl
  )
  await expect.poll(() => ui('document.querySelectorAll(".plugin-item").length')).toBe(4)
})
test.afterEach(async () => {
  await app?.close()
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
  }
  const target = path.resolve(dataRoot)
  if (
    !target.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
    !path.basename(target).startsWith('stools-market-e2e-')
  )
    throw new Error('Unsafe cleanup')
  await fs.rm(target, { recursive: true, force: true })
})

test('统一展示内置功能、指令快捷键和来源筛选', async ({}, info) => {
  expect(await ui('document.querySelectorAll(".source-badge.builtin").length')).toBe(4)
  for (const name of ['Everything 搜索', 'Snipaste 截图', 'Snipaste 贴图'])
    expect(
      await ui('document.querySelector("[data-plugin-name=local-tools]").innerText')
    ).toContain(name)
  expect(
    await ui('document.querySelector("[data-plugin-name=capture-tools]").innerText')
  ).toContain('sTools 截图')
  expect(
    await ui('document.querySelector("[data-plugin-name=capture-tools] .source-badge").innerText')
  ).toBe('内置')
  await screenshot(info, 'function-library.png')
  await ui(
    'document.querySelector("[aria-label=筛选插件来源]").value="market";document.querySelector("[aria-label=筛选插件来源]").dispatchEvent(new Event("change"))'
  )
  await expect.poll(() => ui('document.querySelectorAll(".plugin-item").length')).toBe(0)
  await ui(
    'document.querySelector("[aria-label=筛选插件来源]").value="all";document.querySelector("[aria-label=筛选插件来源]").dispatchEvent(new Event("change"))'
  )
  await expect.poll(() => ui('document.querySelectorAll(".plugin-item").length')).toBe(4)
  await ui('document.querySelector("[data-plugin-name=local-tools] [title=指令与快捷键]").click()')
  await expect.poll(() => ui('document.body.innerText')).toContain('随 sTools 更新')
  expect(await ui('document.querySelectorAll("button[title=卸载]").length')).toBe(0)
  expect(await ui('document.body.innerText')).toContain('Snipaste 截图')
})

test('本地工具快捷键按钮预选具体功能，搜索按钮启动内嵌工具', async () => {
  // 标签包含空格，按完整属性值选择。
  await ui(`document.querySelector('[aria-label="设置Snipaste 截图快捷键"]').click()`)
  await expect.poll(() => ui('location.hash')).toContain('/shortcuts')
  await expect.poll(() => ui('document.body.innerText')).toContain('Snipaste 截图')
  await ui('location.hash="#/plugins"')
  await expect
    .poll(() =>
      ui('document.querySelectorAll("[data-plugin-name=local-tools] .feature-action").length')
    )
    .toBe(4)
  await ui(
    'document.querySelector("[data-plugin-name=local-tools] .feature-action button").click()'
  )
  await expect
    .poll(() =>
      app.evaluate(async ({ webContents }) => {
        const view = webContents
          .getAllWebContents()
          .find((w) => w.getURL().includes('/local-tools/'))
        return view && !view.isLoading() ? view.executeJavaScript('document.body.innerText') : ''
      })
    )
    .toContain('输入关键词开始搜索')
})

test('市场断网显示可重试错误，本地功能仍可用', async () => {
  await ui('location.hash="#/market"')
  await expect.poll(() => ui('document.body.innerText')).toContain('ZTools 插件市场')
  await expect
    .poll(() => ui('document.querySelector("[role=alert]")?.innerText || ""'))
    .toContain('重试')
  await ui('location.hash="#/plugins"')
  await expect.poll(() => ui('document.querySelectorAll(".plugin-item").length')).toBe(4)
})

test('受控市场完整下载、安装、启动和卸载插件', async ({}, info) => {
  test.setTimeout(60000)
  // 本用例只执行下方可审查的静态 HTML，覆盖实际网络、解包和注册路径。
  const plugin = {
    name: 'stools-market-fixture',
    title: '市场测试插件',
    version: '1.0.0',
    description: '受控安装验证',
    main: 'index.html',
    features: [{ code: 'open', cmds: ['市场测试插件'] }]
  }
  const zip = new AdmZip()
  zip.addFile('plugin.json', Buffer.from(JSON.stringify(plugin)))
  zip.addFile(
    'index.html',
    Buffer.from('<!doctype html><html><body><h1>市场测试插件运行成功</h1></body></html>')
  )
  const archive = zip.toBuffer()
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost')
    if (url.pathname === '/fixture.zip') {
      res.writeHead(200, { 'Content-Type': 'application/zip' })
      res.end(archive)
      return
    }
    let data: any = {}
    if (url.pathname.endsWith('/download'))
      data = { name: plugin.name, downloadUrl: 'https://stools-market-fixture.invalid/fixture.zip' }
    else if (url.pathname.endsWith('/latest')) data = { available: true, plugin }
    else if (url.pathname.endsWith('/recommendations')) data = { items: [plugin] }
    else if (url.pathname.endsWith('/rankings'))
      data = { type: url.searchParams.get('type'), items: [plugin] }
    else if (url.pathname.endsWith('/readme')) data = { readme: '# 受控市场测试' }
    else data = { categories: [{ id: 1, title: '测试分类', plugins: [plugin] }], latest: [plugin] }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  await app.evaluate(({ session }, port) => {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['https://z.zosen.link/api/market/*', 'https://stools-market-fixture.invalid/*'] },
      (details, callback) => {
        const url = new URL(details.url)
        callback({ redirectURL: 'http://127.0.0.1:' + port + url.pathname + url.search })
      }
    )
  }, address.port)
  await ui('location.hash="#/market"')
  await expect
    .poll(() => ui('document.querySelectorAll(".plugin-card").length'), { timeout: 20000 })
    .toBeGreaterThan(0)
  const page = await app.firstWindow()
  await page.locator('.search-input').fill('市场测试插件')
  await expect
    .poll(() =>
      ui('document.querySelectorAll(".plugin-card[data-plugin-name=stools-market-fixture]").length')
    )
    .toBe(1)
  await ui(
    'document.querySelector(".plugin-card[data-plugin-name=stools-market-fixture] .download-btn").click()'
  )
  await expect
    .poll(
      () =>
        ui(
          'window.ztools.internal.getPlugins().then(items=>items.find(p=>p.name==="stools-market-fixture")?.installSource)'
        ),
      { timeout: 20000 }
    )
    .toBe('ztools-market')
  await ui('location.hash="#/plugins"')
  await expect
    .poll(() =>
      ui(
        'document.querySelector(".plugin-item[data-plugin-name=stools-market-fixture]")?.innerText||""'
      )
    )
    .toContain('ZTools 市场')
  await screenshot(info, 'installed-market-fixture.png')
  await ui(
    'document.querySelector(".plugin-item[data-plugin-name=stools-market-fixture] .open-btn").click()'
  )
  await expect
    .poll(() =>
      app.evaluate(async ({ webContents }) => {
        for (const view of webContents.getAllWebContents()) {
          if (view.getURL().includes('stools-market-fixture') && !view.isLoading())
            return view.executeJavaScript('document.body.innerText')
        }
        return ''
      })
    )
    .toContain('市场测试插件运行成功')
  // 返回设置后卸载本用例安装的插件，确认内置功能仍保持完整。
  await page.locator('.plugin-tag-close').click()
  await page.locator('.search-input').fill('功能与插件')
  await page.locator('.app-item, .list-item').filter({ hasText: '功能与插件' }).first().click()
  await expect.poll(() => ui('document.body.innerText')).toContain('统一管理内置功能')
  expect(
    await ui(
      'window.ztools.internal.getPlugins().then(items=>window.ztools.internal.deletePlugin(items.find(p=>p.name==="stools-market-fixture").path))'
    )
  ).toMatchObject({ success: true })
  await expect.poll(() => ui('window.ztools.internal.getAllPlugins().then(p=>p.length)')).toBe(4)
})

test('真实市场目录可浏览，断网后明确显示缓存', async ({}, info) => {
  test.setTimeout(45000)
  // 只获取公开目录和图片；不安装或执行任何外部插件。
  await ui('location.hash="#/market"')
  await expect
    .poll(() => ui('document.querySelectorAll(".plugin-card").length'), { timeout: 20000 })
    .toBeGreaterThan(0)
  const page = await app.firstWindow()
  await page.locator('.search-input').fill('Base64')
  await expect
    .poll(() => ui('document.querySelectorAll(".plugin-card[data-plugin-name=base64]").length'))
    .toBe(1)
  await expect
    .poll(
      () =>
        ui(
          'Array.from(document.querySelectorAll(".plugin-card img")).every(img => img.complete && img.naturalWidth > 0)'
        ),
      { timeout: 15000 }
    )
    .toBe(true)
  await screenshot(info, 'live-market-search.png')
  await app.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['https://z.zosen.link/api/market/*'] },
      (_details, callback) => callback({ cancel: true })
    )
  })
  await ui('document.querySelector(".market-source button").click()')
  await expect
    .poll(() => ui('document.querySelector("[role=status]")?.innerText||""'))
    .toContain('上次缓存')
  expect(
    await ui('document.querySelectorAll(".plugin-card[data-plugin-name=base64]").length')
  ).toBe(1)
})
