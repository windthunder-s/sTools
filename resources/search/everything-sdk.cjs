const path = require('node:path')
const { spawn } = require('node:child_process')
const filters = ['all', 'app', 'file', 'folder']

/**
 * Normalize supported SDK options without changing the user's Everything expression.
 * @param {object} value Saved matching and sorting preferences.
 * @returns {object} Validated SDK options.
 * @throws {Error} Unsupported sort or non-boolean matching setting.
 */
function sdkOptions(value = {}) {
  const result = { sort: value.sort ?? 1 }
  if (![1, 2, 3, 4, 5, 6, 13, 14].includes(result.sort)) throw new Error('Everything 排序设置无效')
  for (const key of ['matchCase', 'matchPath', 'matchWholeWord']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean')
      throw new Error('Everything 匹配设置无效')
    result[key] = value[key] ?? false
  }
  return result
}

/**
 * Run a short-lived SDK bridge; cancellation never terminates Everything itself.
 * @param {string} helper Absolute bridge executable path.
 * @param {object} request JSON request, written to stdin without shell interpolation.
 * @param {AbortSignal} signal Host cancellation signal.
 * @returns {Promise<object>} Decoded SDK response.
 * @throws {Error} Launch, timeout, response-size, protocol or SDK failure.
 */
function executeBridge(helper, request, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [], {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal
    })
    const output = []
    let size = 0,
      settled = false
    const timer = setTimeout(() => finish(new Error('Everything SDK 查询超时')), 45000)
    /**
     * Settle once and reclaim the helper on all error paths.
     * @param {Error | null} error Failure, if any.
     * @param {object} value Parsed response.
     * @returns {void} No value.
     */
    function finish(error, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        child.kill()
        reject(error)
      } else resolve(value)
    }
    child.once('error', (error) => finish(error))
    child.stdin.on('error', (error) => finish(error))
    child.stderr.resume()
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > 16 * 1024 * 1024) finish(new Error('Everything SDK 返回内容过大，请缩小范围'))
      else output.push(chunk)
    })
    child.once('close', (code) => {
      if (settled) return
      try {
        const value = JSON.parse(
          Buffer.concat(output)
            .toString('utf8')
            .replace(/^\uFEFF/, '')
        )
        if (value.error || code !== 0) throw new Error(value.error || 'Everything SDK 进程异常退出')
        finish(null, value)
      } catch (error) {
        finish(error)
      }
    })
    child.stdin.end(JSON.stringify(request))
  })
}

/**
 * Own SDK connection, category pages and live-result validation in the host process.
 * @param {object} options Tool-path resolver, optional bridge runner and helper path.
 * @returns {object} Search, status, refresh and cancellation operations.
 */
