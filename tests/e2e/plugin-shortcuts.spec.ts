import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const projectRoot = path.resolve(__dirname, '../..')
let app: ElectronApplication
let dataRoot: string

/**
 * 在源码设置插件的真实 WebContentsView 中执行操作。
 * @param source 页面脚本。
 * @returns 页面返回的数据。
 */
async function ui(source: string): Promise<any> {
  return app.evaluate(async ({ webContents }, source) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL().startsWith('http://127.0.0.1:15177'))
    return contents && !contents.isLoading() ? contents.executeJavaScript(source, true) : null
  }, source)
}

/**
 * 用实际录制组件捕获组合键，验证 DOM 事件到快捷键值的链路。
 * @param key 功能键名称。
 * @returns 录制完成的 Promise。
 */
async function record(key: string): Promise<void> {
  await ui(`document.querySelector('.hotkey-input').click()`)
  await expect.poll(() => ui(`!!document.querySelector('.hotkey-input.recording')`)).toBe(true)
  await expect
    .poll(() => ui(`document.querySelector('.hotkey-input').innerText`))
    .toContain('请按下')
  await ui(`new Promise(resolve => setTimeout(resolve, 150))`)
  await ui(
    `document.dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(key)},code:${JSON.stringify(key)},ctrlKey:true,altKey:true,shiftKey:true,bubbles:true}));document.dispatchEvent(new KeyboardEvent('keyup', {key:${JSON.stringify(key)},code:${JSON.stringify(key)},ctrlKey:true,altKey:true,shiftKey:true,bubbles:true}))`
  )
  await expect
    .poll(() => ui(`document.querySelector('.hotkey-input').innerText`))
    .toBe('Ctrl+Alt+Shift+' + key)
}

/**
 * 截取设置插件自身的可见区域，不与宿主窗口拼接。
 * @param output 截图路径。
 * @returns 写入完成的 Promise。
 */
async function screenshot(output: string): Promise<void> {
  // 等待样式和弹窗动画完成，截取当前稳定画面。
  await ui(
    `new Promise(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 450))`
  )
  const data = await app.evaluate(async ({ webContents }) =>
    (
      await webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith('http://127.0.0.1:15177'))!
        .capturePage()
    )
      .toPNG()
      .toString('base64')
  )
  await fs.writeFile(output, Buffer.from(data, 'base64'))
}

test.beforeEach(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stools-shortcuts-e2e-'))
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
  const page = await app.firstWindow()
  await page.locator('.search-input').fill('插件快捷键汇总')
  await page.locator('.app-item, .list-item').filter({ hasText: '插件快捷键汇总' }).first().click()
  await expect
    .poll(() =>
      ui(
        `document.querySelector('[data-plugin="capture-tools"] [data-feature="capture"]')?.innerText`
      )
    )
    .toContain('区域截图、标注')
})

test.afterEach(async () => {
  await app?.close()
  if (
    !path.resolve(dataRoot).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
    !path.basename(dataRoot).startsWith('stools-shortcuts-e2e-')
  )
    throw new Error('Unsafe cleanup')
  await fs.rm(dataRoot, { recursive: true, force: true })
})

