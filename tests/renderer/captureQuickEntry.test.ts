import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

/**
 * Run the plugin's actual controller with independent in-memory storage and inert DOM fields.
 * @param initialMode Persisted quick-entry preference.
 * @returns Controller methods, fake fields and observable host calls.
 */
function fixture(initialMode?: string) {
  const store = new Map<string, unknown>()
  const hostStore = new Map<string, unknown>()
  if (initialMode) store.set('default-mode', initialMode)
  const fields = new Map<string, any>()
  for (const key of [
    'status',
    'display',
    'default-mode',
    'microphone',
    'system-audio',
    'shortcuts',
    'drafts',
    'shortcut-status'
  ])
    fields.set(`#${key}`, { value: '', textContent: '', checked: false, append: vi.fn() })
  const start = vi.fn(async (_options) => undefined)
  const setItem = vi.fn((key, value) => {
    store.set(key, value)
  })
  const redirect = vi.fn(() => true)
  const context: any = {
    document: {
      querySelector: (key) => fields.get(key),
      querySelectorAll: () => [],
      createElement: () => ({})
    },
    window: {
      captureTools: { start, displays: async () => [], drafts: vi.fn() },
      ztools: {
        dbStorage: { getItem: (key) => store.get(key), setItem },
        internal: { dbGet: async (key) => hostStore.get(key) },
        showMainWindow: vi.fn(),
        setExpendHeight: vi.fn(),
        onPluginEnter: vi.fn(),
        redirect
      }
    }
  }
  runInNewContext(
    readFileSync(resolve('internal-plugins/capture-tools/public/app.js'), 'utf8'),
    context
  )
  return { context, store, hostStore, fields, start, setItem, redirect }
}

describe('capture plugin quick entry', () => {
  it('defaults to screenshot and validates an invalid stored mode', async () => {
    for (const saved of [undefined, 'unsupported']) {
      const item = fixture(saved)
      await item.context.start('quick')
      expect(item.start).toHaveBeenCalledWith(expect.objectContaining({ kind: 'capture' }))
    }
  })
  it.each(['capture', 'record', 'gif', 'scroll'])(
    'quick entry respects explicit %s preference',
    async (mode) => {
      const item = fixture(mode)
      await item.context.start('quick')
      expect(item.start).toHaveBeenCalledWith(expect.objectContaining({ kind: mode }))
    }
  )
  it('direct screenshot remains screenshot when quick entry defaults to recording', async () => {
    const item = fixture('record')
    await item.context.start('capture')
    expect(item.start).toHaveBeenCalledWith(expect.objectContaining({ kind: 'capture' }))
  })
  it('saves an explicit choice persistently and does not launch during preference changes', () => {
    const item = fixture()
    item.fields.get('#default-mode').value = 'scroll'
    item.context.saveDefaultMode()
    expect(item.store.get('default-mode')).toBe('scroll')
    expect(item.start).not.toHaveBeenCalled()
    expect(item.fields.get('#status').textContent).toContain('长截图')
  })
  it('restores the old selection and explains a failed preference save', () => {
    const item = fixture('capture')
    item.setItem.mockReturnValue({ error: 'failed' } as any)
    item.fields.get('#default-mode').value = 'record'
    item.context.saveDefaultMode()
    expect(item.fields.get('#default-mode').value).toBe('capture')
    expect(item.fields.get('#status').textContent).toContain('未能保存')
  })
  it('shows a central F1 conflict and redirects to the shared shortcut manager', async () => {
    const item = fixture()
    item.hostStore.set('capture-quick-shortcut-initialized', {
      status: 'failed',
      error: '已被已有功能占用'
    })
    await item.context.refreshShortcutStatus()
    expect(item.fields.get('#shortcut-status').textContent).toContain('已被已有功能占用')
    item.context.openShortcuts()
    expect(item.redirect).toHaveBeenCalledWith(['设置', '插件快捷键'])
  })
  it('reads the current binding after the user changes F1 to another key', async () => {
    const item = fixture()
    item.hostStore.set('global-shortcuts', [
      { target: 'capture-tools/快速截图', shortcut: 'Ctrl+Alt+A', enabled: true }
    ])
    await item.context.refreshShortcutStatus()
    expect(item.fields.get('#shortcut-status').textContent).toContain('Ctrl+Alt+A（全局）')
  })
})
