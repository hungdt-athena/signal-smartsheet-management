'use client'
import { useState, useEffect, useCallback } from 'react'

interface EntryRow {
  flow_type: 'pull' | 'push'
  period: 'morning' | 'afternoon'
  total: number
  detail: Record<string, number>
  created_at: string
}

interface DayGroup {
  log_date: string
  entries: EntryRow[]
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const PUSH_ICONS: Record<string, string> = { puzzle: '🧩', arcade: '🕹️', simulation: '🚗' }
const PUSH_ORDER = ['puzzle', 'arcade', 'simulation']

function getTodayVN() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function toVNTime(iso: string) {
  return new Date(iso).toLocaleTimeString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function EntryItem({ entry }: { entry: EntryRow }) {
  const isPull = entry.flow_type === 'pull'
  const periodLabel = entry.period === 'morning' ? 'Morning' : 'Afternoon'
  const detailKeys = isPull
    ? Object.keys(entry.detail)
    : PUSH_ORDER.filter(k => k in entry.detail)

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8,
      padding: '5px 0', borderBottom: '1px dashed #D4C4A0',
    }}>
      <span style={{
        background: isPull ? '#7A8C1E' : '#5A3E1B',
        color: '#fff', borderRadius: 4, padding: '1px 7px',
        fontSize: 10, fontWeight: 700, flexShrink: 0, marginTop: 2,
      }}>{isPull ? 'Pull' : 'Push'}</span>
      <span style={{ fontWeight: 600, color: '#2A1F08', fontSize: 12, flexShrink: 0, width: 64 }}>
        {periodLabel}
      </span>
      <span style={{ fontWeight: 800, color: '#2A1F08', fontSize: 13 }}>
        {entry.total.toLocaleString()}
      </span>
      <span style={{ color: '#6B5A3A', fontSize: 11, marginLeft: 4 }}>
        {detailKeys.map(k => (
          <span key={k} style={{ marginRight: 6 }}>
            {isPull ? k : (PUSH_ICONS[k] ?? k)}{' '}{(entry.detail[k] ?? 0).toLocaleString()}
          </span>
        ))}
      </span>
      <span style={{ color: '#9A8A6A', fontSize: 10, marginLeft: 'auto', flexShrink: 0 }}>
        {toVNTime(entry.created_at)}
      </span>
    </div>
  )
}

