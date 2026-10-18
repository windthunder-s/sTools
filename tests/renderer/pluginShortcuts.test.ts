import { describe, expect, it, vi } from 'vitest'
import {
  buildPluginGroups,
  changeBinding,
  normalizeShortcut
} from '../../internal-plugins/setting/src/views/PluginShortcutsSetting/model'
import type {
  Binding,
  ShortcutApi
} from '../../internal-plugins/setting/src/views/PluginShortcutsSetting/model'

const old: Binding = {
  id: 'old',
  shortcut: 'Ctrl+Alt+A',
  target: 'capture-tools/区域截图',
  enabled: true,
  autoCopy: true
}
const next: Binding = { ...old, shortcut: 'Ctrl+Alt+B' }

/**
 * 创建有真实持久化语义的内存 API，并记录运行时绑定变更。
 * @param initial 初始全局快捷键。
 * @returns 模拟 API、存储与运行时集合。
 */
function fixture(initial: Binding[] = [old]): {
  api: ShortcutApi
  data: Record<string, Binding[]>
  runtime: Map<string, string>
} {
  const data = { 'global-shortcuts': structuredClone(initial), 'app-shortcuts': [] }
  const runtime = new Map(
    initial.filter((item) => item.enabled).map((item) => [item.shortcut, item.target])
  )
  const api: ShortcutApi = {
    dbGet: vi.fn(async (key) => structuredClone(data[key])),
    dbPut: vi.fn(async (key, value) => {
      data[key] = structuredClone(value)
      return { ok: true }
    }),
    getCurrentShortcut: vi.fn(async () => 'Control+Space'),
    registerGlobalShortcut: vi.fn(async (key, target) => {
      runtime.set(key, target)
      return { success: true }
    }),
    unregisterGlobalShortcut: vi.fn(async (key) => {
      runtime.delete(key)
      return { success: true }
    }),
    registerAppShortcut: vi.fn(async () => ({ success: true })),
    unregisterAppShortcut: vi.fn(async () => ({ success: true }))
  }
  return { api, data, runtime }
}

describe('插件快捷键汇总', () => {
  it('按功能合并别名、历史标题目标、全局和应用内绑定，不遗漏禁用插件', () => {
    const groups = buildPluginGroups(
      [
        {
          name: 'capture-tools',
          title: '截图与录屏',
          path: 'capture',
          features: [
            {
              code: 'capture',
              explain: '标注和保存',
              cmds: ['sTools 截图', '区域截图', '截图标注']
            }
          ]
        }
      ],
      [
        { ...old, scope: 'global' },
        { ...old, id: 'app', target: '截图与录屏 / 截图标注', scope: 'app', enabled: false }
      ],
      ['capture'],
      'win32'
    )
    expect(groups[0].disabled).toBe(true)
    expect(groups[0].rows).toHaveLength(1)
    expect(groups[0].rows[0]).toMatchObject({
      title: '截图',
      needsContent: false,
      target: 'capture-tools/sTools 截图'
    })
    expect(groups[0].rows[0].bindings).toHaveLength(2)
  })
  it('动态功能覆盖重复 code，平台专用功能被过滤，内容型功能不误设直接启动', () => {
    const group = buildPluginGroups(
      [
        {
          name: 'test',
          path: 'test',
          features: [
            { code: 'image', cmds: ['old'] },
            { code: 'image', explain: '识别图片', cmds: [{ label: '识图' }] },
            { code: 'mac', platform: ['darwin'], cmds: ['Mac'] }
          ]
        }
      ],
      [],
      [],
      'win32'
    )[0]
    expect(group.rows).toHaveLength(1)
    expect(group.rows[0]).toMatchObject({ title: '识别图片', needsContent: true })
  })
  it('修饰键顺序和平台别名规范化，但双击仍是双击', () => {
    expect(normalizeShortcut('Alt+Control+A', 'win32')).toBe(
      normalizeShortcut('Ctrl+Alt+A', 'win32')
    )
    expect(normalizeShortcut('CommandOrControl+Enter', 'win32')).toBe(
      normalizeShortcut('Control+Return', 'win32')
    )
    expect(normalizeShortcut('Ctrl+Ctrl', 'win32')).not.toBe(normalizeShortcut('Ctrl', 'win32'))
  })
})

