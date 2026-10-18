import { describe, it, expect } from 'vitest'
import {
  everythingCategory,
  searchCategory,
  uniqueEverythingItems
} from '../../src/shared/unifiedSearch'
describe('unified search classification', () => {
  it('separates built-in settings and system commands from actual plugins', () => {
    expect(searchCategory({ type: 'plugin', pluginName: 'setting' })).toBe('system')
    expect(searchCategory({ type: 'plugin', pluginName: 'system' })).toBe('system')
    expect(searchCategory({ type: 'plugin', pluginName: 'local-tools' })).toBe('plugin')
    expect(searchCategory({ type: 'direct', subType: 'system-setting' })).toBe('system')
  })
  it('classifies executable suffixes without treating similarly named folders as programs', () => {
    expect(everythingCategory({ name: 'tool.EXE', path: 'D:/tool.EXE', directory: false })).toBe(
      'app'
    )
    expect(everythingCategory({ name: 'tool.lnk', path: 'D:/tool.lnk', directory: false })).toBe(
      'app'
    )
    expect(everythingCategory({ name: 'tool.exe', path: 'D:/tool.exe', directory: true })).toBe(
      'folder'
    )
    expect(
      everythingCategory({ name: 'tool.exe.txt', path: 'D:/tool.exe.txt', directory: false })
    ).toBe('file')
  })
  it('deduplicates Windows paths while preserving unrelated files and plugin folders', () => {
    const items = [
      { name: 'tool.exe', path: 'D:/Apps/TOOL.exe', directory: false },
      { name: 'data.txt', path: 'D:/data.txt', directory: false },
      { name: 'data.txt', path: 'd:/DATA.txt', directory: false },
      { name: 'plugin', path: 'D:/plugin', directory: true }
    ]
    expect(
      uniqueEverythingItems(items, [
        { path: 'd:\\apps\\tool.exe', type: 'direct' },
        { path: 'D:/plugin', type: 'plugin' }
      ]).map((item) => item.name)
    ).toEqual(['data.txt', 'plugin'])
  })
})
