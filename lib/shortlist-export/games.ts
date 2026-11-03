// The Insight / Priority IV games of an export scope, one per game_id.

import { sql } from '@/lib/db'
import { CONCLUSION_OF, type ExportGame, type ExportType } from './types'

/** Labels that can be exported: the ones with a row in `batches`, newest first. */
export async function listExportLabels(): Promise<string[]> {
  const rows = await sql<{ label: string }[]>`
    SELECT label FROM batches ORDER BY starts_at DESC`
  return rows.map(r => r.label)
}

type Row = {
  game_id: string
  title: string | null
  developer_name: string | null
  os: string | null
  app_link: string | null
  icon_url: string | null
  initial_release: string | null
  final_conclusion: string
  batch: string
  evaluate_date: string | Date | null
  youtube_5min_link: string | null
  youtube_20min_link: string | null
}

function clean(v: string | null | undefined): string | null {
  const s = (v ?? '').trim()
  return s ? s : null
}

function platformOf(os: string | null): ExportGame['platform'] {
  const s = (os ?? '').trim().toLowerCase()
  return s === 'android' || s === 'ios' ? s : null
}

function timeOf(v: string | Date | null): number {
  if (!v) return Number.POSITIVE_INFINITY
  const ms = v instanceof Date ? v.getTime() : Date.parse(v)
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
}

/** Games of `labels` whose final conclusion is one of `types`. A game evaluated twice in
 *  the period (cross-genre duplicate rows, or both conclusions) appears once, under its
 *  latest evaluation. Ordered by batch (order of `labels`), then evaluate time. */
export async function loadExportGames(labels: string[], types: ExportType[]): Promise<ExportGame[]> {
  const conclusions = types.map(t => CONCLUSION_OF[t])
  if (!labels.length || !conclusions.length) return []

  const rows = await sql<Row[]>`
    SELECT DISTINCT ON (ge.game_id)
           ge.game_id, gi.title, dev.developer_name, gi.os, gi.app_link, gi.icon_url,
           to_char(gi.initial_release AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS initial_release,
           ge.final_conclusion, ge.batch, ge.evaluate_date,
           ge.youtube_5min_link, ge.youtube_20min_link
    FROM game_evaluations ge
    JOIN game_info gi USING (game_id)
    LEFT JOIN developer dev ON gi.publisher_id = dev.id
    WHERE ge.batch = ANY(${labels}::text[])
      AND ge.final_conclusion = ANY(${conclusions}::text[])
    ORDER BY ge.game_id, ge.evaluate_date DESC NULLS LAST, ge.id DESC`

  const rank = new Map(labels.map((l, i) => [l, i]))
  const sorted = [...rows].sort((a, b) =>
    (rank.get(a.batch) ?? 1e9) - (rank.get(b.batch) ?? 1e9) || timeOf(a.evaluate_date) - timeOf(b.evaluate_date))

  return sorted.map(r => {
    const conclusion: ExportGame['conclusion'] = r.final_conclusion === 'Priority IV' ? 'Priority IV' : 'Insight'
    return {
      gameId: String(r.game_id),
      title: clean(r.title) ?? String(r.game_id),
      publisher: clean(r.developer_name),
      platform: platformOf(r.os),
      storeUrl: clean(r.app_link),
      iconUrl: clean(r.icon_url),
      releaseDate: clean(r.initial_release),
      conclusion,
      batch: r.batch,
      youtubeUrl: clean(conclusion === 'Insight' ? r.youtube_5min_link : r.youtube_20min_link),
    }
  })
}

export function countExportGames(games: ExportGame[]): { insight: number; priorityIV: number } {
  let insight = 0
  let priorityIV = 0
  for (const g of games) {
    if (g.conclusion === 'Insight') insight++
    else priorityIV++
  }
  return { insight, priorityIV }
}
