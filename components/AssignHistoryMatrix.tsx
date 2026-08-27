// components/AssignHistoryMatrix.tsx — the day x person grid, presentational.
//
// A cell shows the NET change for that person on that day: games assigned, plus
// games received, minus games given away. A reassign therefore shows up twice on
// its own date — as a gain for the receiver and a loss for the giver — which is
// what makes "who is actually carrying this" readable off the grid.
'use client'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { shadeScale, type Cell, type Entry, type Matrix, type Totals } from '@/lib/assign-history-matrix'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const VN_OFFSET_MS = 7 * 3_600_000

const dayNum = (iso: string) => iso.slice(8, 10)
const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay()
const signed = (n: number) => (n > 0 ? `+${n}` : String(n))

// run_date is already a VN calendar date, so read it straight — no parsing.
function fmtDay(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${WEEKDAYS[dow(iso)]} ${d} ${MONTHS[+m - 1]} ${y}`
}

// run_at is a timestamptz, so it arrives as an ISO ...Z string. The whole app
// runs on UTC+7; reading the hour off the raw string is off by exactly 7 hours.
function hhmmVN(runAt: string): string {
  const t = Date.parse(runAt)
  if (Number.isNaN(t)) return ''
  const d = new Date(t + VN_OFFSET_MS)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

type Popover =
  | { kind: 'cell'; key: string; cell: Cell; day: string; name: string; rect: DOMRect }
  | { kind: 'total'; key: string; total: Totals; entries: Entry[]; name: string; rect: DOMRect }

export function AssignHistoryMatrix({ matrix }: { matrix: Matrix }) {
  const [open, setOpen] = useState<Popover | null>(null)

  const shade = useMemo(
    () => shadeScale(matrix.rows.flatMap(r => r.cells.map(c => c.net))),
    [matrix],
  )

  // A new window means the old popover points at nothing.
  useEffect(() => { setOpen(null) }, [matrix])

  if (matrix.rows.length === 0) return <p className="empty">No history in this window</p>

  return (
    <div className="hist-matrix-wrap">
      <table className="tbl hist-matrix">
        <thead>
          <tr>
            <th className="hm-name">Evaluator</th>
            {matrix.days.map(d => (
              <th key={d} className={`hm-day${dow(d) % 6 === 0 ? ' hm-weekend' : ''}`}>
                {dayNum(d)}<small>{WEEKDAYS[dow(d)]}</small>
              </th>
            ))}
            <th className="hm-total">TOTAL</th>
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map(r => (
            <tr key={r.name} className={r.inRoster ? undefined : 'hm-gone'}>
              <td className="hm-name">{r.name}</td>
              {r.cells.map((c, i) => {
                const key = `${r.name}-${matrix.days[i]}`
                return (
                  <td key={key} data-testid={`cell-${key}`}
                    className={`hm-l${shade(c.net)}${c.net < 0 ? ' hm-neg' : ''}`}>
                    {c.entries.length === 0
                      ? <span className="hm-none">·</span>
                      : (
                        <button aria-expanded={open?.key === key}
                          onClick={e => setOpen(open?.key === key ? null : {
                            kind: 'cell', key, cell: c, day: matrix.days[i], name: r.name,
                            rect: e.currentTarget.getBoundingClientRect(),
                          })}>
                          <CellValue cell={c} />
                        </button>
                      )}
                  </td>
                )
              })}
              <td className={`hm-total${r.total.net < 0 ? ' hm-neg' : ''}`}
                data-testid={`total-${r.name}`}>
                <button aria-expanded={open?.key === `total-${r.name}`}
                  onClick={e => setOpen(open?.key === `total-${r.name}` ? null : {
                    kind: 'total', key: `total-${r.name}`, total: r.total, name: r.name,
                    entries: r.cells.flatMap(c => c.entries),
                    rect: e.currentTarget.getBoundingClientRect(),
                  })}>
                  {r.total.net}
                </button>
              </td>
            </tr>
          ))}
          <tr className="hm-foot">
            <td className="hm-name">Total</td>
            {matrix.dayTotals.map((t, i) => (
              <td key={matrix.days[i]}>{t.net || <span className="hm-none">·</span>}</td>
            ))}
            <td className="hm-total">{matrix.grandTotal.net}</td>
          </tr>
        </tbody>
      </table>

      {open && <PopoverCard open={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

// The net number, with a marker when a move contributed to it — so a cell that
// happens to net back to its assigned figure still shows that something moved.
function CellValue({ cell }: { cell: Cell }) {
  const moved = cell.reassignIn || cell.reassignOut || cell.handoverIn || cell.handoverOut
  return <>{cell.net}{moved ? <sup>▲</sup> : null}</>
}

const POP_W = 400

// The popover is portalled out with position: fixed. Absolute positioning inside
// a cell does not work: the table sits in an overflow-x container that clips both
// the bottom rows and the right edge. Fixed escapes that, at the cost of having
// to flip and clamp by hand, and to close on scroll since the measured rect goes
// stale the moment the page moves.
function PopoverCard({ open, onClose }: { open: Popover; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null)

  const place = useCallback(() => {
    const el = ref.current
    if (!el) return
    const { rect } = open
    const h = el.offsetHeight
    const gap = 8
    const below = window.innerHeight - rect.bottom - gap
    const above = rect.top - gap
    const flipUp = h > below && above > below
    setPos({
      left: Math.max(8, Math.min(rect.left + rect.width / 2 - POP_W / 2, window.innerWidth - POP_W - 8)),
      top: flipUp ? Math.max(8, rect.top - gap - h) : rect.bottom + gap,
      maxHeight: Math.max(160, (flipUp ? above : below) - 8),
    })
  }, [open])

  useLayoutEffect(() => { place() }, [place])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onOutside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    // Capture phase, so another cell's click closes this one before opening its
    // own rather than opening and being closed again.
    window.addEventListener('mousedown', onOutside, true)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onOutside, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const totals = open.kind === 'cell' ? open.cell : open.total
  const entries = open.kind === 'cell' ? open.cell.entries : open.entries
  const title = open.kind === 'cell' ? fmtDay(open.day) : `${open.name} · window total`

  return createPortal(
    <div ref={ref} className="hm-pop" role="dialog" aria-label={title}
      style={{
        left: pos?.left ?? -9999, top: pos?.top ?? -9999,
        maxHeight: pos?.maxHeight, visibility: pos ? 'visible' : 'hidden',
      }}>
      <div className="hm-pop-head">
        <span className="hm-pop-date">{title}</span>
        {open.kind === 'cell' && <span className="hm-pop-tz">UTC+7</span>}
        <button className="hm-pop-x" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <Breakdown totals={totals} />

      <div className="hm-pop-body">
        {entries.map(({ row, dir }) => (
          <div className={`hm-pop-row${dir === 'out' ? ' out' : ''}`} key={`${row.id}-${dir}`}>
            <span className="hm-pop-time">
              {open.kind === 'cell' ? hhmmVN(row.run_at) : row.run_date.slice(5, 10)}
            </span>
            <span className={`pill ${row.action === 'assign' ? 'on' : row.action === 'reassign' ? 'tag' : 'off'}`}>
              {row.action}
            </span>
            <span className="hm-pop-genre">{row.category_group}</span>
            <span className="hm-pop-n">{dir === 'out' ? `-${row.game_count}` : `+${row.game_count}`}</span>
            <span className="hm-pop-who">
              {dir === 'out'
                ? `→ ${row.evaluator_name}`
                : row.from_evaluator ? `← ${row.from_evaluator}` : row.created_by ?? ''}
            </span>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  )
}

// Assigned / received / given away / net, with the zero lines dropped so the
// common assign-only case stays one line.
function Breakdown({ totals }: { totals: Totals }) {
  const inMoved = totals.reassignIn + totals.handoverIn
  const outMoved = totals.reassignOut + totals.handoverOut
  const lines: [string, string][] = []
  if (totals.assign) lines.push(['Assigned', `+${totals.assign}`])
  if (inMoved) lines.push(['Received', `+${inMoved}`])
  if (outMoved) lines.push(['Given away', `-${outMoved}`])

  return (
    <div className="hm-pop-sum">
      {lines.map(([k, v]) => (
        <span className="hm-pop-sum-item" key={k}><em>{k}</em>{v}</span>
      ))}
      <span className="hm-pop-sum-item net"><em>Net</em>{signed(totals.net)}</span>
    </div>
  )
}
