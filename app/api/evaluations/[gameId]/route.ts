import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { getCurrentBatch } from '@/lib/current-batch'
import { getSession } from '@/lib/session'
import { isStorageConfigured, deleteGameScreenshots } from '@/lib/screenshot-store'
import { sortStores, type PairStore } from '@/lib/eval-pairs'

/** One store of a linked pair, as the panel's Game Info card reads it. Per-store: link, QR, publisher,
 *  release date, StoreKit, description. `conclusion` is that store row's own initial_conclusion.
 *  The two codes are the pair's (the front row's, else the twin's). */
export type PanelStore = PairStore & {
  title: string | null
  icon_url: string | null
  release_date: string | null
  publisher_name: string | null
  publisher_link: string | null
  screenshot_urls: unknown
  manual_screenshot_urls?: unknown
  description: unknown
  subtitle: unknown
  content_rating: unknown
  demo_code: string | null
  record_code: string | null
  conclusion: string | null
}

export const dynamic = 'force-dynamic'

/** Fire-and-forget: StoreKit arrived, so drop the temporary manual copies.
 *  Idempotent — any later view retries if this run fails. */
function cleanupManualScreenshots(gameId: string) {
  if (!isStorageConfigured()) return
  Promise.resolve().then(async () => {
    await deleteGameScreenshots(gameId)
    await sql`UPDATE game_info SET metadata = metadata - 'manual_screenshot_urls' WHERE game_id = ${gameId}`
  }).catch(err => console.error('manual screenshot cleanup failed:', gameId, err))
}

