import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

const BUCKETS = ['5min', '20min', 'none'] as const

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'moderator'])
  if (guard) return guard
  try {
    const { id, bucket } = await req.json()
    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }
    if (!BUCKETS.includes(bucket)) {
      return NextResponse.json({ error: 'bucket must be one of 5min, 20min, none' }, { status: 400 })
    }

    const found = await sql`
      SELECT record_bucket, record_5min_assignee, record_20min_assignee, final_conclusion
      FROM game_evaluations WHERE id = ${id}
    `
    if (found.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    const row = found[0]

    // Resolve the current effective bucket (manual override wins, else derive
    // from final_conclusion) and the assignee currently in that container.
    const cur =
      row.record_bucket === '5min' || row.record_bucket === '20min'
        ? row.record_bucket
        : row.final_conclusion === 'Priority IV'
          ? '20min'
          : row.final_conclusion === 'Insight'
            ? '5min'
            : null
    const curAssignee =
      cur === '5min' ? row.record_5min_assignee
        : cur === '20min' ? row.record_20min_assignee
          : null

    let result
    if (bucket === 'none') {
      // Remove from list: clear both assignees + drop confirmation.
      result = await sql`
        UPDATE game_evaluations SET
          record_bucket = 'none',
          record_5min_assignee = NULL,
          record_20min_assignee = NULL,
          record_confirmed_at = NULL
        WHERE id = ${id}
        RETURNING *
      `
    } else {
      // Move into target container: carry the current recorder into the target
      // duration column, clear the other; keep record_confirmed_at.
      result = await sql`
        UPDATE game_evaluations SET
          record_bucket = ${bucket},
          record_5min_assignee = ${bucket === '5min' ? curAssignee : null},
          record_20min_assignee = ${bucket === '20min' ? curAssignee : null}
        WHERE id = ${id}
        RETURNING *
      `
    }

    return NextResponse.json({ ok: true, data: result[0] })
  } catch (err) {
    console.error('POST /api/evaluations/record-bucket error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
