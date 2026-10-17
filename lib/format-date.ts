// lib/format-date.ts — dates the way the team reads them, always in Vietnam time.
// toLocaleDateString() with no zone/locale prints in whatever the viewer's machine
// is set to, so the same row read differently on two laptops.

const TZ = 'Asia/Ho_Chi_Minh'

/** dd/MM/yy, e.g. 18/10/26. '—' for empty. */
export function fmtDateVN(d: string | number | Date | null | undefined): string {
  if (d == null || d === '') return '—'
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return '—'
  return dt.toLocaleDateString('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: '2-digit' })
}

/** dd/MM/yy - HH:mm, e.g. 18/10/26 - 14:05. '—' for empty. */
export function fmtDateTimeVN(d: string | number | Date | null | undefined): string {
  if (d == null || d === '') return '—'
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return '—'
  const day = fmtDateVN(dt)
  const time = dt.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
  return `${day} - ${time}`
}