export async function GET(
  req: NextRequest,
  { params }: { params: { gameId: string } }
) {
  const guard = await requireAuth()
  if (guard) return guard

  try {
    const gameId = params.gameId
    if (!gameId) return NextResponse.json({ error: 'Invalid game_id' }, { status: 400 })

    // Optional: scope to a category so a game with eval rows in more than one
    // category returns the right one. Every list that opens the panel is per genre
    // and passes it; without it a game in two genres opened whichever row came
    // back first, often another evaluator's.
    const category = req.nextUrl.searchParams.get('category') || ''
    const categoryFilter = category ? sql`AND rq.category_group = ${category}` : sql``

    // A linked game opens as its pair: `data` is the FRONT row (the live one) whichever store's
    // game_id was asked for, and `pair` carries both stores. `rq` is the row asked for, `ge` the
    // front row of its pair (itself when it is not linked or is the front). The twin's store comes
    // in a LATERAL, so the pair costs no extra round-trip.
    // The game and the team's current batch go out together: they are independent,
    // so they share one round-trip on the panel's hottest path (every open, every Next).
    const [rows, currentBatch] = await Promise.all([
      sql`
      SELECT ge.id, ge.game_id, ge.category_group, ge.genre_1, ge.genre_2,
        ge.initial_evaluator, ge.final_evaluator, ge.assigned_date,
        ge.evaluate_date, ge.initial_note, ge.final_note, ge.game_alike,
        ge.initial_gameplay, ge.initial_game_over, ge.initial_level_complete, ge.initial_self_note,
        ge.initial_conclusion, ge.final_conclusion, ge.final_conclusion_date, ge.batch,
        ge.record_assignee, ge.record_assign_date,
        ge.record_5min_assignee, ge.record_5min_date,
        ge.record_5min_drive, ge.record_5min_drive_date,
        ge.record_20min_assignee, ge.record_20min_date,
        ge.record_20min_drive, ge.record_20min_drive_date,
        ge.record_confirmed_at,
        ge.drive_link, ge.drive_date, ge.youtube_link, ge.record_bucket,
        ge.record_5min_confirmed_at, ge.record_20min_confirmed_at,
        ge.youtube_5min_link, ge.youtube_20min_link,
        to_char(ge.youtube_5min_uploaded_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') AS youtube_5min_uploaded_local,
        to_char(ge.youtube_20min_uploaded_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') AS youtube_20min_uploaded_local,
        ge.imported_at, ge.updated_at, ge.updated_by,
        ge.pair_eval_id,
        gi.title, gi.os, gi.app_link, gi.icon_url,
        gi.demo_code, gi.record_code,
        COALESCE(gi.initial_release, gi.temp_release)::text AS release_date,
        gi.metadata->'screenshot_urls' AS screenshot_urls,
        gi.metadata->'manual_screenshot_urls' AS manual_screenshot_urls,
        gi.metadata->'categories' AS categories,
        gi.metadata->'description' AS description,
        gi.metadata->'subtitle' AS subtitle,
        gi.metadata->'content_rating' AS content_rating,
        COALESCE(dev.developer_name, dev.dev_company) AS publisher_name,
        dev.developer_link AS publisher_link,
        ps.stores AS pair_stores
      FROM game_evaluations ge
      JOIN game_evaluations rq ON ge.id = CASE WHEN rq.pair_back THEN rq.pair_eval_id ELSE rq.id END
      JOIN game_info gi ON ge.game_id = gi.game_id
      LEFT JOIN developer dev ON gi.publisher_id = dev.id
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
                 'os', g.os, 'game_id', x.game_id, 'eval_id', x.id, 'app_link', g.app_link,
                 'is_active', COALESCE(g.is_active, true),
                 'dead', x.initial_conclusion IS NOT DISTINCT FROM 'Link_dead',
                 'title', g.title, 'icon_url', g.icon_url,
                 'release_date', COALESCE(g.initial_release, g.temp_release)::text,
                 'publisher_name', COALESCE(d.developer_name, d.dev_company),
                 'publisher_link', d.developer_link,
                 'screenshot_urls', g.metadata->'screenshot_urls',
                 'manual_screenshot_urls', g.metadata->'manual_screenshot_urls',
                 'description', g.metadata->'description',
                 'subtitle', g.metadata->'subtitle',
                 'content_rating', g.metadata->'content_rating',
                 'demo_code', g.demo_code, 'record_code', g.record_code,
                 'conclusion', x.initial_conclusion
               ) ORDER BY CASE WHEN g.os = 'ios' THEN 0 ELSE 1 END) AS stores
        FROM game_evaluations x
        JOIN game_info g ON g.game_id = x.game_id
        LEFT JOIN developer d ON d.id = g.publisher_id
        WHERE ge.pair_eval_id IS NOT NULL AND (x.id = ge.id OR x.id = ge.pair_eval_id)
      ) ps ON true
      WHERE rq.game_id = ${gameId}
        ${categoryFilter}
      ORDER BY ge.id
    `,
      getCurrentBatch(),
    ])

    if (rows.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Still two rows (no category given): the caller's own comes first, so an
    // evaluator opening a game from a list without a genre gets the row they can
    // edit and not a colleague's. Otherwise the older row, which is the one the
    // push created first.
    let row = rows[0]
    if (rows.length > 1) {
      const me = (await getSession())?.user?.name?.toLowerCase()
      if (me) row = rows.find(r => (r.initial_evaluator as string | null)?.toLowerCase() === me) ?? row
    }
    // StoreKit screenshots win over the manual ones: each store's own metadata decides, and a store
    // that has StoreKit drops its manual copies.
    const stripManual = (o: { game_id?: unknown; screenshot_urls?: unknown; manual_screenshot_urls?: unknown }) => {
      const hasStoreKit = Array.isArray(o.screenshot_urls) && o.screenshot_urls.length > 0
      const hasManual = Array.isArray(o.manual_screenshot_urls) && o.manual_screenshot_urls.length > 0
      if (!hasStoreKit) return
      if (hasManual && typeof o.game_id === 'string') cleanupManualScreenshots(o.game_id)
      o.manual_screenshot_urls = null
    }
    stripManual(row)

    // The pair: both stores, iOS first. The codes belong to the pair: the front row's, else the twin's.
    const rawStores = (row.pair_stores ?? null) as PanelStore[] | null
    delete row.pair_stores
    delete row.pair_eval_id
    let pair: { selected_game_id: string; stores: PanelStore[] } | null = null
    if (rawStores && rawStores.length === 2) {
      const demo = (row.demo_code as string | null) ?? rawStores.find(s => s.demo_code)?.demo_code ?? null
      const rec = (row.record_code as string | null) ?? rawStores.find(s => s.record_code)?.record_code ?? null
      row.demo_code = demo
      row.record_code = rec
      const stores = rawStores.map(s => ({ ...s, demo_code: demo, record_code: rec }))
      for (const s of stores) {
        if (s.game_id !== row.game_id) stripManual(s)
        else s.manual_screenshot_urls = row.manual_screenshot_urls
      }
      pair = { selected_game_id: gameId, stores: sortStores(stores) as PanelStore[] }
    }
    // Team-wide current batch (one value for every category) — drives the forced
    // batch evaluators get when marking List_Idea (see EvalDetailPanel).
    row.current_batch = currentBatch
    return NextResponse.json({ data: row, pair })
  } catch (err) {
    console.error('GET /api/evaluations/[gameId] error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
