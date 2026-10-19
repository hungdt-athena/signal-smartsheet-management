// lib/rescue-range.ts — the optional assigned-date range Rescue can be scoped to.
//
// PURE module (no DB import). A range is a VIEW SELECTOR, like the genre: it picks which
// games the sentence or the panel is about and is never written to app_config, so unlike
// a threshold it may travel in a URL. `from` is inclusive, `to` is EXCLUSIVE, both VN
// calendar days, the same convention as the Report's window (`win.from` / `win.to`).

export type AssignedRange = { from: string | null; to: string | null }

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

// Rejects 2026-02-31 as well as 06/10/2026: Date rolls the 31st over to March, so the
// round trip is what proves the day exists.
function isDay(s: string): boolean {
  if (!ISO_DAY.test(s)) return false
  const t = Date.parse(`${s}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s
}

const clean = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s === '' ? null : s
}

// A bad range is an error, never "no range": silently falling back to the whole backlog
// would show a number that is not the one the reader asked about.
export function parseAssignedRange(
  from: unknown,
  to: unknown,
): { ok: true; range: AssignedRange | null } | { ok: false; error: string } {
  const f = clean(from)
  const t = clean(to)
  if (f === null && t === null) return { ok: true, range: null }
  if ((f !== null && !isDay(f)) || (t !== null && !isDay(t))) {
    return { ok: false, error: 'assigned range must be YYYY-MM-DD days' }
  }
  if (f !== null && t !== null && f >= t) {
    return { ok: false, error: 'assigned range must end after it starts' }
  }
  return { ok: true, range: { from: f, to: t } }
}

export function rangeKey(range: AssignedRange | null | undefined): string {
  return range ? `${range.from ?? ''}|${range.to ?? ''}` : ''
}
