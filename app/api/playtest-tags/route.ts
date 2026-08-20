import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireAuth } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'
import { isManagerRole } from '@/lib/roles'
import { TRENDS_FIELD, type PendingTag } from '@/lib/playtest-tags'
import { syncTags } from '@/lib/playtest-tags-sync'
import { fetchQueue } from '@/lib/playtest-tags-queue'

export const dynamic = 'force-dynamic'

interface SessionInfo { isManager: boolean; isAdmin: boolean; name: string; email: string }

async function resolveSession(): Promise<SessionInfo> {
  if (process.env.SKIP_AUTH === 'true') {
    return { isManager: true, isAdmin: true, name: '', email: 'skip-auth@local' }
  }
  const session = await getServerSession(authOptions)
  const role = session?.user?.role
  return {
    isManager: isManagerRole(role),
    isAdmin: role === 'admin',
    name: session?.user?.name || '',
    email: session?.user?.email || '',
  }
}

// GET /api/playtest-tags?gameId=<id> — this game's pending proposals plus the
// Trends tags it already carries in Signal Sense (shown read-only in the modal
// so nobody re-tags what is there).
//
// The pending rows come from the same fetchQueue the admin Tagging tab reads, so
// the in-modal review sees the same `conflict` verdict the queue does. Computing
// it separately here would let the two drift, and they decide when another
// application's data gets overwritten.
export async function GET(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  const gameId = (req.nextUrl.searchParams.get('gameId') || '').trim()
  if (!gameId) return NextResponse.json({ error: 'gameId required' }, { status: 400 })

  const [pending, existing] = await Promise.all([
    fetchQueue({ gameId }),
    sql`
      SELECT cfv.field_value, cfv.sub_value_id, sv.name AS sub_value_name
      FROM custom_field_values cfv
      LEFT JOIN sub_value_definitions sv ON sv.id = cfv.sub_value_id
      WHERE cfv.game_id = ${gameId} AND cfv.field_name = ${TRENDS_FIELD}
      ORDER BY cfv.field_value
    `,
  ])

  return NextResponse.json({ pending, existing }, { headers: { 'Cache-Control': 'no-store' } })
}

