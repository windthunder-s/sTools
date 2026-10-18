import { beforeEach, afterEach, describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
const { LocalIndex } = createRequire(import.meta.url)('../../resources/search/index-worker.cjs')
let directory: string
let root: string
let index: any
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stools-index-unit-'))
  root = path.join(directory, 'files')
  await fs.mkdir(root)
})
afterEach(async () => {
  index?.close()
  index = undefined
  if (
    !directory.startsWith(os.tmpdir()) ||
    !path.basename(directory).startsWith('stools-index-unit-')
  )
    throw new Error('Unsafe fixture path')
  await fs.rm(directory, { recursive: true, force: true })
})
/**
 * 使用隔离数据库创建待测索引。
 * @param excluded 排除的目录名称。
 * @param roots 搜索根目录。
 * @returns 无返回值。
 */
function openIndex(excluded: string[] = [], roots = [root]): void {
  index = new LocalIndex(path.join(directory, 'index.sqlite'), {
    roots,
    excluded,
    nativeDisabled: true
  })
}
describe('内置文件索引', () => {
  it('真实扫描中文、字面特殊字符、路径与程序分类，并持久复用', async () => {
    await fs.writeFile(path.join(root, '中文文件ABC.txt'), 'fixture')
    await fs.writeFile(path.join(root, '100%_验收.txt'), 'fixture')
    await fs.writeFile(path.join(root, '100xx验收.txt'), 'fixture')
    await fs.writeFile(path.join(root, '中文程序.exe'), 'not executable')
    await fs.mkdir(path.join(root, '中文目录'))
    openIndex()
    await index.reconcile()
    expect(index.search('abc').items[0].name).toBe('中文文件ABC.txt')
    expect(index.search('100%_').items.map((item: any) => item.name)).toEqual(['100%_验收.txt'])
    expect(index.search('中文').buckets.app.items[0].name).toBe('中文程序.exe')
    expect(index.search('中文').buckets.folder.items[0].directory).toBe(true)
    expect(index.search(root.replace(/\\/g, '/') + '/中文').items).toHaveLength(3)
    index.close()
    openIndex()
    expect(index.search('中文').items).toHaveLength(3)
  })
  it('各类型从完整索引查询，超过全部结果上限也能查到应用', async () => {
    await Promise.all(
      Array.from({ length: 120 }, (_, n) =>
        fs.writeFile(path.join(root, '验收' + n.toString().padStart(3, '0') + '.txt'), 'fixture')
      )
    )
    await fs.writeFile(path.join(root, '验收zzz.exe'), 'not executable')
    openIndex()
    await index.reconcile()
    const result = index.search('验收')
    expect(result.items).toHaveLength(100)
    expect(result.limited).toBe(true)
    expect(result.buckets.app.items[0].name).toBe('验收zzz.exe')
    expect(result.buckets.app.limited).toBe(false)
  })
  it('增量更新新增、重命名和删除目录子树，不修改源文件', async () => {
    openIndex()
    await index.reconcile()
    const original = path.join(root, '变化目录')
    const renamed = path.join(root, '变化目录新')
    await fs.mkdir(original)
    await fs.writeFile(path.join(original, '变化文件.txt'), 'retained contents')
    index.pending.add(original)
    await index.flushChanges()
    expect(index.search('变化').items).toHaveLength(2)
    await fs.rename(original, renamed)
    index.pending.add(original)
    index.pending.add(renamed)
    await index.flushChanges()
    expect(index.search('变化').items.every((item: any) => item.path.startsWith(renamed))).toBe(
      true
    )
    expect(await fs.readFile(path.join(renamed, '变化文件.txt'), 'utf8')).toBe('retained contents')
    await fs.rm(renamed, { recursive: true })
    index.pending.add(renamed)
    await index.flushChanges()
    expect(index.search('变化').items).toHaveLength(0)
  })
  it('排除目录、移除搜索范围及循环联接均不会泄漏旧结果', async () => {
    const ignored = path.join(root, 'ignored')
    await fs.mkdir(ignored)
    await fs.writeFile(path.join(ignored, '隐藏验收.txt'), 'fixture')
    await fs.writeFile(path.join(root, '公开验收.txt'), 'fixture')
    await fs.symlink(
      root,
      path.join(root, 'loop'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    openIndex()
    await index.reconcile()
    expect(index.search('验收').items).toHaveLength(2)
    index.close()
    openIndex(['ignored'])
    await index.reconcile()
    expect(index.search('验收').items.map((item: any) => item.name)).toEqual(['公开验收.txt'])
    index.close()
    openIndex([], [])
    await index.reconcile()
    expect(index.count()).toBe(0)
  })
})

it('同名目录替换成文件后不会遗留后代索引', async () => {
  const folder = path.join(root, '替换验收')
  await fs.mkdir(folder)
  await fs.writeFile(path.join(folder, '替换验收子项.txt'), 'fixture')
  openIndex()
  await index.reconcile()
  await fs.rm(folder, { recursive: true })
  await fs.writeFile(folder, 'fixture')
  index.pending.add(folder)
  await index.flushChanges()
  expect(index.search('替换验收').items).toEqual([
    { name: '替换验收', path: folder, directory: false }
  ])
})
