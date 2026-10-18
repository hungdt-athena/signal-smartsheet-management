'use client'
// Batch picker: year → month → batch in three columns, in place of one long dropdown
// of every "W1 Jan, 2025 … W4 Oct, 2026" label. Shortcuts on top: All batches and the
// current batch. Optionally a whole month ("All of Oct 2026") can be picked.
//
// Value: '' = all batches, a batch label ("W2 Oct, 2026"), or `month:2026-10` for a
// whole month (only when `allowMonth`). Use parseBatchPick() to turn it into the
// query a page sends (`batch` or `batch_month`).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeToClose } from '@/lib/use-escape-to-close'
import { batchLabelsOfMonth, monthKeyLabel, monthKeyOfBatch } from '@/lib/batch-month'

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_PREFIX = 'month:'

/** What a picker value means for a query. */
export function parseBatchPick(v: string): { batch: string | null; month: string | null } {
  if (v.startsWith(MONTH_PREFIX)) return { batch: null, month: v.slice(MONTH_PREFIX.length) }
  return { batch: v || null, month: null }
}
export const monthPick = (monthKey: string) => `${MONTH_PREFIX}${monthKey}`

/** Short text for a picker value. */
export function batchPickLabel(v: string, allLabel = 'All batches'): string {
  if (!v) return allLabel
  if (v.startsWith(MONTH_PREFIX)) return `All of ${monthKeyLabel(v.slice(MONTH_PREFIX.length))}`
  return v
}

interface Tree { years: string[]; months: Record<string, string[]>; labels: Record<string, string[]>; other: string[] }

// Labels → year → month key → labels (W1 first). Years and months newest first.
function buildTree(labels: string[]): Tree {
  const months: Record<string, Set<string>> = {}
  const byMonth: Record<string, Set<string>> = {}
  const other: string[] = []
  for (const l of labels) {
    const mk = monthKeyOfBatch(l)
    if (!mk) { if (l) other.push(l); continue }
    const y = mk.slice(0, 4)
    ;(months[y] ??= new Set()).add(mk)
    ;(byMonth[mk] ??= new Set()).add(l)
  }
  const years = Object.keys(months).sort((a, b) => b.localeCompare(a))
  const out: Tree = { years, months: {}, labels: {}, other }
  for (const y of years) out.months[y] = Array.from(months[y]).sort((a, b) => b.localeCompare(a))
  for (const mk of Object.keys(byMonth)) {
    const order = batchLabelsOfMonth(mk)
    out.labels[mk] = order.filter(l => byMonth[mk].has(l))
  }
  return out
}

interface Pos { top?: number; bottom?: number; left: number }