test('插件快捷键入口、录制、冲突、修改、移除与持久化', async ({}, testInfo) => {
  test.setTimeout(60000)
  const menus = await ui(
    `Array.from(document.querySelectorAll('.menu-label')).map(item=>item.textContent)`
  )
  expect(menus.slice(menus.indexOf('功能与插件'), menus.indexOf('功能与插件') + 3)).toEqual([
    '功能与插件',
    '插件快捷键',
    '插件市场'
  ])
  expect(
    await ui(`document.querySelectorAll('[data-plugin="capture-tools"] .function-row').length`)
  ).toBe(7)
  await ui(
    `(async()=>{ const a=window.ztools.internal; const s=await a.dbGet('settings-general')||{}; await a.dbPut('settings-general',{...s,windowMaterial:'none',theme:'light'}); location.reload() })()`
  )
  await expect.poll(() => ui(`document.documentElement.dataset.material`)).toBe('none')
  await expect
    .poll(() => ui(`document.querySelector('[data-feature="capture"] .set-key')?.textContent`))
    .toBe('设置快捷键')
  await ui(`document.querySelector('[data-feature="capture"] .set-key').click()`)
  await record('F9')
  await screenshot(testInfo.outputPath('plugin-shortcuts-editor.png'))
  await ui(`document.querySelector('.dialog-footer .primary').click()`)
  await expect
    .poll(() => ui(`document.querySelector('[data-feature="capture"] .binding')?.textContent`))
    .toContain('Ctrl+Alt+Shift+F9')
  expect(
    await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Ctrl+Alt+Shift+F9'))
  ).toBe(true)

  // 同一个组合键不能指向另一个功能，原注册保持生效。
  await ui(`document.querySelector('[data-feature="record"] .set-key').click()`)
  await record('F9')
  await ui(`document.querySelector('.dialog-footer .primary').click()`)
  await expect
    .poll(() => ui(`document.querySelector('.dialog-content [role="alert"]')?.textContent`))
    .toContain('已用于')
  expect(await ui(`window.ztools.internal.dbGet('global-shortcuts')`)).toHaveLength(1)
  await ui(`document.querySelector('.dialog-footer .quiet').click()`)
  await expect.poll(() => ui(`document.querySelector('.dialog-overlay') === null`)).toBe(true)
  await ui(`document.querySelector('[data-feature="capture"] .binding').click()`)
  await record('F10')
  await ui(`document.querySelector('.dialog-footer .primary').click()`)
  await expect
    .poll(() => ui(`document.querySelector('[data-feature="capture"] .binding')?.textContent`))
    .toContain('F10')
  expect(
    await app.evaluate(({ globalShortcut }) => [
      globalShortcut.isRegistered('Ctrl+Alt+Shift+F9'),
      globalShortcut.isRegistered('Ctrl+Alt+Shift+F10')
    ])
  ).toEqual([false, true])
  await ui(`location.reload()`)
  await expect
    .poll(() => ui(`document.querySelector('[data-feature="capture"] .binding')?.textContent`))
    .toContain('F10')
  await screenshot(testInfo.outputPath('plugin-shortcuts-overview.png'))

  // ESC 先取消录制，下一次才关闭弹窗；不能退出设置插件。
  await ui(`document.querySelector('[data-feature="capture"] .binding').click()`)
  await expect.poll(() => ui(`!!document.querySelector('.hotkey-input')`)).toBe(true)
  await ui(`document.querySelector('.hotkey-input').click()`)
  await expect.poll(() => ui(`!!document.querySelector('.hotkey-input.recording')`)).toBe(true)
  await ui(
    `document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}))`
  )
  expect(
    await ui(
      `!!document.querySelector('.dialog-overlay') && !document.querySelector('.hotkey-input.recording')`
    )
  ).toBe(true)
  await ui(
    `document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}))`
  )
  await expect.poll(() => ui(`document.querySelector('.dialog-overlay') === null`)).toBe(true)
  expect(await ui(`!!document.querySelector('.plugin-shortcuts')`)).toBe(true)
  await ui(`document.querySelector('[data-feature="capture"] .binding').click()`)
  await expect.poll(() => ui(`!!document.querySelector('.dialog-footer .remove')`)).toBe(true)
  await ui(`document.querySelector('.dialog-footer .remove').click()`)
  await expect.poll(() => ui(`document.querySelectorAll('.dialog-overlay').length`)).toBe(2)
  await ui(
    `Array.from(document.querySelectorAll('.dialog-footer button')).find(button=>button.textContent.trim()==='移除').click()`
  )
  await expect.poll(() => ui(`window.ztools.internal.dbGet('global-shortcuts')`)).toEqual([])
  expect(
    await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Ctrl+Alt+Shift+F10'))
  ).toBe(false)
})

