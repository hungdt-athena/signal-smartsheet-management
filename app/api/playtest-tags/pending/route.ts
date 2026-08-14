import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { countQueue, fetchQueue } from '@/lib/playtest-tags-queue'

export const dynamic = 'force-dynamic'

// GET /api/playtest-tags/pending?offset=&limit= — the admin review queue as flat
// rows, one per proposed tag, a page at a time. Ordered newest game first with
// its own tags together, so a game is never split across two pages. `total` is
// the whole queue, which is what the table's "scroll for more" counts against.
//
// Paged on `offset` rather than a page number because reviewing a tag removes it
// from the queue: the client asks for "everything after what I already hold",
// which stays correct as rows leave underneath it.
export async function GET(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  const q = req.nextUrl.searchParams
  const offset = Math.max(0, Number(q.get('offset')) || 0)
  const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 50))

  const [tags, total] = await Promise.all([
    fetchQueue({ limit, offset }),
    countQueue(),
  ])
  return NextResponse.json({ tags, total }, { headers: { 'Cache-Control': 'no-store' } })
}
