// 插件市场独立启用；sTools 账号仍使用自己的登录入口。
export const ZTOOLS_ECOSYSTEM_ENABLED = false
export const PLUGIN_MARKET_ENABLED = true
export const ECOSYSTEM_REMOVED_MESSAGE = 'sTools 已移除 ZTools 账号、云同步及社区服务'

const MARKET_CHANNELS = new Set([
  'fetch-plugin-market',
  'fetch-plugin-market-recommendations',
  'install-plugin-from-market',
  'upgrade-plugin-from-market',
  'open-plugin-market-detail',
  'cancel-plugin-market-download'
])

/**
 * 仅开放插件浏览、安装和更新，继续隔离旧账号和社区接口。
 * @param channel IPC 通道名称。
 * @returns 是否必须拒绝执行处理器。
 */
export function isRemovedEcosystemChannel(channel: string): boolean {
  const normalized = channel.replace(/^internal:/, '')
  if (PLUGIN_MARKET_ENABLED && MARKET_CHANNELS.has(normalized)) return false
  return (
    /^(sync:|account:)/.test(normalized) ||
    /plugin-market|plugin-from-market|notification/.test(normalized) ||
    /^ai-providers[:-]get-official$/.test(normalized)
  )
}

/**
 * 识别当前启用的 ZTools 公共市场只读地址。
 * @param input 请求地址。
 * @returns 地址是否属于公开插件 API。
 */
export function isPublicPluginMarketUrl(input: string): boolean {
  try {
    const url = new URL(input)
    return (
      PLUGIN_MARKET_ENABLED &&
      url.origin === 'https://z.zosen.link' &&
      !url.username &&
      !url.password &&
      /^\/api\/market\/plugins(?:\/(?:recommendations|rankings|latest|download|readme))?$/.test(
        url.pathname
      )
    )
  } catch {
    return false
  }
}

/**
 * 拦截旧云服务，只为公开市场 GET 请求保留例外。
 * @param input 请求地址。
 * @param method HTTP 请求方法。
 * @returns 是否属于禁止访问的旧服务地址。
 */
export function isRemovedEcosystemUrl(input: string, method = 'GET'): boolean {
  if (method === 'GET' && isPublicPluginMarketUrl(input)) return false
  try {
    const host = new URL(input).hostname.toLowerCase()
    return ['z.zosen.link', 'z-tools.top'].some(
      (domain) => host === domain || host.endsWith('.' + domain)
    )
  } catch {
    return false
  }
}
