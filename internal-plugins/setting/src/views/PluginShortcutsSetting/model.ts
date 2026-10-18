import { normalizeShortcut } from '@shared/shortcutConflict'
export { normalizeShortcut } from '@shared/shortcutConflict'

export type ShortcutScope = 'global' | 'app'
export interface Binding {
  id: string
  shortcut: string
  target: string
  enabled: boolean
  autoCopy?: boolean
  preScreenshotOptimization?: boolean
}
export interface ScopedBinding extends Binding {
  scope: ShortcutScope
}
export interface PluginSource {
  name: string
  title?: string
  path: string
  logo?: string
  features?: {
    code: string
    explain?: string
    cmds?: (string | { label?: string })[]
    platform?: string[]
  }[]
}
export interface FunctionRow {
  id: string
  code: string
  title: string
  description: string
  target: string
  aliases: string[]
  bindings: ScopedBinding[]
  needsContent: boolean
}
export interface PluginGroup {
  name: string
  title: string
  logo?: string
  disabled: boolean
  rows: FunctionRow[]
}

const captureTitles: Record<string, string> = {
  quick: '快速截图入口',
  scroll: '长截图',
  capture: '截图',
  record: '录屏',
  gif: '录制 GIF',
  pin: '贴图',
  home: '打开工具面板'
}

/**
 * 统一历史快捷键目标中的分隔符空格，保留指令本身的名称。
 * @param target 快捷键目标。
 * @returns 可用于比对的目标字符串。
 */
function normalizeTarget(target: string): string {
  return target.trim().replace(/\s*\/\s*/g, '/')
}

/**
 * 将已安装插件按功能汇总；别名和不同作用范围的快捷键归到同一行。
 * @param plugins 已安装插件，含内置和动态功能。
 * @param bindings 全局与应用内快捷键。
 * @param disabledPaths 已禁用的插件路径。
 * @param platform 当前操作系统。
 * @returns 按常用工具优先排列的插件功能组。
 */
export function buildPluginGroups(
  plugins: PluginSource[],
  bindings: ScopedBinding[],
  disabledPaths: string[],
  platform: string
): PluginGroup[] {
  return plugins
    .map((plugin) => {
      const features = new Map<string, NonNullable<PluginSource['features']>[number]>()
      // 动态功能可以覆盖同 code 的静态定义，避免重复入口。
      for (const feature of plugin.features || []) features.set(feature.code, feature)
      const rows = [...features.values()]
        .filter((feature) => !feature.platform || feature.platform.includes(platform))
        .map((feature) => {
          const textCommands = (feature.cmds || []).filter(
            (cmd): cmd is string => typeof cmd === 'string'
          )
          const aliases = (feature.cmds || [])
            .map((cmd) => (typeof cmd === 'string' ? cmd : cmd.label || ''))
            .filter(Boolean)
          const targets = new Set(
            [plugin.name, plugin.title]
              .filter(Boolean)
              .flatMap((prefix) => aliases.map((alias) => normalizeTarget(`${prefix}/${alias}`)))
          )
          return {
            id: `${plugin.name}:${feature.code}`,
            code: feature.code,
            title:
              (plugin.name === 'capture-tools' && captureTitles[feature.code]) ||
              textCommands[0] ||
              feature.explain ||
              aliases[0] ||
              '需要内容的功能',
            description: feature.explain || '使用快捷键打开此功能',
            target: `${plugin.name}/${textCommands[0] || ''}`,
            aliases,
            bindings: bindings.filter((binding) => targets.has(normalizeTarget(binding.target))),
            needsContent: textCommands.length === 0
          }
        })
      // 截图等直接功能优先，工具面板放在这一组末尾。
      if (plugin.name === 'capture-tools') {
        const order = ['quick', 'capture', 'scroll', 'record', 'gif', 'pin', 'home']
        rows.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code))
      }
      return {
        name: plugin.name,
        title: plugin.title || plugin.name,
        logo: plugin.logo,
        disabled: disabledPaths.includes(plugin.path),
        rows
      }
    })
    .filter((group) => group.rows.length > 0)
    .sort((a, b) => {
      const order = ['capture-tools', 'local-tools']
      /**
       * 计算工具与设置分组的展示顺序。
       * @param name 插件标识。
       * @returns 排序权重。
       */
      const rank = (name: string): number =>
        order.includes(name) ? order.indexOf(name) : ['system', 'setting'].includes(name) ? 3 : 2
      return rank(a.name) - rank(b.name) || a.title.localeCompare(b.title, 'zh-CN')
    })
}

export interface ShortcutApi {
  dbGet(key: string): Promise<unknown>
  dbPut(key: string, value: Binding[]): Promise<{ ok?: boolean; error?: string } | undefined>
  getCurrentShortcut(): Promise<string>
  registerGlobalShortcut(
    shortcut: string,
    target: string,
    autoCopy?: boolean,
    optimize?: boolean,
    replaceTarget?: string
  ): Promise<{ success: boolean; error?: string }>
  unregisterGlobalShortcut(shortcut: string): Promise<{ success: boolean; error?: string }>
  registerAppShortcut(
    shortcut: string,
    target: string,
    replaceTarget?: string
  ): Promise<{ success: boolean; error?: string }>
  unregisterAppShortcut(shortcut: string): Promise<{ success: boolean; error?: string }>
}

