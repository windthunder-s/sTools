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
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
const projectRoot = path.resolve(__dirname, '../..')
let app: ElectronApplication
let page: Page
let dataRoot: string
test.beforeEach(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stools-unified-e2e-'))
  const legacy = path.join(dataRoot, 'legacy')
  await fs.mkdir(legacy)
  await fs.mkdir(path.join(dataRoot, 'search'))
  await fs.writeFile(
    path.join(dataRoot, 'search/config.json'),
    JSON.stringify({ engine: 'everything', roots: [], excluded: [] })
  )
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
  page = await app.firstWindow()
  await expect(page.locator('.search-input')).toBeVisible()
})
test.afterEach(async () => {
  await app?.close()
  if (
    !path.resolve(dataRoot).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
    !path.basename(dataRoot).startsWith('stools-unified-e2e-')
  )
    throw new Error('Unsafe cleanup')
  await fs.rm(dataRoot, { recursive: true, force: true })
})
/**
 * 运行本地工具插件的实际预加载 API。
 * @param script 要执行的测试脚本。
 * @returns 插件结果或尚未加载的空值。
 */
async function localTools(script: string): Promise<any> {
  return app.evaluate(async ({ webContents }, script) => {
    const view = webContents.getAllWebContents().find((w) => w.getURL().includes('/local-tools/'))
    return view && !view.isLoading() ? view.executeJavaScript(script) : null
  }, script)
}
test('主搜索分类、快捷键切换、完整路径和插件系统区分', async ({}, info) => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('file-search:search')
    ipcMain.handle('file-search:search', (_event, query, filter) => {
      const items = [
        { name: query + ' 文档.txt', path: 'D:/资料/' + query + ' 文档.txt', directory: false },
        { name: query + ' 文件夹', path: 'D:/资料/' + query + ' 文件夹', directory: true },
        { name: query + '.exe', path: 'D:/应用/' + query + '.exe', directory: false }
      ]
      return {
        items: items.filter(
          (item) =>
            filter === 'all' ||
            (filter === 'folder'
              ? item.directory
              : filter === 'app'
                ? item.name.endsWith('.exe')
                : !item.directory && !item.name.endsWith('.exe'))
        ),
        limited: false
      }
    })
  })
  await page.locator('.search-input').fill('中文')
  await expect(page.locator('.indexed-results .list-item')).toHaveCount(3)
  await expect(page.locator('.indexed-results')).toContainText('D:/资料/中文 文档.txt')
  await page.locator('.search-input').press('Alt+4')
  await expect(page.locator('[data-category=file]')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.indexed-results .list-item')).toHaveCount(1)
  await expect(page.locator('.indexed-results')).toContainText('中文 文档.txt')
  await page.getByRole('tab', { name: '文件夹', exact: true }).click()
  await expect(page.locator('.indexed-results')).toContainText('中文 文件夹')
  await expect(page.locator('.indexed-results .list-item')).toHaveCount(1)
  await page.getByRole('tab', { name: '应用', exact: true }).click()
  await expect(page.locator('.indexed-results')).toContainText('中文.exe')
  await page.getByRole('tab', { name: '插件', exact: true }).click()
  await page.locator('.search-input').fill('Everything')
  await expect(page.locator('.app-item').filter({ hasText: 'Everything' }).first()).toBeVisible()
  await expect(page.locator('.indexed-results')).toHaveCount(0)
  await page.getByRole('tab', { name: '系统', exact: true }).click()
  await expect(page.locator('.app-item').filter({ hasText: 'Everything' })).toHaveCount(0)
  await page.locator('.search-input').fill('快捷键管理')
  await expect(page.locator('.app-item').filter({ hasText: '快捷键管理' }).first()).toBeVisible()
  await page.locator('.search-input').fill('')
  await expect(page.getByRole('tablist')).toHaveCount(0)
  await page.locator('.search-input').fill('中文')
  await expect(page.locator('.indexed-results .list-item')).toHaveCount(3)
  await page.screenshot({ path: info.outputPath('main-search-categories.png') })
})
test('快速输入不会被迟到查询覆盖，清空输入取消结果', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('file-search:search')
    ;(globalThis as any).queries = []
    ipcMain.handle('file-search:search', async (_event, query) => {
      ;(globalThis as any).queries.push(query)
      await new Promise((resolve) => setTimeout(resolve, query === 'older' ? 900 : 20))
      return {
        items: [{ name: query + '.txt', path: 'D:/' + query + '.txt', directory: false }],
        limited: false
      }
    })
  })
  await page.locator('.search-input').fill('older')
  await expect.poll(() => app.evaluate(() => (globalThis as any).queries)).toContain('older')
  await page.locator('.search-input').fill('newer')
  await expect(page.locator('.indexed-results')).toContainText('newer.txt')
  await page.waitForTimeout(1000)
  await expect(page.locator('.indexed-results')).not.toContainText('older.txt')
  await page.locator('.search-input').fill('')
  await expect(page.locator('.indexed-results')).toHaveCount(0)
})
test('Everything 故障有重试和可用设置入口，应用插件仍可搜索', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('file-search:search')
    ipcMain.handle('file-search:search', () => ({
      items: [],
      limited: false,
      error: 'Everything 测试索引未就绪'
    }))
  })
  await page.locator('.search-input').fill('快捷键管理')
  await expect(page.getByRole('status')).toContainText('索引未就绪')
  await expect(page.locator('.app-item').filter({ hasText: '快捷键管理' }).first()).toBeVisible()
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('索引未就绪')
  await page.getByRole('button', { name: '工具设置', exact: true }).click()
  await expect.poll(() => localTools('document.body.innerText')).toContain('Everything.exe')
})
test('真实 Everything SDK 原生语法、分类缓存、分页、设置和打开操作', async ({}, info) => {
  test.setTimeout(90000)
  const everything = process.env.STOOLS_EVERYTHING_TEST_EXE,
    es = process.env.STOOLS_ES_TEST_EXE
  test.skip(!everything || !es, '需要官方 Everything 与 ES 的隔离索引测试路径')
  const instance = 'stools-unified-' + process.pid
  let fixture = path.join(dataRoot, '索引数据')
  await fs.mkdir(fixture)
  fixture = await fs.realpath(fixture)
  for (let i = 0; i < 235; i++) await fs.writeFile(path.join(fixture, '分页验收-' + String(i).padStart(3, '0') + '.txt'), 'x'.repeat(i + 1))
  const filename = path.join(fixture, '搜索验收 文档.txt'),
    directory = path.join(fixture, '搜索验收 文件夹')
  await fs.writeFile(filename, 'controlled test fixture')
  await fs.mkdir(directory)
  await fs.writeFile(path.join(fixture, '搜索验收 程序.exe'), 'not executable; index fixture only')
  const ini = path.join(dataRoot, 'Everything.ini')
  await fs.writeFile(
    ini,
    '[Everything]\napp_data=0\nrun_as_admin=0\ncheck_for_updates_on_startup=0\nauto_include_fixed_volumes=0\nauto_include_removable_volumes=0\nauto_include_fixed_refs_volumes=0\nauto_include_removable_refs_volumes=0\nfolder_monitor_changes=1\nfolders=' +
      fixture +
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
    await page.locator('.search-input').fill('本地工具设置')
    await page.locator('.app-item').filter({ hasText: '本地工具设置' }).first().click()
    await expect.poll(() => localTools('Boolean(window.localTools)')).toBe(true)
    await localTools(
      'window.localTools.configure(' + JSON.stringify({ everything, es, instance }) + ')'
    )
    await page.evaluate(async () => {
      const plugin = (await window.ztools.getAllPlugins()).find(
        (item: any) => item.name === 'local-tools'
      )
      await window.ztools.killPluginAndReturn(plugin.path)
    })
    await expect(page.getByRole('tablist')).toHaveCount(0)
    await page.locator('.search-input').fill('搜索验收')
    await expect(page.locator('.indexed-results .list-item')).toHaveCount(3, { timeout: 15000 })
    await expect(page.locator('.indexed-results')).toContainText(filename)
    await page.screenshot({ path: info.outputPath('main-search-real-everything.png') })
    await page.getByRole('tab', { name: '文件夹', exact: true }).click()
    await expect(page.locator('.indexed-results .list-item')).toHaveCount(1)
    await expect(page.locator('.indexed-results')).toContainText(directory)
    await page.getByRole('tab', { name: '应用', exact: true }).click()
    await expect(page.locator('.indexed-results .list-item')).toHaveCount(1)
    await expect(page.locator('.indexed-results')).toContainText('搜索验收 程序.exe')
    await page.getByRole('tab', { name: '文件', exact: true }).click()
    await expect(page.locator('.indexed-results .list-item')).toHaveCount(1)
    await expect(page.locator('.indexed-results')).toContainText(filename)
    // Count host queries: switching categories must use the already returned category buckets.
    await app.evaluate(({ ipcMain }) => {
      const handler = (ipcMain as any)._invokeHandlers.get('file-search:search')
      ;(globalThis as any).sdkHostQueries = 0
      ipcMain.removeHandler('file-search:search')
      ipcMain.handle('file-search:search', (...args) => {
        ;(globalThis as any).sdkHostQueries++
        return handler(...args)
      })
    })
    await page.locator('.search-input').fill('分页验收 ext:txt')
    await expect(page.locator('.indexed-results .list-item')).toHaveCount(100)
    const calls = await app.evaluate(() => (globalThis as any).sdkHostQueries)
    await page.getByRole('tab', { name: '文件夹', exact: true }).click()
    await expect(page.locator('.indexed-results .list-item')).toHaveCount(0)
    await page.getByRole('tab', { name: '文件', exact: true }).click()
    await expect(page.locator('.indexed-results .list-item')).toHaveCount(100)
    expect(await app.evaluate(() => (globalThis as any).sdkHostQueries)).toBe(calls)
    await page.getByRole('button', { name: '加载更多', exact: true }).click()
    await expect(page.locator('.indexed-results .list-item')).toHaveCount(200)
    await page.getByRole('button', { name: '加载更多', exact: true }).click()
    await expect(page.locator('.indexed-results .list-item')).toHaveCount(235)
    await expect(page.getByRole('button', { name: '加载更多', exact: true })).toHaveCount(0)
    await page.locator('.search-input').fill('分页验收 size:>230')
    await expect(page.locator('.indexed-results .list-item')).toHaveCount(5)
    await page.locator('.search-input').fill('regex:^分页验收-00[12]\\.txt$')
    await expect(page.locator('.indexed-results .list-item')).toHaveCount(2)
    await page.getByRole('button', { name: '搜索设置', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('Everything 1.4.1.1032')
    await page.getByRole('combobox', { name: '结果排序', exact: true }).selectOption('2')
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('已保存')
    await page.screenshot({ path: info.outputPath('sdk-search-settings.png') })
    await page.getByRole('button', { name: '关闭搜索设置', exact: true }).click()
    await expect(page.locator('.indexed-results .list-item').first()).toContainText('分页验收-002.txt')
    await page.locator('.search-input').fill('动态SDK')
    await expect(page.locator('.indexed-results .list-item')).toHaveCount(0)
    const liveFile = path.join(fixture, '动态SDK.txt')
    await fs.writeFile(liveFile, 'fixture')
    await expect(page.locator('.indexed-results .list-item')).toHaveCount(1, { timeout: 15000 })
    await fs.unlink(liveFile)
    await expect(page.locator('.indexed-results .list-item')).toHaveCount(0, { timeout: 15000 })
    await page.locator('.search-input').fill('搜索验收')
    await expect(page.locator('.indexed-results .list-item')).toHaveCount(1)
    // 截断系统打开边界，验证精确路径和关联方式，不启动外部程序。
    await app.evaluate(({ shell }) => {
      ;(globalThis as any).fileActions = []
      shell.showItemInFolder = (file) => {
        ;(globalThis as any).fileActions.push(['reveal', file])
      }
      shell.openPath = async (file) => {
        ;(globalThis as any).fileActions.push(['open', file])
        return ''
      }
    })
    await page.locator('.search-input').press('Control+Enter')
    await expect
      .poll(() => app.evaluate(() => (globalThis as any).fileActions))
      .toEqual([['reveal', filename]])
    await page.locator('.search-input').press('Enter')
    await expect
      .poll(() => app.evaluate(() => (globalThis as any).fileActions))
      .toEqual([
        ['reveal', filename],
        ['open', filename]
      ])
  } finally {
    await promisify(execFile)(everything!, ['-instance', instance, '-exit'], {
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

test('列表模式保留分类、键盘导航和文件右键操作', async () => {
  await page.evaluate(() => window.ztools.dbPut('settings-general', { searchMode: 'list' }))
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('file-search:search')
    ipcMain.handle('file-search:search', () => ({
      items: [
        { name: '列表 文件.txt', path: 'D:/列表 文件.txt', directory: false },
        { name: '列表 文件夹', path: 'D:/列表 文件夹', directory: true }
      ],
      limited: false
    }))
    ipcMain.removeHandler('show-context-menu')
    ipcMain.handle('show-context-menu', (event, items) => {
      ;(globalThis as any).menuLabels = items.map((item) => item.label)
      event.sender.send(
        'context-menu-command',
        items.find((item) => item.id.startsWith('copy-indexed-path:')).id
      )
    })
    ipcMain.removeHandler('copy-to-clipboard')
    ipcMain.handle('copy-to-clipboard', (_event, text) => {
      ;(globalThis as any).copiedPath = text
    })
  })
  await page.reload()
  await page.locator('.search-input').fill('列表')
  await expect(page.locator('.list-mode-results .list-item')).toHaveCount(2)
  await expect(page.locator('.list-item.selected')).toContainText('列表 文件.txt')
  await page.locator('.search-input').press('ArrowDown')
  await expect(page.locator('.list-item.selected')).toContainText('列表 文件夹')
  await page.locator('.list-item').first().click({ button: 'right' })
  await expect
    .poll(() => app.evaluate(() => (globalThis as any).copiedPath))
    .toBe('D:/列表 文件.txt')
  expect(await app.evaluate(() => (globalThis as any).menuLabels)).toEqual([
    '打开',
    '打开所在位置',
    '复制完整路径'
  ])
})

test('长结果列表向上导航时当前文件不被吸顶分类栏遮住', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('file-search:search')
    ipcMain.handle('file-search:search', () => ({
      items: Array.from({ length: 40 }, (_, index) => ({
        name: '滚动验收-' + index + '.txt',
        path: 'D:/滚动验收-' + index + '.txt',
        directory: false
      })),
      limited: false
    }))
  })
  await page.locator('.search-input').fill('滚动验收')
  await expect(page.locator('.indexed-results .list-item')).toHaveCount(40)
  for (let index = 0; index < 12; index++) await page.locator('.search-input').press('ArrowDown')
  await expect(page.locator('.list-item.selected')).toContainText('滚动验收-12.txt')
  for (let index = 0; index < 9; index++) await page.locator('.search-input').press('ArrowUp')
  await expect(page.locator('.list-item.selected')).toContainText('滚动验收-3.txt')
  await expect
    .poll(() =>
      page.evaluate(() => {
        const item = document.querySelector('.list-item.selected')!.getBoundingClientRect()
        const tabs = document.querySelector('.search-categories')!.getBoundingClientRect()
        const container = document.querySelector('.scrollable-content')!.getBoundingClientRect()
        return item.top >= tabs.bottom - 1 && item.bottom <= container.bottom + 1
      })
    )
    .toBe(true)
})

test('应用扫描尚未完成时分类快捷键已可用', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('get-apps')
    ipcMain.handle('get-apps', async () => {
      ;(globalThis as any).appsPending = true
      await new Promise((resolve) => setTimeout(resolve, 8000))
      ;(globalThis as any).appsPending = false
      return []
    })
    ipcMain.removeHandler('file-search:search')
    ipcMain.handle('file-search:search', () => ({
      items: [{ name: '启动验收.txt', path: 'D:/启动验收.txt', directory: false }],
      limited: false
    }))
  })
  await page.reload()
  await page.locator('.search-input').fill('启动验收')
  await expect(page.locator('.indexed-results .list-item')).toHaveCount(1)
  expect(await app.evaluate(() => (globalThis as any).appsPending)).toBe(true)
  await page.locator('.search-input').press('Alt+4')
  await expect(page.locator('[data-category=file]')).toHaveAttribute('aria-selected', 'true')
  expect(await app.evaluate(() => (globalThis as any).appsPending)).toBe(true)
})

