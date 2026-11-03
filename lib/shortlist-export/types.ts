// Shared shapes of the Short List export (Insight / Priority IV -> Slides, Sheets, xlsx).
// Pure: safe on client and server.

export type ExportType = 'insight' | 'priority_iv'
export type ExportFormat = 'slides' | 'sheets' | 'xlsx'

export const EXPORT_TYPES: readonly ExportType[] = ['insight', 'priority_iv']
export const EXPORT_FORMATS: readonly ExportFormat[] = ['slides', 'sheets', 'xlsx']

/** What one export covers. `labels` are batch labels, W1 first for a month.
 *  `weekTag` is 'W3' for a week export, null for a month export. */
export interface ExportScope {
  kind: 'week' | 'month'
  labels: string[]
  monthKey: string
  weekTag: string | null
}

export interface ExportGame {
  gameId: string
  title: string
  publisher: string | null
  /** from game_info.os, lower-cased; anything else -> null */
  platform: 'android' | 'ios' | null
  storeUrl: string | null
  iconUrl: string | null
  /** 'YYYY-MM-DD' from game_info.initial_release */
  releaseDate: string | null
  conclusion: 'Insight' | 'Priority IV'
  batch: string
  /** Insight -> 5 min link, Priority IV -> 20 min link */
  youtubeUrl: string | null
}

export const CONCLUSION_OF: Record<ExportType, ExportGame['conclusion']> = {
  insight: 'Insight',
  priority_iv: 'Priority IV',
}
