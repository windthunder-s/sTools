import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const projectRoot = path.resolve(__dirname, '../..')
let app: ElectronApplication
let page: Page
let dataRoot: string
let files: string

/**
 * 从源码启动隔离实例，不依赖或启动外部 Everything。
 * @returns 应用可见后的 Promise。
 */
async function launch(): Promise<void> {
  app = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      STOOLS_DATA_ROOT: path.join(dataRoot, 'user-data'),
      STOOLS_LEGACY_USER_DATA_PATH: path.join(dataRoot, 'legacy'),
      ZTOOLS_E2E: '1',
      ZTOOLS_SETTING_DEV_SERVER_URL: 'http://127.0.0.1:15177'
    }
  })
  page = await app.firstWindow()
  await expect(page.locator('.search-input')).toBeVisible()
  await app.evaluate(({ ipcMain }) => {
    ;(globalThis as any).externalSearchCalls = 0
    ipcMain.removeHandler('everything:search')
    ipcMain.handle('everything:search', () => {
      ;(globalThis as any).externalSearchCalls++
      throw new Error('本测试禁止使用 Everything')
    })
  })
  await expect
    .poll(() =>
      page.evaluate(() => window.ztools.fileSearch.status().then((value) => value.index.phase))
    )
    .toBe('ready')
}
test.beforeEach(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stools-builtin-e2e-'))
  files = path.join(dataRoot, 'files')
  await fs.mkdir(files)
  await fs.mkdir(path.join(dataRoot, 'legacy'))
  await fs.mkdir(path.join(dataRoot, 'user-data/search'), { recursive: true })
  await fs.writeFile(
    path.join(dataRoot, 'user-data/search/config.json'),
    JSON.stringify({ engine: 'builtin', roots: [files], excluded: ['ignored'] })
  )
  await fs.writeFile(path.join(files, '内置验收 文档.txt'), 'fixture')
  await fs.writeFile(path.join(files, '内置验收 程序.exe'), 'not executable')
  await fs.mkdir(path.join(files, '内置验收 文件夹'))
  await fs.mkdir(path.join(files, 'ignored'))
  await fs.writeFile(path.join(files, 'ignored', '内置验收 隐藏.txt'), 'fixture')
  await launch()
})
test.afterEach(async () => {
  await app?.close()
  if (
    !path.resolve(dataRoot).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
    !path.basename(dataRoot).startsWith('stools-builtin-e2e-')
  )
    throw new Error('Unsafe cleanup')
  await fs.rm(dataRoot, { recursive: true, force: true })
})

test('内置真实索引独立搜索，切换分类直接复用结果', async ({}, info) => {
  await page.locator('.search-input').fill('内置验收')
  await expect(page.locator('.indexed-results .list-item')).toHaveCount(3)
  await expect(page.locator('.indexed-heading')).toContainText('sTools 内置搜索')
  await expect(page.locator('.indexed-results')).not.toContainText('隐藏')
  // 首次查询后阻断新查询，分类仍应从同一完整索引响应中立即显示。
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('file-search:search')
    ipcMain.handle('file-search:search', () => ({
      items: [],
      limited: false,
      engine: 'builtin',
      version: 0,
      error: '发生了不必要的重复查询'
    }))
  })
  for (const [tab, name] of [
    ['文件', '文档.txt'],
    ['文件夹', '文件夹'],
    ['应用', '程序.exe'],
    ['全部', '文档.txt']
  ]) {
    await page.getByRole('tab', { name: tab, exact: true }).click()
    await expect(page.locator('.indexed-results')).toContainText(name)
    await expect(page.getByRole('status')).not.toContainText('重复查询')
  }
  expect(await app.evaluate(() => (globalThis as any).externalSearchCalls)).toBe(0)
  await page.screenshot({ path: info.outputPath('builtin-search.png') })
})

test('目录监听实际处理新增、改名、删除并在重启后恢复索引', async () => {
  await page.locator('.search-input').fill('动态验收')
  const original = path.join(files, '动态验收旧.txt'),
    renamed = path.join(files, '动态验收新.txt')
  await fs.writeFile(original, 'fixture')
  await expect(page.locator('.indexed-results')).toContainText('动态验收旧.txt', { timeout: 10000 })
  await fs.rename(original, renamed)
  await expect(page.locator('.indexed-results')).toContainText('动态验收新.txt', { timeout: 10000 })
  await expect(page.locator('.indexed-results')).not.toContainText('动态验收旧.txt')
  await app.close()
  await launch()
  await page.locator('.search-input').fill('动态验收')
  await expect(page.locator('.indexed-results')).toContainText('动态验收新.txt')
  await fs.unlink(renamed)
  await expect(page.locator('.indexed-results')).toHaveCount(0, { timeout: 10000 })
  expect(await app.evaluate(() => (globalThis as any).externalSearchCalls)).toBe(0)
})