for (const mode of ['aggregate', 'list'] as const) {
  test('分类栏与滚动文件分区，鼠标滚动和切换不重叠：' + mode, async ({}, info) => {
    await page.evaluate(
      (mode) => window.ztools.dbPut('settings-general', { searchMode: mode }),
      mode
    )
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('file-search:search')
      ipcMain.handle('file-search:search', (_event, query, filter) => ({
        items: Array.from({ length: 40 }, (_, index) => ({
          name: query + '-' + index + (filter === 'folder' ? ' 文件夹' : '.code-snippets'),
          path:
            'D:/资料/' + query + '-' + index + (filter === 'folder' ? ' 文件夹' : '.code-snippets'),
          directory: filter === 'folder'
        })),
        limited: false
      }))
    })
    await page.reload()
    await page.locator('.search-input').fill('重叠验收')
    await page.getByRole('tab', { name: '文件', exact: true }).click()
    await expect(page.locator('.list-item')).toHaveCount(40)
    // Windows 材质有意使用透明背景；两种主题都必须靠布局裁切避免穿透。
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      await page.evaluate((theme) => {
        document.documentElement.classList.add('os-windows')
        document.documentElement.setAttribute(
          'data-material',
          theme === 'light' ? 'mica' : 'acrylic'
        )
        ;(document.querySelector('.scrollable-content') as HTMLElement).scrollTop = 0
      }, theme)
      await page.locator('.list-item').first().hover()
      await page.mouse.wheel(0, 420)
      await expect
        .poll(() => page.locator('.scrollable-content').evaluate((node) => node.scrollTop))
        .toBeGreaterThan(100)
      await expect
        .poll(() =>
          page.evaluate(() => {
            const tabs = document.querySelector('.search-categories')!
            const results = document.querySelector('.scrollable-content')!
            const tabRect = tabs.getBoundingClientRect(),
              resultRect = results.getBoundingClientRect()
            // 文件的绘制和命中测试都必须裁切在分类栏下方，背景透明也不能覆盖按钮。
            const filesAtTab = document
              .elementsFromPoint(tabRect.left + 30, tabRect.top + tabRect.height / 2)
              .some((node) => Boolean(node.closest('.list-item')))
            return resultRect.top >= tabRect.bottom - 1 && !filesAtTab && resultRect.height > 100
          })
        )
        .toBe(true)
      await page.screenshot({
        path: info.outputPath('separate-categories-' + mode + '-' + theme + '.png')
      })
    }
    await page.getByRole('tab', { name: '文件夹', exact: true }).click()
    await expect(page.locator('.list-item').first()).toContainText('文件夹')
    await expect
      .poll(() => page.locator('.scrollable-content').evaluate((node) => node.scrollTop))
      .toBe(0)
    await page.locator('.list-item').first().hover()
    await page.mouse.wheel(0, 320)
    await expect
      .poll(() => page.locator('.scrollable-content').evaluate((node) => node.scrollTop))
      .toBeGreaterThan(100)
    await page.locator('.search-input').fill('新词验收')
    await expect(page.locator('.list-item').first()).toContainText('新词验收-0')
    await expect
      .poll(() => page.locator('.scrollable-content').evaluate((node) => node.scrollTop))
      .toBe(0)
    await page.locator('.search-input').fill('')
    await expect(page.getByRole('tablist')).toHaveCount(0)
    await page.locator('.search-input').fill('恢复验收')
    await expect(page.locator('.list-item').first()).toContainText('恢复验收-0')
    await expect(page.locator('[data-category=all]')).toHaveAttribute('aria-selected', 'true')
  })
}
