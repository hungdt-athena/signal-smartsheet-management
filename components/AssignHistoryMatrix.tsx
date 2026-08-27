// components/AssignHistoryMatrix.tsx — matrix ngày × người, presentational.
// Số trong ô là assign. Reassign/handover chỉ hiện bằng dấu ▲ và trong popover,
// không bao giờ cộng vào con số — game bị reassign đã đếm ở lần assign gốc.
'use client'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { shadeScale, type Cell, type Matrix } from '@/lib/assign-history-matrix'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const VN_OFFSET_MS = 7 * 3_600_000

const dayNum = (iso: string) => iso.slice(8, 10)
const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay()

// run_date đã là ngày giờ VN nên đọc thẳng, không parse qua timezone.
function fmtDay(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${WEEKDAYS[dow(iso)]} ${d} ${MONTHS[+m - 1]} ${y}`
}

// run_at là timestamptz, JSON hoá thành ISO ...Z. Cả app chạy UTC+7 nên phải
// dịch trước khi đọc giờ, không thì mọi mốc lệch đúng 7 tiếng.
function hhmmVN(runAt: string): string {
  const t = Date.parse(runAt)
  if (Number.isNaN(t)) return ''
  const d = new Date(t + VN_OFFSET_MS)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

interface OpenCell { key: string; cell: Cell; day: string; rect: DOMRect }

export function AssignHistoryMatrix({ matrix }: { matrix: Matrix }) {
  const [open, setOpen] = useState<OpenCell | null>(null)

  const shade = useMemo(
    () => shadeScale(matrix.rows.flatMap(r => r.cells.map(c => c.assign))),
    [matrix],
  )

  // Cửa sổ đổi thì popover cũ không còn trỏ vào đâu cả.
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
            <th className="hm-total">TỔNG</th>
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map(r => (
            <tr key={r.name} className={r.inRoster ? undefined : 'hm-gone'}>
              <td className="hm-name">{r.name}</td>
              {r.cells.map((c, i) => {
                const key = `${r.name}-${matrix.days[i]}`
                return (
                  <td key={key} data-testid={`cell-${key}`} className={`hm-l${shade(c.assign)}`}>
                    {c.rows.length === 0
                      ? <span className="hm-none">·</span>
                      : (
                        <button
                          aria-expanded={open?.key === key}
                          onClick={e => setOpen(open?.key === key ? null : {
                            key, cell: c, day: matrix.days[i],
                            rect: e.currentTarget.getBoundingClientRect(),
                          })}>
                          <CellValue cell={c} />
                        </button>
                      )}
                  </td>
                )
              })}
              <td className="hm-total">
                {r.total.assign}
                {r.total.reassign > 0 && <small> +{r.total.reassign}R</small>}
              </td>
            </tr>
          ))}
          <tr className="hm-foot">
            <td className="hm-name">Tổng</td>
            {matrix.dayTotals.map((t, i) => (
              <td key={matrix.days[i]}>{t.assign || <span className="hm-none">·</span>}</td>
            ))}
            <td className="hm-total">{matrix.grandTotal.assign}</td>
          </tr>
        </tbody>
      </table>

      {open && <CellDetail open={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

// assign > 0 thì in số. Chỉ có reassign/handover thì in ▲ — không in con số của
// chúng, vì đọc nhanh sẽ tưởng đó là game mới được chia.
function CellValue({ cell }: { cell: Cell }) {
  const marked = cell.reassign > 0 || cell.handover > 0
  if (cell.assign > 0) return <>{cell.assign}{marked && <sup>▲</sup>}</>
  return <>▲</>
}

const POP_W = 380

// Popover đi qua portal với position: fixed. Bảng matrix nằm trong một container
// overflow-x: auto, nên một popover absolute bên trong ô sẽ bị cắt ở đáy và ở lề
// phải. Fixed + portal thoát khỏi container đó; đổi lại phải tự lật và tự kẹp
// vào viewport, và tự đóng khi trang cuộn (rect đã đo sẽ cũ).
function CellDetail({ open, onClose }: { open: OpenCell; onClose: () => void }) {
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
      maxHeight: Math.max(140, (flipUp ? above : below) - 8),
    })
  }, [open])

  useLayoutEffect(() => { place() }, [place])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onOutside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    // capture: nghe trước khi ô khác kịp mở popover của nó, tránh mở-rồi-đóng ngay.
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

  const { cell, day } = open
  const parts = [
    cell.assign > 0 && `${cell.assign} assigned`,
    cell.reassign > 0 && `${cell.reassign} reassigned`,
    cell.handover > 0 && `${cell.handover} handover`,
  ].filter(Boolean) as string[]

  return createPortal(
    <div ref={ref} className="hm-pop" role="dialog" aria-label={`History ${day}`}
      style={{
        left: pos?.left ?? -9999, top: pos?.top ?? -9999,
        maxHeight: pos?.maxHeight, visibility: pos ? 'visible' : 'hidden',
      }}>
      <div className="hm-pop-head">
        <span className="hm-pop-date">{fmtDay(day)}</span>
        <span className="hm-pop-tz">UTC+7</span>
        <button className="hm-pop-x" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div className="hm-pop-body">
        {cell.rows.map(r => (
          <div className="hm-pop-row" key={r.id}>
            <span className="hm-pop-time">{hhmmVN(r.run_at)}</span>
            <span className={`pill ${r.action === 'assign' ? 'on' : r.action === 'reassign' ? 'tag' : 'off'}`}>{r.action}</span>
            <span className="hm-pop-genre">{r.category_group}</span>
            <span className="hm-pop-n">{r.game_count}</span>
            <span className="hm-pop-who">
              {r.from_evaluator ? `← ${r.from_evaluator}` : r.created_by ?? ''}
            </span>
          </div>
        ))}
      </div>

      <div className="hm-pop-foot">
        <span>{cell.rows.length} {cell.rows.length === 1 ? 'run' : 'runs'}</span>
        <span className="hm-pop-sums">{parts.join(' · ') || '0 game'}</span>
      </div>
    </div>,
    document.body,
  )
}