function DayRow({
  day, open, onToggle,
}: { day: DayGroup; open: boolean; onToggle: () => void }) {
  const today = getTodayVN()
  const isToday = day.log_date === today
  const [, m, d] = day.log_date.split('-')
  const label = isToday ? 'Today' : `${d}/${m}`
  const pullCount = day.entries.filter(e => e.flow_type === 'pull').length
  const pushCount = day.entries.filter(e => e.flow_type === 'push').length

  return (
    <div style={{ border: '2px solid #D4C4A0', borderRadius: 8, overflow: 'hidden', marginBottom: 3 }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          background: '#EFE3C8', padding: '5px 10px', border: 'none',
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 10 }}>{open ? '▾' : '▸'}</span>
        <span style={{ fontWeight: 700, color: '#2A1F08', fontSize: 12 }}>{label}</span>
        {isToday && (
          <span style={{
            background: '#7A8C1E', color: '#fff', borderRadius: 4,
            padding: '1px 6px', fontSize: 10, fontWeight: 700,
          }}>Today</span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6B5A3A' }}>
          {pullCount} pull · {pushCount} push
        </span>
      </button>
      {open && (
        <div style={{ padding: '6px 12px', background: '#FAF5EC' }}>
          {day.entries.map((e, i) => (
            <EntryItem key={`${e.flow_type}-${e.period}-${i}`} entry={e} />
          ))}
        </div>
      )}
    </div>
  )
}

function MonthRow({
  year, month, open, loaded, days, error, onToggle, openDays, onToggleDay,
}: {
  year: number
  month: number
  open: boolean
  loaded: boolean
  days: DayGroup[]
  error: string | null
  onToggle: () => void
  openDays: Set<string>
  onToggleDay: (date: string) => void
}) {
  return (
    <div style={{ marginBottom: 4 }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          background: '#C8B896', border: 'none', borderRadius: 7,
          padding: '5px 10px', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 10 }}>{open ? '▾' : '▸'}</span>
        <span style={{ fontWeight: 700, color: '#2A1F08', fontSize: 12 }}>
          {MONTH_NAMES[month - 1]}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6B5A3A' }}>
          {!loaded ? 'click to load' : `${days.length} days`}
        </span>
      </button>
      {open && (
        <div style={{ marginLeft: 14, marginTop: 3 }}>
          {!loaded && !error && (
            <p style={{ fontSize: 11, color: '#9A8A6A', padding: '4px 6px' }}>Loading...</p>
          )}
          {error && (
            <p style={{ fontSize: 11, color: '#b91c1c', padding: '4px 6px' }}>{error}</p>
          )}
          {loaded && days.length === 0 && (
            <p style={{ fontSize: 11, color: '#9A8A6A', padding: '4px 6px' }}>No data for this month.</p>
          )}
          {loaded && days.map(day => (
            <DayRow
              key={day.log_date}
              day={day}
              open={openDays.has(day.log_date)}
              onToggle={() => onToggleDay(day.log_date)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function FlowHistory() {
  const [years, setYears] = useState<number[] | null>(null)
  const [monthsByYear, setMonthsByYear] = useState<Record<number, number[]>>({})
  const [entriesByMonth, setEntriesByMonth] = useState<Record<string, DayGroup[]>>({})
  const [loadingMonths, setLoadingMonths] = useState<Set<number>>(new Set())
  const [loadingMonth, setLoadingMonth] = useState<Set<string>>(new Set())
  const [monthErrors, setMonthErrors] = useState<Record<string, string>>({})
  const [openYears, setOpenYears] = useState<Set<number>>(new Set())
  const [openMonths, setOpenMonths] = useState<Set<string>>(new Set())
  const [openDays, setOpenDays] = useState<Set<string>>(new Set())
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  const fetchYears = useCallback(async (): Promise<number[]> => {
    const res = await fetch('/api/flow-logs/years', { cache: 'no-store' })
    if (!res.ok) return []
    return res.json()
  }, [])

  const fetchMonths = useCallback(async (year: number): Promise<number[]> => {
    const res = await fetch(`/api/flow-logs/months?year=${year}`, { cache: 'no-store' })
    if (!res.ok) return []
    return res.json()
  }, [])

  const fetchMonth = useCallback(async (year: number, month: number): Promise<DayGroup[]> => {
    const res = await fetch(`/api/flow-logs/month?year=${year}&month=${month}`, { cache: 'no-store' })
    if (!res.ok) throw new Error('Failed to load')
    return res.json()
  }, [])

  // Auto-open today on mount
  useEffect(() => {
    async function init() {
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
      const todayYear = now.getFullYear()
      const todayMonth = now.getMonth() + 1
      const todayDate = getTodayVN()

      const fetchedYears = await fetchYears()
      setYears(fetchedYears)
      if (!fetchedYears.includes(todayYear)) return

      setOpenYears(new Set([todayYear]))
      setLoadingMonths(new Set([todayYear]))
      const fetchedMonths = await fetchMonths(todayYear)
      setMonthsByYear({ [todayYear]: fetchedMonths })
      setLoadingMonths(new Set())
      if (!fetchedMonths.includes(todayMonth)) return

      const mk = `${todayYear}-${todayMonth}`
      setOpenMonths(new Set([mk]))
      setLoadingMonth(new Set([mk]))
      try {
        const days = await fetchMonth(todayYear, todayMonth)
        setEntriesByMonth({ [mk]: days })
        if (days.some(d => d.log_date === todayDate)) {
          setOpenDays(new Set([todayDate]))
        }
      } catch {
        setMonthErrors({ [mk]: 'Failed to load' })
      } finally {
        setLoadingMonth(new Set())
      }
    }
    init()
  }, [fetchYears, fetchMonths, fetchMonth])

  async function toggleYear(year: number) {
    setOpenYears(s => {
      const n = new Set(s)
      n.has(year) ? n.delete(year) : n.add(year)
      return n
    })
    if (monthsByYear[year] !== undefined) return
    setLoadingMonths(s => new Set(Array.from(s).concat([year])))
    const months = await fetchMonths(year)
    setMonthsByYear(s => ({ ...s, [year]: months }))
    setLoadingMonths(s => { const n = new Set(s); n.delete(year); return n })
  }

  async function toggleMonth(year: number, month: number) {
    const mk = `${year}-${month}`
    setOpenMonths(s => {
      const n = new Set(s)
      n.has(mk) ? n.delete(mk) : n.add(mk)
      return n
    })
    if (entriesByMonth[mk] !== undefined) return
    setLoadingMonth(s => new Set(Array.from(s).concat([mk])))
    try {
      const days = await fetchMonth(year, month)
      setEntriesByMonth(s => ({ ...s, [mk]: days }))
    } catch {
      setMonthErrors(s => ({ ...s, [mk]: 'Failed to load. Try again.' }))
    } finally {
      setLoadingMonth(s => { const n = new Set(s); n.delete(mk); return n })
    }
  }

  function toggleDay(date: string) {
    setOpenDays(s => {
      const n = new Set(s)
      n.has(date) ? n.delete(date) : n.add(date)
      return n
    })
  }

  async function doRefresh() {
    setRefreshing(true)
    setRefreshError(null)
    try {
      const res = await fetch('/api/flow-logs/refresh', { method: 'POST' })
      if (!res.ok) throw new Error('Refresh failed')
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
      const year = now.getFullYear()
      const month = now.getMonth() + 1
      const mk = `${year}-${month}`
      const days = await fetchMonth(year, month)
      setEntriesByMonth(s => ({ ...s, [mk]: days }))
      const todayDate = getTodayVN()
      if (days.some(d => d.log_date === todayDate)) {
        setOpenDays(s => new Set(Array.from(s).concat([todayDate])))
      }
    } catch {
      setRefreshError('Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <p className="bean-section-label">Games History</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {refreshError && (
            <span style={{ fontSize: 11, color: '#b91c1c' }}>{refreshError}</span>
          )}
          <button
            onClick={doRefresh}
            disabled={refreshing}
            className="flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-lg transition-all"
            style={{ background: '#D4C4A0', color: '#5A3E1B', opacity: refreshing ? 0.6 : 1, border: 'none', cursor: 'pointer' }}
          >
            <span style={{ display: 'inline-block', animation: refreshing ? 'spin 1s linear infinite' : 'none' }}>↻</span>
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Scroll container */}
      <div style={{ height: 350, overflowY: 'auto', paddingRight: 4 }}>
        {years === null && (
          <p style={{ fontSize: 12, color: '#9A8A6A', padding: '8px 4px' }}>Loading...</p>
        )}
        {years !== null && years.length === 0 && (
          <p style={{ fontSize: 12, color: '#9A8A6A', padding: '8px 4px' }}>No history yet.</p>
        )}
        {years !== null && years.map(year => (
          <div key={year} style={{ marginBottom: 6 }}>
            <button
              onClick={() => toggleYear(year)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                background: '#D4C4A0', border: 'none', borderRadius: 8,
                padding: '6px 10px', cursor: 'pointer', textAlign: 'left', marginBottom: 4,
              }}
            >
              <span style={{ fontSize: 10 }}>{openYears.has(year) ? '▾' : '▸'}</span>
              <span style={{ fontWeight: 700, color: '#2A1F08', fontSize: 13 }}>{year}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6B5A3A' }}>
                {loadingMonths.has(year)
                  ? 'loading...'
                  : monthsByYear[year] == null
                    ? 'click to load'
                    : `${monthsByYear[year].length} months`}
              </span>
            </button>

            {openYears.has(year) && monthsByYear[year] != null && (
              <div style={{ marginLeft: 14 }}>
                {monthsByYear[year].map(month => {
                  const mk = `${year}-${month}`
                  return (
                    <MonthRow
                      key={mk}
                      year={year}
                      month={month}
                      open={openMonths.has(mk)}
                      loaded={entriesByMonth[mk] !== undefined && !loadingMonth.has(mk)}
                      days={entriesByMonth[mk] ?? []}
                      error={monthErrors[mk] ?? null}
                      onToggle={() => toggleMonth(year, month)}
                      openDays={openDays}
                      onToggleDay={toggleDay}
                    />
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
