// A month's batches. A batch is a label ("W3 Oct, 2026"), not a date window, so a month
// is just its four labels -- the same W1-W4 a manager can pick (see BATCH_LABEL in
// lib/weekly-feedback). Pure: safe on client and server.

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/
const BATCH_LABEL = /^W[1-4] (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec), (\d{4})$/

/** The four batch labels of a month key ("2026-10"), W1 first. [] for a malformed key. */
export function batchLabelsOfMonth(monthKey: string): string[] {
  const m = MONTH_KEY.exec(monthKey)
  if (!m) return []
  const abbr = MONTH_ABBR[parseInt(m[2], 10) - 1]
  return [1, 2, 3, 4].map(w => `W${w} ${abbr}, ${m[1]}`)
}

/** The month key a batch label belongs to ("W3 Oct, 2026" -> "2026-10"), or null. */
export function monthKeyOfBatch(label: string | null | undefined): string | null {
  const m = label ? BATCH_LABEL.exec(label.trim()) : null
  if (!m) return null
  return `${m[2]}-${String(MONTH_ABBR.indexOf(m[1]) + 1).padStart(2, '0')}`
}

/** "2026-10" -> "Oct 2026". */
export function monthKeyLabel(monthKey: string): string {
  const m = MONTH_KEY.exec(monthKey)
  return m ? `${MONTH_ABBR[parseInt(m[2], 10) - 1]} ${m[1]}` : monthKey
}
