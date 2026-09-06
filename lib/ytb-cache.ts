import { readYtbUploaded, type YtbRow } from '@/lib/google-sheets'

// Server-side cache for the `ytb_uploaded` sheet.
//
// Why this exists: readYtbUploaded() pulls the whole A:H range on every call
// (300-1500ms, and Sheets API has a per-minute quota). That read sat on the hot
// path of opening ANY evaluation panel — evaluators open dozens of games a day,
// so the same unchanged sheet was refetched dozens of times.
//
// TTL is short on purpose. The Record tab edits these rows and expects to see
// its own write immediately, which is what invalidateYtbCache() below is for;
// the TTL only covers changes made outside the app (someone editing the sheet
// by hand, or n8n appending a row).
//
// Scope note: this is per-process. On Cloud Run each instance keeps its own
// copy, so the win scales with how long an instance stays warm, not across the
// fleet. That is fine here — the alternative (Redis) is Tier 2.
const TTL_MS = 60_000

let cachedRows: YtbRow[] | null = null
let cachedAt = 0
let inflight: Promise<YtbRow[]> | null = null

/** Drop the cache. Call after ANY write to the sheet, before responding. */
export function invalidateYtbCache(): void {
  cachedRows = null
  cachedAt = 0
}

/**
 * The sheet rows, at most TTL_MS old.
 *
 * Concurrent callers share one in-flight read rather than each starting their
 * own — opening the Record tab fires several fetches at once, and without this
 * a cold cache would turn into several parallel Sheets calls.
 */
export async function getYtbUploaded(force = false): Promise<YtbRow[]> {
  if (!force && cachedRows && Date.now() - cachedAt < TTL_MS) return cachedRows
  if (inflight) return inflight

  inflight = readYtbUploaded()
    .then(rows => {
      cachedRows = rows
      cachedAt = Date.now()
      return rows
    })
    .finally(() => { inflight = null })

  return inflight
}

/** Age of the cached copy in ms, or null when nothing is cached. Diagnostics only. */
export function ytbCacheAge(): number | null {
  return cachedRows ? Date.now() - cachedAt : null
}
