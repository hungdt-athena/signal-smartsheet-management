import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { loadGenreTargets } from '@/lib/genre-config-db'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// DB replacement for the "[unified] database-to-smartsheet" n8n flow:
// new releases from game_info become unassigned game_evaluations rows.
// Dedupe via the UNIQUE(game_id, category_group) constraint instead of the
// ID-ledger sheet.
// NOTE: never hard-delete game_evaluations rows for dead links (mark
// Link_dead) — a deleted row inside the 30-day window would be re-pushed.

const CATEGORIES = ['puzzle', 'arcade', 'simulation']

function hasWebhookSecret(req: NextRequest): boolean {
  const secret = process.env.WEBHOOK_SECRET
  return !!secret && req.headers.get('x-webhook-secret') === secret
}

export async function POST(req: NextRequest) {
  if (!hasWebhookSecret(req)) {
    const guard = await requireAdmin()
    if (guard) return guard
  }

  let body: { category?: string; categories?: string[]; dryRun?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  // category  = the category_group written to game_evaluations (one of CATEGORIES).
  // categories = the game_info metadata category names to match against. These two
  //              fields differ by design: ["puzzle", "word"] are the metadata
  //              categories that map into the "puzzle" evaluation group.
  const category = String(body.category ?? '').trim().toLowerCase()
  if (!CATEGORIES.includes(category)) {
    return NextResponse.json({ error: `category must be one of ${CATEGORIES.join(', ')}` }, { status: 400 })
  }

  try {
    // Genre gate. /api/cron/push-targets already filters the list n8n loops over,
    // but this route is also reachable by hand and by a replayed run, so it asks
    // the same question itself. A skipped genre is a 200, not an error: nothing
    // went wrong, there is simply no reason to push games nobody will evaluate.
    const target = (await loadGenreTargets()).find(t => t.bucket === category)
    const skipped = !target?.enabled ? 'disabled' : target.available === 0 ? 'no-evaluator' : null
    if (skipped) {
      return NextResponse.json({
        ok: true, dryRun: !!body.dryRun, category, pushed: 0, game_ids: [], skipped,
      })
    }

    // Genres to match against game_info.metadata->'categories'. Callers may pass an
    // explicit `categories` override; otherwise derive them from category_mappings so
    // n8n only needs to send {category} (the DB owns the genre→bucket split now).
    let cats = (body.categories || []).map(c => String(c).trim().toLowerCase()).filter(Boolean)
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

    // Eligibility window (both branches below carry an identical copy; postgres.js
    // template literals do not compose cleanly and the dry-run count is only worth
    // reading if it filters exactly like the insert):
    //   released in the last 30 days, OR — only when the store gave us no release
    //   date at all — crawled in the last 30 days.
    // A game released long ago that merely got crawled today is back catalogue, not
    // a new release. Admitting it on created_date alone is what put 2,876 games in
    // the queue on 2026-08-19 when the apkcombo scraper reached a publisher's
    // archive.

    if (body.dryRun) {
      // DryRun: SELECT only, no INSERT.
      rows = await sql<{ game_id: string }[]>`
        SELECT gi.game_id
        FROM game_info gi
        CROSS JOIN LATERAL (
          SELECT COALESCE(gi.initial_release, gi.temp_release) AS rel,
                 (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS today
        ) w
        WHERE (
                w.rel BETWEEN (w.today - INTERVAL '30 days') AND w.today
                OR (w.rel IS NULL AND gi.created_date BETWEEN (w.today - INTERVAL '30 days') AND w.today)
              )
          AND (gi.type IS NULL OR gi.type::text ILIKE '%sync%' OR gi.type::text ILIKE '%top-pub-scraper%'
               OR gi.type::text ILIKE '%apkcombo-scraper%' OR gi.type::text ILIKE '%appagg-scraper%')
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
      rows = await sql<{ game_id: string }[]>`
        INSERT INTO game_evaluations (game_id, category_group, genre_1, genre_2)
        -- genre_1/genre_2 mirror the first two entries of metadata->'categories', the
        -- shape the Smartsheet-era import used. Without them the Evaluate panel shows an
        -- empty Genre field, since it reads the columns and not game_info.
        SELECT gi.game_id, ${category},
               left(gi.metadata -> 'categories' ->> 0, 50),
               left(gi.metadata -> 'categories' ->> 1, 50)
        FROM game_info gi
        CROSS JOIN LATERAL (
          SELECT COALESCE(gi.initial_release, gi.temp_release) AS rel,
                 (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS today
        ) w
        WHERE (
                w.rel BETWEEN (w.today - INTERVAL '30 days') AND w.today
                OR (w.rel IS NULL AND gi.created_date BETWEEN (w.today - INTERVAL '30 days') AND w.today)
              )
          AND (gi.type IS NULL OR gi.type::text ILIKE '%sync%' OR gi.type::text ILIKE '%top-pub-scraper%'
               OR gi.type::text ILIKE '%apkcombo-scraper%' OR gi.type::text ILIKE '%appagg-scraper%')
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
