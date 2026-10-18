const fs = require('node:fs')
const path = require('node:path')
const { execFile, spawn } = require('node:child_process')
const { promisify } = require('node:util')
const run = promisify(execFile)
const executableNames = { everything: 'Everything.exe', es: 'es.exe', snipaste: 'Snipaste.exe' }

/**
 * 检查工具路径指向预期的可执行文件。
 * @param {string} key 工具名称。
 * @param {string} filename 可执行文件路径。
 * @returns {boolean} 是否存在且名称匹配。
 */
function validExecutable(key, filename) {
  try {
    return (
      typeof filename === 'string' &&
      path.isAbsolute(filename) &&
      path.basename(filename).toLowerCase() === executableNames[key].toLowerCase() &&
      fs.statSync(filename).isFile()
    )
  } catch {
    return false
  }
}

/**
 * 查找常见安装目录；用户保存的路径优先且失效时明确报告。
 * @param {object} saved 已保存配置。
 * @returns {object} 路径及可用状态。
 */
function detectTools(saved = {}) {
  const result = { instance: typeof saved.instance === 'string' ? saved.instance : '' }
  for (const [key, name] of Object.entries(executableNames)) {
    const folder = key === 'snipaste' ? 'Snipaste' : 'Everything'
    const roots = [
      path.join('D:\\soft\\daily', folder),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', folder),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', folder),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', folder),
      ...(process.env.PATH || '').split(path.delimiter)
    ]
    if (key === 'es' && saved.everything) roots.unshift(path.dirname(saved.everything))
    const chosen =
      saved[key] ||
      roots.map((root) => path.join(root, name)).find((file) => validExecutable(key, file)) ||
      ''
    result[key] = chosen
    result[key + 'Ready'] = validExecutable(key, chosen)
  }
  return result
}

/**
 * 把关键词转换为单个正则搜索参数，防止 ES 将搜索内容识别为命令选项。
 * @param {string} query 用户输入的关键词，空格分词。
 * @returns {string} Everything 正则表达式参数。
 * @throws {Error} 关键词过长或含控制字符时抛出错误。
 */
function searchExpression(query) {
  if (typeof query !== 'string' || query.length > 500 || /[\x00-\x1f]/.test(query))
    throw new Error('请输入不超过 500 字的文件名关键词')
  // 每个字符以 Unicode 码位编码，避免引号、反斜线和 ES 开关改变调用含义。
  const terms = query.trim().split(/\s+/).filter(Boolean)
  return (
    'regex:' +
    terms
      .map(
        (term) =>
          '(?=.*' +
          Array.from(term, (c) => '\\x{' + c.codePointAt(0).toString(16) + '}').join('') +
          ')'
      )
      .join('')
  )
}

/**
 * 启动本地进程，不经过 shell，并确认操作系统已接受启动。
 * @param {string} executable 可执行文件。
 * @param {string[]} args 参数列表。
 * @returns {Promise<number>} 子进程 PID。
 * @throws {Error} 无法启动进程时抛出错误。
 */
function startProcess(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: path.dirname(executable),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve(child.pid)
    })
  })
}

/**
 * 等待 Snipaste 的消息循环就绪；已有实例时新进程会快速退出。
 * @param {number} pid 本次启动的 PID。
 * @returns {Promise<void>} 输入队列就绪后结束。
 * @throws {Error} 首次启动超时或进程异常时抛出错误。
 */
