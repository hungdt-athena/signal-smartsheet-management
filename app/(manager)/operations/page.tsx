'use client'
import { useEffect, useState, useCallback, useMemo } from 'react'

// ── Config ────────────────────────────────────────────────────────────────────

const GROUPS = [
  {
    label: 'Die-Link',
    workflows: [
      { label: 'Delete Bypass', workflow: 'delete_bypass', realtime: 'delete-bypass' },
      { label: 'Delete Blank',  workflow: 'delete_blank',  realtime: 'delete-blank' },
    ],
  },
  {
    label: 'Smartsheet',
    workflows: [
      { label: 'Pull iOS',         workflow: 'pull_ios',        realtime: 'pull-ios' },
      { label: 'Pull Android',     workflow: 'pull_android',    realtime: 'pull-android' },
      { label: 'Push Smartsheet',  workflow: 'push_smartsheet', realtime: 'push-smartsheet' },
    ],
  },
  {
    label: 'Videos',
    workflows: [
      { label: 'Upload YouTube', workflow: 'upload_ytb',   realtime: 'upload-youtube' },
      { label: 'Append Sheet',   workflow: 'append_sheet', realtime: 'append-sheet' },
    ],
  },
]

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

// ── Types ────────────────────────────────────────────────────────────────────

interface RealtimeRow { workflow: string; status: string }
interface LogRow      { date: string; name: string; status: string; note: string }
interface DayBucket   { date: string; rows: LogRow[] }
interface MonthBucket { key: string; year: number; month: number; days: DayBucket[] }
interface YearBucket  { year: number; months: MonthBucket[] }

// ── Helpers ──────────────────────────────────────────────────────────────────

function getTodayVN() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function formatNote(name: string, raw: string): string {
  const n = parseInt(raw, 10)
  if (name === 'delete-bypass' || name === 'delete-blank') {
    if (isNaN(n) || n === 0) return 'No die links to delete'
    return `${n} link${n !== 1 ? 's' : ''} deleted`
  }
  if (name === 'upload-youtube') {
    if (isNaN(n)) return raw || ''
    return `${n} video${n !== 1 ? 's' : ''} uploaded`
  }
  if (name === 'append-sheet') {
    if (isNaN(n)) return raw || ''
    return `${n} video${n !== 1 ? 's' : ''} appended to sheet`
  }
  return '' // pull/push: no note
}

function groupByDate(rows: LogRow[]): YearBucket[] {
  const byDate: Record<string, LogRow[]> = {}
  for (const r of rows) {
    const d = r.date.slice(0, 10)
    ;(byDate[d] = byDate[d] || []).push(r)
  }
  const byMonth: Record<string, DayBucket[]> = {}
  for (const [date, rs] of Object.entries(byDate)) {
    const mk = date.slice(0, 7)
    ;(byMonth[mk] = byMonth[mk] || []).push({ date, rows: rs })
  }
  const byYear: Record<string, MonthBucket[]> = {}
  for (const [mk, days] of Object.entries(byMonth)) {
    const [y, m] = mk.split('-')
    ;(byYear[y] = byYear[y] || []).push({
      key: mk, year: Number(y), month: Number(m),
      days: days.sort((a, b) => b.date.localeCompare(a.date)),
    })
  }
  return Object.entries(byYear)
    .sort(([a], [b]) => Number(b) - Number(a))
    .map(([year, months]) => ({
      year: Number(year),
      months: months.sort((a, b) => b.month - a.month),
    }))
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const running = status === 'running'
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full"
      style={{ background: running ? '#FEF3C7' : '#F3F4F6', color: running ? '#92400E' : '#9CA3AF' }}>
      <span className={`w-1.5 h-1.5 rounded-full inline-block ${running ? 'bg-amber-500 animate-pulse' : 'bg-gray-300'}`} />
      {running ? 'running' : 'idle'}
    </span>
  )
}