test('搜索、状态筛选与插件详情中的快捷键入口', async () => {
  // 历史别名目标和应用内快捷键应显示在同一个功能下。
  await ui(
    `window.ztools.internal.dbPut('app-shortcuts',[{id:'legacy',shortcut:'Ctrl+Alt+F8',target:'截图与录屏 / 区域截图',enabled:false}])`
  )
  await ui(`document.querySelector('.page-heading button').click()`)
  await expect
    .poll(() => ui(`document.querySelector('[data-feature="capture"] .binding')?.textContent`))
    .toContain('仅主搜索页 · 已停用')
  await ui(
    `var input=document.querySelector('.filters input'); input.value='截图标注'; input.dispatchEvent(new Event('input',{bubbles:true}))`
  )
  await expect.poll(() => ui(`document.querySelectorAll('.function-row').length`)).toBe(1)
  expect(await ui(`document.querySelector('.function-row h2').textContent`)).toBe('截图')
  await ui(
    `var input=document.querySelector('.filters input'); input.value=''; input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelectorAll('.filter-tabs button')[1].click()`
  )
  await expect
    .poll(() => ui(`document.querySelector('.empty')?.textContent`))
    .toContain('没有符合条件')
  await ui(
    `Array.from(document.querySelectorAll('.menu-item')).find(item=>item.textContent.includes('功能与插件')).click()`
  )
  await expect.poll(() => ui(`document.querySelectorAll('.plugin-item').length`)).toBeGreaterThan(0)
  await ui(
    `Array.from(document.querySelectorAll('.plugin-item')).find(item=>item.textContent.includes('截图与录屏')).querySelector('[title="指令与快捷键"]').click()`
  )
  await expect
    .poll(() => ui(`document.querySelector('.shortcut-guide')?.textContent`))
    .toContain('无需了解指令或别名')
  await ui(`document.querySelector('.shortcut-guide').click()`)
  await expect
    .poll(() => ui(`document.querySelector('.filters select')?.value`))
    .toBe('capture-tools')
  expect(await ui(`document.querySelectorAll('.plugin-group').length`)).toBe(1)
  await ui(`document.querySelector('[data-feature="record"] .set-key').click()`)
  await record('F11')
  await ui(
    `document.querySelector('#shortcut-scope').value='app'; document.querySelector('#shortcut-scope').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('.dialog-footer .primary').click()`
  )
  await expect
    .poll(() => ui(`document.querySelector('[data-feature="record"] .binding')?.textContent`))
    .toContain('仅主搜索页')
  expect(
    await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Ctrl+Alt+Shift+F11'))
  ).toBe(false)
  const saved = await ui(`window.ztools.internal.dbGet('app-shortcuts')`)
  expect(saved).toHaveLength(2)
  expect(saved.find((item: any) => item.id === 'legacy').enabled).toBe(false)
  expect(saved.find((item: any) => item.shortcut.endsWith('F11')).target).toBe(
    'capture-tools/sTools 录屏'
  )
})