describe('快捷键保存与恢复', () => {
  it('修改时先注册新键，再释放旧键，保留高级配置及其它记录', async () => {
    const other = { ...old, id: 'other', shortcut: 'Ctrl+Alt+C', target: 'capture-tools/录屏' }
    const { api, data, runtime } = fixture([old, other])
    await changeBinding(api, 'global', old, next, 'win32')
    expect(data['global-shortcuts']).toEqual([other, next])
    expect(runtime.has(old.shortcut)).toBe(false)
    expect(runtime.get(next.shortcut)).toBe(next.target)
    expect(vi.mocked(api.registerGlobalShortcut).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.unregisterGlobalShortcut).mock.invocationCallOrder[0]
    )
  })
  it('新组合键被其它软件占用时保留旧键及配置', async () => {
    const { api, data, runtime } = fixture()
    vi.mocked(api.registerGlobalShortcut).mockResolvedValueOnce({ success: false, error: '被占用' })
    await expect(changeBinding(api, 'global', old, next, 'win32')).rejects.toThrow('被占用')
    expect(runtime.get(old.shortcut)).toBe(old.target)
    expect(data['global-shortcuts']).toEqual([old])
    expect(api.unregisterGlobalShortcut).not.toHaveBeenCalled()
  })
  it('存储失败时释放新键并恢复旧键', async () => {
    const { api, data, runtime } = fixture()
    vi.mocked(api.dbPut).mockResolvedValueOnce({ ok: false })
    await expect(changeBinding(api, 'global', old, next, 'win32')).rejects.toThrow('保存')
    expect(runtime.has(next.shortcut)).toBe(false)
    expect(runtime.get(old.shortcut)).toBe(old.target)
    expect(data['global-shortcuts']).toEqual([old])
  })
  it('删除时持久化失败同样恢复原键', async () => {
    const { api, runtime } = fixture()
    vi.mocked(api.dbPut).mockRejectedValueOnce(new Error('磁盘失败'))
    await expect(changeBinding(api, 'global', old, undefined, 'win32')).rejects.toThrow('磁盘失败')
    expect(runtime.get(old.shortcut)).toBe(old.target)
  })
  it('同键重新注册失败也恢复旧目标', async () => {
    const { api } = fixture()
    vi.mocked(api.registerGlobalShortcut).mockResolvedValueOnce({ success: false })
    await expect(
      changeBinding(api, 'global', old, { ...old, target: 'capture-tools/截图标注' }, 'win32')
    ).rejects.toThrow()
    expect(api.registerGlobalShortcut).toHaveBeenLastCalledWith(
      old.shortcut,
      old.target,
      true,
      undefined,
      'capture-tools/截图标注'
    )
  })
  it('冲突按修饰键别名检查，且禁止覆盖唤起 sTools 的主快捷键', async () => {
    const { api } = fixture()
    await expect(
      changeBinding(
        api,
        'global',
        undefined,
        { ...old, id: 'new', shortcut: 'Alt+Control+A' },
        'win32'
      )
    ).rejects.toThrow('已用于')
    await expect(
      changeBinding(api, 'global', old, { ...old, shortcut: 'Ctrl+Space' }, 'win32')
    ).rejects.toThrow('唤起 sTools')
    expect(api.registerGlobalShortcut).not.toHaveBeenCalled()
  })
  it('跨范围冲突也拦截，避免应用内组合键被全局绑定吞掉', async () => {
    const { api } = fixture()
    await expect(
      changeBinding(api, 'app', undefined, { ...old, id: 'new' }, 'win32')
    ).rejects.toThrow('已用于')
  })
  it('配置已被其它页面修改时不覆盖', async () => {
    const { api } = fixture([{ ...old, enabled: false }])
    await expect(changeBinding(api, 'global', old, next, 'win32')).rejects.toThrow('其它页面修改')
    expect(api.dbPut).not.toHaveBeenCalled()
  })
  it('删除停用的绑定不会注销其它软件或应用正在使用的键', async () => {
    const inactive = { ...old, enabled: false }
    const { api, data } = fixture([inactive])
    await changeBinding(api, 'global', inactive, undefined, 'win32')
    expect(api.unregisterGlobalShortcut).not.toHaveBeenCalled()
    expect(data['global-shortcuts']).toEqual([])
  })
  it('应用内快捷键使用应用后端，不占用系统全局组合键', async () => {
    const { api, data } = fixture([])
    await changeBinding(api, 'app', undefined, next, 'win32')
    expect(api.registerAppShortcut).toHaveBeenCalledWith(next.shortcut, next.target, undefined)
    expect(api.registerGlobalShortcut).not.toHaveBeenCalled()
    expect(data['app-shortcuts']).toEqual([next])
  })
})

it('编辑同一个组合键时沿用旧拼写，避免后端别名残留', async () => {
  const { api, data } = fixture()
  await changeBinding(api, 'global', old, { ...old, shortcut: 'Control+Alt+A' }, 'win32')
  expect(data['global-shortcuts'][0].shortcut).toBe(old.shortcut)
  expect(api.registerGlobalShortcut).toHaveBeenCalledWith(
    old.shortcut,
    old.target,
    true,
    undefined,
    old.target
  )
})
