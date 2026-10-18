import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  createBackend,
  searchExpression
} = require('../../internal-plugins/local-tools/public/backend.cjs')
const roots: string[] = []

/**
 * 创建隔离路径和可观测的进程适配器。
 * @returns 测试上下文。
 */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stools-tools-unit-'))
  roots.push(root)
  let config: Record<string, string> = { instance: 'isolated' }
  for (const [key, name] of Object.entries({
    everything: 'Everything.exe',
    es: 'es.exe',
    snipaste: 'Snipaste.exe'
  })) {
    config[key] = path.join(root, name)
    fs.writeFileSync(config[key], '')
  }
  const run = vi.fn().mockResolvedValue({ stdout: '' })
  const start = vi.fn().mockResolvedValue(42)
  const ready = vi.fn().mockResolvedValue(undefined)
  const hide = vi.fn().mockResolvedValue(undefined)
  const show = vi.fn().mockResolvedValue(undefined)
  const api = createBackend({
    getConfig: () => config,
    saveConfig: (value: any) => {
      config = value
    },
    run,
    start,
    ready,
    hide,
    show
  })
  return { api, root, run, start, ready, hide, show, config }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (
      !path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(root).startsWith('stools-tools-unit-')
    )
      throw new Error('Unsafe cleanup')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('local Everything and Snipaste integration', () => {
  it('encodes user text as one regex parameter instead of CLI switches or shell syntax', () => {
    const expression = searchExpression('-exit "中文 & $(bad)"')
    expect(expression).toMatch(/^regex:/)
    expect(expression).not.toMatch(/[\s"&$]/)
    expect(expression).toContain('\\x{4e2d}')
    expect(() => searchExpression('a\u0000b')).toThrow()
    expect(() => searchExpression('a'.repeat(501))).toThrow()
  })
  it('queries folders with a bounded result count, no shell and a named instance', async () => {
    const { api, run, start, root } = setup()
    const folder = path.join(root, '中文 文件夹')
    fs.mkdirSync(folder)
    run.mockResolvedValue({ stdout: '\uFEFF' + folder + '\r\n' })
    expect(await api.search('中文 文件', 'folder')).toEqual([
      { path: folder, name: '中文 文件夹', directory: true }
    ])
    expect(start.mock.calls[0][1]).toEqual(['-instance', 'isolated', '-startup'])
    expect(run.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['/ad', '-n', '100', '-instance', 'isolated'])
    )
    expect(run.mock.calls[0][2]).toMatchObject({ shell: false, timeout: 6500, windowsHide: true })
  })
  it('empty query cancels in-flight work without launching another query', async () => {
    const { api, run } = setup()
    let aborted = false
    run.mockImplementation(
      (_exe, _args, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('abort'))
          })
        })
    )
    const first = api.search('old')
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(await api.search('')).toEqual([])
    expect(await first).toEqual([])
    expect(aborted).toBe(true)
    expect(run).toHaveBeenCalledOnce()
  })
  it('reports unavailable indexing rather than displaying an empty success', async () => {
    const { api, run } = setup()
    run.mockRejectedValue(new Error('Everything IPC not found'))
    await expect(api.search('test')).rejects.toThrow('Everything 查询失败')
  })
  it('rejects an invalid configured path without silently using a different installation', async () => {
    const { api, config } = setup()
    expect(() => api.configure({ es: 'C:\\missing\\es.exe' })).toThrow('请选择有效')
    fs.unlinkSync(config.snipaste)
    await expect(api.snipaste('snip')).rejects.toThrow('选择 Snipaste.exe')
    expect(api.status().snipasteReady).toBe(false)
  })
  it('waits for cold Snipaste startup and hides sTools before invoking capture', async () => {
    const { api, start, ready, hide, run } = setup()
    await api.snipaste('snip')
    expect(start.mock.calls[0][1]).toEqual([])
    expect(ready).toHaveBeenCalledWith(42)
    expect(ready.mock.invocationCallOrder[0]).toBeLessThan(hide.mock.invocationCallOrder[0])
    expect(hide.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0])
    expect(run.mock.calls[0][1]).toEqual(['snip'])
  })
  it('deduplicates simultaneous screenshot triggers and restores sTools on command failure', async () => {
    const { api, run, show } = setup()
    run.mockRejectedValue(new Error('launch failed'))
    const first = api.snipaste('paste')
    await api.snipaste('paste')
    await expect(first).rejects.toThrow('Snipaste 调用失败')
    expect(run).toHaveBeenCalledOnce()
    expect(show).toHaveBeenCalledOnce()
    await expect(api.snipaste('exit')).rejects.toThrow('不支持')
  })
})
