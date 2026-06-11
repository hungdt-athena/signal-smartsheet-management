import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Import evaluation data from Smartsheet into game_evaluations.
// n8n reads the Smartsheet (it holds the token), flattens each row into a
// { <column title>: value } object, and POSTs { category, rows } here. This
// route owns the title→field mapping + the DB write. One-time / on-demand:
// it CLEARS the given category then inserts (dedup by game_id, FK-safe).
// Admin-only + destructive (clears a category) → gated behind requireRole.

const CATEGORIES = ['puzzle', 'arcade', 'simulation']

// Smartsheet column title → game_evaluations field. Columns already held in
// game_info (Game Name, links, publisher, release, screenshots…) are NOT synced.
// Smartsheet has no Final Evaluator / Record 5-20min columns → those stay NULL.

function parseTs(s?: string | null): string | null {
  if (s == null || !String(s).trim()) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d.toISOString()
}
function parseDate(s?: string | null): string | null {
  const t = parseTs(s)
  return t ? t.slice(0, 10) : null
}
function clean(v: unknown): string | null {
  const s = v == null ? '' : String(v).trim()
  return s === '' ? null : s
}

interface EvalRow {
  game_id: string
  category_group: string
  initial_evaluator: string | null
  assigned_date: string | null
  evaluate_date: string | null
  initial_note: string | null
  initial_conclusion: string | null
  genre_1: string | null
  genre_2: string | null
  youtube_link: string | null
}

// n8n calls this server-to-server with the shared webhook secret; humans (admin)
// can also call it from a logged-in session. Either auth path is accepted.
function hasWebhookSecret(req: NextRequest): boolean {
  const secret = process.env.WEBHOOK_SECRET
  return !!secret && req.headers.get('x-webhook-secret') === secret
}

export async function POST(req: NextRequest) {
  if (!hasWebhookSecret(req)) {
    const guard = await requireRole(['admin'])
    if (guard) return guard
  }

  let body: { category?: string; rows?: Record<string, unknown>[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const category = body.category
  const rows = body.rows
  if (!category || !CATEGORIES.includes(category)) {
    return NextResponse.json({ error: `category must be one of ${CATEGORIES.join(', ')}` }, { status: 400 })
  }
  if (!Array.isArray(rows)) {
    return NextResponse.json({ error: 'rows array required' }, { status: 400 })
  }

  // Map + dedup by game_id (duplicates → written once, first wins).
  const byId = new Map<string, EvalRow>()
  let noGameId = 0
  for (const r of rows) {
    const gameId = clean(r['GameID'])
    if (!gameId) { noGameId++; continue }
    if (byId.has(gameId)) continue
    const storeKit = (clean(r['StoreKit']) || '').toLowerCase()
    let conclusion = clean(r['Initial Conclusion'])
    if (storeKit === 'x') conclusion = 'Link_dead'   // StoreKit 'x' = dead link
    byId.set(gameId, {
      game_id: gameId,
      category_group: category,
      initial_evaluator: clean(r['Initial Evaluator']),
      assigned_date: parseDate(r['Assigned Date'] as string),
      evaluate_date: parseTs(r['Evaluate Date'] as string),
      initial_note: clean(r['Initial Evaluator note']),
      initial_conclusion: conclusion,
      genre_1: clean(r['Genre 1']),
      genre_2: clean(r['Genre 2']),
      // Drive Video intentionally NOT synced: Smartsheet has a single drive link,
      // but the DB splits it into record_5min/record_20min — ambiguous which one.
      // Leave NULL for now (handle later).
      youtube_link: clean(r['Youtube Video']),
    })
  }

  let mapped = Array.from(byId.values())
  const mappedTotal = mapped.length

  // FK safety: keep only game_ids that exist in game_info (should be all, since
  // Smartsheet games were originally pushed from game_info).
  let skippedNoGameInfo = 0
  if (mapped.length > 0) {
    const ids = mapped.map(r => r.game_id)
    const existing = await sql`SELECT game_id FROM game_info WHERE game_id IN ${sql(ids)}`
    const present = new Set(existing.map(r => r.game_id as string))
    const before = mapped.length
    mapped = mapped.filter(r => present.has(r.game_id))
    skippedNoGameInfo = before - mapped.length
  }

  const cols: (keyof EvalRow)[] = [
    'game_id', 'category_group', 'initial_evaluator', 'assigned_date', 'evaluate_date',
    'initial_note', 'initial_conclusion', 'genre_1', 'genre_2', 'youtube_link',
  ]

  let inserted = 0
  try {
    await sql.begin(async txRaw => {
      const tx = txRaw as unknown as typeof sql
      // Clear this category (removes test/old rows), then insert fresh.
      await tx`DELETE FROM game_evaluations WHERE category_group = ${category}`
      if (mapped.length > 0) {
        const res = await tx`
          INSERT INTO game_evaluations ${tx(mapped, ...cols)}
          ON CONFLICT (game_id, category_group) DO NOTHING
        `
        inserted = res.count
      }
    })
  } catch (e) {
    console.error('import-evaluations DB error:', e)
    return NextResponse.json({ error: 'DB write failed', detail: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    category,
    received: rows.length,
    mapped: mappedTotal,
    inserted,
    skipped_no_gameid: noGameId,
    skipped_no_gameinfo: skippedNoGameInfo,
  })
}
