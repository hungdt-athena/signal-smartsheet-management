// The pending review queue, read as flat rows with `conflict` already decided.
//
// Kept out of the route files so the queue listing and the single-row read after
// an inline edit return the exact same shape: the admin table is rebuilt from
// whatever this returns, so a PATCH that answered with fewer columns would blank
// the row it just corrected.

import { sql } from '@/lib/db'
import { classifyTag, TRENDS_FIELD } from '@/lib/playtest-tags'

/** One pending proposal plus the game it belongs to and Signal Sense's current
 *  state for the same (game, value). */
export interface QueueTag {
  id: number
  game_id: string
  title: string
  publisher_name: string | null
  icon_url: string | null
  initial_evaluator: string | null
  field_value: string
  sub_value_id: number | null
  sub_value_name: string | null
  tagged_by_name: string | null
  tagged_at: string
  their_sub_value_id: number | null
  their_sub_value_name: string | null
  /** Signal Sense has this value with a different sub-value: confirming writes
   *  nothing unless the admin ticks overwrite. */
  conflict: boolean
}

interface Row extends Omit<QueueTag, 'conflict'> {
  /** True when Signal Sense already has a row for this (game, value). Needed on
   *  its own because a joined row with a NULL sub-value and no joined row at all
   *  both leave `their_sub_value_id` NULL, and `classifyTag` treats them
   *  differently. */
  their_exists: boolean
}

/** How many tags are waiting, for the queue's paging. */
export async function countQueue(): Promise<number> {
  const [row] = await sql`SELECT count(*)::int AS n FROM playtest_tags WHERE status = 'pending'`
  return (row?.n as number) ?? 0
}

/** Pending tags, newest first. `ids` narrows to specific rows — used to read
 *  back a single row after an edit. `limit`/`offset` page the queue; a game's
 *  tags can therefore straddle a page boundary, which is fine now that every
 *  row carries its own game. */
export async function fetchQueue(
  opts: { ids?: number[]; limit?: number; offset?: number } = {},
): Promise<QueueTag[]> {
  const idFilter = opts.ids ? sql`AND pt.id = ANY(${opts.ids})` : sql``
  const window = opts.limit === undefined
    ? sql``
    : sql`LIMIT ${opts.limit} OFFSET ${opts.offset ?? 0}`
  const rows = await sql`
    SELECT
      pt.id, pt.game_id, pt.field_value, pt.sub_value_id, pt.tagged_at,
      gi.title, gi.icon_url,
      COALESCE(dev.developer_name, dev.dev_company) AS publisher_name,
      ge.initial_evaluator,
      du.name AS tagged_by_name,
      sv.name AS sub_value_name,
      (cfv.field_value IS NOT NULL) AS their_exists,
      cfv.sub_value_id AS their_sub_value_id,
      their_sv.name AS their_sub_value_name
    FROM playtest_tags pt
    JOIN game_info gi ON gi.game_id = pt.game_id
    LEFT JOIN developer dev ON gi.publisher_id = dev.id
    LEFT JOIN LATERAL (
      SELECT initial_evaluator FROM game_evaluations WHERE game_id = pt.game_id LIMIT 1
    ) ge ON true
    LEFT JOIN dashboard_users du ON du.email = pt.tagged_by
    LEFT JOIN sub_value_definitions sv ON sv.id = pt.sub_value_id
    LEFT JOIN custom_field_values cfv
      ON cfv.game_id = pt.game_id AND cfv.field_name = ${TRENDS_FIELD} AND cfv.field_value = pt.field_value
    LEFT JOIN sub_value_definitions their_sv ON their_sv.id = cfv.sub_value_id
    WHERE pt.status = 'pending' ${idFilter}
    -- Newest game first, its own tags together and newest first inside. Ordering
    -- the grouping here rather than in the client is what lets the queue be
    -- paged: a game cannot be split across two pages by a later arrival, and id
    -- breaks every remaining tie so no row can appear on two pages.
    ORDER BY MAX(pt.tagged_at) OVER (PARTITION BY pt.game_id) DESC,
             pt.game_id, pt.tagged_at DESC, pt.id
    ${window}
  ` as unknown as Row[]

  return rows.map(r => {
    // One definition of "conflict" only: the same pure function the confirm
    // route runs. Recomputing the rule here would let the queue's badges drift
    // away from what Confirm actually does.
    const action = classifyTag(
      { id: r.id, field_value: r.field_value, sub_value_id: r.sub_value_id },
      r.their_exists
        ? { field_value: r.field_value, sub_value_id: r.their_sub_value_id }
        : undefined,
    )
    // their_exists is an implementation detail of the join, not part of the row
    // the client reads: `conflict` is what it was needed for.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { their_exists, ...tag } = r
    return { ...tag, conflict: action.kind === 'conflict' }
  })
}
