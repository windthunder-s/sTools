export type SearchCategory = 'all' | 'app' | 'plugin' | 'file' | 'folder' | 'system'
export type EverythingFilter = 'all' | 'app' | 'file' | 'folder'
export interface EverythingItem {
  name: string
  path: string
  directory: boolean
}
export interface EverythingResponse {
  items: EverythingItem[]
  error?: string
  limited: boolean
}
export interface EverythingSearchAPI {
  search: (query: string, filter: EverythingFilter) => Promise<EverythingResponse>
  cancel: () => void
}
export const SEARCH_CATEGORIES: { key: SearchCategory; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'app', label: '应用' },
  { key: 'plugin', label: '插件' },
  { key: 'file', label: '文件' },
  { key: 'folder', label: '文件夹' },
  { key: 'system', label: '系统' }
]
interface CategorizedCommand {
  type?: string
  subType?: string
  pluginName?: string
  category?: string
}
/**
 * 将内置指令、插件、启动项和索引结果映射到统一分类。
 * @param command 待分类的搜索结果。
 * @returns 用于筛选和展示的类别。
 */
export function searchCategory(command: CategorizedCommand): SearchCategory {
  if (
    command.type === 'builtin' ||
    command.subType === 'system-setting' ||
    (command.type === 'plugin' && ['setting', 'system'].includes(command.pluginName || ''))
  )
    return 'system'
  if (command.type === 'plugin') return 'plugin'
  if (command.category === 'folder' || command.category === 'file') return command.category
  return 'app'
}
/**
 * 识别 Everything 中可直接启动的程序与快捷方式。
 * @param item 本地索引结果。
 * @returns 应用、文件或文件夹类别。
 */
export function everythingCategory(item: EverythingItem): SearchCategory {
  return item.directory ? 'folder' : /\.(exe|lnk|appref-ms)$/i.test(item.path) ? 'app' : 'file'
}
/**
 * 移除已由应用扫描器提供的相同路径，保留原应用名和指令优先级。
 * @param items Everything 的结果。
 * @param commands 已匹配的本地应用和插件指令。
 * @returns 去重后的索引结果。
 */
export function uniqueEverythingItems(
  items: EverythingItem[],
  commands: { path: string; type?: string }[]
): EverythingItem[] {
  const seen = new Set(
    commands
      .filter((item) => item.type === 'direct')
      .map((item) => item.path.replace(/\\/g, '/').toLowerCase())
  )
  return items.filter((item) => {
    const key = item.path.replace(/\\/g, '/').toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
