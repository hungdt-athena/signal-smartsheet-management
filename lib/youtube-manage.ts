// Rename / delete a video on YouTube, through the n8n workflow
// "YTB Manage (rename / delete video)" (webhook `ytb-manage`).
//
// The app holds no YouTube credential: the videos belong to the channel that
// n8n's "Upload Youtube" flow uploads with, so the edit goes through n8n too,
// with the same credential. The webhook checks the `x-webhook-secret` header
// (value = WEBHOOK_SECRET).

export const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/

/** Same regex as n8n "[NEW] Parse Filenames": Title_Recorder_Nmins(.ext). */
const UPLOAD_TITLE_RE = /^([^_]+)_([^_]+)_(\d+)mins(?:\..*)?$/i

export function cleanTitle(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim()
}

/** YouTube's title rules: 1-100 characters, no angle brackets. */
export function titleError(title: string): string | null {
  if (!title) return 'Title is required'
  if (title.length > 100) return 'Title must be 100 characters or fewer'
  if (/[<>]/.test(title)) return 'Title cannot contain < or >'
  return null
}

/** The sheet's match fields from an upload-format title, or null for a free-form title. */
export function parseUploadTitle(title: string): { gameTitle: string; pic: string; duration: string } | null {
  const m = title.trim().match(UPLOAD_TITLE_RE)
  if (!m) return null
  const mins = Number(m[3])
  if (!Number.isInteger(mins) || mins <= 0) return null
  return { gameTitle: m[1].trim(), pic: m[2].trim(), duration: String(mins) }
}

export interface YtbManageResult {
  ok: boolean
  error?: string | null
  title?: string
  old_title?: string
  /** delete only: the video was already gone from YouTube. */
  gone?: boolean
}

export type YtbManageRequest =
  | { action: 'rename'; youtubeId: string; title: string; by: string }
  | { action: 'delete'; youtubeId: string; by: string }

export interface YtVideoInfo {
  id: string
  title: string
  /** Real length on YouTube, in seconds. null while YouTube is still processing. */
  duration_s: number | null
  privacy: string
}

// Video info barely changes, and the panel asks again on every row click, so
// keep answers for a while. A video YouTube does not return (deleted, other
// channel) is cached as null so it is not asked again and again either.
const INFO_TTL_MS = 10 * 60_000
const infoCache = new Map<string, { at: number; info: YtVideoInfo | null }>()

/** Drop cached info, e.g. after a rename or delete. */
export function forgetYtInfo(id: string) { infoCache.delete(id) }

/** Title + real duration for up to 50 ids, through the n8n `info` action. */
export async function getYtInfo(ids: string[]): Promise<{ ok: boolean; items: Record<string, YtVideoInfo | null>; error?: string }> {
  const now = Date.now()
  const items: Record<string, YtVideoInfo | null> = {}
  const missing: string[] = []
  for (const id of Array.from(new Set(ids))) {
    const hit = infoCache.get(id)
    if (hit && now - hit.at < INFO_TTL_MS) items[id] = hit.info
    else missing.push(id)
  }
  if (missing.length === 0) return { ok: true, items }

  const url = process.env.WEBHOOK_YTB_MANAGE
  const secret = process.env.WEBHOOK_SECRET
  if (!url || !secret) return { ok: false, items, error: 'not_configured' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secret },
      body: JSON.stringify({ action: 'info', ids: missing.slice(0, 50) }),
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, items, error: `n8n_${res.status}` }
    const data = await res.json() as { ok?: boolean; items?: YtVideoInfo[]; error?: string }
    if (data?.ok !== true) return { ok: false, items, error: data?.error ?? 'n8n_failed' }
    const found = new Map((data.items ?? []).map(v => [v.id, v]))
    for (const id of missing.slice(0, 50)) {
      const info = found.get(id) ?? null
      infoCache.set(id, { at: now, info })
      items[id] = info
    }
    return { ok: true, items }
  } catch (e) {
    return { ok: false, items, error: e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'n8n_unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

export async function callYtbManage(body: YtbManageRequest): Promise<YtbManageResult> {
  const url = process.env.WEBHOOK_YTB_MANAGE
  const secret = process.env.WEBHOOK_SECRET
  if (!url || !secret) return { ok: false, error: 'not_configured' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secret },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, error: `n8n_${res.status}` }
    const data = await res.json() as YtbManageResult
    return { ...data, ok: data?.ok === true }
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'n8n_unreachable' }
  } finally {
    clearTimeout(timer)
  }
}
