import type { EverythingFilter, EverythingResponse } from './unifiedSearch'

export type SearchEngine = 'builtin' | 'everything'
export interface EverythingOptions {
  sort: number
  matchCase: boolean
  matchPath: boolean
  matchWholeWord: boolean
}
export interface FileSearchConfig {
  engine: SearchEngine
  everything?: EverythingOptions
  roots: string[]
  excluded: string[]
}
export interface IndexState {
  phase: 'starting' | 'scanning' | 'ready' | 'error' | 'disabled'
  count: number
  scanned: number
  skipped: number
  current: string
  warning: string
  version: number
  nativeVolumes?: string[]
  fallbackVolumes?: string[]
  lastScanMs?: number
}
export interface FileSearchStatus {
  config: FileSearchConfig
  index: IndexState
}
export interface FileSearchPage extends EverythingResponse {
  total?: number
  offset?: number
  version?: number
}
export interface FileSearchResponse extends FileSearchPage {
  engine: SearchEngine
  version: number
  buckets?: Partial<Record<EverythingFilter, FileSearchPage>>
}
export interface FileSearchAPI {
  search: (
    query: string,
    filter: EverythingFilter,
    options?: { offset?: number; version?: number }
  ) => Promise<FileSearchResponse>
  nativeService: (action: 'install' | 'uninstall') => Promise<void>
  status: (options?: { watchQuery?: boolean }) => Promise<FileSearchStatus>
  configure: (config: FileSearchConfig) => Promise<FileSearchStatus>
  chooseFolder: () => Promise<string | null>
  refresh: () => Promise<void>
}
