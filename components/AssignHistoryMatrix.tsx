// components/AssignHistoryMatrix.tsx — matrix ngày × người, presentational.
// Số trong ô là assign. Reassign/handover chỉ hiện bằng dấu ▲ và trong popover,
// không bao giờ cộng vào con số — game bị reassign đã đếm ở lần assign gốc.
'use client'
import { useMemo, useState } from 'react'
import { shadeScale, type Cell, type Matrix } from '@/lib/assign-history-matrix'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const dayNum = (iso: string) => iso.slice(8, 10)
const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay()
const hhmm = (runAt: string) => (runAt.includes('T') ? runAt.slice(11, 16) : '')

export function AssignHistoryMatrix({ matrix }: { matrix: Matrix }) {
  const [openKey, setOpenKey] = useState<string | null>(null)

  const shade = useMemo(
    () => shadeScale(matrix.rows.flatMap(r => r.cells.map(c => c.assign))),
    [matrix],
  )

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
                        <button onClick={() => setOpenKey(openKey === key ? null : key)}>
                          <CellValue cell={c} />
                        </button>
                      )}
                    {openKey === key && <CellDetail cell={c} day={matrix.days[i]} onClose={() => setOpenKey(null)} />}
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

function CellDetail({ cell, day, onClose }: { cell: Cell; day: string; onClose: () => void }) {
  return (
    <div className="hm-pop" role="dialog" aria-label={`History ${day}`}>
      <div className="hm-pop-head">
        <span>{day}</span>
        <button onClick={onClose} aria-label="Close">✕</button>
      </div>
      {cell.rows.map(r => (
        <div className="hm-pop-row" key={r.id}>
          <span className="hm-pop-time">{hhmm(r.run_at)}</span>
          <span className={`pill ${r.action === 'assign' ? 'on' : r.action === 'reassign' ? 'tag' : 'off'}`}>{r.action}</span>
          <span>{r.category_group}</span>
          <span>{r.game_count} game</span>
          {r.from_evaluator && <span className="hm-pop-from">← {r.from_evaluator}</span>}
          <span className="hm-pop-by">{r.created_by ?? '—'}</span>
        </div>
      ))}
    </div>
  )
}
