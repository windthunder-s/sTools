import { beforeEach, afterEach, describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { LocalIndex } = require('../../resources/search/index-worker.cjs')
const { NtfsIndex } = require('../../resources/search/ntfs-index.cjs')
let directory: string, root: string, index: any

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stools-fast-unit-'))
  root = path.join(directory, 'files')
  await fs.mkdir(root)
  index = new LocalIndex(path.join(directory, 'index.sqlite'), {
    roots: [root],
    excluded: ['ignored'],
    nativeDisabled: true
  })
})
afterEach(async () => {
  index?.close()
  if (
    !path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
    !path.basename(directory).startsWith('stools-fast-unit-')
  )
    throw new Error('Unsafe cleanup')
  await fs.rm(directory, { recursive: true, force: true })
})

describe('paged filename search', () => {
  it('keeps page versions stable during unchanged reconciliation and duplicate notifications', async () => {
    const file = path.join(root, '稳定分页.txt')
    await fs.writeFile(file, 'fixture')
    await index.reconcile()
    const original = index.search('稳定分页').version
    await index.reconcile()
    expect(index.state.version).toBe(original)
    index.pending.add(file)
    await index.flushChanges()
    expect(index.state.version).toBe(original)
    expect(index.search('稳定分页', 'all', 100, original).reset).toBe(false)
  })
  it('returns every page and category from one stable sorted result set', async () => {
    for (let n = 0; n < 235; n++)
      await fs.writeFile(path.join(root, `分页验收 ${String(n).padStart(3, '0')}.txt`), 'fixture')
    await fs.writeFile(path.join(root, '分页验收 app.exe'), 'fixture')
    await index.reconcile()
    const first = index.search('分页验收'),
      second = index.search('分页验收', 'all', 100, first.version),
      third = index.search('分页验收', 'all', 200, first.version)
    expect(first.total).toBe(236)
    expect(first.buckets.app.total).toBe(1)
    expect(second.items).toHaveLength(100)
    expect(third.items).toHaveLength(36)
    expect(third.limited).toBe(false)
    expect(
      new Set([...first.items, ...second.items, ...third.items].map((item: any) => item.path)).size
    ).toBe(236)
    expect(index.search('分页验收', 'file', 200, first.version).items).toHaveLength(35)
  })
  it('resets stale page offsets after insertion instead of skipping or duplicating matches', async () => {
    await fs.writeFile(path.join(root, '版本验收.txt'), 'fixture')
    await index.reconcile()
    const original = index.search('版本验收')
    const added = path.join(root, '版本验收 新.txt')
    await fs.writeFile(added, 'fixture')
    index.pending.add(added)
    await index.flushChanges()
    const next = index.search('版本验收', 'all', 100, original.version)
    expect(next.reset).toBe(true)
    expect(next.offset).toBe(0)
    expect(next.items).toHaveLength(2)
  })
  it('supports wildcard, quoted phrase, ext, exclusion and path filters without SQL interpolation', async () => {
    for (const name of [
      'Report final 2026.pdf',
      'Report draft 2026.pdf',
      'Report final 2026.pdf.bak',
      'Report final 2026.txt',
      '100%_literal.txt',
      "quote'文件.txt"
    ])
      await fs.writeFile(path.join(root, name), 'fixture')
    await fs.mkdir(path.join(root, 'Report folder.pdf'))
    await index.reconcile()
    expect(index.search('report ext:pdf !draft').items.map((item: any) => item.name)).toEqual([
      'Report final 2026.pdf'
    ])
    expect(index.search('"report final" ext:pdf;txt').total).toBe(2)
    expect(index.search('report*202?.pdf').total).toBe(2)
    expect(index.search('*.pdf').total).toBe(3)
    expect(index.search('100%_literal').total).toBe(1)
    expect(index.search("quote'文件").total).toBe(1)
    expect(index.search(`path:"${root}" ext:txt`).total).toBe(3)
    expect(() => index.search('"unfinished')).toThrow('双引号')
    expect(() => index.search('ext:')).toThrow('扩展名')
  })
  it('removes one subtree without touching similarly prefixed paths', async () => {
    for (const folder of ['前缀', '前缀-保留']) {
      await fs.mkdir(path.join(root, folder))
      await fs.writeFile(path.join(root, folder, '验收.txt'), 'fixture')
    }
    await index.reconcile()
    index.deleteTree(index.keyOf(path.join(root, '前缀')))
    expect(index.search('验收').items[0].path).toContain('前缀-保留')
    expect(index.search('验收').total).toBe(1)
  })
})