async function waitForInputIdle(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Snipaste 启动失败')
  const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { try { if (-not $p.WaitForInputIdle(10000)) { exit 2 } } catch { if (-not $p.HasExited) { exit 3 } } }`
  await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    { windowsHide: true, timeout: 12000 }
  )
}

/**
 * 创建本地工具适配器，允许测试替换进程启动但沿用真实的参数处理。
 * @param {object} options 配置存储与系统操作。
 * @returns {object} 搜索、路径配置和截图接口。
 */
function createBackend(options) {
  const execute = options.run || run
  const start = options.start || startProcess
  const ready = options.ready || waitForInputIdle
  let activeSearch = null
  let snipasteBusy = false

  /**
   * 读取并检测当前配置。
   * @returns {object} 工具路径和状态。
   */
  function status() {
    return detectTools(options.getConfig() || {})
  }

  /**
   * 保存校验后的工具路径；空值表示恢复自动检测。
   * @param {object} value 用户配置。
   * @returns {object} 最新可用状态。
   * @throws {Error} 工具路径或实例名称无效时抛出错误。
   */
  function configure(value) {
    const config = {}
    for (const key of Object.keys(executableNames)) {
      const filename = String(value[key] || '')
        .trim()
        .replace(/^"|"$/g, '')
      if (filename && !validExecutable(key, filename))
        throw new Error(`请选择有效的 ${executableNames[key]}`)
      config[key] = filename
    }
    config.instance = String(value.instance || '').trim()
    if (config.instance && !/^[\w.-]{1,80}$/.test(config.instance))
      throw new Error('Everything 实例名称只能包含字母、数字、下划线、点和短横线')
    options.saveConfig(config)
    return status()
  }

  /**
   * 取消前一次搜索，避免快速输入时累积查询进程。
   * @returns {void} 无返回值。
   */
  function cancelSearch() {
    activeSearch?.abort()
    activeSearch = null
  }

  /**
   * 通过 ES 查询 Everything 的本地索引，最多显示 100 条结果。
   * @param {string} query 文件名关键词。
   * @param {string} filter all、file、folder、app 或 document（排除程序的文件）。
   * @returns {Promise<object[]>} 文件结果。
   * @throws {Error} 路径缺失、索引不可用或查询失败时抛出错误。
   */
  async function search(query, filter = 'all') {
    cancelSearch()
    const expression = searchExpression(query)
    if (!query.trim()) return []
    const config = status()
    if (!config.esReady || !config.everythingReady)
      throw new Error('请先在“工具设置”中选择 Everything.exe 和 es.exe')
    const controller = new AbortController()
    activeSearch = controller
    const instanceArgs = config.instance ? ['-instance', config.instance] : []
    const args = [
      '-ipc2',
      '-timeout',
      '5000',
      '-n',
      '100',
      '-full-path',
      '-no-highlight',
      '-utf8-bom',
      '-code-page',
      '65001',
      '-sort',
      'name',
      ...instanceArgs
    ]
    if (filter === 'folder') args.push('/ad')
    if (['file', 'document', 'app'].includes(filter)) args.push('/a-d')
    if (filter === 'app') args.push('ext:exe;lnk;appref-ms')
    if (filter === 'document') args.push('!ext:exe;lnk;appref-ms')
    args.push(expression)
    try {
      // Everything 自己持有索引；启动参数只确保查询客户端在后台运行。
      await start(config.everything, [...instanceArgs, '-startup'])
      if (controller.signal.aborted) return []
      const { stdout } = await execute(config.es, args, {
        windowsHide: true,
        shell: false,
        timeout: 6500,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
        signal: controller.signal
      })
      const files = stdout
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, 100)
      return await Promise.all(
        files.map(async (filename) => {
          let directory = false
          try {
            directory = (await fs.promises.stat(filename)).isDirectory()
          } catch {
            /* 索引中的已删除文件仍可显示并由打开操作报告。 */
          }
          return { path: filename, name: path.basename(filename), directory }
        })
      )
    } catch (error) {
      if (controller.signal.aborted) return []
      throw new Error(
        'Everything 查询失败：请确认程序已运行、索引已就绪且与 sTools 使用相同用户权限。可在 Everything 的“工具 → 选项”检查索引。' +
          (error.killed ? '（查询超时）' : '')
      )
    } finally {
      if (activeSearch === controller) activeSearch = null
    }
  }

  /**
   * 先启动 Snipaste 并等待消息循环，再发出截图或贴图命令。
   * @param {string} action snip 或 paste。
   * @returns {Promise<void>} 命令已发送，不表示用户已完成截图。
   * @throws {Error} 软件缺失、动作无效或调用失败时抛出错误。
   */
  async function snipaste(action) {
    if (!['snip', 'paste'].includes(action)) throw new Error('不支持的 Snipaste 操作')
    if (snipasteBusy) return
    const config = status()
    if (!config.snipasteReady) throw new Error('请先在“工具设置”中选择 Snipaste.exe')
    snipasteBusy = true
    try {
      const pid = await start(config.snipaste, [])
      await ready(pid)
      await options.hide()
      // 给宿主退出前台的动画留出时间，避免截入搜索窗口。
      await new Promise((resolve) => setTimeout(resolve, 180))
      await execute(config.snipaste, [action], { windowsHide: true, shell: false, timeout: 8000 })
    } catch (error) {
      await options.show()
      throw new Error('Snipaste 调用失败：' + error.message)
    } finally {
      snipasteBusy = false
    }
  }

  return { status, configure, search, cancelSearch, snipaste }
}

module.exports = { createBackend, searchExpression, validExecutable, detectTools }
