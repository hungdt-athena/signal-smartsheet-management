// components/AssignHistory.tsx — per-bucket assignment_history reader (migration 025).
// Shows one row per (run, evaluator): daily auto-assign, manual re-assign, handover.
// Rendered as a Year → Month → Day timeline instead of a flat table.
'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Bucket } from '@/lib/buckets'

interface HistoryRow {
  id: number
  run_date: string
  run_at: string
  category_group: string
  action: 'assign' | 'reassign' | 'handover'
  evaluator_name: string
  from_evaluator: string | null
  game_count: number
  created_by: string | null
}

const ACTION_LABEL: Record<HistoryRow['action'], string> = {
  assign: 'Assign', reassign: 'Reassign', handover: 'Handover',
}
// Reuse the shared pill palette: on=accent, tag=neutral, off=muted.
const ACTION_PILL: Record<HistoryRow['action'], string> = {
  assign: 'on', reassign: 'tag', handover: 'off',
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface DayGroup { key: string; d: string; weekday: string; rows: HistoryRow[]; runs: number; games: number }
interface MonthGroup { key: string; name: string; days: DayGroup[]; runs: number; games: number }
interface YearGroup { year: string; months: MonthGroup[]; runs: number; games: number }

// run_date is a plain YYYY-MM-DD (VN date) — parse as UTC to avoid a timezone shift.
function groupRows(rows: HistoryRow[]): YearGroup[] {
  const years: YearGroup[] = []
  let cy: YearGroup | null = null
  let cm: MonthGroup | null = null
  let cd: DayGroup | null = null
  for (const r of rows) {
    const iso = r.run_date.slice(0, 10)
    const [ys, ms, ds] = iso.split('-')
    const mk = `${ys}-${ms}`
    const g = r.game_count || 0
    if (!cy || cy.year !== ys) { cy = { year: ys, months: [], runs: 0, games: 0 }; years.push(cy); cm = null; cd = null }
    if (!cm || cm.key !== mk) { cm = { key: mk, name: `${MONTHS[+ms - 1]} ${ys}`, days: [], runs: 0, games: 0 }; cy.months.push(cm); cd = null }
    if (!cd || cd.key !== iso) {
      const dow = new Date(`${iso}T00:00:00Z`).getUTCDay()
      cd = { key: iso, d: ds, weekday: WEEKDAYS[dow], rows: [], runs: 0, games: 0 }
      cm.days.push(cd)
    }
    cd.rows.push(r)
    cd.runs++; cd.games += g
    cm.runs++; cm.games += g
    cy.runs++; cy.games += g
  }
  return years
}

const fmtInt = (n: number) => n.toLocaleString('en-US')
const runsGames = (runs: number, games: number) => `${runs} ${runs === 1 ? 'run' : 'runs'} · ${fmtInt(games)} games`

export function AssignHistory({ bucket }: { bucket: Bucket }) {
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openMonths, setOpenMonths] = useState<Set<string>>(new Set())
  const [openDays, setOpenDays] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/admin/assignment-history?category=${bucket}&limit=500`, { cache: 'no-store' })
      if (!res.ok) throw new Error()
      const json = await res.json()
      setRows(json.rows ?? [])
    } catch { setError('Failed to load history.') }
    finally { setLoading(false) }
  }, [bucket])

  useEffect(() => { refresh() }, [refresh])

  const years = useMemo(() => groupRows(rows), [rows])
  const totalGames = useMemo(() => rows.reduce((s, r) => s + (r.game_count || 0), 0), [rows])
  const multiYear = years.length > 1

  // Signature of the current grouping — only re-seed defaults when the shape changes
  // (e.g. a refresh brings in a new day), so manual toggles survive a same-data refresh.
  const structKey = useMemo(
    () => years.map(y => y.months.map(m => `${m.key}(${m.days.map(d => d.key).join(',')})`).join('|')).join('#'),
    [years],
  )
  const seeded = useRef('')
  useEffect(() => {
    if (!years.length || seeded.current === structKey) return
    seeded.current = structKey
    // Collapse everything; open only the most recent month + its most recent day.
    const month0 = years[0].months[0]
    setOpenMonths(new Set([month0.key]))
    setOpenDays(new Set([month0.days[0].key]))
  }, [structKey, years])

  const toggle = (setter: typeof setOpenMonths) => (k: string) => setter(prev => {
    const next = new Set(prev)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    return next
  })
  const toggleMonth = toggle(setOpenMonths)
  const toggleDay = toggle(setOpenDays)

  return (
    <div className="card hist-card">
      <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="card-label">
          History
          {rows.length > 0 && <span className="hist-sub">{runsGames(rows.length, totalGames)}</span>}
        </span>
        <button className="btn btn-sm" onClick={refresh} disabled={loading}>
          <span className={loading ? 'spin' : ''}>↻</span>{loading ? '...' : 'Refresh'}
        </button>
      </div>

      {error && <p className="msg-err" style={{ margin: '8px 0' }}>{error}</p>}
      {rows.length === 0 && !loading && !error && <p className="empty">No history yet</p>}

      <div className="hist">
        {years.map(yg => (
          <section className="hist-year" key={yg.year}>
            {multiYear && (
              <div className="hist-year-bar">
                <span className="hist-year-num">{yg.year}</span>
                <span className="hist-year-meta">{runsGames(yg.runs, yg.games)}</span>
              </div>
            )}
            {yg.months.map(mg => {
              const mOpen = openMonths.has(mg.key)
              return (
                <div className="hist-month" key={mg.key}>
                  <button className="hist-month-head" onClick={() => toggleMonth(mg.key)} aria-expanded={mOpen}>
                    <span className={`hist-caret${mOpen ? ' open' : ''}`}>›</span>
                    <span className="hist-month-name">{mg.name}</span>
                    <span className="hist-month-meta">{runsGames(mg.runs, mg.games)}</span>
                  </button>
                  {mOpen && (
                    <div className="hist-days">
                      {mg.days.map(dg => {
                        const dOpen = openDays.has(dg.key)
                        return (
                          <div className={`hist-day${dOpen ? ' open' : ''}`} key={dg.key}>
                            <button className="hist-day-head" onClick={() => toggleDay(dg.key)} aria-expanded={dOpen}>
                              <span className="hist-daymark">
                                <span className="hist-dnum">{dg.d}</span>
                                <span className="hist-dwk">{dg.weekday}</span>
                              </span>
                              <span className={`hist-caret${dOpen ? ' open' : ''}`}>›</span>
                              <span className="hist-day-meta">{runsGames(dg.runs, dg.games)}</span>
                            </button>
                            {dOpen && (
                              <div className="hist-rows">
                                {dg.rows.map(r => (
                                  <div className="hist-row" key={r.id}>
                                    <span className={`pill ${ACTION_PILL[r.action]}`}>{ACTION_LABEL[r.action] ?? r.action}</span>
                                    <div className="hist-move">
                                      {r.from_evaluator && (
                                        <>
                                          <span className="hist-from">{r.from_evaluator}</span>
                                          <span className="hist-arrow" aria-label="to">→</span>
                                        </>
                                      )}
                                      <span className="hist-to">{r.evaluator_name}</span>
                                    </div>
                                    <span className="hist-games">{fmtInt(r.game_count)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </section>
        ))}
      </div>
    </div>
  )
}
