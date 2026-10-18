import { describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ handle: vi.fn(), request: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle },
  net: { request: mocks.request },
  session: { defaultSession: {} }
}))
import { isRemovedEcosystemChannel, isRemovedEcosystemUrl } from '../../src/shared/ecosystemPolicy'
import { registerProductHandler } from '../../src/main/core/productIpc'
import { httpRequest } from '../../src/main/utils/httpRequest'

describe('sTools public market and local account boundary', () => {
  it.each([
    'internal:create-plugin-market-comment',
    'internal:fetch-plugin-market-comments',
    'delete-plugin-market-comment',
    'sync:save-config',
    'account:login',
    'internal:notification-summary',
    'internal:ai-providers:get-official',
    'internal:ai-providers-get-official'
  ])('rejects the removed handler %s before executing it', async (channel) => {
    const handler = vi.fn()
    registerProductHandler(channel, handler)
    const registered = mocks.handle.mock.calls.at(-1)![1]
    expect(await registered({})).toMatchObject({ success: false, code: 'SERVICE_REMOVED' })
    expect(handler).not.toHaveBeenCalled()
  })
  it.each([
    'internal:fetch-plugin-market',
    'install-plugin-from-market',
    'upgrade-plugin-from-market',
    'internal:cancel-plugin-market-download',
    'internal:install-plugin-from-path',
    'internal:register-global-shortcut',
    'get-plugins',
    'ai-providers:add'
  ])('keeps the local capability %s', (channel) => {
    const handler = vi.fn()
    expect(isRemovedEcosystemChannel(channel)).toBe(false)
    registerProductHandler(channel, handler)
    expect(mocks.handle.mock.calls.at(-1)![1]).toBe(handler)
  })
  it('blocks original service requests before net.request', async () => {
    for (const url of [
      'https://z.zosen.link/api/market/plugins/comments',
      'https://z-tools.top/api/auth/login'
    ]) {
      await expect(httpRequest(url)).rejects.toThrow('已移除')
    }
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('permits only GET requests to the exact public market origin and paths', () => {
    expect(isRemovedEcosystemUrl('https://z.zosen.link/api/market/plugins?platform=win32')).toBe(
      false
    )
    expect(isRemovedEcosystemUrl('https://z.zosen.link/api/market/plugins', 'POST')).toBe(true)
    expect(isRemovedEcosystemUrl('https://evil.z.zosen.link/api/market/plugins')).toBe(true)
    expect(isRemovedEcosystemUrl('https://z.zosen.link/api/auth/login')).toBe(true)
  })
  it('does not confuse user-configured providers with removed hosts', () => {
    expect(isRemovedEcosystemUrl('https://api.example.com')).toBe(false)
    expect(isRemovedEcosystemUrl('http://127.0.0.1:1234')).toBe(false)
    expect(isRemovedEcosystemUrl('https://z.zosen.link.example.com')).toBe(false)
  })
})
