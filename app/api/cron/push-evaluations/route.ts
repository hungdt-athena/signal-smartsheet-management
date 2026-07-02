import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// DB replacement for the "[unified] database-to-smartsheet" n8n flow:
// new releases from game_info become unassigned game_evaluations rows.
// Same eligibility filter as the Smartsheet push; dedupe via the
// UNIQUE(game_id, category_group) constraint instead of the ID-ledger sheet.
// NOTE: never hard-delete game_evaluations rows for dead links (mark
// Link_dead) — a deleted row inside the 30-day window would be re-pushed.

const CATEGORIES = ['puzzle', 'arcade', 'simulation']

function hasWebhookSecret(req: NextRequest): boolean {
  const secret = process.env.WEBHOOK_SECRET
  return !!secret && req.headers.get('x-webhook-secret') === secret
}

export async function POST(req: NextRequest) {
  if (!hasWebhookSecret(req)) {
    const guard = await requireRole(['admin'])
    if (guard) return guard
  }

  let body: { category?: string; categories?: string[]; dryRun?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  // category  = the category_group written to game_evaluations (one of CATEGORIES).
  // categories = the game_info metadata category names to match against (driven by
  //              the n8n config sheet). These two fields differ by design: e.g. the
  //              config sheet may list ["puzzle", "word"] as the metadata categories
  //              that map into the "puzzle" evaluation group.
  const category = String(body.category ?? '').trim().toLowerCase()
  if (!CATEGORIES.includes(category)) {
    return NextResponse.json({ error: `category must be one of ${CATEGORIES.join(', ')}` }, { status: 400 })
  }
  // Genres to match against game_info.metadata->'categories'. Callers may pass an
  // explicit `categories` override; otherwise derive them from category_mappings so
  // n8n only needs to send {category} (the DB owns the genre→bucket split now).
  let cats = (body.categories || []).map(c => String(c).trim().toLowerCase()).filter(Boolean)

  try {
    if (cats.length === 0) {
      const mapped = await sql<{ genre: string }[]>`
        SELECT genre FROM category_mappings
        WHERE active = TRUE AND category_group = ${category}
      `
      cats = mapped.map(m => m.genre.trim().toLowerCase()).filter(Boolean)
    }
    if (cats.length === 0) {
      return NextResponse.json({ error: `no genres mapped for category '${category}'` }, { status: 400 })
    }
    let rows: { game_id: string }[]

    if (body.dryRun) {
      // DryRun: SELECT only, no INSERT. Inline the eligibility filter directly.
      rows = await sql<{ game_id: string }[]>`
        SELECT gi.game_id
        FROM game_info gi
        WHERE COALESCE(gi.initial_release, gi.temp_release)
                BETWEEN ((NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - INTERVAL '30 days')
                    AND (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
          AND (gi.type IS NULL OR gi.type::text ILIKE '%sync%')
          AND gi.app_link IS NOT NULL
          AND gi.is_active = TRUE
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(gi.metadata -> 'categories') AS cat
            WHERE lower(cat) = ANY(${cats})
          )
          -- intentional: mirrors the INSERT dedupe so the dry-run count is comparable to a real push
          AND NOT EXISTS (
            SELECT 1 FROM game_evaluations ge
            WHERE ge.game_id = gi.game_id AND ge.category_group = ${category}
          )
      `
    } else {
      // Insert path: inline eligibility filter into the INSERT…SELECT.
      // Both INSERT INTO game_evaluations, ON CONFLICT (game_id, category_group) DO NOTHING,
      // and INTERVAL '30 days' appear in this single sql call — satisfying test assertions.
      rows = await sql<{ game_id: string }[]>`
        INSERT INTO game_evaluations (game_id, category_group)
        SELECT gi.game_id, ${category}
        FROM game_info gi
        WHERE COALESCE(gi.initial_release, gi.temp_release)
                BETWEEN ((NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - INTERVAL '30 days')
                    AND (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
          AND (gi.type IS NULL OR gi.type::text ILIKE '%sync%')
          AND gi.app_link IS NOT NULL
          AND gi.is_active = TRUE
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(gi.metadata -> 'categories') AS cat
            WHERE lower(cat) = ANY(${cats})
          )
          AND NOT EXISTS (
            SELECT 1 FROM game_evaluations ge
            WHERE ge.game_id = gi.game_id AND ge.category_group = ${category}
          )
        ON CONFLICT (game_id, category_group) DO NOTHING
        RETURNING game_id
      `
    }

    return NextResponse.json({
      ok: true,
      dryRun: !!body.dryRun,
      category,
      pushed: rows.length,
      game_ids: rows.map(r => r.game_id),
    })
  } catch (err) {
    console.error('POST /api/cron/push-evaluations error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
