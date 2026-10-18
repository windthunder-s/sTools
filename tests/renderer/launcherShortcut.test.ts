import { describe, expect, it, vi } from 'vitest'
import {
  changeLauncherShortcut,
  type LauncherShortcutApi
} from '../../internal-plugins/setting/src/views/PluginShortcutsSetting/launcher'

/**
 * 创建隔离的呼出键与设置 API，不访问真实用户数据库。
 * @returns API、存储和当前组合键查询器。
 */
function fixture(): {
  api: LauncherShortcutApi
  data: Record<string, unknown>
  current: () => string
} {
  let current = 'Ctrl+Alt+Space'
  const data: Record<string, unknown> = {
    'settings-general': { hotkey: current, theme: 'dark', customPreference: { keep: true } },
    'global-shortcuts': [],
    'app-shortcuts': []
  }
  const api: LauncherShortcutApi = {
    dbGet: vi.fn(async (key) => structuredClone(data[key])),
    dbPut: vi.fn(async (key, value) => {
      data[key] = structuredClone(value)
      return { ok: true }
    }),
    getCurrentShortcut: vi.fn(async () => current),
    updateShortcut: vi.fn(async (key) => {
      current = key
      return { success: true }
    })
  }
  return { api, data, current: () => current }
}

describe('主程序呼出快捷键', () => {
  it('修改立即生效并持久化，同时保留其它通用设置', async () => {
    const { api, data, current } = fixture()
    await expect(changeLauncherShortcut(api, current(), 'Ctrl+Alt+F12', 'win32')).resolves.toBe(
      'Ctrl+Alt+F12'
    )
    expect(current()).toBe('Ctrl+Alt+F12')
    expect(data['settings-general']).toEqual({
      hotkey: 'Ctrl+Alt+F12',
      theme: 'dark',
      customPreference: { keep: true }
    })
    expect(data['global-shortcuts']).toEqual([])
  })
  it.each(['global-shortcuts', 'app-shortcuts'])(
    '禁止占用 %s 中的插件绑定，识别 Control/Ctrl 别名',
    async (scope) => {
      const { api, data, current } = fixture()
      data[scope] = [
        { id: 'capture', target: 'capture-tools/截图', shortcut: 'Control+Alt+F12', enabled: true }
      ]
      await expect(changeLauncherShortcut(api, current(), 'Ctrl+Alt+F12', 'win32')).rejects.toThrow(
        '截图'
      )
      expect(api.updateShortcut).not.toHaveBeenCalled()
    }
  )
  it('保存失败恢复旧呼出键和原配置', async () => {
    const { api, data, current } = fixture()
    vi.mocked(api.dbPut).mockResolvedValueOnce({ ok: false })
    await expect(changeLauncherShortcut(api, current(), 'Ctrl+Alt+F12', 'win32')).rejects.toThrow(
      '保存'
    )
    expect(current()).toBe('Ctrl+Alt+Space')
    expect(data['settings-general']).toMatchObject({ hotkey: 'Ctrl+Alt+Space' })
  })
  it('注册失败或抛出异常时恢复旧呼出键', async () => {
    const { api, current } = fixture()
    vi.mocked(api.updateShortcut).mockRejectedValueOnce(new Error('无效组合键'))
    await expect(changeLauncherShortcut(api, current(), 'invalid', 'win32')).rejects.toThrow(
      '无效组合键'
    )
    expect(api.updateShortcut).toHaveBeenLastCalledWith('Ctrl+Alt+Space')
    expect(api.dbPut).not.toHaveBeenCalled()
  })
  it('其它入口更新后拒绝覆盖旧快照', async () => {
    const { api } = fixture()
    await expect(
      changeLauncherShortcut(api, 'Ctrl+Alt+F11', 'Ctrl+Alt+F12', 'win32')
    ).rejects.toThrow('其它页面修改')
    expect(api.updateShortcut).not.toHaveBeenCalled()
  })
  it('旧键恢复失败时给出托盘恢复入口', async () => {
    const { api, current } = fixture()
    vi.mocked(api.updateShortcut).mockResolvedValue({ success: false, error: '被占用' })
    await expect(changeLauncherShortcut(api, current(), 'Ctrl+Alt+F12', 'win32')).rejects.toThrow(
      '从托盘打开'
    )
  })
  it('无效通用设置或空组合键不会修改运行时', async () => {
    const { api, data, current } = fixture()
    await expect(changeLauncherShortcut(api, current(), '', 'win32')).rejects.toThrow('请先')
    data['settings-general'] = []
    await expect(changeLauncherShortcut(api, current(), 'Ctrl+Alt+F12', 'win32')).rejects.toThrow(
      '读取异常'
    )
    expect(api.updateShortcut).not.toHaveBeenCalled()
  })
})