/**
 * Create an NTFS graph whose paths remain inside the temporary test scope.
 * @returns Controllable snapshot and journal transport plus file-reference helpers.
 */
function journalFixture() {
  const volume = path.parse(root).root.slice(0, 2).toUpperCase()
  let nextId = 100,
    cursor = 1000,
    snapshots = 0,
    reset = false,
    failSnapshot = false
  const nodes = new Map<string, any>(),
    changes: any[] = []
  nodes.set('5', { id: '5', parent: '5', name: '.', attributes: 16, reason: 0 })
  let parent = '5'
  for (const segment of root.slice(path.parse(root).root.length).split(path.sep)) {
    const id = String(nextId++)
    nodes.set(id, { id, parent, name: segment, attributes: 16, reason: 0 })
    parent = id
  }
  const rootId = parent
  /**
   * Add a file/directory to the emulated current MFT.
   * @param name Entry basename.
   * @param parentId Parent reference.
   * @param directory Whether the entry is a directory.
   * @param attributes Additional NTFS attributes.
   * @returns File reference.
   */
  function add(name: string, parentId = rootId, directory = false, attributes = 0) {
    const id = String(nextId++)
    nodes.set(id, {
      id,
      parent: parentId,
      name,
      attributes: (directory ? 16 : 0) | attributes,
      reason: 0x100
    })
    return id
  }
  /**
   * Deliver a bounded snapshot or a durable journal suffix.
   * @param args Native command arguments.
   * @param receive Consumer for validated records.
   * @returns Journal endpoint.
   */
  async function read(args: string[], receive: Function) {
    if (args[0] === 'snapshot') {
      snapshots++
      for (const row of nodes.values()) await receive(row)
      if (failSnapshot) throw new Error('interrupted snapshot')
    } else {
      if (reset) {
        reset = false
        throw new Error('JOURNAL_RESET: full snapshot required')
      }
      for (const row of changes.splice(0)) await receive(row)
    }
    return { journal: '90071992547409999', next: String(++cursor) }
  }
  /**
   * Change a file identity and append the exact resulting journal record.
   * @param id File reference.
   * @param update New name, parent, attributes or reason.
   * @returns No value.
   */
  function change(id: string, update: object) {
    const row = { ...nodes.get(id), reason: 0x2000, ...update }
    changes.push(row)
    if (row.reason & 0x200) nodes.delete(id)
    else nodes.set(id, row)
  }
  return {
    volume,
    add,
    change,
    nodes,
    rootId,
    read,
    get snapshots() {
      return snapshots
    },
    set reset(value: boolean) {
      reset = value
    },
    set failSnapshot(value: boolean) {
      failSnapshot = value
    }
  }
}

