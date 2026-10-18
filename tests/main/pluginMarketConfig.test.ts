import { beforeEach, describe, expect, it, vi } from 'vitest'
const request = vi.hoisted(() => vi.fn())
vi.mock('../../src/main/utils/httpRequest.js', () => ({ httpRequest: request }))
import {
  requestPluginMarket,
  PluginMarketAuthMode,
  PluginMarketAuthRequiredError,
  getPluginMarketAuthHeaders
} from '../../src/main/api/renderer/pluginMarketConfig'

describe('anonymous ZTools market', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    request.mockResolvedValue({ status: 200, data: {} })
  })
  it('uses the fixed public endpoint without forwarding credentials or cookies', async () => {
    await requestPluginMarket('/plugins/download?name=base64', {
      headers: { Authorization: 'secret', Cookie: 'session=secret' }
    })
    expect(request).toHaveBeenCalledWith(
      'https://z.zosen.link/api/market/plugins/download?name=base64',
      expect.objectContaining({ method: 'GET', timeoutMs: 15000 })
    )
    expect(request.mock.calls[0][1].headers).toBeUndefined()
    expect(await getPluginMarketAuthHeaders()).toEqual({})
  })
  it.each(['/plugins/comments', 'https://example.com/plugins', '/plugins/../account/login'])(
    'rejects non-public path %s',
    async (p) => {
      await expect(requestPluginMarket(p)).rejects.toThrow('只读')
      expect(request).not.toHaveBeenCalled()
    }
  )
  it('rejects writes before making a request', async () => {
    await expect(requestPluginMarket('/plugins', { method: 'POST' })).rejects.toThrow('只读')
    await expect(
      requestPluginMarket('/plugins', {}, PluginMarketAuthMode.REQUIRED)
    ).rejects.toBeInstanceOf(PluginMarketAuthRequiredError)
    expect(request).not.toHaveBeenCalled()
  })
  it('reports authentication requirements without refreshing or retrying tokens', async () => {
    request.mockResolvedValue({ status: 401 })
    await expect(requestPluginMarket('/plugins/download?name=private')).rejects.toBeInstanceOf(
      PluginMarketAuthRequiredError
    )
    expect(request).toHaveBeenCalledTimes(1)
  })
})
