import { ECOSYSTEM_REMOVED_MESSAGE, isPublicPluginMarketUrl } from '../../../shared/ecosystemPolicy'
import type { HttpRequestOptions, HttpResponse } from '../../utils/httpRequest'
import { httpRequest } from '../../utils/httpRequest.js'
import { OFFICIAL_SYNC_SERVER_URL } from '../../../shared/syncServerUrl'

export const DEFAULT_SYNC_SERVER_URL = OFFICIAL_SYNC_SERVER_URL
export const DEFAULT_PLUGIN_MARKET_API_BASE = 'https://z.zosen.link/api/market'
export class PluginMarketAuthRequiredError extends Error {
  /**
   * 创建需要上游认证的错误；sTools 不接入该账号。
   * @param message 错误说明。
   * @returns 错误实例。
   */
  constructor(message = '此操作需要 ZTools 账号，sTools 仅接入公开插件市场') {
    super(message)
    this.name = 'PluginMarketAuthRequiredError'
  }
}
export const PluginMarketAuthMode = { OPTIONAL: 'optional', REQUIRED: 'required' } as const
export type PluginMarketAuthMode = (typeof PluginMarketAuthMode)[keyof typeof PluginMarketAuthMode]

/**
 * 返回公开市场的固定 API 地址。
 * @returns 市场 API 根地址。
 */
export function getPluginMarketApiBase(): string {
  return DEFAULT_PLUGIN_MARKET_API_BASE
}

/**
 * 公开市场始终匿名访问，不读取或传递旧账号凭据。
 * @param marketApiBase 保留兼容参数。
 * @returns 空认证头。
 */
export async function getPluginMarketAuthHeaders(
  marketApiBase = getPluginMarketApiBase()
): Promise<Record<string, string>> {
  void marketApiBase
  return {}
}

/**
 * 以匿名 GET 请求公开市场，不执行认证刷新或社区写操作。
 * @param path 市场相对路径或完整地址。
 * @param options 请求选项。
 * @param authMode 调用方所需认证级别。
 * @returns 市场响应。
 * @throws 请求越界、需要认证、超时或服务端失败时抛出错误。
 */
export async function requestPluginMarket(
  path: string,
  options: HttpRequestOptions = {},
  authMode: PluginMarketAuthMode = PluginMarketAuthMode.OPTIONAL
): Promise<HttpResponse> {
  if (authMode === PluginMarketAuthMode.REQUIRED) throw new PluginMarketAuthRequiredError()
  const url = path.startsWith('http') ? path : getPluginMarketApiBase() + path
  if (
    !isPublicPluginMarketUrl(url) ||
    (options.method && options.method !== 'GET') ||
    options.body
  ) {
    throw new Error('仅支持 ZTools 公开插件市场的只读接口')
  }
  // 不发送调用方传入的认证头或 Cookie，避免混用不同产品的账号。
  const response = await httpRequest(url, {
    method: 'GET',
    timeoutMs: 15000,
    validateStatus: (status) => (status >= 200 && status < 300) || status === 401 || status === 403
  })
  if (response.status === 401 || response.status === 403) throw new PluginMarketAuthRequiredError()
  return response
}

/**
 * 保留旧调用签名，但禁止保存上游市场账号。
 * @param input 旧账号信息。
 * @returns 拒绝的 Promise。
 * @throws 当前产品不支持此账号服务。
 */
export async function savePluginMarketTokens(input: {
  serverUrl?: string
  token: string
  refreshToken?: string
  username?: string
}): Promise<void> {
  void input
  throw new Error(ECOSYSTEM_REMOVED_MESSAGE)
}

/**
 * 将 WebSocket 地址转换为对应 HTTP 地址。
 * @param serverUrl 服务地址。
 * @returns HTTP 地址。
 */
export function syncServerUrlToHttp(serverUrl: string): string {
  return serverUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://')
}