// PUT /api/playtest-tags — replace the whole pending set for one game. Called
// from the evaluation modal's save(), so the payload is the full list the user
// sees: anything missing from it is dropped.
export async function PUT(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  let body: { game_id?: string; tags?: { field_value?: string; sub_value_id?: number | null }[] }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const gameId = (body.game_id || '').trim()
  if (!gameId) return NextResponse.json({ error: 'game_id required' }, { status: 400 })

  const tags = (body.tags || [])
    .map(t => ({ field_value: (t.field_value || '').trim(), sub_value_id: t.sub_value_id ?? null }))
    .filter(t => t.field_value)
  // The pending set is keyed on (game, value); collapse a repeated value rather
  // than tripping the partial unique index.
  const unique = Array.from(new Map(tags.map(t => [t.field_value, t])).values())

  const { isManager, isAdmin, name, email } = await resolveSession()

  // Own-only: an evaluator may tag their own game, a manager any game.
  // game_evaluations is UNIQUE(game_id, category_group), so a game can hold rows
  // in two groups — test EXISTS across all of them instead of picking one row,
  // which would make authorisation depend on the planner.
  const evRows = await sql`
    SELECT
      EXISTS (SELECT 1 FROM game_evaluations WHERE game_id = ${gameId}) AS found,
      EXISTS (
        SELECT 1 FROM game_evaluations
        WHERE game_id = ${gameId} AND initial_evaluator ILIKE ${name}
      ) AS owned
  `
  if (!evRows[0]?.found) return NextResponse.json({ error: 'Game not found' }, { status: 404 })
  if (!isManager && !(name && evRows[0].owned)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Values must exist as active Trends definitions — this app never creates them.
  if (unique.length > 0) {
    const wanted = unique.map(t => t.field_value)
    const ok = await sql`
      SELECT DISTINCT field_value FROM custom_field_definitions
      WHERE field_name = ${TRENDS_FIELD} AND is_active AND field_value = ANY(${wanted})
    `
    const allowed = new Set(ok.map(r => r.field_value as string))
    const bad = wanted.filter(v => !allowed.has(v))
    if (bad.length > 0) {
      return NextResponse.json({ error: `Unknown Trends value: ${bad.join(', ')}` }, { status: 400 })
    }
  }

  // Replace: only pending rows are touched, so confirmed/rejected history stays.
  // A row that survives the replace keeps its original tagged_by / tagged_at --
  // provenance is the whole reason this table exists, and this PUT fires on every
  // eval save, including saves that never touched a tag. So: drop the pending
  // rows whose value is gone from the payload, then upsert the rest on the
  // partial unique index, updating only the sub-value.
  // Wrapped in a transaction so a mid-loop failure (e.g. a bad sub_value_id FK)
  // can't leave the DELETE committed with a partial INSERT set.
  const values = unique.map(t => t.field_value)
  await sql.begin(async txRaw => {
    const tx = txRaw as unknown as typeof sql
    if (values.length === 0) {
      await tx`DELETE FROM playtest_tags WHERE game_id = ${gameId} AND status = 'pending'`
    } else {
      await tx`
        DELETE FROM playtest_tags
        WHERE game_id = ${gameId} AND status = 'pending'
          AND NOT (field_value = ANY(${values}))
      `
      for (const t of unique) {
        // The conflict target repeats the index predicate because
        // playtest_tags_pending_uniq is a PARTIAL unique index.
        //
        // Editing someone else's pending tag here makes it yours: this dialog
        // has no review trail -- no original_* snapshot, no note, no separate
        // reviewer -- so the honest record is that the saver is now the one
        // proposing this tag. Reviewing without taking it over is what the
        // panel's pending pills are for, and they go through PATCH + confirm.
        //
        // Guarded on an actual change: this PUT fires on every evaluation save,
        // including saves that never opened the tag dialog. Without the CASE, an
        // admin who saved a note would quietly take over every teammate's
        // pending tag on that game.
        await tx`
          INSERT INTO playtest_tags (game_id, field_value, sub_value_id, tagged_by)
          VALUES (${gameId}, ${t.field_value}, ${t.sub_value_id}, ${email})
          ON CONFLICT (game_id, field_value) WHERE status = 'pending'
          DO UPDATE SET
            sub_value_id = EXCLUDED.sub_value_id,
            tagged_by = CASE
              WHEN playtest_tags.sub_value_id IS DISTINCT FROM EXCLUDED.sub_value_id
                THEN EXCLUDED.tagged_by ELSE playtest_tags.tagged_by END,
            tagged_at = CASE
              WHEN playtest_tags.sub_value_id IS DISTINCT FROM EXCLUDED.sub_value_id
                THEN now() ELSE playtest_tags.tagged_at END
        `
      }
    }

    // An admin does not queue up to review themselves: their tags go straight
    // into Signal Sense, in this same transaction, and their sub-value wins any
    // conflict. Overwrite is automatic here and has to be ticked on the manual
    // confirm path -- that difference is the whole of the admin tier's edge in
    // this flow, and the reason a moderator's tags still queue.
    //
    // `tagged_by = email` is what keeps this honest. The modal shows the whole
    // game's pending set, so without it an admin who saved the evaluation form
    // would silently confirm every proposal an evaluator had left waiting --
    // approving work they never looked at. Other people's tags stay pending and
    // are reviewed deliberately, in the queue or in the panel's review rows.
    //
    // Read back rather than trusting the payload: the upsert above may have
    // updated an existing row, and it is that row's id the sync has to stamp.
    if (isAdmin && values.length > 0) {
      const rows = await tx`
        SELECT id, field_value, sub_value_id
        FROM playtest_tags
        WHERE game_id = ${gameId} AND status = 'pending'
          AND field_value = ANY(${values}) AND tagged_by = ${email}
        ORDER BY id
      ` as unknown as PendingTag[]
      await syncTags(tx, {
        gameId, pending: rows, actor: email,
        overwrite: new Set(rows.map(r => r.id)),
        notes: new Map(),
      })
    }
  })

  return NextResponse.json({ ok: true, count: unique.length })
}
