import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireAuth } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { countQueue, fetchQueue } from '@/lib/playtest-tags-queue'
import { isManagerRole } from '@/lib/roles'

export const dynamic = 'force-dynamic'

/** Stands in for a non-admin session with no email. No tagged_by can equal it. */
const NO_EMAIL = '(no email)'

// GET /api/playtest-tags/pending?offset=&limit= — the review queue as flat rows,
// one per proposed tag, a page at a time. Ordered newest game first with its own
// tags together, so a game is never split across two pages. `total` is the whole
// queue, which is what the table's "scroll for more" counts against.
//
// Paged on `offset` rather than a page number because reviewing a tag removes it
// from the queue: the client asks for "everything after what I already hold",
// which stays correct as rows leave underneath it.
//
// Any signed-in user may read it, but an evaluator sees only what they proposed
// themselves — the same own-only rule the Evaluate and Short List tabs follow.
// Scoping is decided here from the session, never from a client parameter.
// Acting on the queue (confirm, reject, edit) stays admin-only in its own routes.
export async function GET(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  const q = req.nextUrl.searchParams
  const offset = Math.max(0, Number(q.get('offset')) || 0)
  const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 50))

  const session = process.env.SKIP_AUTH === 'true' ? null : await getServerSession(authOptions)
  // A non-admin session with no email matches nothing rather than everything:
  // failing open here would hand one evaluator the whole team's queue. The
  // sentinel has to stay truthy as well as unmatchable: an empty string would
  // read downstream as "no scope asked for" and widen the query right back.
  const mine = session && !isManagerRole(session.user?.role)
    ? session.user?.email || NO_EMAIL
    : undefined

  const [tags, total] = await Promise.all([
    fetchQueue({ limit, offset, taggedBy: mine }),
    countQueue(mine),
  ])
  return NextResponse.json({ tags, total }, { headers: { 'Cache-Control': 'no-store' } })
}
