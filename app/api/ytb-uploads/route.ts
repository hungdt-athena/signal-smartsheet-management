import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { readYtbMirror } from '@/lib/ytb-mirror'

export const dynamic = 'force-dynamic'

// GET /api/ytb-uploads — read-only YouTube upload rows from the Postgres mirror.
//
// This is the READ path for consumers that only need to answer "does this game
// have a video yet" — today that is the evaluation detail panel. It is
// deliberately separate from GET /api/sheets/ytb-uploaded, which still talks to
// the sheet because the Record tab edits rows and needs row_index to write back.
//
// Returns the shape lib/ytb-match consumes, nothing more: no row_index, so
// nobody can accidentally build a write path on top of mirrored positions.
export async function GET() {
  const guard = await requireAuth()
  if (guard) return guard

  try {
    const { rows, synced_at, refreshed } = await readYtbMirror()
    return NextResponse.json(rows, {
      headers: {
        'Cache-Control': 'no-store',
        // Diagnostics: makes it visible in devtools whether a slow response was
        // the self-heal re-pulling the sheet, without changing the body shape.
        'X-Ytb-Synced-At': synced_at ?? 'never',
        'X-Ytb-Refreshed': refreshed ? '1' : '0',
      },
    })
  } catch (e) {
    console.error('[ytb-uploads GET]', e)
    return NextResponse.json({ error: 'Failed to read uploads' }, { status: 500 })
  }
}