/**
 * 读取快捷键配置，发现无效存储时中止，防止覆盖用户数据。
 * @param api 设置插件 API。
 * @param scope 快捷键作用范围。
 * @returns 当前持久化配置。
 * @throws 配置不是数组或记录不完整时抛出错误。
 */
export async function readBindings(
  api: Pick<ShortcutApi, 'dbGet'>,
  scope: ShortcutScope
): Promise<Binding[]> {
  const data = await api.dbGet(`${scope}-shortcuts`)
  if (data == null) return []
  if (
    !Array.isArray(data) ||
    data.some(
      (item) =>
        !item ||
        typeof item.id !== 'string' ||
        typeof item.shortcut !== 'string' ||
        typeof item.target !== 'string'
    )
  )
    throw new Error('快捷键配置读取异常，请先到快捷键管理中检查。')
  return data
}

/**
 * 保存、修改或删除一条绑定，检查冲突并在注册或持久化失败后恢复原快捷键。
 * @param api 设置插件 API。
 * @param scope 快捷键作用范围。
 * @param previous 编辑前的记录；新增时为空。
 * @param next 新记录；删除时为空。
 * @param platform 当前操作系统。
 * @returns 操作成功后结束的 Promise。
 * @throws 配置已变化、快捷键冲突或保存失败时抛出可展示的错误。
 */
export async function changeBinding(
  api: ShortcutApi,
  scope: ShortcutScope,
  previous: Binding | undefined,
  next: Binding | undefined,
  platform: string
): Promise<void> {
  const records = await readBindings(api, scope)
  const old = previous ? records.find((item) => item.id === previous.id) : undefined
  // 保存前重读，避免用页面旧快照覆盖其它入口的修改。
  if (previous && (!old || JSON.stringify(old) !== JSON.stringify(previous)))
    throw new Error('这条快捷键已在其它页面修改，请刷新后重试。')
  if (next) {
    if (!next.shortcut.trim()) throw new Error('请先按下要使用的快捷键。')
    const key = normalizeShortcut(next.shortcut, platform)
    const other = await readBindings(api, scope === 'global' ? 'app' : 'global')
    const collision = [...records.filter((item) => item.id !== old?.id), ...other].find(
      (item) => normalizeShortcut(item.shortcut, platform) === key
    )
    if (collision)
      throw new Error(`此快捷键已用于「${collision.target.split('/').pop()}」，请换一个组合键。`)
    if (key === normalizeShortcut(await api.getCurrentShortcut(), platform))
      throw new Error('此快捷键用于唤起 sTools，请换一个组合键。')
  }
  // 同一个组合键沿用旧拼写，避免后端以不同别名重复保留内部记录。
  if (
    old &&
    next &&
    normalizeShortcut(old.shortcut, platform) === normalizeShortcut(next.shortcut, platform)
  )
    next = { ...next, shortcut: old.shortcut }
  const updated = records.filter((item) => item.id !== old?.id)
  if (next) updated.push(next)
  /**
   * 将绑定注册到其作用范围对应的后端。
   * @param item 待注册绑定。
   * @returns 后端注册结果。
   */
  const register = (item: Binding): Promise<{ success: boolean; error?: string }> =>
    scope === 'global'
      ? api.registerGlobalShortcut(
          item.shortcut,
          item.target,
          item.autoCopy,
          item.preScreenshotOptimization,
          item === next ? old?.target : next?.target
        )
      : api.registerAppShortcut(
          item.shortcut,
          item.target,
          item === next ? old?.target : next?.target
        )
  /**
   * 释放对应作用范围内的运行时绑定。
   * @param item 待释放绑定。
   * @returns 后端注销结果。
   */
  const unregister = (item: Binding): Promise<{ success: boolean; error?: string }> =>
    scope === 'global'
      ? api.unregisterGlobalShortcut(item.shortcut)
      : api.unregisterAppShortcut(item.shortcut)
  const sameKey =
    old &&
    next &&
    normalizeShortcut(old.shortcut, platform) === normalizeShortcut(next.shortcut, platform)
  let registered = false
  let oldTouched = false
  try {
    // 先尝试新组合键；被其它软件占用时不撤销原绑定。
    if (next?.enabled) {
      if (sameKey && old?.enabled) oldTouched = true
      const result = await register(next)
      if (!result.success)
        throw new Error(result.error || '快捷键已被其它软件占用，请换一个组合键。')
      registered = true
    }
    if (old?.enabled && (!sameKey || !next?.enabled)) {
      oldTouched = true
      const result = await unregister(old)
      if (!result.success) throw new Error(result.error || '原快捷键未能释放，请重试。')
    }
    const result = await api.dbPut(`${scope}-shortcuts`, updated)
    if (result?.ok === false || result?.error) throw new Error('快捷键未能保存，请重试。')
  } catch (error) {
    // 释放本次新注册，恢复旧后端状态；回滚失败必须向用户说明。
    const failures: string[] = []
    if (registered && next) {
      try {
        if (!(await unregister(next)).success) failures.push('新快捷键未能释放')
      } catch {
        failures.push('新快捷键未能释放')
      }
    }
    if (oldTouched && old?.enabled) {
      try {
        if (!(await register(old)).success) failures.push('原快捷键未能恢复')
      } catch {
        failures.push('原快捷键未能恢复')
      }
    }
    throw new Error(
      `${error instanceof Error ? error.message : '保存失败，请重试。'}${failures.length ? `（${failures.join('；')}，请重启 sTools 后检查）` : ''}`
    )
  }
}
