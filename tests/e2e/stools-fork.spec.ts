import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const projectRoot = path.resolve(__dirname, '../..')
const settingsUrl = 'http://127.0.0.1:15177'

/**
 * 在隔离测试实例的设置插件中执行 UI 或公开插件 API 操作。
 * @param app 当前 Electron 测试实例。
 * @param script 插件页面中执行的脚本。
 * @returns 脚本结果。
 */
async function inSettings(app: ElectronApplication, script: string): Promise<any> {
  return app.evaluate(
    async ({ webContents }, { url, source }) => {
      const contents = webContents.getAllWebContents().find((item) => item.getURL().startsWith(url))
      if (!contents || contents.isLoading()) return null
      return contents.executeJavaScript(source)
    },
    { url: settingsUrl, source: script }
  )
}

test('sTools 使用独立数据和原生插件界面，支持功能级快捷键管理', async ({}, testInfo) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stools-fork-e2e-'))
  const legacyRoot = path.join(dataRoot, 'legacy')
  await fs.mkdir(legacyRoot)
  let app: ElectronApplication | undefined
  try {
    // 从源码启动，数据根与旧数据根都限制在本次测试目录内。
    app = await electron.launch({
      args: [projectRoot],
      cwd: projectRoot,
      env: {
        ...process.env,
        STOOLS_DATA_ROOT: dataRoot,
        STOOLS_LEGACY_USER_DATA_PATH: legacyRoot,
        ZTOOLS_E2E: '1',
        ZTOOLS_SETTING_DEV_SERVER_URL: settingsUrl
      }
    })
    const identity = await app.evaluate(({ app }) => ({
      name: app.getName(),
      data: app.getPath('userData')
    }))
    expect(identity).toEqual({ name: 'sTools', data: dataRoot })
    const page = await app.firstWindow()
    await expect(page.locator('.search-input')).toBeVisible()
    await page.locator('.search-input').fill('快捷键管理')
    const command = page.locator('.app-item, .list-item').filter({ hasText: '快捷键管理' }).first()
    await expect(command).toBeVisible()
    await command.click()
    await expect.poll(() => inSettings(app!, 'document.body.innerText')).toContain('浏览全部功能')
    // 保存真实外观设置并重新加载，让插件自身应用不透明背景，便于独立截图。
    await inSettings(
      app,
      `(async () => {
      const api = window.ztools.internal
      const settings = await api.dbGet('settings-general') || {}
      await api.dbPut('settings-general', { ...settings, windowMaterial: 'none', theme: 'light' })
    })()`
    )
    await app.evaluate(({ webContents }, url) => {
      webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith(url))!
        .reload()
    }, settingsUrl)
    await expect.poll(() => inSettings(app!, 'document.body.innerText')).toContain('浏览全部功能')
    await expect
      .poll(() => inSettings(app!, 'document.documentElement.dataset.material'))
      .toBe('none')

    // 注册同一插件的两个不同功能，确认底层仍沿用可工作的全局注册机制。
    const bindings = await inSettings(
      app,
      `(async () => {
      const api = window.ztools.internal
      const first = await api.registerGlobalShortcut('Control+Alt+Shift+F9', 'setting/通用设置', false, false)
      const second = await api.registerGlobalShortcut('Control+Alt+Shift+F10', 'setting/快捷键管理', false, false)
      return [first, second]
    })()`
    )
    expect(bindings.map((item: { success: boolean }) => item.success)).toEqual([true, true])
    expect(
      await app.evaluate(({ globalShortcut }) => [
        globalShortcut.isRegistered('Control+Alt+Shift+F9'),
        globalShortcut.isRegistered('Control+Alt+Shift+F10')
      ])
    ).toEqual([true, true])
    await inSettings(
      app,
      `Promise.all([
      window.ztools.internal.unregisterGlobalShortcut('Control+Alt+Shift+F9'),
      window.ztools.internal.unregisterGlobalShortcut('Control+Alt+Shift+F10')
    ])`
    )

    // 等待主体稳定后单独截取真实插件 WebContentsView。
    const screenshot = await app.evaluate(async ({ webContents }, url) => {
      const view = webContents.getAllWebContents().find((item) => item.getURL().startsWith(url))!
      return (await view.capturePage()).toPNG().toString('base64')
    }, settingsUrl)
    await fs.writeFile(
      testInfo.outputPath('stools-shortcuts.png'),
      Buffer.from(screenshot, 'base64')
    )

    await inSettings(
      app,
      `Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('浏览全部功能')).click()`
    )
    await expect.poll(() => inSettings(app!, 'location.hash')).toContain('allCommands')
    await expect.poll(() => inSettings(app!, 'document.body.innerText')).toContain('通用设置')
    await inSettings(app, `location.hash = '#/about'`)
    await expect
      .poll(() => inSettings(app!, 'document.body.innerText'))
      .toContain('基于 ZTools 3.2.0')
    await expect
      .poll(() => inSettings(app!, 'document.body.innerText'))
      .toContain('此版本采用手动更新')
    const update = await inSettings(app, 'window.ztools.internal.updaterCheckUpdate()')
    expect(update.hasUpdate).toBe(false)
  } finally {
    // 先释放全局快捷键和实例，再仅清理本用例创建的目录。
    await app?.close()
    const resolved = path.resolve(dataRoot)
    if (
      !resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(resolved).startsWith('stools-fork-e2e-')
    )
      throw new Error('Unsafe test cleanup path')
    await fs.rm(resolved, { recursive: true, force: true })
  }
})
