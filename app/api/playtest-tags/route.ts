import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireAuth } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'
import { isManagerRole } from '@/lib/roles'
import { classifyTag, TRENDS_FIELD, type PendingTag } from '@/lib/playtest-tags'

/** One pending proposal as the evaluation modal reads it: the tag, who proposed
 *  it, and what Signal Sense currently has for the same (game, value). */
interface ReviewRow {
  id: number
  game_id: string
  field_value: string
  sub_value_id: number | null
  sub_value_name: string | null
  tagged_by: string
  tagged_at: string
  tagged_by_name: string | null
  their_sub_value_id: number | null
  their_sub_value_name: string | null
  conflict: boolean
}
import { syncTags } from '@/lib/playtest-tags-sync'


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
// One game, so this reads it directly rather than through fetchQueue: that query
// exists for the team-wide review table and carries its weight — game_info, the
// developer join, a LATERAL over game_evaluations, a window function to keep a
// game's tags on one page. None of it means anything for a single game whose
// title the modal is already showing, and the modal re-reads this on every
// review action.
//
// `conflict` still comes from classifyTag, the same pure function fetchQueue and
// the confirm route use. Sharing the rule is what matters; sharing the query was
// never the point.
export async function GET(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  const gameId = (req.nextUrl.searchParams.get('gameId') || '').trim()
  if (!gameId) return NextResponse.json({ error: 'gameId required' }, { status: 400 })

  const [rows, existing] = await Promise.all([
    sql`
      SELECT
        pt.id, pt.game_id, pt.field_value, pt.sub_value_id, pt.tagged_by, pt.tagged_at,
        du.name AS tagged_by_name, sv.name AS sub_value_name,
        (cfv.field_value IS NOT NULL) AS their_exists,
        cfv.sub_value_id AS their_sub_value_id,
        their_sv.name AS their_sub_value_name
      FROM playtest_tags pt
      LEFT JOIN dashboard_users du ON du.email = pt.tagged_by
      LEFT JOIN sub_value_definitions sv ON sv.id = pt.sub_value_id
      LEFT JOIN custom_field_values cfv
        ON cfv.game_id = pt.game_id AND cfv.field_name = ${TRENDS_FIELD}
        AND cfv.field_value = pt.field_value
      LEFT JOIN sub_value_definitions their_sv ON their_sv.id = cfv.sub_value_id
      WHERE pt.game_id = ${gameId} AND pt.status = 'pending'
      ORDER BY pt.field_value
    `,
    // created_by is carried through so the modal can name whoever tagged it
    // before a manager edits or removes it -- these rows include tags made in
    // Signal Sense, which this app never proposed and now may still change.
    sql`
      SELECT cfv.field_value, cfv.sub_value_id, sv.name AS sub_value_name,
             cfv.created_by,
             NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS created_by_name
      FROM custom_field_values cfv
      LEFT JOIN sub_value_definitions sv ON sv.id = cfv.sub_value_id
      LEFT JOIN users u ON u.id = cfv.created_by
      WHERE cfv.game_id = ${gameId} AND cfv.field_name = ${TRENDS_FIELD}
      ORDER BY cfv.field_value
    `,
  ])

  const pending = (rows as unknown as (Omit<ReviewRow, 'conflict'> & { their_exists: boolean })[])
    .map(r => {
      const action = classifyTag(
        { id: r.id, field_value: r.field_value, sub_value_id: r.sub_value_id },
        r.their_exists
          ? { field_value: r.field_value, sub_value_id: r.their_sub_value_id }
          : undefined,
      )
      // their_exists is an artefact of the join, not part of the row the client
      // reads: `conflict` is what it was needed for.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { their_exists, ...tag } = r
      return { ...tag, conflict: action.kind === 'conflict' }
    })

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
    // Dropping someone else's tag rejects it; it is never deleted. A deleted
    // row takes the whole episode with it -- the evaluator who proposed the tag
    // would find it simply gone, with nothing in History to say who dropped it
    // or when. `rejected` keeps that line readable, and the partial unique index
    // only covers pending rows, so the same value can be proposed again later.
    // Taking back your own untouched proposal is not a review, it is a
    // correction mid-thought: the row is deleted outright. `rejected` here would
    // fill History with lines whose Proposed and Reviewed are the same person,
    // saying nothing except that someone changed their mind before an admin ever
    // saw the tag. Anyone else's tag still goes to `rejected` -- that one is a
    // decision about another person's work and has to stay readable.
    //
    // `edited_by` is the second half of the rule: once a moderator has corrected
    // the tag, the episode involves two people, and dropping it deletes their
    // correction along with it. So the row only disappears while it is still
    // wholly yours.
    if (values.length === 0) {
      await tx`
        DELETE FROM playtest_tags
        WHERE game_id = ${gameId} AND status = 'pending'
          AND tagged_by = ${email}
          AND (edited_by IS NULL OR edited_by = ${email})
      `
      await tx`
        UPDATE playtest_tags
        SET status = 'rejected', confirmed_by = ${email}, confirmed_at = now()
        WHERE game_id = ${gameId} AND status = 'pending'
      `
    } else {
      await tx`
        DELETE FROM playtest_tags
        WHERE game_id = ${gameId} AND status = 'pending'
          AND NOT (field_value = ANY(${values}))
          AND tagged_by = ${email}
          AND (edited_by IS NULL OR edited_by = ${email})
      `
      await tx`
        UPDATE playtest_tags
        SET status = 'rejected', confirmed_by = ${email}, confirmed_at = now()
        WHERE game_id = ${gameId} AND status = 'pending'
          AND NOT (field_value = ANY(${values}))
      `
      for (const t of unique) {
        // The conflict target repeats the index predicate because
        // playtest_tags_pending_uniq is a PARTIAL unique index.
        //
        // Editing someone else's pending tag here leaves the same trail the
        // review rows leave: they proposed it, you edited it. Provenance stays
        // with the tagger, the version being replaced is snapshotted once, and
        // edited_by names whoever moved it -- so one line of History reads
        // "proposed by X, edited by Y" instead of quietly becoming Y's tag.
        //
        // Every branch is guarded on the sub-value actually moving. This PUT
        // fires on every evaluation save, including saves that never opened the
        // tag dialog; without the guards, saving a note would stamp an edit on
        // each of a teammate's pending tags.
        await tx`
          INSERT INTO playtest_tags (game_id, field_value, sub_value_id, tagged_by)
          VALUES (${gameId}, ${t.field_value}, ${t.sub_value_id}, ${email})
          ON CONFLICT (game_id, field_value) WHERE status = 'pending'
          DO UPDATE SET
            sub_value_id = EXCLUDED.sub_value_id,
            original_field_value = CASE
              WHEN playtest_tags.sub_value_id IS DISTINCT FROM EXCLUDED.sub_value_id
                AND playtest_tags.original_captured_at IS NULL
                THEN playtest_tags.field_value ELSE playtest_tags.original_field_value END,
            original_sub_value_id = CASE
              WHEN playtest_tags.sub_value_id IS DISTINCT FROM EXCLUDED.sub_value_id
                AND playtest_tags.original_captured_at IS NULL
                THEN playtest_tags.sub_value_id ELSE playtest_tags.original_sub_value_id END,
            original_captured_at = CASE
              WHEN playtest_tags.sub_value_id IS DISTINCT FROM EXCLUDED.sub_value_id
                AND playtest_tags.original_captured_at IS NULL
                THEN now() ELSE playtest_tags.original_captured_at END,
            edited_by = CASE
              WHEN playtest_tags.sub_value_id IS DISTINCT FROM EXCLUDED.sub_value_id
                THEN EXCLUDED.tagged_by ELSE playtest_tags.edited_by END,
            edited_at = CASE
              WHEN playtest_tags.sub_value_id IS DISTINCT FROM EXCLUDED.sub_value_id
                THEN now() ELSE playtest_tags.edited_at END
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
