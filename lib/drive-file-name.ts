// Reads a Drive file's name, for the demo-link check. Server only.
//
// With GOOGLE_SA_KEY_JSON set it asks the Drive API as the service account. Otherwise, or if
// that fails, it reads the public "anyone with the link" page. null when neither gives a name.

import { google } from 'googleapis'
import { getExportAuth } from '@/lib/shortlist-export/google'

const TTL_MS = 5 * 60 * 1000
const MAX_ENTRIES = 500
const PAGE_TIMEOUT_MS = 5000

const cache = new Map<string, { name: string; at: number }>()

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** Titles of pages that are not a file: the sign-in wall and Drive's own home. */
function isNotAFile(t: string): boolean {
  return !t || /^google drive$/i.test(t) || /sign[\s-]?in/i.test(t) || /google accounts/i.test(t)
}

/** The file name on a public Drive file page: og:title, else <title> minus " - Google Drive". */
export function titleFromDriveHtml(html: string): string | null {
  const og = html.match(/<meta\s[^>]*property=["']og:title["'][^>]*>/i)?.[0]
  const ogContent = og?.match(/content=["']([^"']*)["']/i)?.[1]
  if (ogContent != null) {
    const t = unescapeHtml(ogContent).trim()
    if (!isNotAFile(t)) return t
  }
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]
  if (title == null) return null
  const t = unescapeHtml(title).replace(/\s+-\s+Google Drive\s*$/i, '').trim()
  return isNotAFile(t) ? null : t
}

async function nameFromApi(fileId: string): Promise<string | null> {
  if (!process.env.GOOGLE_SA_KEY_JSON) return null
  try {
    const res = await google.drive({ version: 'v3', auth: getExportAuth() }).files.get({
      fileId, fields: 'name', supportsAllDrives: true,
    })
    return res.data.name?.trim() || null
  } catch {
    return null
  }
}

async function nameFromPage(fileId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`, {
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS), cache: 'no-store',
    })
    if (res.status !== 200 || /accounts\.google\.com/i.test(res.url)) return null
    return titleFromDriveHtml(await res.text())
  } catch {
    return null
  }
}

/** The file's name, cached for a few minutes. null when it cannot be read. Never throws. */
export async function lookupDriveFileName(fileId: string): Promise<string | null> {
  const hit = cache.get(fileId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.name
  const name = (await nameFromApi(fileId)) ?? (await nameFromPage(fileId))
  if (name) {
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(fileId, { name, at: Date.now() })
  }
  return name
}
