import { normalizeShortcut, readBindings } from './model'

export interface LauncherShortcutApi {
  dbGet(key: string): Promise<unknown>
  dbPut(
    key: string,
    value: Record<string, unknown>
  ): Promise<{ ok?: boolean; error?: string } | undefined>
  getCurrentShortcut(): Promise<string>
  updateShortcut(shortcut: string): Promise<{ success: boolean; error?: string }>
}

/**
 * 修改主程序呼出键，合并保存通用设置，并在失败时恢复原有呼出方式。
 * @param api 设置插件 API。
 * @param previous 打开编辑器时的呼出键。
 * @param shortcut 用户录制的新组合键。
 * @param platform 当前操作系统。
 * @returns 已保存且生效的呼出键。
 * @throws 配置过期、快捷键冲突、注册或保存失败时抛出可展示的错误。
 */
export async function changeLauncherShortcut(
  api: LauncherShortcutApi,
  previous: string,
  shortcut: string,
  platform: string
): Promise<string> {
  if (!shortcut.trim()) throw new Error('请先按下要使用的快捷键。')
  const [current, globalKeys, appKeys, settings] = await Promise.all([
    api.getCurrentShortcut(),
    readBindings(api, 'global'),
    readBindings(api, 'app'),
    api.dbGet('settings-general')
  ])
  if (current !== previous) throw new Error('呼出快捷键已在其它页面修改，请刷新后重试。')
  if (settings != null && (typeof settings !== 'object' || Array.isArray(settings)))
    throw new Error('通用设置读取异常，请先检查设置。')
  const normalized = normalizeShortcut(shortcut, platform)
  const collision = [...globalKeys, ...appKeys].find(
    (binding) => normalizeShortcut(binding.shortcut, platform) === normalized
  )
  if (collision)
    throw new Error(`此快捷键已用于「${collision.target.split('/').pop()}」，请换一个组合键。`)
  // 同一组合键沿用原拼写，与主程序和插件快捷键的内部记录保持一致。
  const next = normalized === normalizeShortcut(current, platform) ? current : shortcut
  try {
    const result = await api.updateShortcut(next)
    if (!result.success) throw new Error(result.error || '快捷键已被其它软件占用，请换一个组合键。')
    const saved = await api.dbPut('settings-general', {
      ...(settings as Record<string, unknown> | null),
      hotkey: next
    })
    if (saved?.ok === false || saved?.error) throw new Error('快捷键未能保存，请重试。')
    return next
  } catch (error) {
    // 注册异常或持久化失败都要恢复旧键，避免用户失去唤起入口。
    let restored = false
    try {
      restored = (await api.updateShortcut(current)).success
    } catch {
      /* 在错误中说明恢复失败。 */
    }
    throw new Error(
      `${error instanceof Error ? error.message : '保存失败，请重试。'}${restored ? '' : '（原呼出键未能恢复，请从托盘打开 sTools 后重新设置）'}`
    )
  }
}
