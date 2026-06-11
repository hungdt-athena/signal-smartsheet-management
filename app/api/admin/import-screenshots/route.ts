import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { isStorageConfigured, uploadScreenshot } from '@/lib/supabase-storage'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Ingest screenshots pasted into Smartsheet StoreKit cells. n8n resolves the
// temporary image URLs (it holds the Smartsheet token) and POSTs
// { items: [{ game_id, image_urls }] }; this route downloads and persists them
// as manual screenshots for games that have neither StoreKit nor manual images.

const MAX_ITEMS = 50
const MAX_URLS_PER_GAME = 10
const MAX_SIZE = 5 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 15_000
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

function hasWebhookSecret(req: NextRequest): boolean {
  const secret = process.env.WEBHOOK_SECRET
  return !!secret && req.headers.get('x-webhook-secret') === secret
}

interface Item { game_id: string; image_urls: string[] }

export async function POST(req: NextRequest) {
  if (!hasWebhookSecret(req)) {
    const guard = await requireRole(['admin'])
    if (guard) return guard
  }

  try {
    if (!isStorageConfigured()) {
      return NextResponse.json({ error: 'Storage not configured' }, { status: 503 })
    }

    let body: { items?: { game_id?: unknown; image_urls?: unknown }[] }
    try { body = await req.json() } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 })
    }
    if (!Array.isArray(body.items)) {
      return NextResponse.json({ error: 'items array required' }, { status: 400 })
    }
    if (body.items.length > MAX_ITEMS) {
      return NextResponse.json({ error: `Max ${MAX_ITEMS} items per call` }, { status: 400 })
    }

    // Normalize + dedup by game_id (first wins).
    const byId = new Map<string, Item>()
    for (const raw of body.items) {
      const gameId = typeof raw.game_id === 'string' ? raw.game_id.trim() : ''
      const urls = Array.isArray(raw.image_urls)
        ? raw.image_urls.filter((u): u is string => typeof u === 'string' && u.length > 0).slice(0, MAX_URLS_PER_GAME)
        : []
      if (!gameId || urls.length === 0 || byId.has(gameId)) continue
      byId.set(gameId, { game_id: gameId, image_urls: urls })
    }
    const items = Array.from(byId.values())

    const counts = { uploaded: 0, skipped_has_storekit: 0, skipped_has_manual: 0, skipped_not_found: 0 }
    const failed: { game_id: string; error: string }[] = []

    if (items.length > 0) {
      const states = await sql`
        SELECT game_id,
          CASE WHEN jsonb_typeof(metadata->'screenshot_urls') = 'array'
               THEN jsonb_array_length(metadata->'screenshot_urls') ELSE 0 END > 0 AS has_storekit,
          CASE WHEN jsonb_typeof(metadata->'manual_screenshot_urls') = 'array'
               THEN jsonb_array_length(metadata->'manual_screenshot_urls') ELSE 0 END > 0 AS has_manual
        FROM game_info
        WHERE game_id IN ${sql(items.map(i => i.game_id))}
      `
      const stateById = new Map(states.map(s => [s.game_id as string, s]))

      for (const item of items) {
        const state = stateById.get(item.game_id)
        if (!state) { counts.skipped_not_found++; continue }
        if (state.has_storekit) { counts.skipped_has_storekit++; continue }
        if (state.has_manual) { counts.skipped_has_manual++; continue }

        const uploadedUrls: string[] = []
        let lastError = 'No valid images'
        for (let i = 0; i < item.image_urls.length; i++) {
          try {
            const res = await fetch(item.image_urls[i], { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
            if (!res.ok) { lastError = `download HTTP ${res.status}`; continue }
            const ct = (res.headers.get('content-type') || '').split(';')[0].trim()
            const ext = MIME_EXT[ct]
            if (!ext) { lastError = `unsupported type ${ct || 'unknown'}`; continue }
            const buf = Buffer.from(await res.arrayBuffer())
            if (buf.length > MAX_SIZE) { lastError = 'larger than 5MB'; continue }
            uploadedUrls.push(await uploadScreenshot(item.game_id, buf, ext, i))
          } catch (e) {
            lastError = e instanceof Error ? e.message : 'download failed'
          }
        }

        if (uploadedUrls.length === 0) {
          failed.push({ game_id: item.game_id, error: lastError })
          continue
        }

        await sql`
          UPDATE game_info
          SET metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{manual_screenshot_urls}',
            COALESCE(metadata->'manual_screenshot_urls', '[]'::jsonb) || ${sql.json(uploadedUrls)}
          )
          WHERE game_id = ${item.game_id}
        `
        counts.uploaded++
      }
    }

    return NextResponse.json({ ok: true, received: body.items.length, ...counts, failed })
  } catch (err) {
    console.error('POST /api/admin/import-screenshots error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
