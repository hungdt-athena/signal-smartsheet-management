import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { driveFileId, matchDemoFileName } from '@/lib/demo-link-name'
import { lookupDriveFileName } from '@/lib/drive-file-name'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }
const unknown = () => NextResponse.json({ status: 'unknown' }, { headers: NO_STORE })

// POST /api/evaluations/check-demo-link { gameId, link }
//   -> { status: 'ok' | 'mismatch' | 'unknown', fileName?, expected?: { code, title } }
//
// Read only. Is the Drive file behind a pasted demo link named after this game (its demo code
// or its title)? The UI warns on mismatch and never blocks the save. Anything that cannot be
// checked (not a Drive link, file name unreadable, game without title and code) is unknown.
export async function POST(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  let body: { gameId?: unknown; link?: unknown } = {}
  try { body = await req.json() } catch { /* handled below */ }
  const gameId = typeof body.gameId === 'string' ? body.gameId.trim() : ''
  const link = typeof body.link === 'string' ? body.link.trim() : ''
  if (!gameId || !link) return NextResponse.json({ error: 'gameId and link are required' }, { status: 400 })

  const fileId = driveFileId(link)
  if (!fileId) return unknown()

  try {
    const rows = await sql`SELECT title, demo_code FROM game_info WHERE game_id = ${gameId} LIMIT 1`
    if (rows.length === 0) return unknown()
    const expected = {
      code: (rows[0].demo_code as string | null)?.trim() || null,
      title: (rows[0].title as string | null)?.trim() || null,
    }
    if (!expected.code && !expected.title) return unknown()

    const fileName = await lookupDriveFileName(fileId).catch(() => null)
    if (!fileName) return unknown()

    const status = matchDemoFileName(fileName, expected)
    if (status === 'unknown') return unknown()
    return NextResponse.json({ status, fileName, expected }, { headers: NO_STORE })
  } catch (err) {
    console.error('POST /api/evaluations/check-demo-link error:', err)
    return unknown()
  }
}