test('搜索设置增减范围、排除目录、保存与键盘操作', async ({}, info) => {
  await page.getByRole('button', { name: '搜索设置', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '搜索设置' })
  await expect(panel).toContainText('索引已就绪')
  await expect(panel).toContainText(files)
  await expect(panel.locator('select')).toHaveValue('builtin')
  await panel.locator('textarea').fill('')
  await panel.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(panel).toContainText('已保存')
  await expect(panel).toContainText('索引已就绪')
  await page.screenshot({ path: info.outputPath('builtin-search-settings.png') })
  // Enter 在设置字段内不能启动底层搜索结果；Escape 只关闭设置。
  await panel.locator('textarea').press('Enter')
  await expect(panel).toBeVisible()
  await panel.locator('textarea').press('Escape')
  await expect(panel).toHaveCount(0)
  await page.locator('.search-input').fill('内置验收')
  await expect(page.locator('.indexed-results .list-item')).toHaveCount(4)
  await page.getByRole('button', { name: '搜索设置', exact: true }).click()
  await panel.getByRole('button', { name: '移除 ' + files, exact: true }).click()
  await panel.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(panel).toContainText('已保存')
  await panel.getByRole('button', { name: '关闭搜索设置', exact: true }).click()
  await expect(page.locator('.indexed-results')).toHaveCount(0)
  const config = JSON.parse(
    await fs.readFile(path.join(dataRoot, 'user-data/search/config.json'), 'utf8')
  )
  expect(config.roots).toEqual([])
  expect(config.engine).toBe('builtin')
})

test('外部插件窗口不能查询文件索引或修改搜索范围', async () => {
  const result = await app.evaluate(async ({ BrowserWindow }) => {
    const outsider = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    })
    try {
      await outsider.loadURL('data:text/html,<p>controlled IPC boundary fixture</p>')
      return await outsider.webContents.executeJavaScript(`Promise.all([
        require('electron').ipcRenderer.invoke('file-search:search', '内置验收', 'all'),
        require('electron').ipcRenderer.invoke('file-search:configure', {engine:'builtin',roots:[],excluded:[]}).catch(e=>String(e))
      ])`)
    } finally {
      outsider.destroy()
    }
  })
  expect(result[0].items).toEqual([])
  expect(result[0].error).toContain('仅主搜索窗口')
  expect(result[1]).toContain('仅主搜索窗口')
  const status = await page.evaluate(() => window.ztools.fileSearch.status())
  expect(status.config.roots).toEqual([files])
})

test('分页完整显示超过 100 条结果，分类切换保留已加载页面', async ({}, info) => {
  for (let n = 0; n < 205; n++)
    await fs.writeFile(
      path.join(files, '分页验收 ' + String(n).padStart(3, '0') + '.txt'),
      'fixture'
    )
  await page.evaluate(() => window.ztools.fileSearch.refresh())
  await expect
    .poll(() =>
      page.evaluate(() => window.ztools.fileSearch.status().then((value) => value.index.phase))
    )
    .toBe('ready')
  await page.locator('.search-input').fill('分页验收 ext:txt')
  await page.getByRole('tab', { name: '文件', exact: true }).click()
  await expect(page.locator('.indexed-results .list-item')).toHaveCount(100)
  await expect(page.getByRole('status')).toContainText('100 / 205')
  await page.screenshot({ path: info.outputPath('fast-search-first-page.png') })
  await page.getByRole('button', { name: '加载更多', exact: true }).click()
  await expect(page.locator('.indexed-results .list-item')).toHaveCount(200)
  await page.getByRole('button', { name: '加载更多', exact: true }).click()
  await expect(page.locator('.indexed-results .list-item')).toHaveCount(205)
  await expect(page.getByRole('button', { name: '加载更多', exact: true })).toHaveCount(0)
  const paths = await page.locator('.indexed-results .list-item .app-description').allTextContents()
  if (paths.length) expect(new Set(paths).size).toBe(paths.length)
  await page.getByRole('tab', { name: '应用', exact: true }).click()
  await expect(page.locator('.indexed-results')).toHaveCount(0)
  await page.getByRole('tab', { name: '文件', exact: true }).click()
  await expect(page.locator('.indexed-results .list-item')).toHaveCount(205)
})

test('搜索条件和错误恢复在真实 Electron 中工作，隔离测试禁止安装服务', async () => {
  await page.locator('.search-input').fill('内置验收 ext:txt !隐藏')
  await expect(page.locator('.indexed-results .list-item')).toHaveCount(1)
  await expect(page.locator('.indexed-results')).toContainText('文档.txt')
  await page.locator('.search-input').fill('"未完成短语')
  await expect(page.getByRole('status')).toContainText('双引号')
  await page.locator('.search-input').fill('内置*文档.?xt')
  await expect(page.locator('.indexed-results .list-item')).toHaveCount(1)
  const result = await page.evaluate(async () => {
    const invalid = await window.ztools.fileSearch.search('验收', 'all', { offset: -1 })
    const service = await window.ztools.fileSearch.nativeService('install').then(
      () => '',
      (error) => String(error)
    )
    return { invalid, service }
  })
  expect(result.invalid.error).toContain('无效')
  expect(result.service).toContain('当前环境不可管理')
})