function LogBadge({ status }: { status: string }) {
  const ok = status.toLowerCase() === 'success'
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
      {status}
    </span>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function OperationsPage() {
  const [triggering, setTriggering]         = useState<string | null>(null)
  const [triggered, setTriggered]           = useState<string | null>(null)
  const [realtimeRows, setRealtimeRows]     = useState<RealtimeRow[]>([])
  const [realtimeOk, setRealtimeOk]         = useState<boolean | null>(null)
  const [logRows, setLogRows]               = useState<LogRow[]>([])
  const [logOk, setLogOk]                   = useState<boolean | null>(null)
  const [realtimeAt, setRealtimeAt]         = useState<Date | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)

  // History filters
  const [filterWorkflow, setFilterWorkflow] = useState('')
  const [filterStatus, setFilterStatus]     = useState('')
  const [filterFrom, setFilterFrom]         = useState('')
  const [filterTo, setFilterTo]             = useState('')

  // Collapsed state for nested history
  const today = getTodayVN()
  const todayMonth = today.slice(0, 7)
  const todayYear  = today.slice(0, 4)
  const [openYears,  setOpenYears]  = useState<Set<string>>(new Set([todayYear]))
  const [openMonths, setOpenMonths] = useState<Set<string>>(new Set([todayMonth]))
  const [openDays,   setOpenDays]   = useState<Set<string>>(new Set([today]))

  const fetchRealtime = useCallback(async () => {
    try {
      const res = await fetch('/api/operations/realtime', { cache: 'no-store' })
      if (res.ok) {
        setRealtimeRows(await res.json())
        setRealtimeAt(new Date())
        setRealtimeOk(true)
      } else {
        setRealtimeOk(false)
      }
    } catch {
      setRealtimeOk(false)
    }
  }, [])

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const res = await fetch('/api/operations/history?limit=200', { cache: 'no-store' })
      if (res.ok) { setLogRows(await res.json()); setLogOk(true) }
      else setLogOk(false)
    } catch {
      setLogOk(false)
    } finally { setHistoryLoading(false) }
  }, [])

  useEffect(() => {
    fetchRealtime()
    fetchHistory()
    const rt = setInterval(fetchRealtime, 5000)
    const ht = setInterval(fetchHistory, 60000)
    return () => { clearInterval(rt); clearInterval(ht) }
  }, [fetchRealtime, fetchHistory])

  async function handleTrigger(workflow: string) {
    setTriggering(workflow)
    setTriggered(null)
    try {
      await fetch('/api/workflows/trigger', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow }),
      })
      setTriggered(workflow)
    } finally {
      setTriggering(null)
      setTimeout(() => setTriggered(null), 2500)
    }
  }

  // Realtime lookup
  const statusMap = useMemo(() =>
    Object.fromEntries(realtimeRows.map(r => [r.workflow, r.status])),
  [realtimeRows])


  const nowStr = realtimeAt
    ? realtimeAt.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null

  // Unique workflow names for filter dropdown
  const workflowNames = useMemo(() => Array.from(new Set(logRows.map(r => r.name))).sort(), [logRows])

  // Filtered + grouped history
  const filteredRows = useMemo(() => logRows.filter(r => {
    if (filterWorkflow && r.name !== filterWorkflow) return false
    if (filterStatus   && r.status.toLowerCase() !== filterStatus.toLowerCase()) return false
    const d = r.date.slice(0, 10)
    if (filterFrom && d < filterFrom) return false
    if (filterTo   && d > filterTo)   return false
    return true
  }), [logRows, filterWorkflow, filterStatus, filterFrom, filterTo])

  const grouped = useMemo(() => groupByDate(filteredRows), [filteredRows])

  function toggle(set: Set<string>, val: string): Set<string> {
    const n = new Set(Array.from(set))
    if (n.has(val)) { n.delete(val) } else { n.add(val) }
    return n
  }

  return (
    <div className="space-y-5">
      <h1 className="font-extrabold text-2xl" style={{ color: '#2A1F08' }}>Operations</h1>

      {/* ── Section 1+2: Groups (Realtime + Triggers combined) ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {GROUPS.map(group => {
          const groupRunning = group.workflows.some(w => statusMap[w.realtime] === 'running')
          return (
            <div key={group.label} className="bean-card p-4 flex flex-col gap-0">
              <div className="flex items-center justify-between mb-3">
                <p className="bean-section-label" style={{ marginBottom: 0 }}>{group.label}</p>
                {realtimeOk === false ? (
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                    style={{ background: '#FEE2E2', color: '#B91C1C' }}>
                    ⚡ disconnected
                  </span>
                ) : groupRunning ? (
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full flex items-center gap-1"
                    style={{ background: '#FEF3C7', color: '#92400E' }}>
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse inline-block" />
                    running
                  </span>
                ) : null}
              </div>

              <div className="divide-y" style={{ borderColor: '#E8DCC8' }}>
                {group.workflows.map(op => {
                  const disconnected  = realtimeOk === false
                  const status       = disconnected ? 'idle' : (statusMap[op.realtime] ?? 'idle')
                  const isRunning    = status === 'running'
                  const isTriggering = triggering === op.workflow
                  const wasTriggered = triggered === op.workflow
                  const isLocked     = isRunning || isTriggering
                  return (
                    <div key={op.workflow}
                      className="flex items-center justify-between py-2.5 gap-2"
                      style={{ background: isRunning ? '#FFFBEB' : 'transparent' }}>
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        {disconnected
                          ? <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: '#F3F4F6', color: '#9CA3AF' }}>–</span>
                          : <StatusDot status={status} />}
                        <span className="text-xs font-semibold truncate" style={{ color: '#2A1F08' }}>{op.label}</span>
                      </div>
                      <button
                        onClick={() => handleTrigger(op.workflow)}
                        disabled={isLocked}
                        className="flex-shrink-0 text-xs font-bold px-2.5 py-1 rounded-lg transition-all"
                        style={{
                          background: wasTriggered ? '#7A8C1E'
                                    : isRunning    ? '#F59E0B'
                                    :                '#D4C4A0',
                          color:  wasTriggered ? '#fff'
                                : isRunning    ? '#fff'
                                :                '#2A1F08',
                          border: '1.5px solid ' + (isRunning ? '#D97706' : '#5A6A10'),
                          opacity: isLocked ? 0.6 : 1,
                          cursor: isLocked ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {isTriggering ? <span className="inline-block animate-spin">↻</span>
                         : wasTriggered ? '✓'
                         : isRunning   ? '●'
                         : '▶'}
                      </button>
                    </div>
                  )
                })}
              </div>

              <p className="text-xs mt-2 text-right" style={{ color: '#9CA3AF' }}>
                {nowStr ? `${nowStr} · 5s` : '…'}
              </p>
            </div>
          )
        })}
      </div>

      {/* ── Section 3: History ── */}
      <div className="bean-card p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="bean-section-label">History</p>
          <button onClick={fetchHistory} disabled={historyLoading}
            className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-lg"
            style={{ background: '#D4C4A0', color: '#5A3E1B', opacity: historyLoading ? 0.6 : 1 }}>
            <span className={historyLoading ? 'inline-block animate-spin' : ''}>↻</span>
            {historyLoading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-2 mb-4">
          <select value={filterWorkflow} onChange={e => setFilterWorkflow(e.target.value)}
            className="text-xs border rounded-lg px-2 py-1.5 font-medium"
            style={{ borderColor: '#D4C4A0', color: '#2A1F08', background: '#FAF5EC' }}>
            <option value="">All workflows</option>
            {workflowNames.map(n => <option key={n} value={n}>{n}</option>)}
          </select>

          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
            className="text-xs border rounded-lg px-2 py-1.5 font-medium"
            style={{ borderColor: '#D4C4A0', color: '#2A1F08', background: '#FAF5EC' }}>
            <option value="">All status</option>
            <option value="Success">Success</option>
            <option value="Failed">Failed</option>
          </select>

          <input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)}
            className="text-xs border rounded-lg px-2 py-1.5"
            style={{ borderColor: '#D4C4A0', color: '#2A1F08', background: '#FAF5EC' }} />
          <span className="text-xs self-center" style={{ color: '#8B6A3E' }}>→</span>
          <input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)}
            className="text-xs border rounded-lg px-2 py-1.5"
            style={{ borderColor: '#D4C4A0', color: '#2A1F08', background: '#FAF5EC' }} />

          {(filterWorkflow || filterStatus || filterFrom || filterTo) && (
            <button onClick={() => { setFilterWorkflow(''); setFilterStatus(''); setFilterFrom(''); setFilterTo('') }}
              className="text-xs px-2 py-1.5 rounded-lg font-medium"
              style={{ background: '#FEE2E2', color: '#B91C1C' }}>
              ✕ Clear
            </button>
          )}
        </div>

        {/* Nested date tree */}
        {logOk === false ? (
          <p className="text-sm text-center py-6" style={{ color: '#B91C1C' }}>
            ⚡ Cannot connect to Google Sheets — check OAuth credentials in Replit secrets.
          </p>
        ) : grouped.length === 0 ? (
          <p className="text-sm text-center py-6" style={{ color: '#8B6A3E' }}>
            No entries match the current filters.
          </p>
        ) : (
          <div className="space-y-1.5" style={{ maxHeight: 480, overflowY: 'auto', paddingRight: 4 }}>
            {grouped.map(yb => (
              <div key={yb.year}>
                {/* Year row */}
                <button onClick={() => setOpenYears(s => toggle(s, String(yb.year)))}
                  className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg font-bold text-sm"
                  style={{ background: '#D4C4A0', color: '#2A1F08', border: 'none', cursor: 'pointer' }}>
                  <span className="text-xs">{openYears.has(String(yb.year)) ? '▾' : '▸'}</span>
                  {yb.year}
                  <span className="ml-auto text-xs font-normal" style={{ color: '#6B5A3A' }}>
                    {yb.months.length} month{yb.months.length !== 1 ? 's' : ''}
                  </span>
                </button>

                {openYears.has(String(yb.year)) && (
                  <div className="ml-4 mt-1 space-y-1">
                    {yb.months.map(mb => (
                      <div key={mb.key}>
                        {/* Month row */}
                        <button onClick={() => setOpenMonths(s => toggle(s, mb.key))}
                          className="w-full flex items-center gap-2 px-3 py-1 rounded-lg text-xs font-semibold"
                          style={{ background: '#EFE3C8', color: '#2A1F08', border: 'none', cursor: 'pointer' }}>
                          <span className="text-xs">{openMonths.has(mb.key) ? '▾' : '▸'}</span>
                          {MONTH_NAMES[mb.month - 1]}
                          <span className="ml-auto font-normal" style={{ color: '#6B5A3A' }}>
                            {mb.days.length} day{mb.days.length !== 1 ? 's' : ''}
                          </span>
                        </button>

                        {openMonths.has(mb.key) && (
                          <div className="ml-4 mt-1 space-y-1">
                            {mb.days.map(db => {
                              const isToday = db.date === today
                              const [, dm, dd] = db.date.split('-')
                              const label = `${dd}/${dm}`
                              const successCount = db.rows.filter(r => r.status.toLowerCase() === 'success').length
                              const failCount    = db.rows.length - successCount
                              return (
                                <div key={db.date} className="rounded-lg overflow-hidden"
                                  style={{ border: '1.5px solid #D4C4A0' }}>
                                  {/* Day row */}
                                  <button onClick={() => setOpenDays(s => toggle(s, db.date))}
                                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs"
                                    style={{ background: '#FAF5EC', border: 'none', cursor: 'pointer' }}>
                                    <span className="text-xs">{openDays.has(db.date) ? '▾' : '▸'}</span>
                                    <span className="font-bold" style={{ color: '#2A1F08' }}>{label}</span>
                                    {isToday && (
                                      <span className="px-1.5 py-0.5 rounded text-xs font-bold"
                                        style={{ background: '#7A8C1E', color: '#fff', fontSize: '0.6rem' }}>TODAY</span>
                                    )}
                                    <span className="ml-auto font-normal flex items-center gap-2" style={{ color: '#6B5A3A' }}>
                                      {successCount > 0 && <span className="text-green-600 font-semibold">✓ {successCount}</span>}
                                      {failCount    > 0 && <span className="text-red-500 font-semibold">✗ {failCount}</span>}
                                    </span>
                                  </button>

                                  {/* Day entries */}
                                  {openDays.has(db.date) && (
                                    <div style={{ background: '#FDFAF4' }}>
                                      {db.rows.map((r, i) => {
                                        const note = formatNote(r.name, r.note)
                                        return (
                                          <div key={i}
                                            className="flex items-center gap-3 px-4 py-2 text-xs border-t"
                                            style={{ borderColor: '#EFE3C8' }}>
                                            <span className="text-gray-400 font-mono whitespace-nowrap"
                                              style={{ fontSize: '0.65rem' }}>
                                              {r.date.slice(11, 16)}
                                            </span>
                                            <span className="font-semibold flex-shrink-0" style={{ color: '#2A1F08', minWidth: 100 }}>{r.name}</span>
                                            <LogBadge status={r.status} />
                                            {note && (
                                              <span className="ml-auto text-right" style={{ color: '#6B5A3A' }}>{note}</span>
                                            )}
                                          </div>
                                        )
                                      })}
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