describe.skipIf(process.platform !== 'win32')('MFT snapshots and USN replay', () => {
  it('resolves full 64-bit root references when the MFT snapshot omits the root record', async () => {
    const fixture = journalFixture()
    fixture.nodes.delete('5')
    for (const node of fixture.nodes.values())
      if (node.parent === '5') node.parent = '1407374883553285'
    fixture.add('根目录缺失验收.txt')
    const native = new NtfsIndex(index, fixture.read)
    await native.sync(fixture.volume)
    expect(index.search('根目录缺失验收').items[0].path).toBe(path.join(root, '根目录缺失验收.txt'))
    expect(fixture.snapshots).toBe(1)
  })

  it('rebuilds an older persisted projection when the root resolver version changes', async () => {
    const fixture = journalFixture()
    fixture.add('升级恢复.txt')
    const native = new NtfsIndex(index, fixture.read)
    await native.sync(fixture.volume)
    index.db.exec('DELETE FROM entries')
    index.db
      .prepare('UPDATE ntfs_volumes SET signature=?')
      .run(JSON.stringify([index.config.roots, index.config.excluded, index.config.dataDirectory]))
    await native.sync(fixture.volume)
    expect(fixture.snapshots).toBe(2)
    expect(index.search('升级恢复').total).toBe(1)
  })
  it('keeps pagination stable when USN repeats cumulative create and rename reasons', async () => {
    const fixture = journalFixture()
    const folder = fixture.add('稳定目录', undefined, true)
    const file = fixture.add('稳定文件.txt', folder)
    const native = new NtfsIndex(index, fixture.read)
    await native.sync(fixture.volume)
    const first = index.search('稳定')
    fixture.change(folder, { reason: 0x80000100 })
    fixture.change(file, { reason: 0x80002000 })
    await native.sync(fixture.volume)
    expect(index.search('稳定').version).toBe(first.version)
    expect(index.count()).toBe(2)
    fixture.change(folder, { name: '真正改名' })
    await native.sync(fixture.volume)
    expect(index.search('稳定文件').items[0].path).toBe(path.join(root, '真正改名', '稳定文件.txt'))
  })
  it('handles directory rename, exclusion moves, reparse points and subtree deletion', async () => {
    const fixture = journalFixture()
    const folder = fixture.add('原始目录', undefined, true)
    const file = fixture.add('原始文件.txt', folder)
    const link = fixture.add('联接', undefined, true, 0x400)
    fixture.add('不应泄漏.txt', link)
    const native = new NtfsIndex(index, fixture.read)
    await native.sync(fixture.volume)
    expect(index.search('原始').total).toBe(2)
    expect(index.search('不应泄漏').total).toBe(0)
    fixture.change(folder, { name: '新目录' })
    await native.sync(fixture.volume)
    expect(index.search('原始文件').items[0].path).toBe(path.join(root, '新目录', '原始文件.txt'))
    fixture.change(folder, { name: 'ignored' })
    await native.sync(fixture.volume)
    expect(index.search('原始文件').total).toBe(0)
    fixture.change(folder, { name: '恢复目录' })
    await native.sync(fixture.volume)
    expect(index.search('原始文件').total).toBe(1)
    fixture.change(file, { reason: 0x200 })
    fixture.change(folder, { reason: 0x200 })
    await native.sync(fixture.volume)
    expect(index.count()).toBe(0)
    expect(fixture.snapshots).toBe(1)
  })
  it('persists its cursor across restart and does not rebuild or invalidate queries when idle', async () => {
    const fixture = journalFixture()
    fixture.add('持久验收.txt')
    await new NtfsIndex(index, fixture.read).sync(fixture.volume)
    const version = index.state.version
    await new NtfsIndex(index, fixture.read).sync(fixture.volume)
    expect(index.state.version).toBe(version)
    index.close()
    index = new LocalIndex(path.join(directory, 'index.sqlite'), {
      roots: [root],
      excluded: ['ignored'],
      nativeDisabled: true
    })
    await new NtfsIndex(index, fixture.read).sync(fixture.volume)
    expect(fixture.snapshots).toBe(1)
    expect(index.search('持久验收').total).toBe(1)
  })
  it('rebuilds after journal rollover and retries an interrupted snapshot without committing its cursor', async () => {
    const fixture = journalFixture()
    fixture.add('日志验收.txt')
    const native = new NtfsIndex(index, fixture.read)
    await native.sync(fixture.volume)
    fixture.reset = true
    await native.sync(fixture.volume)
    expect(fixture.snapshots).toBe(2)
    fixture.failSnapshot = true
    await expect(native.sync(fixture.volume, true)).rejects.toThrow('interrupted')
    expect(index.search('日志验收').total).toBe(1)
    expect(index.db.prepare('SELECT dirty FROM ntfs_volumes').get().dirty).toBe(1)
    fixture.failSnapshot = false
    await native.sync(fixture.volume)
    expect(fixture.snapshots).toBe(4)
    expect(index.db.prepare('SELECT dirty FROM ntfs_volumes').get().dirty).toBe(0)
  })
})
