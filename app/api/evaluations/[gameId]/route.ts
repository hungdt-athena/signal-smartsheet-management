import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { isStorageConfigured, deleteGameScreenshots } from '@/lib/screenshot-store'

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
    // category returns the right one (the record popup passes this).
    const category = req.nextUrl.searchParams.get('category') || ''
    const categoryFilter = category ? sql`AND ge.category_group = ${category}` : sql``

    // The game and the team's current-batch config go out together. The config read
    // used to come after the game had landed, because the key it wants is built from
    // that game's category_group -- one more serialized round-trip on the panel's
    // hottest path (every open, every Next). There are only three categories, so
    // reading all of them costs nothing on a connection that is otherwise idle and
    // lets both queries share one round-trip. The right one is picked out below.
    const [rows, batchCfg] = await Promise.all([
      sql`
      SELECT ge.id, ge.game_id, ge.category_group, ge.genre_1, ge.genre_2,
        ge.initial_evaluator, ge.final_evaluator, ge.assigned_date,
        ge.evaluate_date, ge.initial_note, ge.final_note, ge.game_alike,
        ge.initial_conclusion, ge.final_conclusion, ge.final_conclusion_date, ge.batch,
        ge.record_assignee, ge.record_assign_date,
        ge.record_5min_assignee, ge.record_5min_date,
        ge.record_5min_drive, ge.record_5min_drive_date,
        ge.record_20min_assignee, ge.record_20min_date,
        ge.record_20min_drive, ge.record_20min_drive_date,
        ge.record_confirmed_at,
        ge.drive_link, ge.drive_date, ge.youtube_link,
        ge.imported_at, ge.updated_at, ge.updated_by,
        gi.title, gi.os, gi.app_link, gi.icon_url,
        COALESCE(gi.initial_release, gi.temp_release)::text AS release_date,
        gi.metadata->'screenshot_urls' AS screenshot_urls,
        gi.metadata->'manual_screenshot_urls' AS manual_screenshot_urls,
        gi.metadata->'categories' AS categories,
        gi.metadata->'description' AS description,
        gi.metadata->'subtitle' AS subtitle,
        gi.metadata->'content_rating' AS content_rating,
        COALESCE(dev.developer_name, dev.dev_company) AS publisher_name,
        dev.developer_link AS publisher_link
      FROM game_evaluations ge
      JOIN game_info gi ON ge.game_id = gi.game_id
      LEFT JOIN developer dev ON gi.publisher_id = dev.id
      WHERE ge.game_id = ${gameId}
        ${categoryFilter}
    `,
      sql<{ key: string; value: string }[]>`
        SELECT key, value FROM app_config WHERE key LIKE 'current_batch:%'
      `,
    ])

    if (rows.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const row = rows[0]
    const hasStoreKit = Array.isArray(row.screenshot_urls) && row.screenshot_urls.length > 0
    const hasManual = Array.isArray(row.manual_screenshot_urls) && row.manual_screenshot_urls.length > 0
    if (hasStoreKit) {
      if (hasManual) cleanupManualScreenshots(gameId)
      row.manual_screenshot_urls = null
    }
    // Team-wide "current batch" for this game's category — drives the forced
    // batch evaluators get when marking List_Idea (see EvalDetailPanel).
    row.current_batch =
      batchCfg.find(c => c.key === `current_batch:${row.category_group}`)?.value ?? null
    return NextResponse.json({ data: row })
  } catch (err) {
    console.error('GET /api/evaluations/[gameId] error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
