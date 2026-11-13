import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireManager } from '@/lib/auth-guard'
import { getSession } from '@/lib/session'
import { sql } from '@/lib/db'
import { updateYtbRow, type YtbColumn } from '@/lib/google-sheets'
import { getYtbUploaded, invalidateYtbCache } from '@/lib/ytb-cache'
import { mirrorYtbUploads } from '@/lib/ytb-mirror'
import { YT_ID_RE, callYtbManage, cleanTitle, forgetYtInfo, getYtInfo, parseUploadTitle, titleError, type YtbManageResult } from '@/lib/youtube-manage'

export const dynamic = 'force-dynamic'

// The YouTube tab's video actions. YouTube first, the sheet second: the sheet
// only changes once YouTube said yes, so a failed call leaves everything as it was.
//
// PATCH  { row_index, youtubeId, title } -> rename the video on YouTube
// DELETE { row_index, youtubeId }        -> delete it from YouTube
//
// A deleted video's row is KEPT with status DELETED and an empty youtubeId:
//   - empty youtubeId -> lib/ytb-match no longer matches it, so the game is back
//     to Recording in the Record tab;
//   - the row (same fileId) stays -> n8n "Append Sheet" sees the Drive file as
//     known and does not upload it again. Its "Classify Record Codes" skips
//     DELETED rows, so a new recording of the game is not held back.

interface Target { row_index: number; youtubeId: string }

async function loadTarget(body: Record<string, unknown>): Promise<Target | NextResponse> {
  const row_index = Number(body.row_index)
  const youtubeId = String(body.youtubeId ?? '').trim()
  if (!Number.isInteger(row_index) || row_index < 2 || !YT_ID_RE.test(youtubeId)) {
    return NextResponse.json({ error: 'row_index and a YouTube id are required' }, { status: 400 })
  }
  // Rows are addressed by position and a delete elsewhere shifts them, so check
  // the row still holds this video before touching anything.
  const rows = await getYtbUploaded(true)
  const row = rows.find(r => r.row_index === row_index)
  if (!row || row.youtubeId.trim() !== youtubeId) {
    return NextResponse.json({ error: 'This row changed in the sheet. Refresh and try again.' }, { status: 409 })
  }
  return { row_index, youtubeId }
}

function youtubeFailure(r: YtbManageResult): NextResponse {
  if (r.error === 'not_found') {
    return NextResponse.json({ error: 'This video is not on the YouTube channel.' }, { status: 404 })
  }
  if (r.error === 'not_configured') {
    return NextResponse.json({ error: 'WEBHOOK_YTB_MANAGE or WEBHOOK_SECRET is not configured' }, { status: 503 })
  }
  console.error('[youtube/videos] n8n failed:', r.error)
  return NextResponse.json({ error: 'YouTube did not accept the change.', detail: r.error ?? null }, { status: 502 })
}

/** Re-pull the sheet into the mirror now, so the eval panel and Signal Sense see the change. */
async function syncAfterWrite() {
  invalidateYtbCache()
  try { await mirrorYtbUploads() } catch (e) { console.error('[youtube/videos] mirror sync failed:', (e as Error).message) }
}

async function actor(): Promise<string> {
  const s = await getSession()
  return s?.user?.email || s?.user?.name || 'unknown'
}

// GET ?ids=a,b -> { items: { [id]: { title, duration_s, privacy } | null } }
// Read-only: the real title and length on YouTube (the sheet only knows the
// minutes written in the file name). Any signed-in user; cached 10 min.
export async function GET(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard
  const ids = (req.nextUrl.searchParams.get('ids') ?? '').split(',').map(s => s.trim()).filter(Boolean)
  if (ids.length === 0 || ids.length > 50 || ids.some(id => !YT_ID_RE.test(id))) {
    return NextResponse.json({ error: 'ids must be 1-50 YouTube ids' }, { status: 400 })
  }
  const r = await getYtInfo(ids)
  if (!r.ok && Object.keys(r.items).length === 0) {
    return NextResponse.json({ error: 'Could not read YouTube', detail: r.error ?? null }, { status: 502 })
  }
  return NextResponse.json({ items: r.items })
}

