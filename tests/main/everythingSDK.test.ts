import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
const { createSDKBackend, sdkOptions } = createRequire(import.meta.url)('../../resources/search/everything-sdk.cjs')
const config = { everythingReady: true, everything: 'D:/Everything/Everything.exe', instance: 'unit' }

/**
 * Build a deterministic category batch for cache and pagination checks.
 * @param name Marker used to detect stale responses.
 * @returns Mock SDK category pages.
 */
function batch(name = 'first') {
  return { buckets: Object.fromEntries(['all', 'app', 'file', 'folder'].map((key) => [key, {
    items: [{ name, path: 'D:/' + name, directory: key === 'folder' }],
    total: 3, offset: 0, limited: true, hash: name, prefixHash: ''
  }])) }
}
afterEach(() => vi.useRealTimers())
describe('Everything SDK host adapter', () => {
  it('passes native syntax unchanged and reuses every category without another query', async () => {
    const execute = vi.fn(async () => batch())
    const sdk = createSDKBackend({ execute, getConfig: () => config })
    const query = '<"two words" | regex:^S.*> size:>10mb dm:today !ext:tmp'
    await sdk.search(query, 'all')
    for (const filter of ['app', 'file', 'folder', 'all']) await sdk.search(query, filter)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][0]).toMatchObject({ query, action: 'query', instance: 'unit', sort: 1 })
  })
  it('continues a stable prefix and resets after edits inside the displayed prefix', async () => {
    const execute = vi.fn().mockResolvedValueOnce(batch()).mockResolvedValueOnce({ items: [{ name: 'second', path: 'D:/second' }], total: 3, offset: 1, limited: true, hash: 'second', prefixHash: 'first' })
      .mockResolvedValueOnce({ items: [], total: 3, offset: 2, limited: false, hash: 'changed', prefixHash: 'changed' }).mockResolvedValueOnce(batch('changed'))
    const sdk = createSDKBackend({ execute, getConfig: () => config })
    const first = await sdk.search('x', 'file')
    const next = await sdk.search('x', 'file', { offset: 1, version: first.version })
    expect(next.offset).toBe(1)
    expect(next.version).toBe(first.version)
    const reset = await sdk.search('x', 'file', { offset: 2, version: first.version })
    expect(reset.offset).toBe(0)
    expect(reset.items[0].name).toBe('changed')
    expect(reset.version).toBeGreaterThan(first.version)
  })
  it('does not let a cancelled late response replace a newer query', async () => {
    let release: (result: object) => void = () => {}
    const execute = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { release = resolve })).mockResolvedValue(batch('new'))
    const sdk = createSDKBackend({ execute, getConfig: () => config })
    const old = sdk.search('old').catch((error: Error) => error.message)
    sdk.cancelSearch()
    await sdk.search('new')
    release(batch('old'))
    expect(await old).toBe('查询已取消')
    expect((await sdk.search('new')).items[0].name).toBe('new')
    expect(execute).toHaveBeenCalledTimes(2)
  })
  it('invalidates cached results when matching options or connection change', async () => {
    const execute = vi.fn(async () => batch())
    const sdk = createSDKBackend({ execute, getConfig: () => config })
    await sdk.search('Name')
    await sdk.search('Name', 'all', {}, { sort: 14, matchCase: true })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1][0]).toMatchObject({ sort: 14, matchCase: true })
    expect(() => sdkOptions({ sort: 999 })).toThrow()
    await expect(sdk.search('bad\0query')).rejects.toThrow()
    await expect(sdk.search('x', 'all', { offset: -1 })).rejects.toThrow()
  })
  it('recovers after connection validation failed synchronously', async () => {
    vi.useFakeTimers()
    let ready = false
    const execute = vi.fn(async () => ({ version: '1.4.1.1032', count: 123 }))
    const sdk = createSDKBackend({ execute, getConfig: () => ({ ...config, everythingReady: ready }) })
    expect((await sdk.status()).phase).toBe('error')
    ready = true
    vi.advanceTimersByTime(2001)
    expect((await sdk.status()).phase).toBe('ready')
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('changes the live revision only when the queried result heads actually change', async () => {
    vi.useFakeTimers()
    let changed = false
    const execute = vi.fn(async (request) => request.action === 'status' ? { version: '1.4.1.1032', count: 123 } : batch(changed ? 'changed' : 'first'))
    const sdk = createSDKBackend({ execute, getConfig: () => config })
    const first = await sdk.search('x')
    expect((await sdk.status()).version).toBe(first.version)
    changed = true
    vi.advanceTimersByTime(2001)
    expect((await sdk.status()).version).toBeGreaterThan(first.version)
    expect((await sdk.search('x')).items[0].name).toBe('changed')
  })
})