function createSDKBackend(options) {
  const execute =
    options.execute ||
    ((request, signal) =>
      executeBridge(
        options.helper || path.join(__dirname, 'stools-everything.exe'),
        request,
        signal
      ))
  let current,
    launchKey = '',
    version = 1,
    polling,
    lastPoll = 0,
    sequence = 0,
    active = 0
  let state = {
    phase: 'starting',
    count: 0,
    scanned: 0,
    skipped: 0,
    current: '',
    warning: '',
    version
  }
  const foreground = new Set(),
    background = new Set()

  /**
   * Resolve current paths, respecting test isolation before starting or querying an engine.
   * @param {object} preferences Matching and sorting preferences.
   * @returns {object} Connection identity and validated options.
   * @throws {Error} Missing executable or unisolated test connection.
   */
  function connection(preferences) {
    const tools = options.getConfig()
    if (!tools.everythingReady) throw new Error('未找到 Everything.exe，请在本地工具设置中选择程序')
    if (process.env.ZTOOLS_E2E === '1' && !tools.instance)
      throw new Error('隔离测试未配置 Everything 实例')
    const settings = sdkOptions(preferences)
    return {
      tools,
      settings,
      key: JSON.stringify([tools.everything, tools.instance || '', settings])
    }
  }

  /**
   * Start the configured engine once, then send a cancellable SDK request.
   * @param {object} link Resolved connection.
   * @param {object} request Query or status request.
   * @param {boolean} quiet Whether this belongs to background refresh.
   * @returns {Promise<object>} Native response.
   * @throws {Error} Engine startup or query failed.
   */
  async function run(link, request, quiet = false) {
    if (!options.execute && process.env.ZTOOLS_E2E !== '1' && launchKey !== link.key) {
      const args = [...(link.tools.instance ? ['-instance', link.tools.instance] : []), '-startup']
      await new Promise((resolve, reject) => {
        const child = spawn(link.tools.everything, args, {
          windowsHide: true,
          shell: false,
          detached: true,
          stdio: 'ignore'
        })
        child.once('error', reject)
        child.once('spawn', () => {
          child.unref()
          resolve()
        })
      })
      launchKey = link.key
    }
    const controller = new AbortController(),
      group = quiet ? background : foreground
    group.add(controller)
    try {
      return await execute(
        { ...request, ...link.settings, instance: link.tools.instance || '' },
        controller.signal
      )
    } catch (error) {
      if (!controller.signal.aborted) launchKey = ''
      throw error
    } finally {
      group.delete(controller)
    }
  }

  /**
   * Publish a first batch with one shared version for every category.
   * @param {string} query Unmodified expression.
   * @param {object} link Connection identity.
   * @param {object} result Native category pages.
   * @returns {object} Stored query snapshot.
   */
  function publish(query, link, result) {
    version++
    const pages = {}
    for (const filter of filters) pages[filter] = { ...result.buckets[filter], version }
    current = { query, key: link.key, heads: result.buckets, pages }
    state = { ...state, phase: 'ready', warning: '', version }
    return current
  }

  /**
   * Return category heads or a validated continuation; changed prefixes reset safely.
   * @param {string} query Raw Everything expression.
   * @param {string} filter sTools category.
   * @param {object} page Requested offset and snapshot version.
   * @param {object} preferences Matching and sorting preferences.
   * @returns {Promise<object>} Search response with shared category buckets.
   * @throws {Error} Invalid input, cancellation or engine failure.
   */
  async function search(query, filter = 'all', page = {}, preferences = {}) {
    if (
      typeof query !== 'string' ||
      query.length > 512 ||
      query.includes('\0') ||
      !filters.includes(filter) ||
      !Number.isSafeInteger(page.offset ?? 0) ||
      (page.offset ?? 0) < 0 ||
      (page.offset ?? 0) > 1000000
    )
      throw new Error('无效的搜索参数')
    const link = connection(preferences),
      ticket = ++sequence
    active++
    try {
      let record = current
      if (
        !record ||
        record.query !== query ||
        record.key !== link.key ||
        (page.version !== undefined && page.version !== version)
      ) {
        const result = await run(link, { action: 'query', query })
        if (ticket !== sequence) throw new Error('查询已取消')
        record = publish(query, link, result)
        page = {}
      }
      const offset = page.offset || 0
      if (offset) {
        const result = await run(link, { action: 'page', query, filter, offset })
        if (ticket !== sequence) throw new Error('查询已取消')
        const previous = record.pages[filter]
        // Verify the entire displayed prefix, including edits beyond the first page.
        if (
          record !== current ||
          previous.items.length !== offset ||
          previous.hash !== result.prefixHash ||
          previous.total !== result.total
        ) {
          const reset = await run(link, { action: 'query', query })
          if (ticket !== sequence) throw new Error('查询已取消')
          record = publish(query, link, reset)
        } else {
          record.pages[filter] = { ...result, items: [...previous.items, ...result.items], version }
          return { ...result, engine: 'everything', version }
        }
      }
      return {
        ...record.pages[filter],
        offset: 0,
        engine: 'everything',
        version,
        buckets: record.pages
      }
    } finally {
      active--
    }
  }

  /**
   * Check connection health and refresh active category heads at most every two seconds.
   * @param {object} preferences Matching and sorting preferences.
   * @param {boolean} watchQuery Whether visible search results need live refresh.
   * @returns {Promise<object>} Connection and live-result revision.
   */
  async function status(preferences = {}, watchQuery = true) {
    if (polling) return polling
    if (Date.now() - lastPoll < 2000) return { ...state, version }
    polling = (async () => {
      try {
        const link = connection(preferences),
          record = current,
          ticket = sequence
        const health = await run(link, { action: 'status' }, true)
        state = {
          ...state,
          phase: 'ready',
          count: health.count,
          current: 'Everything ' + health.version + ' · SDK IPC',
          warning: '',
          version
        }
        if (watchQuery && record && record.key === link.key && !active) {
          const result = await run(link, { action: 'query', query: record.query }, true)
          let changed = filters.some((key) => record.heads[key].hash !== result.buckets[key].hash || record.heads[key].total !== result.buckets[key].total)
          // Loaded later pages also need validation when edits leave the first page unchanged.
          if (!changed) for (const key of filters) {
            const loaded = record.pages[key]
            if (loaded.items.length <= 100) continue
            const check = await run(link, { action: 'page', query: record.query, filter: key, offset: loaded.items.length }, true)
            if (check.prefixHash !== loaded.hash) { changed = true; break }
          }
          if (current === record && ticket === sequence && !active && changed) publish(record.query, link, result)
        }
      } catch (error) {
        if (state.warning !== error.message) {
          version++
          current = undefined
        }
        state = { ...state, phase: 'error', warning: error.message, version }
      } finally {
        lastPoll = Date.now()
      }
      return { ...state, version }
    })().finally(() => {
      polling = undefined
    })
    return polling
  }

  /**
   * Cancel only pending foreground bridge processes, keeping cached categories available.
   * @returns {void} No value.
   */
  function cancelSearch() {
    sequence++
    for (const controller of foreground) controller.abort()
  }

  /**
   * Invalidate the query cache without rebuilding or modifying Everything's database.
   * @returns {void} No value.
   */
  function refresh() {
    cancelSearch()
    current = undefined
    lastPoll = 0
    version++
  }

  /**
   * Dispose all child bridges when the application quits.
   * @returns {void} No value.
   */
  function close() {
    cancelSearch()
    for (const controller of background) controller.abort()
  }
  return { search, status, refresh, cancelSearch, close }
}
module.exports = { createSDKBackend, executeBridge, sdkOptions }