export async function PATCH(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  const body = await req.json().catch(() => ({}))
  const title = cleanTitle(body.title)
  const bad = titleError(title)
  if (bad) return NextResponse.json({ error: bad }, { status: 400 })

  try {
    const target = await loadTarget(body)
    if (target instanceof NextResponse) return target

    const r = await callYtbManage({ action: 'rename', youtubeId: target.youtubeId, title, by: await actor() })
    if (!r.ok) return youtubeFailure(r)
    forgetYtInfo(target.youtubeId)

    // fileName shows the name on YouTube. Write ONLY that column: game title /
    // pic / duration (F:H) are one ARRAYFORMULA in F1 that splits fileName. A
    // value typed into F:H blocks the formula and the whole column turns #REF!.
    // The formula re-derives them, so an upload-format title still re-matches.
    const updates: Partial<Record<YtbColumn, string>> = { fileName: title }
    try {
      await updateYtbRow(target.row_index, updates)
    } catch (e) {
      console.error('[youtube/videos PATCH] sheet write failed:', e)
      return NextResponse.json({ error: 'Renamed on YouTube, but the sheet was not updated. Try again.' }, { status: 502 })
    }
    await syncAfterWrite()
    // The client shows the derived fields right away (the sheet formula computes the same).
    return NextResponse.json({ ok: true, updates: { ...updates, ...(parseUploadTitle(title) ?? {}) }, old_title: r.old_title ?? null })
  } catch (e) {
    console.error('[youtube/videos PATCH]', e)
    return NextResponse.json({ error: 'Rename failed' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  const body = await req.json().catch(() => ({}))
  try {
    const target = await loadTarget(body)
    if (target instanceof NextResponse) return target

    // A video already gone from YouTube comes back ok + gone, so a retry after a
    // failed sheet write below still completes.
    const r = await callYtbManage({ action: 'delete', youtubeId: target.youtubeId, by: await actor() })
    if (!r.ok) return youtubeFailure(r)
    forgetYtInfo(target.youtubeId)

    const updates = { status: 'DELETED', youtubeId: '' }
    try {
      await updateYtbRow(target.row_index, updates)
    } catch (e) {
      console.error('[youtube/videos DELETE] sheet write failed:', e)
      return NextResponse.json({ error: 'Deleted on YouTube, but the sheet was not updated. Try again.' }, { status: 502 })
    }

    // Stored links to this video (Signal Sense overlay, n8n youtube_live check)
    // go too. The ids are [A-Za-z0-9_-], so strpos is an exact contains test.
    // Best effort: the sheet already says DELETED (a retry would 409), and the
    // Record tab reads the sheet, so a failure here is logged, not returned.
    const id = target.youtubeId
    await sql`
      UPDATE game_evaluations SET
        youtube_uploaded_at       = CASE WHEN strpos(COALESCE(youtube_link, ''), ${id}) > 0 THEN NULL ELSE youtube_uploaded_at END,
        youtube_link              = CASE WHEN strpos(COALESCE(youtube_link, ''), ${id}) > 0 THEN NULL ELSE youtube_link END,
        youtube_5min_uploaded_at  = CASE WHEN strpos(COALESCE(youtube_5min_link, ''), ${id}) > 0 THEN NULL ELSE youtube_5min_uploaded_at END,
        youtube_5min_link         = CASE WHEN strpos(COALESCE(youtube_5min_link, ''), ${id}) > 0 THEN NULL ELSE youtube_5min_link END,
        youtube_20min_uploaded_at = CASE WHEN strpos(COALESCE(youtube_20min_link, ''), ${id}) > 0 THEN NULL ELSE youtube_20min_uploaded_at END,
        youtube_20min_link        = CASE WHEN strpos(COALESCE(youtube_20min_link, ''), ${id}) > 0 THEN NULL ELSE youtube_20min_link END
      WHERE strpos(COALESCE(youtube_link, ''), ${id}) > 0
         OR strpos(COALESCE(youtube_5min_link, ''), ${id}) > 0
         OR strpos(COALESCE(youtube_20min_link, ''), ${id}) > 0`
      .catch((e: unknown) => console.error('[youtube/videos DELETE] clearing DB links failed:', e))

    await syncAfterWrite()
    return NextResponse.json({ ok: true, updates, gone: r.gone === true })
  } catch (e) {
    console.error('[youtube/videos DELETE]', e)
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
  }
}
