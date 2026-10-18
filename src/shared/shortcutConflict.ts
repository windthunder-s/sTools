/**
 * 规范化组合键的别名与修饰键顺序，同时保留双击修饰键语义。
 * @param shortcut 用户或历史配置中的组合键。
 * @param platform 当前操作系统。
 * @returns 冲突检测用的规范字符串。
 */
export function normalizeShortcut(shortcut: string, platform: string): string {
  const aliases: Record<string, string> = {
    control: 'ctrl',
    option: 'alt',
    cmd: 'meta',
    command: 'meta',
    super: 'meta',
    win: 'meta',
    windows: 'meta',
    commandorcontrol: platform === 'darwin' ? 'meta' : 'ctrl',
    cmdorctrl: platform === 'darwin' ? 'meta' : 'ctrl',
    enter: 'return',
    esc: 'escape'
  }
  return shortcut
    .toLowerCase()
    .split('+')
    .map((key) => aliases[key.trim()] || key.trim())
    .sort()
    .join('+')
}

/**
 * 返回启用的内置操作或操作系统保留键说明。
 * @param shortcut 待检查的组合键。
 * @param platform 操作系统。
 * @param settings 通用设置，包含可关闭的内置键。
 * @returns 占用说明；无已知冲突时为空。
 */
export function reservedShortcut(
  shortcut: string,
  platform: string,
  settings?: any
): string | undefined {
  const mod = platform === 'darwin' ? 'Command' : 'Control'
  const enabled = settings?.builtinAppShortcutsEnabled || {}
  const keys: [string, string, boolean?][] = [
    [mod + '+D', '分离插件'],
    [mod + '+,', '打开设置'],
    ['Tab', '切换指令'],
    [mod + '+F', '搜索筛选', enabled.search],
    [mod + '+Q', '终止插件', enabled.killPlugin],
    [mod + '+W', '关闭插件', enabled.closePlugin],
    ['Escape', '退出/隐藏窗口', enabled.esc],
    [platform === 'darwin' ? 'Alt+Command+I' : 'Control+Shift+I', '开发者工具']
  ]
  if (platform === 'win32')
    keys.push(
      ['Alt+F4', '关闭窗口'],
      ['Control+Alt+Delete', 'Windows 安全界面'],
      ['Control+Shift+Escape', '任务管理器'],
      ['Super+L', 'Windows 锁屏']
    )
  const key = normalizeShortcut(shortcut, platform)
  return keys.find(
    ([combo, , active]) => active !== false && normalizeShortcut(combo, platform) === key
  )?.[1]
}
