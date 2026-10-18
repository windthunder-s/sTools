import { ECOSYSTEM_REMOVED_MESSAGE, isRemovedEcosystemUrl } from '../../shared/ecosystemPolicy'
import { net, session } from 'electron'
import { IncomingMessage } from 'electron'

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'HEAD' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  body?: string | URLSearchParams
  timeoutMs?: number
  maxRedirects?: number
  validateStatus?: (status: number) => boolean
}

export interface HttpResponse {
  data: any
  status: number
  statusMessage: string
  headers: Record<string, string | string[]>
  request?: {
    res?: {
      responseUrl?: string
    }
  }
}

/**
 * 使用 Electron net.request 发送允许的 HTTP 请求。
 * @param url 请求地址。
 * @param options 请求参数。
 * @returns 响应 Promise；移除的生态地址会拒绝请求。
 * 注意: 代理配置已在全局 session 上设置，所有请求自动使用代理
 * 默认禁用缓存，确保每次都获取最新数据
 */
export function httpRequest(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  // 宿主统一请求层拒绝旧服务，防止隐藏页面或遗留调用重新联网。
  if (isRemovedEcosystemUrl(url, options.method || 'GET'))
    return Promise.reject(new Error(ECOSYSTEM_REMOVED_MESSAGE))
  let timer: ReturnType<typeof setTimeout> | undefined
  return new Promise<HttpResponse>((resolve, reject) => {
    const {
      method = 'GET',
      headers = {},
      body,
      validateStatus = (status) => status >= 200 && status < 300
    } = options

    // 默认禁用缓存的请求头（用户传入的 headers 可以覆盖）
    const defaultHeaders = {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      ...headers // 用户自定义的 headers 会覆盖默认值
    }

    const finalUrl = url

    const makeRequest = (requestUrl: string): void => {
      const request = net.request({
        method,
        url: requestUrl,
        redirect: 'follow', // 自动跟随重定向（manual 模式在某些 Electron 版本会导致 Redirect was cancelled 错误）
        session: session.defaultSession // 显式指定使用 defaultSession（确保代理配置生效）
      })

      // 市场请求设置截止时间，离线时及时返回缓存或重试入口。
      if (options.timeoutMs)
        timer = setTimeout(() => {
          reject(new Error('请求超时，请检查网络后重试'))
          request.abort()
        }, options.timeoutMs)

      // 设置请求头（包含默认的禁用缓存头）
      Object.entries(defaultHeaders).forEach(([key, value]) => {
        request.setHeader(key, value)
      })

      // 处理响应
      request.on('response', (response: IncomingMessage) => {
        const chunks: Buffer[] = []
        const responseHeaders: Record<string, string | string[]> = {}

        // 收集响应头
        Object.entries(response.headers).forEach(([key, value]) => {
          responseHeaders[key] = value
        })

        // 收集响应数据
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })

        response.on('end', () => {
          const buffer = Buffer.concat(chunks)
          let data: any

          // 根据 Content-Type 解析数据
          const contentType = response.headers['content-type']
          const contentTypeStr = Array.isArray(contentType) ? contentType[0] : contentType

          if (contentTypeStr?.includes('application/json')) {
            try {
              data = JSON.parse(buffer.toString('utf-8'))
            } catch {
              data = buffer.toString('utf-8')
            }
          } else {
            data = buffer.toString('utf-8')
          }

          const httpResponse: HttpResponse = {
            data,
            status: response.statusCode || 0,
            statusMessage: response.statusMessage || '',
            headers: responseHeaders,
            request: {
              res: {
                responseUrl: finalUrl
              }
            }
          }

          // 验证状态码
          if (validateStatus(httpResponse.status)) {
            resolve(httpResponse)
          } else {
            reject(
              new Error(
                `Request failed with status code ${httpResponse.status}: ${httpResponse.statusMessage}`
              )
            )
          }
        })

        response.on('error', (error: Error) => {
          reject(error)
        })
      })

      // 处理请求错误
      request.on('error', (error: Error) => {
        reject(error)
      })

      // 发送请求体
      if (body) {
        if (body instanceof URLSearchParams) {
          request.write(body.toString())
        } else {
          request.write(body)
        }
      }

      // 结束请求
      request.end()
    }

    makeRequest(url)
  }).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * GET 请求
 */
export function httpGet(
  url: string,
  options: Omit<HttpRequestOptions, 'method'> = {}
): Promise<HttpResponse> {
  return httpRequest(url, { ...options, method: 'GET' })
}

/**
 * POST 请求
 */
export function httpPost(
  url: string,
  body?: string | URLSearchParams,
  options: Omit<HttpRequestOptions, 'method' | 'body'> = {}
): Promise<HttpResponse> {
  return httpRequest(url, { ...options, method: 'POST', body })
}

/**
 * HEAD 请求
 */
export function httpHead(
  url: string,
  options: Omit<HttpRequestOptions, 'method'> = {}
): Promise<HttpResponse> {
  return httpRequest(url, { ...options, method: 'HEAD' })
}