export function BatchPicker({
  value, onChange, batches, current = null, allowAll = true, allowMonth = false,
  filter = false, placeholder = 'Select a batch', allLabel = 'All batches', ariaLabel = 'Batch',
  width = 180, disabled = false,
}: {
  value: string
  onChange: (v: string) => void
  /** Every label that can be picked. */
  batches: string[]
  /** The team's current batch: a shortcut on top, and where the picker opens. */
  current?: string | null
  allowAll?: boolean
  allowMonth?: boolean
  /** Filter use: tint the control while it holds a value other than all. */
  filter?: boolean
  placeholder?: string
  allLabel?: string
  ariaLabel?: string
  width?: number | string
  disabled?: boolean
}) {
  const tree = useMemo(() => buildTree(batches), [batches])
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<Pos | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // The path shown when the picker opens: the selected value, else the current batch,
  // else the newest month.
  const startMonth = useCallback((): string | null => {
    const p = parseBatchPick(value)
    return p.month ?? monthKeyOfBatch(p.batch) ?? monthKeyOfBatch(current) ?? tree.months[tree.years[0]]?.[0] ?? null
  }, [value, current, tree])
  const [year, setYear] = useState<string | null>(null)
  const [month, setMonth] = useState<string | null>(null)

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const below = window.innerHeight - r.bottom
    setPos(below < 320 && r.top > below
      ? { bottom: window.innerHeight - r.top + 5, left: Math.min(r.left, window.innerWidth - 420) }
      : { top: r.bottom + 5, left: Math.min(r.left, window.innerWidth - 420) })
  }, [])

  const openPicker = () => {
    if (disabled) return
    const mk = startMonth()
    setMonth(mk)
    setYear(mk ? mk.slice(0, 4) : tree.years[0] ?? null)
    place()
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, place])
  useEscapeToClose(() => { setOpen(false); btnRef.current?.focus() }, open)

  const pick = (v: string) => { onChange(v); setOpen(false); btnRef.current?.focus() }
  const pickedBatch = parseBatchPick(value).batch
  const pickedMonth = parseBatchPick(value).month
  const label = value ? batchPickLabel(value, allLabel) : (allowAll ? allLabel : placeholder)
  const active = filter && value !== ''

  return (
    <div className="ssel" style={{ width }}>
      <button ref={btnRef} type="button" className={'ssel-btn' + (active ? ' is-active' : '')}
        aria-haspopup="dialog" aria-expanded={open} aria-label={`${ariaLabel}: ${label}`}
        disabled={disabled} onClick={() => (open ? setOpen(false) : openPicker())}>
        <span style={{ color: value || allowAll ? 'inherit' : 'var(--faint)' }}>{label}</span>
        <span className="chev" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
        </span>
      </button>
      {open && pos && createPortal(
        <div ref={popRef} className="bp-pop" role="dialog" aria-label={`Pick a ${ariaLabel.toLowerCase()}`}
          style={{ top: pos.top ?? 'auto', bottom: pos.bottom ?? 'auto', left: Math.max(8, pos.left) }}>
          {(allowAll || current) && (
            <div className="bp-top">
              {allowAll && (
                <button type="button" className={`bp-chip${value === '' ? ' on' : ''}`} onClick={() => pick('')}>{allLabel}</button>
              )}
              {current && (
                <button type="button" className={`bp-chip${pickedBatch === current ? ' on' : ''}`} onClick={() => pick(current)}>
                  Current · {current}
                </button>
              )}
            </div>
          )}
          <div className="bp-cols">
            <div className="bp-col" role="group" aria-label="Year">
              <div className="bp-h">Year</div>
              {tree.years.map(y => (
                <button key={y} type="button" className={`bp-it${year === y ? ' path' : ''}`}
                  onClick={() => { setYear(y); setMonth(tree.months[y][0] ?? null) }}>
                  {y}<span className="bp-ch" aria-hidden="true">›</span>
                </button>
              ))}
              {tree.other.length > 0 && (
                <button type="button" className={`bp-it${year === 'other' ? ' path' : ''}`}
                  onClick={() => { setYear('other'); setMonth(null) }}>
                  Other<span className="bp-ch" aria-hidden="true">›</span>
                </button>
              )}
            </div>
            <div className="bp-col" role="group" aria-label="Month">
              <div className="bp-h">Month</div>
              {year && year !== 'other' && (tree.months[year] ?? []).map(mk => (
                <button key={mk} type="button" className={`bp-it${month === mk ? ' path' : ''}${pickedMonth === mk ? ' on' : ''}`}
                  onClick={() => setMonth(mk)}>
                  {MONTH_ABBR[parseInt(mk.slice(5), 10) - 1]}<span className="bp-ch" aria-hidden="true">›</span>
                </button>
              ))}
            </div>
            <div className="bp-col bp-col-last" role="group" aria-label="Batch">
              <div className="bp-h">Batch</div>
              {year === 'other' && tree.other.map(l => (
                <button key={l} type="button" className={`bp-it${pickedBatch === l ? ' on' : ''}`} onClick={() => pick(l)}>{l}</button>
              ))}
              {month && year !== 'other' && (
                <>
                  {allowMonth && (
                    <button type="button" className={`bp-it bp-month${pickedMonth === month ? ' on' : ''}`}
                      onClick={() => pick(monthPick(month))}>
                      All of {monthKeyLabel(month)}
                    </button>
                  )}
                  {(tree.labels[month] ?? []).map(l => (
                    <button key={l} type="button" className={`bp-it${pickedBatch === l ? ' on' : ''}`} onClick={() => pick(l)}>
                      {l}{l === current && <em className="bp-cur">current</em>}
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
