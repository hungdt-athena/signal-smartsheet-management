import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireAuth } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'
import {
  isStorageConfigured, uploadScreenshot,
  deleteScreenshotByUrl, deleteGameScreenshots,
} from '@/lib/supabase-storage'

export const dynamic = 'force-dynamic'

const MAX_FILES = 10
const MAX_SIZE = 5 * 1024 * 1024
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** Allowed: admin/moderator, or the game's assigned initial evaluator. Null when allowed. */
async function checkPermission(gameId: string): Promise<NextResponse | null> {
  if (process.env.SKIP_AUTH === 'true') return null
  const session = await getServerSession(authOptions)
  const role = session?.user?.role
  if (role === 'admin' || role === 'moderator') return null
  const rows = await sql`SELECT initial_evaluator FROM game_evaluations WHERE game_id = ${gameId}`
  if (rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (rows[0].initial_evaluator !== session?.user?.name) {
    return NextResponse.json({ error: 'Forbidden: not your evaluation' }, { status: 403 })
  }
  return null
}

export async function POST(req: NextRequest, { params }: { params: { gameId: string } }) {
  const guard = await requireAuth()
  if (guard) return guard

  try {
    const gameId = params.gameId
    const denied = await checkPermission(gameId)
    if (denied) return denied
    if (!isStorageConfigured()) {
      return NextResponse.json({ error: 'Storage not configured' }, { status: 503 })
    }

    const form = await req.formData()
    const files = form.getAll('files').filter((f): f is File => typeof f !== 'string')
    if (files.length === 0) return NextResponse.json({ error: 'No files' }, { status: 400 })
    if (files.length > MAX_FILES) {
      return NextResponse.json({ error: `Max ${MAX_FILES} files per save` }, { status: 400 })
    }

    const uploaded: string[] = []
    const failed: { name: string; error: string }[] = []
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const ext = MIME_EXT[f.type]
      if (!ext) { failed.push({ name: f.name, error: 'Unsupported type' }); continue }
      if (f.size > MAX_SIZE) { failed.push({ name: f.name, error: 'Larger than 5MB' }); continue }
      try {
        const buf = Buffer.from(await f.arrayBuffer())
        uploaded.push(await uploadScreenshot(gameId, buf, ext, i))
      } catch (e) {
        failed.push({ name: f.name, error: e instanceof Error ? e.message : 'Upload failed' })
      }
    }

    if (uploaded.length === 0) {
      return NextResponse.json({ error: 'All files rejected', failed }, { status: 400 })
    }

    const rows = await sql`
      UPDATE game_info
      SET metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{manual_screenshot_urls}',
        COALESCE(metadata->'manual_screenshot_urls', '[]'::jsonb) || ${JSON.stringify(uploaded)}::jsonb
      )
      WHERE game_id = ${gameId}
      RETURNING metadata->'manual_screenshot_urls' AS urls
    `
    if (rows.length === 0) return NextResponse.json({ error: 'Game not found' }, { status: 404 })
    const urls = rows[0].urls || []

    return NextResponse.json({ urls, failed })
  } catch (err) {
    console.error('POST /api/evaluations/[gameId]/screenshots error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { gameId: string } }) {
  const guard = await requireAuth()
  if (guard) return guard

  try {
    const gameId = params.gameId
    const denied = await checkPermission(gameId)
    if (denied) return denied
    if (!isStorageConfigured()) {
      return NextResponse.json({ error: 'Storage not configured' }, { status: 503 })
    }

    const body = await req.json().catch(() => ({}))
    const url: string | undefined = body.url

    if (url) {
      await deleteScreenshotByUrl(url, gameId)
      const rows = await sql`
        UPDATE game_info
        SET metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{manual_screenshot_urls}',
          COALESCE((
            SELECT jsonb_agg(u)
            FROM jsonb_array_elements(COALESCE(metadata->'manual_screenshot_urls', '[]'::jsonb)) AS u
            WHERE u != ${JSON.stringify(url)}::jsonb
          ), '[]'::jsonb)
        )
        WHERE game_id = ${gameId}
        RETURNING metadata->'manual_screenshot_urls' AS urls
      `
      return NextResponse.json({ urls: rows[0]?.urls || [] })
    }

    await deleteGameScreenshots(gameId)
    await sql`UPDATE game_info SET metadata = metadata - 'manual_screenshot_urls' WHERE game_id = ${gameId}`
    return NextResponse.json({ urls: [] })
  } catch (err) {
    console.error('DELETE /api/evaluations/[gameId]/screenshots error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
