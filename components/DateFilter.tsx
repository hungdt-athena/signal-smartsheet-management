'use client'
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

export type DateBasis = 'assigned' | 'evaluated'
export type DateMode = 'day' | 'month' | 'range'
export interface YearMonth { year: number; month: number }

// Canonical filter value. Every mode reduces to an inclusive [from, to] range on
// one basis; `mode` is kept only so the outer chip renders the right label
// (a single day vs a whole month vs a custom range). from/to null = All time.
export interface DateFilterValue {
  basis: DateBasis
  mode: DateMode
  from: string | null // 'YYYY-MM-DD'
  to: string | null   // 'YYYY-MM-DD', inclusive
}

const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

// ---- pure date helpers (civil dates, no tz math beyond resolving "today" in VN) ----
const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`
function parseYMD(s: string) { const [y, m, d] = s.split('-').map(Number); return { y, m, d } }
function daysInMonth(y: number, m: number) { return new Date(y, m, 0).getDate() }
function firstWeekday(y: number, m: number) { return new Date(Date.UTC(y, m - 1, 1)).getUTCDay() }
function todayParts() {
  const dt = new Date(Date.now() + 7 * 3600 * 1000) // Asia/Ho_Chi_Minh
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
}
function addDays(s: string, delta: number) {
  const { y, m, d } = parseYMD(s)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + delta)
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())
}
function cmp(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0 }

// ---- exported helpers used by callers ----
export function emptyValue(basis: DateBasis): DateFilterValue {
  return { basis, mode: 'month', from: null, to: null }
}

export function monthToValue(ap: YearMonth, basis: DateBasis): DateFilterValue {
  return {
    basis, mode: 'month',
    from: ymd(ap.year, ap.month, 1),
    to: ymd(ap.year, ap.month, daysInMonth(ap.year, ap.month)),
  }
}

// Coarse YearMonth from a value (start of the range) for callers that still think
// in months (batch options, Quick Stats). Null when no date is set.
export function valueToYearMonth(v: DateFilterValue): YearMonth | null {
  if (!v.from) return null
  const { y, m } = parseYMD(v.from)
  return { year: y, month: m }
}

// Query params for /api/evaluations. autoMonth defers resolution to the server.
export function dateFilterParams(v: DateFilterValue, autoMonth: boolean): Record<string, string> {
  const p: Record<string, string> = { date_basis: v.basis }
  if (autoMonth) {
    p.month = 'auto'
  } else if (v.from && v.to) {
    p.from = v.from
    p.to = v.to
  }
  return p
}

export function valueLabel(v: DateFilterValue): string {
  if (!v.from || !v.to) return 'All time'
  const f = parseYMD(v.from), t = parseYMD(v.to)
  if (v.mode === 'month') return `${MONTH_NAMES[f.m]} ${f.y}`
  if (v.mode === 'day') return `${f.d} ${MONTH_NAMES[f.m]} ${f.y}`
  // range
  if (f.y === t.y && f.m === t.m) return `${f.d}–${t.d} ${MONTH_NAMES[f.m]} ${f.y}`
  if (f.y === t.y) return `${f.d} ${MONTH_NAMES[f.m]} – ${t.d} ${MONTH_NAMES[t.m]} ${f.y}`
  return `${f.d} ${MONTH_NAMES[f.m]} ${f.y} – ${t.d} ${MONTH_NAMES[t.m]} ${t.y}`
}

// ---- presets (left rail) ----
type PresetId = 'today' | 'yesterday' | '7d' | '30d' | 'thisMonth' | 'lastMonth' | 'thisYear' | 'all'
const PRESETS: { id: PresetId; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'thisMonth', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'thisYear', label: 'This year' },
  { id: 'all', label: 'All time' },
]
function presetValue(id: PresetId, basis: DateBasis): DateFilterValue {
  const t = todayParts()
  const today = ymd(t.y, t.m, t.d)
  switch (id) {
    case 'today': return { basis, mode: 'day', from: today, to: today }
    case 'yesterday': { const y = addDays(today, -1); return { basis, mode: 'day', from: y, to: y } }
    case '7d': return { basis, mode: 'range', from: addDays(today, -6), to: today }
    case '30d': return { basis, mode: 'range', from: addDays(today, -29), to: today }
    case 'thisMonth': return monthToValue({ year: t.y, month: t.m }, basis)
    case 'lastMonth': {
      const m = t.m === 1 ? 12 : t.m - 1
      const y = t.m === 1 ? t.y - 1 : t.y
      return monthToValue({ year: y, month: m }, basis)
    }
    case 'thisYear': return { basis, mode: 'range', from: ymd(t.y, 1, 1), to: ymd(t.y, 12, 31) }
    case 'all': return emptyValue(basis)
  }
}
function sameSel(a: DateFilterValue, b: DateFilterValue) {
  return a.from === b.from && a.to === b.to && a.mode === b.mode
}

// ============================== component ==============================

export function DateFilter({ value, onChange, hideEvaluated = false }: {
  value: DateFilterValue
  onChange: (v: DateFilterValue) => void
  // Pending lists have no evaluated date yet, so the "Date evaluated" basis is
  // meaningless there — hide the toggle and force the basis to 'assigned'.
  hideEvaluated?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Draft state — every edit (calendar clicks AND presets) stays local and is
  // previewed on the calendar until the user hits Apply. Nothing applies on click.
  const [draft, setDraft] = useState<DateFilterValue>(value)
  const [view, setView] = useState<YearMonth>(() => {
    const t = todayParts(); return { year: t.y, month: t.m }
  })
  // First click of a range (null = next calendar click starts a fresh selection).
  const [anchor, setAnchor] = useState<string | null>(null)

  // (Re)initialise the draft + view each time the modal opens.
  useEffect(() => {
    if (!open) return
    setDraft(hideEvaluated && value.basis === 'evaluated' ? { ...value, basis: 'assigned' } : value)
    setAnchor(null)
    const seed = value.from ? parseYMD(value.from) : todayParts()
    setView({ year: seed.y, month: seed.m })
  }, [open, value, hideEvaluated])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  function shiftView(delta: number) {
    setView(v => {
      const m0 = v.month - 1 + delta
      const year = v.year + Math.floor(m0 / 12)
      const month = ((m0 % 12) + 12) % 12 + 1
      return { year, month }
    })
  }

  // Calendar day click: 1st click = single day; 2nd = range; re-click anchor = day.
  function pickDay(dateStr: string) {
    if (anchor === null) {
      setAnchor(dateStr)
      setDraft({ ...draft, mode: 'day', from: dateStr, to: dateStr })
    } else if (dateStr === anchor) {
      setAnchor(null)
      setDraft({ ...draft, mode: 'day', from: dateStr, to: dateStr })
    } else {
      const [from, to] = cmp(anchor, dateStr) <= 0 ? [anchor, dateStr] : [dateStr, anchor]
      setAnchor(null)
      setDraft({ ...draft, mode: 'range', from, to })
    }
  }

  // Click the month/year header → select the whole visible month.
  function pickWholeMonth() {
    setAnchor(null)
    setDraft({
      ...draft, mode: 'month',
      from: ymd(view.year, view.month, 1),
      to: ymd(view.year, view.month, daysInMonth(view.year, view.month)),
    })
  }

  // Presets seed the draft + move the calendar to preview the selection; the
  // user reviews it on the calendar and confirms with Apply.
  function clickPreset(id: PresetId) {
    const v = presetValue(id, draft.basis)
    setAnchor(null)
    setDraft(v)
    if (v.from) { const p = parseYMD(v.from); setView({ year: p.y, month: p.m }) }
  }

  const activePreset = PRESETS.find(p => sameSel(presetValue(p.id, draft.basis), draft))?.id ?? null

  function renderCalendar() {
    const total = daysInMonth(view.year, view.month)
    const lead = firstWeekday(view.year, view.month)
    const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: total }, (_, i) => i + 1)]
    while (cells.length % 7 !== 0) cells.push(null)
    const t = todayParts()
    const monthSelected = draft.mode === 'month' && draft.from === ymd(view.year, view.month, 1)
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => shiftView(-1)} style={{ padding: '2px 8px' }}>‹</button>
          <button onClick={pickWholeMonth} title={`Click to select all of ${MONTH_NAMES[view.month]} ${view.year}`}
            style={{
              border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, borderRadius: 6, padding: '3px 10px',
              display: 'inline-flex', alignItems: 'center', gap: 5,
              background: monthSelected ? 'var(--accent-weak)' : 'transparent',
              color: monthSelected ? 'var(--accent-strong)' : 'var(--text)',
              textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3,
              textDecorationColor: 'var(--accent-border)',
            }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            {MONTH_NAMES[view.month]} {view.year}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => shiftView(1)} style={{ padding: '2px 8px' }}>›</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
          {WEEKDAYS.map(w => (
            <div key={w} style={{ textAlign: 'center', fontSize: 10, fontWeight: 600, color: 'var(--faint)', padding: '2px 0' }}>{w}</div>
          ))}
          {cells.map((d, i) => {
            if (d === null) return <div key={i} />
            const ds = ymd(view.year, view.month, d)
            const inRange = !!(draft.from && draft.to && cmp(ds, draft.from) >= 0 && cmp(ds, draft.to) <= 0)
            const isEnd = ds === draft.from || ds === draft.to
            const isToday = view.year === t.y && view.month === t.m && d === t.d
            // Whole-month selection renders as a flat uniform tint so it reads as
            // "the month" rather than a 1→last-day custom range.
            const monthCell = monthSelected && inRange
            let bg = 'transparent', color = 'var(--text)', weight = 400
            if (monthCell) { bg = 'var(--accent-weak)'; color = 'var(--accent-strong)'; weight = 600 }
            else if (isEnd) { bg = 'var(--accent)'; color = '#fff'; weight = 600 }
            else if (inRange) { bg = 'var(--surface-3)' }
            return (
              <button key={i} onClick={() => pickDay(ds)}
                style={{
                  position: 'relative',
                  height: 32, border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12.5,
                  background: bg, color, fontWeight: weight,
                }}>
                {d}
                {isToday && !isEnd && (
                  <span style={{
                    position: 'absolute', left: '50%', bottom: 4, transform: 'translateX(-50%)',
                    width: 4, height: 4, borderRadius: 99, background: 'var(--accent)',
                  }} />
                )}
              </button>
            )
          })}
        </div>
        <button onClick={pickWholeMonth}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            width: '100%', marginTop: 12, padding: 8, borderRadius: 8, cursor: 'pointer',
            fontSize: 12.5, fontWeight: 600,
            border: monthSelected ? '1px solid var(--accent)' : '1px dashed var(--accent-border)',
            background: monthSelected ? 'var(--accent)' : 'var(--accent-weak)',
            color: monthSelected ? '#fff' : 'var(--accent-strong)',
          }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          Select entire month
        </button>
        <p style={{ fontSize: 11, color: 'var(--faint)', margin: '8px 0 0', textAlign: 'center' }}>
          Click a day, then another day to make a range.
        </p>
      </div>
    )
  }

  function summaryText() {
    if (anchor) return 'Pick the end date (or Apply for a single day)'
    const basisWord = draft.basis === 'evaluated' ? 'Date evaluated' : 'Date assigned'
    if (!draft.from) return `${basisWord} · All time`
    return `${basisWord} · ${valueLabel(draft)}`
  }

  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex', gap: 8 }}>
      {/* Single read-only chip: "<basis> · <date>" — opens the modal */}
      <button className="btn btn-sm" onClick={() => setOpen(true)} style={{ gap: 8, minWidth: 200, justifyContent: 'space-between' }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span style={{ flex: 1, textAlign: 'left' }}>
          <span style={{ color: 'var(--muted)' }}>{value.basis === 'evaluated' ? 'Evaluated' : 'Assigned'}</span>
          {' · '}{valueLabel(value)}
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        <div className="eval-modal-backdrop" onMouseDown={() => setOpen(false)}
          style={{ alignItems: 'flex-start', overflowY: 'auto', padding: '32px 16px' }}>
          <div className="eval-modal-container" onMouseDown={e => e.stopPropagation()}
            style={{ padding: '18px 20px 16px', width: 470, maxWidth: '95vw', maxHeight: 'none' }}>

            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Filter by date</h2>
              <button className="btn btn-ghost" onClick={() => setOpen(false)} style={{ padding: '2px 8px', fontSize: 12 }}>✕</button>
            </div>

            {/* Which date to filter on (hidden when only one basis applies) */}
            {!hideEvaluated && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Match on</span>
              <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                {(['assigned', 'evaluated'] as DateBasis[]).map(b => (
                  <button key={b} onClick={() => setDraft(d => ({ ...d, basis: b }))}
                    style={{
                      padding: '5px 14px', border: 'none', cursor: 'pointer', fontSize: 12,
                      background: draft.basis === b ? 'var(--accent)' : 'transparent',
                      color: draft.basis === b ? '#fff' : 'var(--text)',
                      fontWeight: draft.basis === b ? 600 : 400,
                    }}>
                    {b === 'assigned' ? 'Date assigned' : 'Date evaluated'}
                  </button>
                ))}
              </div>
              <span style={{ fontSize: 10.5, color: 'var(--faint)' }}>
                {draft.basis === 'evaluated' ? 'uses last-updated date if not yet evaluated' : ''}
              </span>
            </div>
            )}

            {/* Body: preset rail + calendar */}
            <div style={{ display: 'flex', gap: 14 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 116, borderRight: '1px solid var(--border)', paddingRight: 12 }}>
                {PRESETS.map(p => {
                  const on = activePreset === p.id
                  return (
                    <button key={p.id} onClick={() => clickPreset(p.id)}
                      style={{
                        textAlign: 'left', padding: '6px 10px', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12.5,
                        background: on ? 'var(--surface-3)' : 'transparent',
                        color: on ? 'var(--accent)' : 'var(--text)',
                        fontWeight: on ? 600 : 400,
                      }}>
                      {p.label}
                    </button>
                  )
                })}
              </div>
              <div style={{ flex: 1 }}>
                {renderCalendar()}
              </div>
            </div>

            {/* Footer: live summary + actions */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <span style={{ fontSize: 12, color: anchor ? 'var(--accent)' : 'var(--muted)' }}>{summaryText()}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => { onChange(emptyValue(draft.basis)); setOpen(false) }}>Clear</button>
                <button className="btn btn-primary btn-sm" onClick={() => { onChange(draft); setOpen(false) }}>Apply</button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
