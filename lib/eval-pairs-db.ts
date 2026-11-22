// lib/eval-pairs-db.ts — DB reads about linked store rows (migration 054).
// The pure SQL fragments live in lib/eval-pairs.ts; this file runs queries.
import { sql } from '@/lib/db'

/**
 * game_id -> the twin store's game_id, for each given game whose row is linked to a twin
 * that moves with it: neither row holds Link_dead / Stale_release, so the 054 sync trigger
 * copied the row's holder and assign dates to the twin. A twin holding its own store result
 * keeps its own holder and is left out. Games with no such twin are not in the map.
 * One query; no query for an empty list.
 *
 * Never throws: every caller (assign, reassign, handover, rescue) reads it AFTER its move
 * committed, only to add the twin ids to the history row. A failed read logs and returns an
 * empty map (history then names the front store only) rather than turning a done move into
 * a 500 that invites a retry.
 */
export async function twinGameIds(gameIds: string[]): Promise<Map<string, string>> {
  const ids = Array.from(new Set(gameIds.filter(Boolean)))
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  let rows: { game_id: string; twin_game_id: string }[]
  try {
    rows = (await sql`
      SELECT ge.game_id, t.game_id AS twin_game_id
      FROM game_evaluations ge
      JOIN game_evaluations t ON t.id = ge.pair_eval_id
      WHERE ge.game_id = ANY(${ids})
        AND ge.initial_conclusion IS DISTINCT FROM 'Link_dead'
        AND ge.initial_conclusion IS DISTINCT FROM 'Stale_release'
        AND t.initial_conclusion IS DISTINCT FROM 'Link_dead'
        AND t.initial_conclusion IS DISTINCT FROM 'Stale_release'
    `) as unknown as { game_id: string; twin_game_id: string }[]
  } catch (err) {
    console.error('twinGameIds: twin lookup failed, history keeps the front store ids only', err)
    return out
  }
  for (const r of rows) out.set(r.game_id, r.twin_game_id)
  return out
}