test('主程序呼出快捷键可修改、恢复默认并在重启后生效', async ({}, testInfo) => {
  test.setTimeout(60000)
  // 测试专用呼出键避开用户安装版使用的默认键。
  await ui(
    `(async()=>{const a=window.ztools.internal; const s=await a.dbGet('settings-general')||{}; const result=await a.updateShortcut('Ctrl+Alt+Shift+F7'); if(!result.success) throw new Error(result.error); await a.dbPut('settings-general',{...s,hotkey:'Ctrl+Alt+Shift+F7',theme:'light',windowMaterial:'none',launcherTestPreference:'keep'}); location.reload()})()`
  )
  await expect
    .poll(() => ui(`document.querySelector('.launcher-key')?.textContent`))
    .toContain('F7')
  await app.evaluate(({ globalShortcut }) => {
    // 保留真正的系统注册，仅记录新键的主程序回调，用于隐藏后的呼出验证。
    const original = globalShortcut.register.bind(globalShortcut)
    globalShortcut.register = (key, callback) => {
      const success = original(key, callback)
      if (success && key === 'Ctrl+Alt+Shift+F12') (globalThis as any).launcherCallback = callback
      return success
    }
  })
  await ui(`document.querySelector('.launcher-key').click()`)
  await record('F12')
  await ui(`document.querySelector('.dialog-footer .primary').click()`)
  await expect
    .poll(() => ui(`document.querySelector('.launcher-key')?.textContent`))
    .toContain('F12')
  expect(
    await app.evaluate(({ globalShortcut }) => [
      globalShortcut.isRegistered('Ctrl+Alt+Shift+F7'),
      globalShortcut.isRegistered('Ctrl+Alt+Shift+F12')
    ])
  ).toEqual([false, true])
  expect(await ui(`window.ztools.internal.dbGet('settings-general')`)).toMatchObject({
    hotkey: 'Ctrl+Alt+Shift+F12',
    launcherTestPreference: 'keep'
  })
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'sTools')!
    main.hide()
    ;(globalThis as any).launcherCallback()
  })
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.getTitle() === 'sTools')!
          .isVisible()
      )
    )
    .toBe(true)

  // 已有插件键不能被主呼出键覆盖。
  await ui(
    `(async()=>{const a=window.ztools.internal; const b={id:'reserved',shortcut:'Ctrl+Alt+Shift+F9',target:'capture-tools/sTools 截图',enabled:true}; await a.registerGlobalShortcut(b.shortcut,b.target); await a.dbPut('global-shortcuts',[b]);})()`
  )
  await ui(`document.querySelector('.launcher-key').click()`)
  await record('F9')
  await ui(`document.querySelector('.dialog-footer .primary').click()`)
  await expect
    .poll(() => ui(`document.querySelector('.dialog-content [role="alert"]')?.textContent`))
    .toContain('已用于')
  expect(await ui(`window.ztools.internal.getCurrentShortcut()`)).toBe('Ctrl+Alt+Shift+F12')
  expect(
    await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Ctrl+Alt+Shift+F9'))
  ).toBe(true)
  await ui(`document.querySelector('.restore-launcher').click()`)
  await expect
    .poll(() => ui(`document.querySelector('.hotkey-input')?.textContent.trim()`))
    .toBe('Ctrl+Alt+Space')
  await ui(`document.querySelector('.dialog-footer .quiet').click()`)
  await expect.poll(() => ui(`document.querySelector('.dialog-overlay') === null`)).toBe(true)
  await screenshot(testInfo.outputPath('launcher-shortcut.png'))

  // 完整重启同一隔离实例，验证持久化后的实际系统注册。
  await app.close()
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
  const page = await app.firstWindow()
  await page.locator('.search-input').fill('插件快捷键汇总')
  await page.locator('.app-item, .list-item').filter({ hasText: '插件快捷键汇总' }).first().click()
  await expect
    .poll(() => ui(`document.querySelector('.launcher-key')?.textContent`))
    .toContain('F12')
  expect(
    await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Ctrl+Alt+Shift+F12'))
  ).toBe(true)
  await ui(
    `Array.from(document.querySelectorAll('.menu-item')).find(item=>item.textContent.includes('通用设置')).click()`
  )
  await expect
    .poll(() => ui(`document.querySelector('.hotkey-input')?.textContent.trim()`))
    .toBe('Ctrl+Alt+Shift+F12')
})

test('后端统一拒绝跨范围、主窗口及内置键冲突，同键改目标需要明确编辑', async () => {
  const key = 'Control+Alt+Shift+F6'
  const result = await ui(`(async()=>{
    const a=window.ztools.internal;
    const first=await a.registerGlobalShortcut('${key}','capture-tools/sTools 截图');
    const app=await a.registerAppShortcut('Alt+Shift+Ctrl+F6','capture-tools/sTools 录屏');
    const main=await a.updateShortcut('Shift+Ctrl+Alt+F6');
    const reserved=await a.registerAppShortcut('Control+F','capture-tools/sTools 截图');
    const accidental=await a.registerGlobalShortcut('${key}','capture-tools/sTools 录屏');
    const edit=await a.registerGlobalShortcut('${key}','capture-tools/sTools 录屏',false,false,'capture-tools/sTools 截图');
    const localFirst=await a.registerAppShortcut('Control+Alt+Shift+F5','capture-tools/sTools 截图');
    const localAccidental=await a.registerAppShortcut('Alt+Shift+Ctrl+F5','capture-tools/sTools 录屏');
    const localEdit=await a.registerAppShortcut('Control+Alt+Shift+F5','capture-tools/sTools 录屏','capture-tools/sTools 截图');
    return {first,app,main,reserved,accidental,edit,localFirst,localAccidental,localEdit};
  })()`)
  expect(result.first.success).toBe(true)
  for (const name of ['app', 'main', 'reserved', 'accidental', 'localAccidental']) {
    expect(result[name]).toMatchObject({ success: false, error: expect.stringContaining('已用于') })
  }
  expect(result.edit, JSON.stringify(result)).toMatchObject({ success: true })
  expect(result.localFirst.success).toBe(true)
  expect(result.localEdit, JSON.stringify(result)).toMatchObject({ success: true })
  expect(
    await app.evaluate(({ globalShortcut }, key) => globalShortcut.isRegistered(key), key)
  ).toBe(true)
  await ui(`window.ztools.internal.unregisterGlobalShortcut('${key}')`)
})
