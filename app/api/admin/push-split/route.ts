import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Manual game split (DB-side) — parity test against the Smartsheet push/split flow.
//
// Ports the exact eligibility/split logic from [unified]-database-to-smartsheet:
//   - COALESCE(initial_release, temp_release) within the last N days (default 30)
//   - type IS NULL OR type ILIKE '%sync%'
//   - app_link IS NOT NULL AND is_active = true
//   - metadata->'categories' overlaps the bucket's genre list
//   - a game may land in MULTIPLE buckets (each bucket matched independently — no
//     cross-bucket dedup, same as the Smartsheet flow)
//
// Bucket membership comes from category_mappings (genre -> category_group), or from
// an inline `mappings` override in the request body (useful before the table is seeded).
//
// GET  -> dry run: report eligible games per bucket, nothing written.
// POST -> insert eligible rows into game_evaluations (ON CONFLICT DO NOTHING),
//         unless { dryRun: true }.

const DEFAULT_WINDOW_DAYS = 30

function hasWebhookSecret(req: NextRequest): boolean {
  const secret = process.env.WEBHOOK_SECRET
  return !!secret && req.headers.get('x-webhook-secret') === secret
}

type Pair = { genre: string; category_group: string }

// Inline mappings: { puzzle: ['Puzzle','Word'], arcade: [...], ... }
function pairsFromBody(mappings: unknown): Pair[] | null {
  if (!mappings || typeof mappings !== 'object') return null
  const out: Pair[] = []
  for (const [group, genres] of Object.entries(mappings as Record<string, unknown>)) {
    if (!Array.isArray(genres)) continue
    for (const g of genres) {
      const genre = String(g).trim()
      if (genre) out.push({ genre, category_group: String(group).trim().toLowerCase() })
    }
  }
  return out.length ? out : null
}

async function pairsFromTable(): Promise<Pair[]> {
  const rows = await sql<Pair[]>`
    SELECT genre, category_group FROM category_mappings WHERE active = true
  `
  return rows.map((r) => ({ genre: r.genre, category_group: r.category_group }))
}

interface EligibleRow {
  game_id: string
  category_group: string
  already_in_db: boolean
}

async function computeEligible(pairs: Pair[], windowDays: number): Promise<EligibleRow[]> {
  const mappingJson = JSON.stringify(
    pairs.map((p) => ({ genre: p.genre.toLowerCase(), category_group: p.category_group })),
  )
  return sql<EligibleRow[]>`
    WITH mapping AS (
      SELECT genre, category_group
      FROM jsonb_to_recordset(${mappingJson}::jsonb) AS m(genre text, category_group text)
    ),
    eligible AS (
      SELECT DISTINCT gi.game_id, m.category_group
      FROM game_info gi
      CROSS JOIN LATERAL jsonb_array_elements_text(gi.metadata -> 'categories') AS cat(name)
      JOIN mapping m ON m.genre = lower(cat.name)
      WHERE jsonb_typeof(gi.metadata -> 'categories') = 'array'
        AND COALESCE(gi.initial_release, gi.temp_release)
              BETWEEN (CURRENT_DATE - (${windowDays} || ' days')::interval) AND CURRENT_DATE
        AND (gi.type IS NULL OR gi.type::text ILIKE '%sync%')
        AND gi.app_link IS NOT NULL
        AND gi.is_active = true
    )
    SELECT e.game_id, e.category_group, (ge.game_id IS NOT NULL) AS already_in_db
    FROM eligible e
    LEFT JOIN game_evaluations ge
      ON ge.game_id = e.game_id AND ge.category_group = e.category_group
    ORDER BY e.category_group, e.game_id
  `
}

function summarize(rows: EligibleRow[]) {
  const buckets: Record<string, { eligible: number; new: number; game_ids: string[] }> = {}
  for (const r of rows) {
    const b = (buckets[r.category_group] ??= { eligible: 0, new: 0, game_ids: [] })
    b.eligible += 1
    if (!r.already_in_db) b.new += 1
    b.game_ids.push(r.game_id)
  }
  return buckets
}

async function run(req: NextRequest, write: boolean) {
  if (!hasWebhookSecret(req)) {
    const guard = await requireRole(['admin'])
    if (guard) return guard
  }

  let body: Record<string, unknown> = {}
  if (write) {
    try {
      body = await req.json()
    } catch {
      body = {}
    }
  }

  const windowDays = Number(body.windowDays) > 0 ? Number(body.windowDays) : DEFAULT_WINDOW_DAYS
  const dryRun = body.dryRun === true || !write

  const pairs = pairsFromBody(body.mappings) ?? (await pairsFromTable())
  if (pairs.length === 0) {
    return NextResponse.json(
      {
        error:
          'No category mappings. Seed the category_mappings table or pass { mappings: { puzzle: [...], arcade: [...], simulation: [...] } }.',
      },
      { status: 400 },
    )
  }

  const rows = await computeEligible(pairs, windowDays)
  const toInsert = rows.filter((r) => !r.already_in_db)

  let inserted = 0
  if (!dryRun && toInsert.length > 0) {
    const res = await sql`
      INSERT INTO game_evaluations ${sql(
        toInsert.map((r) => ({ game_id: r.game_id, category_group: r.category_group })),
        'game_id',
        'category_group',
      )}
      ON CONFLICT (game_id, category_group) DO NOTHING
    `
    inserted = res.count
  }

  return NextResponse.json({
    dryRun,
    windowDays,
    mapping_source: pairsFromBody(body.mappings) ? 'inline' : 'category_mappings',
    total_eligible: rows.length,
    total_new: toInsert.length,
    inserted,
    buckets: summarize(rows),
  })
}

export async function GET(req: NextRequest) {
  return run(req, false)
}

export async function POST(req: NextRequest) {
  return run(req, true)
}
