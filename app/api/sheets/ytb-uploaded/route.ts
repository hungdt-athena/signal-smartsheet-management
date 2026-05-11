import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { readYtbUploaded, updateYtbRow, appendYtbRow, deleteYtbRow } from '@/lib/google-sheets'

export const dynamic = 'force-dynamic'

function missingConfig() {
  if (!process.env.GOOGLE_SPREADSHEET_ID) return 'GOOGLE_SPREADSHEET_ID'
  if (!process.env.GOOGLE_REFRESH_TOKEN) return 'GOOGLE_REFRESH_TOKEN'
  return null
}

export async function GET() {
  const guard = await requireRole('manager')
  if (guard) return guard

  const missing = missingConfig()
  if (missing) return NextResponse.json({ error: `${missing} not configured` }, { status: 503 })

  try {
    const rows = await readYtbUploaded()
    return NextResponse.json(rows, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[sheets/ytb-uploaded GET]', e)
    return NextResponse.json({ error: 'Failed to read sheet' }, { status: 502 })
  }
}

// PATCH /api/sheets/ytb-uploaded
// Body: { row_index: number, updates: { status?, youtubeId?, ... } }
export async function PATCH(req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const missing = missingConfig()
  if (missing) return NextResponse.json({ error: `${missing} not configured` }, { status: 503 })

  const { row_index, updates } = await req.json()
  if (!row_index || !updates) return NextResponse.json({ error: 'row_index and updates required' }, { status: 400 })

  try {
    await updateYtbRow(row_index, updates)
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[sheets/ytb-uploaded PATCH]', e)
    return NextResponse.json({ error: 'Failed to update row' }, { status: 502 })
  }
}

// POST /api/sheets/ytb-uploaded
// Body: { fileId, time, status, fileName, youtubeId, gameTitle, pic, duration }
export async function POST(req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const missing = missingConfig()
  if (missing) return NextResponse.json({ error: `${missing} not configured` }, { status: 503 })

  const body = await req.json()
  try {
    await appendYtbRow({
      fileId:    body.fileId    ?? '',
      time:      body.time      ?? new Date().toISOString(),
      status:    body.status    ?? '',
      fileName:  body.fileName  ?? '',
      youtubeId: body.youtubeId ?? '',
      gameTitle: body.gameTitle ?? '',
      pic:       body.pic       ?? '',
      duration:  body.duration  ?? '',
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[sheets/ytb-uploaded POST]', e)
    return NextResponse.json({ error: 'Failed to append row' }, { status: 502 })
  }
}

// DELETE /api/sheets/ytb-uploaded
// Body: { row_index: number }
export async function DELETE(req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const missing = missingConfig()
  if (missing) return NextResponse.json({ error: `${missing} not configured` }, { status: 503 })

  const { row_index } = await req.json()
  if (!row_index) return NextResponse.json({ error: 'row_index required' }, { status: 400 })

  try {
    await deleteYtbRow(row_index)
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[sheets/ytb-uploaded DELETE]', e)
    return NextResponse.json({ error: 'Failed to delete row' }, { status: 502 })
  }
}
