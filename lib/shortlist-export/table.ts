// Games -> the two sheet tabs (Priority IV, Insight) shared by Google Sheets and xlsx. Pure.

import type { ExportGame, ExportType } from './types'

export const SHEET_HEADER = ['id', 'title', 'publisher', 'android', 'ios'] as const
/** Columns (0-based) that hold store links. */
export const LINK_COLUMNS = [3, 4] as const

export interface SheetTab {
  name: 'Priority IV' | 'Insight'
  header: ['id', 'title', 'publisher', 'android', 'ios']
  rows: string[][]
}

function rowOf(g: ExportGame): string[] {
  const link = g.storeUrl ?? ''
  return [
    g.gameId,
    g.title,
    g.publisher ?? '',
    g.platform === 'android' ? link : '',
    g.platform === 'ios' ? link : '',
  ]
}

/** Tabs in the order Priority IV, Insight -- only the chosen types. */
export function buildTabs(games: ExportGame[], types: ExportType[]): SheetTab[] {
  const tabs: SheetTab[] = []
  for (const name of ['Priority IV', 'Insight'] as const) {
    const type: ExportType = name === 'Insight' ? 'insight' : 'priority_iv'
    if (!types.includes(type)) continue
    tabs.push({
      name,
      header: [...SHEET_HEADER],
      rows: games.filter(g => g.conclusion === name).map(rowOf),
    })
  }
  return tabs
}
