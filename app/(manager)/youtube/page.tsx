'use client'
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { StyledSelect } from '@/components/StyledSelect'
import { MultiSelect } from '@/components/MultiSelect'
import { MonthPicker } from '@/components/MonthPicker'
import type { YearMonth } from '@/components/MonthPicker'
import EvalDetailPanel from '@/components/EvalDetailPanel'

interface YtbRow {
  row_index: number
  fileId: string
  time: string
  status: string
  fileName: string
  youtubeId: string
  gameTitle: string
  pic: string
  duration: string
}

// ── Status ────────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, { cls: string; label: string }> = {
  DONE:       { cls: 'success', label: 'Uploaded' },
  FAILED:     { cls: 'error',   label: 'Failed to Upload' },
  PROCESSING: { cls: 'running', label: 'Processing' },
  IN_BATCH:   { cls: 'running', label: 'Waiting for processing' },
  PENDING:    { cls: 'idle',    label: 'Pending' },
}

function StatusBadge({ status }: { status: string }) {
  const key = status?.toUpperCase() as keyof typeof STATUS_STYLES
  const s = STATUS_STYLES[key]
  if (s) return <span className={`badge ${s.cls}`}>{s.label}</span>
  return <span className="badge neutral">{status || '—'}</span>
}

// ── Month names ───────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// ── Filter types ──────────────────────────────────────────────────────────────

interface Filters {
  year: string
  month: string
  evaluator: string
  duration: string
}

function getCurrentMonthFilters(): Filters {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
  return {
    year: String(now.getFullYear()),
    month: String(now.getMonth()),
    evaluator: '',
    duration: '',
  }
}

const EMPTY_FILTERS: Filters = { year: '', month: '', evaluator: '', duration: '' }

function normalizeEvaluator(name: string): string {
  const match = name.match(/^(.*?)(\d+)$/)
  if (match) return match[1].toLowerCase() + match[2]
  return name.toLowerCase()
}

function getFilterOptions(rows: YtbRow[]) {
  const years = new Set<string>()
  const monthsByYear = new Map<string, Set<number>>()
  const evaluatorMap = new Map<string, string>()
  const durations = new Set<string>()

  for (const row of rows) {
    if (row.time) {
      const d = new Date(row.time)
      if (!isNaN(d.getTime())) {
        const y = String(d.getFullYear())
        years.add(y)
        if (!monthsByYear.has(y)) monthsByYear.set(y, new Set())
        monthsByYear.get(y)!.add(d.getMonth())
      }
    }
    if (row.pic) {
      const key = normalizeEvaluator(row.pic)
      const existing = evaluatorMap.get(key)
      if (!existing) {
        evaluatorMap.set(key, row.pic)
      } else {
        const hasDigits = /\d+$/.test(row.pic)
        const existingHasDigits = /\d+$/.test(existing)
        if (hasDigits && !existingHasDigits) evaluatorMap.set(key, row.pic)
      }
    }
    if (row.duration) durations.add(row.duration)
  }

  const monthsByYearObj: Record<string, number[]> = {}
  monthsByYear.forEach((ms, y) => {
    monthsByYearObj[y] = Array.from(ms).sort((a: number, b: number) => a - b)
  })

  const evaluators: string[] = []
  evaluatorMap.forEach(v => evaluators.push(v))
  evaluators.sort((a, b) => normalizeEvaluator(a).localeCompare(normalizeEvaluator(b)))

  return {
    years: Array.from(years).sort((a, b) => Number(b) - Number(a)),
    monthsByYear: monthsByYearObj,
    evaluators,
    durations: Array.from(durations).sort(),
  }
}

function applyFilters(rows: YtbRow[], filters: Filters): YtbRow[] {
  const evalKey = filters.evaluator ? normalizeEvaluator(filters.evaluator) : ''
  return rows.filter(row => {
    if (filters.year || filters.month) {
      if (!row.time) return false
      const d = new Date(row.time)
      if (isNaN(d.getTime())) return false
      if (filters.year && String(d.getFullYear()) !== filters.year) return false
      if (filters.month && String(d.getMonth()) !== filters.month) return false
    }
    if (evalKey && normalizeEvaluator(row.pic) !== evalKey) return false
    if (filters.duration && row.duration !== filters.duration) return false
    return true
  })
}

function groupByDay(rows: YtbRow[]): { day: string; label: string; rows: YtbRow[] }[] {
  const map = new Map<string, YtbRow[]>()
  for (const row of rows) {
    let key = 'No date'
    if (row.time) {
      const d = new Date(row.time)
      if (!isNaN(d.getTime())) {
        const vnDate = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
        key = `${vnDate.getFullYear()}-${String(vnDate.getMonth() + 1).padStart(2, '0')}-${String(vnDate.getDate()).padStart(2, '0')}`
      }
    }
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(row)
  }

  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  return Array.from(map.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, rows]) => ({
      day,
      label: day === todayStr ? 'Today' : day === 'No date' ? 'No date' : formatDayLabel(day),
      rows,
    }))
}

function formatDayLabel(dayStr: string) {
  const [y, m, d] = dayStr.split('-')
  const monthName = MONTH_NAMES[Number(m) - 1]?.slice(0, 3) ?? m
  return `${d} ${monthName} ${y}`
}

// ── Custom Dropdown ───────────────────────────────────────────────────────────

function CustomDropdown({ label, value, options, onChange }: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const allOptions = [{ value: '', label: `All ${label}` }, ...options]
  const selectedLabel = allOptions.find(o => o.value === value)?.label ?? `All ${label}`
  const isActive = value !== ''

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          border: `1.5px solid ${isActive ? 'var(--accent-border)' : 'var(--border-strong)'}`,
          borderRadius: 8, padding: '5px 10px',
          fontSize: 12, fontWeight: 600,
          color: isActive ? 'var(--accent-strong)' : 'var(--text)',
          background: isActive ? 'var(--accent-weak)' : 'var(--surface)',
          cursor: 'pointer', whiteSpace: 'nowrap',
          transition: 'all 0.15s ease',
          fontFamily: 'var(--font)',
        }}
      >
        {selectedLabel}
        <span style={{ fontSize: 9, color: 'var(--faint)', marginLeft: 2, transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'none' }}>▼</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 50,
          background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 10,
          padding: '4px', minWidth: 160, maxHeight: 260, overflowY: 'auto',
          boxShadow: 'var(--shadow-md)',
        }}>
          {allOptions.map(opt => {
            const selected = opt.value === value
            return (
              <button
                key={opt.value}
                onClick={() => { onChange(opt.value); setOpen(false) }}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                  padding: '7px 9px', border: 'none', borderRadius: 6,
                  background: selected ? 'var(--accent-weak)' : 'transparent',
                  color: selected ? 'var(--accent-strong)' : 'var(--text)',
                  fontSize: 13, fontWeight: selected ? 700 : 500,
                  cursor: 'pointer', textAlign: 'left',
                  fontFamily: 'var(--font)',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--surface-2)' }}
                onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{ width: 16, flexShrink: 0, fontSize: 11, color: 'var(--accent)' }}>
                  {selected ? '✓' : ''}
                </span>
                {opt.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Nested Time Filter ────────────────────────────────────────────────────────

function TimeFilter({ filters, options, onChange }: {
  filters: Filters
  options: ReturnType<typeof getFilterOptions>
  onChange: (f: Filters) => void
}) {
  const [expandedYear, setExpandedYear] = useState<string | null>(filters.year || null)

  useEffect(() => {
    if (filters.year && expandedYear !== filters.year) setExpandedYear(filters.year)
  }, [filters.year, expandedYear])

  function selectYear(y: string) {
    if (filters.year === y) { onChange({ ...filters, year: '', month: '' }); setExpandedYear(null) }
    else { onChange({ ...filters, year: y, month: '' }); setExpandedYear(y) }
  }

  function selectMonth(m: number) {
    if (filters.month === String(m)) onChange({ ...filters, month: '' })
    else onChange({ ...filters, month: String(m) })
  }

  function toggleExpand(y: string) {
    setExpandedYear(expandedYear === y ? null : y)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
      {options.years.map(year => {
        const isSelected = filters.year === year
        const isExpanded = expandedYear === year
        const months = options.monthsByYear[year] ?? []

        return (
          <div key={year} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
              <button
                onClick={() => toggleExpand(year)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 20, height: 28, border: 'none', background: 'transparent',
                  cursor: 'pointer', color: 'var(--faint)', fontSize: 9,
                  transition: 'transform 0.15s',
                  transform: isExpanded ? 'rotate(90deg)' : 'none',
                }}
              >▶</button>
              <button
                onClick={() => selectYear(year)}
                style={{
                  border: `1.5px solid ${isSelected ? 'var(--accent)' : 'var(--border-strong)'}`,
                  borderRadius: 8, padding: '4px 12px',
                  fontSize: 12, fontWeight: 700,
                  color: isSelected ? 'var(--accent-contrast)' : 'var(--text)',
                  background: isSelected ? 'var(--accent)' : 'var(--surface-2)',
                  cursor: 'pointer', transition: 'all 0.15s ease',
                  fontFamily: 'var(--font)',
                }}
              >{year}</button>
            </div>

            {isExpanded && months.length > 0 && (
              <div style={{
                display: 'flex', gap: 4, flexWrap: 'wrap',
                marginLeft: 22, paddingLeft: 8,
                borderLeft: '2px solid var(--border)',
              }}>
                {months.map(m => {
                  const mSelected = isSelected && filters.month === String(m)
                  return (
                    <button
                      key={m}
                      onClick={() => {
                        if (!isSelected) onChange({ ...filters, year, month: String(m) })
                        else selectMonth(m)
                      }}
                      style={{
                        border: `1.5px solid ${mSelected ? 'var(--accent)' : 'transparent'}`,
                        borderRadius: 6, padding: '3px 10px',
                        fontSize: 11, fontWeight: 600,
                        color: mSelected ? 'var(--accent-contrast)' : 'var(--muted)',
                        background: mSelected ? 'var(--accent)' : 'var(--surface-3)',
                        cursor: 'pointer', transition: 'all 0.15s ease',
                        fontFamily: 'var(--font)',
                      }}
                    >{MONTH_SHORT[m]}</button>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Filter bar ────────────────────────────────────────────────────────────────

function FilterBar({ filters, options, onChange, onClear }: {
  filters: Filters
  options: ReturnType<typeof getFilterOptions>
  onChange: (f: Filters) => void
  onClear: () => void
}) {
  const hasAny = filters.year || filters.month || filters.evaluator || filters.duration

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <CustomDropdown
          label="Evaluators"
          value={filters.evaluator}
          options={options.evaluators.map(e => ({ value: e, label: e }))}
          onChange={v => onChange({ ...filters, evaluator: v })}
        />
        <CustomDropdown
          label="Durations"
          value={filters.duration}
          options={options.durations.map(d => ({ value: d, label: d }))}
          onChange={v => onChange({ ...filters, duration: v })}
        />
        {hasAny && (
          <button className="btn btn-sm" onClick={onClear}
            style={{ color: 'var(--bad)', borderColor: 'var(--bad-weak)' }}>
            ✕ Clear all
          </button>
        )}
      </div>

      {options.years.length > 0 && (
        <TimeFilter filters={filters} options={options} onChange={onChange} />
      )}
    </div>
  )
}

// ── Blocking Toggle ──────────────────────────────────────────────────────────

function BlockingToggle() {
  const [blocking, setBlocking] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/sheets/routing', { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setBlocking(data.blocking)
      }
    } catch { /* silent */ }
  }, [])

  useEffect(() => { fetchStatus() }, [fetchStatus])

  async function toggle() {
    if (blocking === null) return
    const newVal = blocking === 'yes' ? 'no' : 'yes'
    setSaving(true)
    try {
      const res = await fetch('/api/sheets/routing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocking: newVal }),
      })
      if (res.ok) setBlocking(newVal)
    } catch { /* silent */ }
    setSaving(false)
  }

  if (blocking === null) {
    return <span style={{ fontSize: 12, color: 'var(--faint)' }}>Loading...</span>
  }

  const isBlocked = blocking === 'yes'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>Auto-upload to YouTube</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: isBlocked ? 'var(--bad)' : 'var(--good)' }}>
        {isBlocked ? 'Blocked' : 'Active'}
      </span>
      <button
        onClick={toggle}
        disabled={saving}
        title={isBlocked ? 'Blocked — click to activate' : 'Active — click to block'}
        style={{
          position: 'relative',
          width: 44, height: 24, borderRadius: 12, border: 'none',
          background: isBlocked ? 'var(--bad)' : 'var(--good)',
          cursor: saving ? 'not-allowed' : 'pointer',
          opacity: saving ? 0.6 : 1,
          transition: 'background 0.2s ease',
          flexShrink: 0,
        }}
      >
        <span style={{
          position: 'absolute', top: 3, left: isBlocked ? 3 : 23,
          width: 18, height: 18, borderRadius: '50%', background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          transition: 'left 0.2s ease',
        }} />
      </button>
    </div>
  )
}

// ── Colgroup ─────────────────────────────────────────────────────────────────

function ColGroup() {
  return (
    <colgroup>
      <col style={{ width: '10%' }} />
      <col style={{ width: '17%' }} />
      <col style={{ width: '10%' }} />
      <col style={{ width: '7%' }} />
      <col style={{ width: '14%' }} />
      <col style={{ width: '19%' }} />
      <col style={{ width: '17%' }} />
      <col style={{ width: '6%' }} />
    </colgroup>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

function YouTubeTab() {
  const [rows, setRows]       = useState<YtbRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [edits, setEdits]     = useState<Record<number, Partial<YtbRow>>>({})
  const [saving, setSaving]   = useState<Set<number>>(new Set())
  const [filters, setFilters] = useState<Filters>(getCurrentMonthFilters)
  const [openDays, setOpenDays] = useState<Set<string>>(new Set())
  const initialOpenDone = useRef(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/sheets/ytb-uploaded', { cache: 'no-store' })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Failed to load')
      }
      setRows(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const filterOptions = useMemo(() => getFilterOptions(rows), [rows])
  const filteredRows  = useMemo(() => applyFilters(rows, filters), [rows, filters])
  const dayGroups     = useMemo(() => groupByDay(filteredRows), [filteredRows])

  useEffect(() => {
    if (initialOpenDone.current || dayGroups.length === 0) return
    initialOpenDone.current = true
    const todayGroup = dayGroups.find(g => g.label === 'Today')
    if (todayGroup) setOpenDays(new Set([todayGroup.day]))
    else setOpenDays(new Set([dayGroups[0].day]))
  }, [dayGroups])

  function toggleDay(day: string) {
    setOpenDays(s => {
      const n = new Set(s)
      if (n.has(day)) { n.delete(day) } else { n.add(day) }
      return n
    })
  }

  function setEdit(rowIndex: number, field: keyof YtbRow, value: string) {
    setEdits(prev => ({ ...prev, [rowIndex]: { ...prev[rowIndex], [field]: value } }))
  }

  async function saveEdits(rowIndex: number) {
    const updates = edits[rowIndex]
    if (!updates || Object.keys(updates).length === 0) return
    setSaving(s => new Set(Array.from(s).concat([rowIndex])))
    try {
      const res = await fetch('/api/sheets/ytb-uploaded', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_index: rowIndex, updates }),
      })
      if (!res.ok) throw new Error()
      setRows(prev => prev.map(r => r.row_index === rowIndex ? { ...r, ...updates } : r))
      setEdits(prev => { const n = { ...prev }; delete n[rowIndex]; return n })
    } catch {
      setError('Failed to save.')
    } finally {
      setSaving(s => { const n = new Set(s); n.delete(rowIndex); return n })
    }
  }

  function cancelEdits(rowIndex: number) {
    setEdits(prev => { const n = { ...prev }; delete n[rowIndex]; return n })
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h-title">Videos</h1>
        <div className="head-actions">
          <BlockingToggle />
        </div>
      </div>

      <div className="card" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 140px)' }}>
        {/* Header */}
        <div className="card-head" style={{ flexShrink: 0 }}>
          <span className="card-label">Drive Videos</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="card-note">{filteredRows.length}/{rows.length} videos</span>
            <button className="btn btn-sm" onClick={refresh} disabled={loading}>
              <span className={loading ? 'spin' : ''}>↻</span>
              {loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* Filter bar */}
        {rows.length > 0 && (
          <div style={{
            background: 'var(--surface-2)', borderRadius: 10, padding: '10px 14px',
            marginBottom: 12, border: '1px solid var(--border)', flexShrink: 0,
          }}>
            <FilterBar
              filters={filters}
              options={filterOptions}
              onChange={setFilters}
              onClear={() => setFilters(EMPTY_FILTERS)}
            />
          </div>
        )}

        {error && <p className="msg-err" style={{ marginBottom: 6, flexShrink: 0 }}>{error}</p>}

        {/* Table header */}
        <div style={{ flexShrink: 0 }}>
          <table className="tbl" style={{ tableLayout: 'fixed' }}>
            <ColGroup />
            <thead>
              <tr>
                <th>Time</th>
                <th>Game Title</th>
                <th>Evaluator</th>
                <th>Duration</th>
                <th>Status</th>
                <th>File Name</th>
                <th>YouTube Link</th>
                <th></th>
              </tr>
            </thead>
          </table>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
          {filteredRows.length === 0 && !loading && (
            <p className="empty">
              {rows.length === 0 ? 'No data — click Refresh to load' : 'No rows match the selected filters'}
            </p>
          )}
          {loading && (
            <table className="tbl" style={{ tableLayout: 'fixed' }}>
              <ColGroup />
              <tbody><SkeletonRows cols={8} rows={4} /></tbody>
            </table>
          )}
          {!loading && dayGroups.map((group, gi) => {
            const isOpen  = openDays.has(group.day)
            const isToday = group.label === 'Today'
            return (
              <div key={group.day}>
                {gi > 0 && <div style={{ height: 4, background: 'var(--border)' }} />}

                {/* Day header */}
                <button
                  onClick={() => toggleDay(group.day)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                    background: isToday ? 'var(--accent-weak)' : 'var(--surface-2)',
                    padding: '7px 12px', border: 'none',
                    borderBottom: `1px solid ${isToday ? 'var(--accent-border)' : 'var(--border)'}`,
                    cursor: 'pointer', textAlign: 'left',
                  }}
                >
                  <span style={{ fontSize: 9, color: isToday ? 'var(--accent)' : 'var(--faint)' }}>
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <span style={{ fontWeight: 700, color: isToday ? 'var(--accent-strong)' : 'var(--text)', fontSize: 12 }}>
                    {group.label}
                  </span>
                  {isToday && (
                    <span className="badge running" style={{ fontSize: 9, padding: '1px 6px' }}>live</span>
                  )}
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--faint)', fontWeight: 600 }}>
                    {group.rows.length} video{group.rows.length !== 1 ? 's' : ''}
                  </span>
                </button>

                {/* Day rows */}
                {isOpen && (
                  <table className="tbl" style={{ tableLayout: 'fixed' }}>
                    <ColGroup />
                    <tbody>
                      {group.rows.map(row => {
                        const pending   = edits[row.row_index] ?? {}
                        const isDirty   = Object.keys(pending).length > 0
                        const isSaving  = saving.has(row.row_index)
                        const youtubeId = pending.youtubeId ?? row.youtubeId
                        const ytUrl     = youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : null

                        return (
                          <tr key={row.row_index} style={{ background: isDirty ? 'var(--accent-weak)' : 'transparent' }}>
                            <td style={{ color: 'var(--faint)' }}>
                              {row.time ? new Date(row.time).toLocaleTimeString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' }) : '—'}
                            </td>
                            <td>{row.gameTitle || '—'}</td>
                            <td>{row.pic || '—'}</td>
                            <td style={{ color: 'var(--muted)' }}>{row.duration || '—'}</td>
                            <td><StatusBadge status={row.status} /></td>
                            <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.fileName || '—'}</td>
                            <td>
                              {isDirty ? (
                                <input
                                  value={youtubeId}
                                  onChange={e => setEdit(row.row_index, 'youtubeId', e.target.value)}
                                  placeholder="YouTube ID"
                                  autoFocus
                                  className="input"
                                  style={{ padding: '3px 7px', fontSize: 12, fontFamily: 'var(--num)', width: 160 }}
                                />
                              ) : (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  {ytUrl ? (
                                    <a href={ytUrl} target="_blank" rel="noreferrer"
                                      style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 12, textDecoration: 'underline', whiteSpace: 'nowrap' }}>
                                      youtu.be/{youtubeId}
                                    </a>
                                  ) : (
                                    <span style={{ color: 'var(--faint)', fontStyle: 'italic', fontSize: 12 }}>
                                      not synced yet
                                    </span>
                                  )}
                                  <button
                                    onClick={() => setEdit(row.row_index, 'youtubeId', youtubeId)}
                                    title="Edit YouTube ID"
                                    style={{
                                      background: 'none', border: 'none', cursor: 'pointer',
                                      color: 'var(--faint)', fontSize: 13, lineHeight: 1,
                                      padding: '1px 3px', borderRadius: 4, flexShrink: 0,
                                    }}
                                    onMouseEnter={e => (e.currentTarget.style.color = 'var(--text)')}
                                    onMouseLeave={e => (e.currentTarget.style.color = 'var(--faint)')}
                                  >✎</button>
                                </div>
                              )}
                            </td>
                            <td style={{ width: 90 }}>
                              {isDirty && (
                                <div style={{ display: 'flex', gap: 4 }}>
                                  <button className="btn btn-sm btn-primary"
                                    onClick={() => saveEdits(row.row_index)} disabled={isSaving}>
                                    {isSaving ? '...' : 'Save'}
                                  </button>
                                  <button className="btn btn-sm"
                                    onClick={() => cancelEdits(row.row_index)} disabled={isSaving}>✕</button>
                                </div>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Short List types ─────────────────────────────────────────────────────────

interface ShortListItem {
  id: number
  game_id: string
  title: string
  icon_url: string | null
  os: string
  initial_evaluator: string | null
  final_evaluator: string | null
  initial_note: string | null
  initial_conclusion: string | null
  drive_link: string | null
  record_5min_assignee: string | null
  record_5min_drive: string | null
  record_20min_assignee: string | null
  record_20min_drive: string | null
  genre_1: string | null
  genre_2: string | null
  publisher_name: string | null
  category_group: string
  app_link: string | null
}

const SL_CONCLUSION_COLORS: Record<string, string> = {
  'Bypass': 'error', 'M_ByPass': 'error', 'Skip': 'error', 'Link_dead': 'error',
  'Good': 'success', 'Conclusion': 'success',
  'List_Idea': 'success', 'Priority I': 'success', 'Priority II': 'success',
  'Priority III: Watchlist for next phase': 'running',
  'Priority IV: Idea': 'running', 'Watchlist for next milestone': 'running',
  'Need deeper testing': 'running', 'Wait for PlayTest': 'running',
  'Check Market Data': 'running', 'Need Direction': 'running',
}

const CONCLUSION_OPTIONS = [
  'Bypass', 'Conclusion', 'Good', 'Link_dead', 'M_ByPass', 'Need deeper testing', 'Skip',
  'Wait for PlayTest', 'Priority IV: Idea', 'Priority III: Watchlist for next phase',
  'Check Market Data', 'Watchlist for next milestone', 'Priority II', 'Priority I',
  'Need Direction', 'List_Idea',
]

function DriveBtnSmall({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener" onClick={e => e.stopPropagation()} className="drive-btn">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="23 7 16 12 23 17 23 7" />
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      </svg>
    </a>
  )
}

// ── Assign Record Modal ──────────────────────────────────────────────────────

function AssignRecordModal({ games, onClose, onSaved, mode = 'assign' }: {
  games: ShortListItem[]
  onClose: () => void
  onSaved: () => void
  mode?: 'assign' | 'review'
}) {
  const isReview = mode === 'review'
  const original = useMemo(() => {
    const m: Record<number, { r5: string; r20: string }> = {}
    for (const g of games) m[g.id] = {
      r5: isReview ? (g.record_5min_assignee || '') : '',
      r20: isReview ? (g.record_20min_assignee || '') : '',
    }
    return m
  }, [games, isReview])
  const [rows, setRows] = useState(games)
  const [assignments, setAssignments] = useState<Record<number, { r5: string; r20: string }>>(original)
  const [recorders, setRecorders] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch('/api/team/recorders').then(r => r.ok ? r.json() : []).then(setRecorders).catch(() => {})
  }, [])

  const filtered = useMemo(() => {
    if (!search.trim()) return rows
    const q = search.toLowerCase()
    return rows.filter(r => r.title.toLowerCase().includes(q))
  }, [rows, search])

  function setAssign(id: number, field: 'r5' | 'r20', value: string) {
    setAssignments(prev => ({
      ...prev,
      [id]: { ...prev[id] || { r5: '', r20: '' }, [field]: value },
    }))
  }

  function removeRow(id: number) {
    setRows(prev => prev.filter(r => r.id !== id))
    setAssignments(prev => { const n = { ...prev }; delete n[id]; return n })
  }

  function bulkAssign(field: 'r5' | 'r20', value: string) {
    setAssignments(prev => {
      const next = { ...prev }
      for (const game of filtered) {
        next[game.id] = { ...next[game.id] || { r5: '', r20: '' }, [field]: value }
      }
      return next
    })
  }

  // Rows whose selection differs from the original state (incl. clearing to '').
  const changed = useMemo(() => Object.entries(assignments).filter(([id, v]) => {
    const o = original[Number(id)] || { r5: '', r20: '' }
    return v.r5 !== o.r5 || v.r20 !== o.r20
  }), [assignments, original])

  async function save() {
    const batch = changed.map(([id, v]) => {
      const o = original[Number(id)] || { r5: '', r20: '' }
      const entry: Record<string, unknown> = { id: Number(id) }
      // Send only the durations that changed; empty selection clears the assignee.
      if (v.r5 !== o.r5) entry.record_5min_assignee = v.r5 || null
      if (v.r20 !== o.r20) entry.record_20min_assignee = v.r20 || null
      return entry
    })
    if (batch.length === 0) return
    setSaving(true)
    try {
      const res = await fetch('/api/evaluations/assign-records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments: batch }),
      })
      if (res.ok) { onSaved(); onClose() }
    } catch { /* ignore */ }
    setSaving(false)
  }

  const assignCount = changed.length
  const recOpts = [{ value: '', label: '—' }, ...recorders.map(r => ({ value: r, label: r }))]

  return (
    <div className="eval-modal-backdrop" onClick={onClose}>
      <div className="eval-modal-container" onClick={e => e.stopPropagation()}
        style={{ padding: '24px 28px 24px', maxWidth: 1100, width: '95vw' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{isReview ? 'Review Recorders' : 'Assign Recorders'}</h2>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 0' }}>
              {rows.length} {isReview ? 'assigned' : 'unassigned'} game{rows.length !== 1 ? 's' : ''}
              {assignCount > 0 && <> · <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{assignCount} changed</span></>}
            </p>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} style={{ fontSize: 18, padding: '2px 8px' }}>x</button>
        </div>

        {/* Toolbar */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 }}>
          <div className="search-wrap">
            <span className="search-icon-abs">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
              </svg>
            </span>
            <input className="search-input" placeholder="Filter games..." style={{ width: 180 }}
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          {recorders.length > 0 && (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
              <span style={{ fontWeight: 600 }}>Bulk assign all visible:</span>
              <div style={{ width: 120 }}>
                <StyledSelect value="" onChange={v => { if (v) bulkAssign('r5', v) }}
                  placeholder="5 min →" options={recOpts} style={{ fontSize: 11 }} />
              </div>
              <div style={{ width: 120 }}>
                <StyledSelect value="" onChange={v => { if (v) bulkAssign('r20', v) }}
                  placeholder="20 min →" options={recOpts} style={{ fontSize: 11 }} />
              </div>
            </div>
          )}
        </div>

        <div style={{ maxHeight: 'calc(80vh - 180px)', overflowY: 'auto' }}>
          {filtered.length === 0 ? (
            <p className="empty">{search ? 'No games match your search' : isReview ? 'No assigned games' : 'No unassigned games'}</p>
          ) : (
            <table className="tbl" style={{ fontSize: 12.5 }}>
              <thead style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface)', boxShadow: '0 1px 0 var(--border)' }}>
                <tr>
                  <th style={{ width: 36 }}>#</th>
                  <th>Game</th>
                  <th style={{ width: 60 }}>OS</th>
                  <th style={{ width: 180 }}>5 min Recorder</th>
                  <th style={{ width: 180 }}>20 min Recorder</th>
                  <th style={{ width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((game, idx) => {
                  const a = assignments[game.id] || { r5: '', r20: '' }
                  const hasAssign = a.r5 || a.r20
                  return (
                    <tr key={game.id} className="tbl-row-premium"
                      style={hasAssign ? { background: 'var(--accent-weak)' } : undefined}>
                      <td className="num" style={{ color: 'var(--faint)', fontSize: 11 }}>{idx + 1}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {game.icon_url ? (
                            <img src={game.icon_url} alt="" width={26} height={26} style={{ borderRadius: 6, flexShrink: 0 }} />
                          ) : (
                            <div style={{ width: 26, height: 26, borderRadius: 6, background: 'var(--surface-3)', flexShrink: 0 }} />
                          )}
                          <span className="cell-name" style={{ fontSize: 12.5 }}>{game.title}</span>
                        </div>
                      </td>
                      <td>
                        <span className="pill muted" style={{ fontSize: 9, padding: '1px 5px' }}>{game.os?.toUpperCase()}</span>
                      </td>
                      <td>
                        <StyledSelect value={a.r5} onChange={v => setAssign(game.id, 'r5', v)}
                          placeholder="—" options={recOpts} style={{ fontSize: 12 }} />
                      </td>
                      <td>
                        <StyledSelect value={a.r20} onChange={v => setAssign(game.id, 'r20', v)}
                          placeholder="—" options={recOpts} style={{ fontSize: 12 }} />
                      </td>
                      <td>
                        <button className="btn btn-sm btn-ghost" onClick={() => removeRow(game.id)}
                          style={{ color: 'var(--bad)', padding: '2px 6px', fontSize: 13 }}>x</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          <span style={{ fontSize: 11, color: 'var(--faint)' }}>
            {filtered.length} game{filtered.length !== 1 ? 's' : ''} shown
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm" onClick={onClose}>Cancel</button>
            <button className="btn btn-sm btn-primary" onClick={save}
              disabled={saving || assignCount === 0}>
              {saving ? 'Saving...' : `Save ${assignCount} assignment${assignCount !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Extract Chat Text Modal ──────────────────────────────────────────────────

function ExtractChatModal({ games, onClose }: {
  games: ShortListItem[]
  onClose: () => void
}) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set(games.map(g => g.id)))
  const [copied, setCopied] = useState(false)

  function toggle(id: number) {
    setSelected(s => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }
  const allSelected = selected.size === games.length
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(games.map(g => g.id)))
  }

  const message = useMemo(() => {
    const chosen = games.filter(g => selected.has(g.id))
    const sections: string[] = []
    const build = (label: string, pick: (g: ShortListItem) => string | null) => {
      const items = chosen.filter(g => pick(g))
      if (items.length === 0) return
      const lines = items.map((g, i) => {
        const head = `${i + 1}. ${g.title} - ${pick(g)}`
        return g.app_link ? `${head}\n${g.app_link}` : head
      })
      sections.push(`${label}\n${lines.join('\n')}`)
    }
    build("20'", g => g.record_20min_assignee)
    build("5'", g => g.record_5min_assignee)
    return sections.join('\n\n')
  }, [games, selected])

  async function copy() {
    try {
      await navigator.clipboard.writeText(message)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* ignore */ }
  }

  return (
    <div className="eval-modal-backdrop" onClick={onClose}>
      <div className="eval-modal-container" onClick={e => e.stopPropagation()}
        style={{ padding: '24px 28px 24px', maxWidth: 980, width: '92vw' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Extract Chat Text</h2>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 0' }}>
              {selected.size}/{games.length} game{games.length !== 1 ? 's' : ''} selected
            </p>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} style={{ fontSize: 18, padding: '2px 8px' }}>x</button>
        </div>

        {/* Two columns: selection list + preview */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
          {/* Selection list */}
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span className="card-label">Games</span>
              <button className="btn btn-sm btn-ghost" onClick={toggleAll} style={{ fontSize: 11 }}>
                {allSelected ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            <div style={{ maxHeight: 'calc(80vh - 220px)', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
              {games.length === 0 ? (
                <p className="empty">No assigned games</p>
              ) : games.map(g => {
                const checked = selected.has(g.id)
                return (
                  <label key={g.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                      borderBottom: '1px solid var(--border)', cursor: 'pointer',
                      background: checked ? 'var(--accent-weak)' : 'transparent',
                    }}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(g.id)} />
                    {g.icon_url ? (
                      <img src={g.icon_url} alt="" width={24} height={24} style={{ borderRadius: 6, flexShrink: 0 }} />
                    ) : (
                      <div style={{ width: 24, height: 24, borderRadius: 6, background: 'var(--surface-3)', flexShrink: 0 }} />
                    )}
                    <span className="cell-name" style={{ fontSize: 12.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.title}</span>
                    <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      {g.record_20min_assignee && <span className="pill tag" style={{ fontSize: 9, padding: '1px 5px' }}>20&apos; {g.record_20min_assignee}</span>}
                      {g.record_5min_assignee && <span className="pill muted" style={{ fontSize: 9, padding: '1px 5px' }}>5&apos; {g.record_5min_assignee}</span>}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>

          {/* Preview */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span className="card-label" style={{ marginBottom: 8 }}>Message preview</span>
            <textarea
              readOnly
              value={message}
              placeholder="Select at least one game..."
              style={{
                width: '100%', height: 'calc(80vh - 220px)', resize: 'none',
                fontFamily: 'var(--num, monospace)', fontSize: 12.5, lineHeight: 1.6,
                padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border)',
                background: 'var(--surface-2)', color: 'var(--text)', boxSizing: 'border-box',
              }}
            />
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
          <button className="btn btn-sm btn-primary" onClick={copy} disabled={!message}>
            {copied ? '✓ Copied!' : 'Copy message'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Skeleton Rows ────────────────────────────────────────────────────────────

function SkeletonRows({ cols, rows = 5 }: { cols: number; rows?: number }) {
  const widths = [30, 180, 120, 80, 100, 100]
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i}>
          {Array.from({ length: cols }).map((_, c) => (
            <td key={c}>
              <span className="skeleton" style={{ width: widths[c % widths.length] || 80, height: 14 }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

// ── Recording Status Cell ───────────────────────────────────────────────────

function RecordingCell({ assignee, drive }: { assignee: string | null; drive: string | null }) {
  if (!assignee) return <span className="rec-status none">—</span>
  if (drive) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span className="rec-status done">&#10003; {assignee}</span>
      <DriveBtnSmall href={drive} />
    </div>
  )
  return <span className="rec-status pending">&#9711; {assignee}</span>
}

// ── Short List Tab ───────────────────────────────────────────────────────────

function ShortListTab() {
  const { data: session } = useSession()
  const userName = session?.user?.name || ''
  const role = session?.user?.role

  const [data, setData] = useState<ShortListItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [availableMonths, setAvailableMonths] = useState<YearMonth[]>([])
  const [filterCategory, setFilterCategory] = useState('puzzle')
  const [filterConclusions, setFilterConclusions] = useState<string[]>(['List_Idea'])
  const [availableConclusions, setAvailableConclusions] = useState<string[]>(CONCLUSION_OPTIONS)
  const [filterAssignment, setFilterAssignment] = useState('')
  const [filterMonth, setFilterMonth] = useState<YearMonth | null>(null)
  // First load sends month=auto; server resolves current month or latest with data.
  const [autoMonth, setAutoMonth] = useState(true)
  const suppressFetchRef = useRef(false)
  const fetchSeqRef = useRef(0)
  const [showAssignModal, setShowAssignModal] = useState(false)
  const [showReviewModal, setShowReviewModal] = useState(false)
  const [showExtractModal, setShowExtractModal] = useState(false)
  const [detailGameId, setDetailGameId] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    const seq = ++fetchSeqRef.current
    setLoading(true)
    try {
      const params = new URLSearchParams({ category: filterCategory, limit: '500' })
      if (filterConclusions.length > 0) params.set('conclusions', filterConclusions.join(','))
      if (filterAssignment) params.set('assignment_status', filterAssignment)
      if (autoMonth) {
        params.set('month', 'auto')
      } else if (filterMonth) {
        params.set('year', String(filterMonth.year))
        params.set('month', String(filterMonth.month))
      }
      const res = await fetch(`/api/evaluations?${params}`)
      const json = await res.json()
      if (seq !== fetchSeqRef.current) return // stale response; a newer fetch owns the state
      setData(json.data || [])
      setTotal(json.total || 0)
      if (json.available_months) setAvailableMonths(json.available_months)
      if (autoMonth && json.applied_month !== undefined) {
        // Lock in the server-resolved month: the picker shows it and all
        // later fetches use explicit params instead of re-resolving auto.
        const ap = json.applied_month as YearMonth | null
        suppressFetchRef.current = true
        setAutoMonth(false)
        setFilterMonth(ap)
      }
      if (json.available_conclusions?.length) {
        // keep currently-selected values visible even if filtered out by scope
        const merged = Array.from(new Set([...json.available_conclusions, ...filterConclusions]))
        setAvailableConclusions(CONCLUSION_OPTIONS.filter(c => merged.includes(c)).concat(merged.filter(c => !CONCLUSION_OPTIONS.includes(c))))
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [filterCategory, filterConclusions, filterAssignment, filterMonth, autoMonth])

  useEffect(() => {
    if (suppressFetchRef.current) {
      suppressFetchRef.current = false
      return
    }
    fetchData()
  }, [fetchData])

  const unassigned = useMemo(() =>
    data.filter(d => !d.record_5min_assignee && !d.record_20min_assignee),
    [data]
  )

  const assigned = useMemo(() =>
    data.filter(d => d.record_5min_assignee || d.record_20min_assignee),
    [data]
  )

  const withDrive = useMemo(() =>
    data.filter(d => d.record_5min_drive || d.record_20min_drive),
    [data]
  )

  function clickStat(filter: string) {
    setFilterAssignment(prev => prev === filter ? '' : filter)
  }

  return (
    <div className="page" style={{ paddingBottom: 16, height: '100vh', boxSizing: 'border-box', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h1 className="h-title">Videos</h1>
          <p className="h-sub">{total} games · Short List · {filterCategory}</p>
        </div>
      </div>

      {/* Stats summary */}
      {!loading && data.length > 0 && (
        <div className="stats-row-compact">
          <div className={`stat-card-compact${filterAssignment === '' ? ' active-filter' : ''}`}
            onClick={() => clickStat('')}>
            <span className="scc-label">Total</span>
            <span className="scc-num">{data.length}</span>
            <span className="scc-sub">games loaded</span>
          </div>
          <div className={`stat-card-compact${filterAssignment === 'assigned' ? ' active-filter' : ''}`}
            onClick={() => clickStat('assigned')}>
            <span className="scc-label">Assigned</span>
            <span className="scc-num">{assigned.length}</span>
            <span className="scc-sub">{data.length > 0 ? Math.round(assigned.length / data.length * 100) : 0}% of total</span>
          </div>
          <div className={`stat-card-compact${filterAssignment === 'unassigned' ? ' active-filter' : ''}`}
            onClick={() => clickStat('unassigned')}
            style={unassigned.length > 0 ? { borderColor: 'var(--warn)', background: 'var(--warn-weak)' } : undefined}>
            <span className="scc-label">Unassigned</span>
            <span className="scc-num" style={unassigned.length > 0 ? { color: 'var(--warn)' } : undefined}>{unassigned.length}</span>
            <span className="scc-sub">need assignment</span>
          </div>
          <div className="stat-card-compact" style={{ cursor: 'default' }}>
            <span className="scc-label">With Drive</span>
            <span className="scc-num">{withDrive.length}</span>
            <span className="scc-sub">recordings uploaded</span>
          </div>
        </div>
      )}

      <div className="filter-row" style={{ position: 'relative', zIndex: 30 }}>
        <MonthPicker available={availableMonths} value={filterMonth}
          onChange={v => { setAutoMonth(false); setFilterMonth(v) }} />

        <div style={{ width: 140 }}>
          <StyledSelect
            value={filterCategory}
            onChange={setFilterCategory}
            placeholder="Category"
            options={[
              { value: 'puzzle', label: 'Puzzle' },
              { value: 'arcade', label: 'Arcade' },
              { value: 'simulation', label: 'Simulation' },
            ]}
          />
        </div>

        <div style={{ width: 200 }}>
          <MultiSelect
            value={filterConclusions}
            onChange={setFilterConclusions}
            placeholder="Conclusions"
            options={availableConclusions.map(c => ({ value: c, label: c }))}
          />
        </div>

        <div className="seg-wrapper">
          {[
            { value: '', label: 'All' },
            { value: 'unassigned', label: 'Unassigned' },
            { value: 'assigned', label: 'Assigned' },
          ].map(s => (
            <button key={s.value}
              className={`seg-btn-premium${filterAssignment === s.value ? ' active' : ''}`}
              onClick={() => setFilterAssignment(s.value)}>
              {s.label}
            </button>
          ))}
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="sync" style={{ fontSize: 12.5, fontWeight: 600 }}>
            {loading ? 'Loading...' : `${total} results`}
          </span>
          <button className="btn btn-sm" onClick={() => setShowReviewModal(true)} disabled={assigned.length === 0}>
            Review Assign
            {assigned.length > 0 && <span className="badge-count">{assigned.length}</span>}
          </button>
          <button className="btn btn-sm" onClick={() => setShowExtractModal(true)} disabled={assigned.length === 0}>
            Extract Chat
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => setShowAssignModal(true)}>
            Assign Record
            {unassigned.length > 0 && <span className="badge-count">{unassigned.length}</span>}
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="tbl-wrap" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <table className="tbl">
            <thead style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface)', boxShadow: '0 1px 0 var(--border)' }}>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th>Game</th>
                <th>Note</th>
                <th>Conclusion</th>
                <th style={{ width: 90 }}>Drive Demo</th>
                <th style={{ width: 140 }}>5 min</th>
                <th style={{ width: 140 }}>20 min</th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && !loading && (
                <tr><td colSpan={7} className="empty">No games found</td></tr>
              )}
              {loading && <SkeletonRows cols={7} />}
              {data.map((item, idx) => (
                <tr key={item.id} className="tbl-row-premium" style={{ cursor: 'pointer' }}
                  onClick={() => setDetailGameId(item.game_id)}>
                  <td className="num" style={{ color: 'var(--faint)', fontSize: 12 }}>{idx + 1}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 200 }}>
                      {item.icon_url ? (
                        <img src={item.icon_url} alt="" width={28} height={28} style={{ borderRadius: 6, flexShrink: 0 }} />
                      ) : (
                        <div style={{ width: 28, height: 28, borderRadius: 6, background: 'var(--surface-3)', flexShrink: 0 }} />
                      )}
                      <div style={{ minWidth: 0 }}>
                        <div className="cell-name" style={{ fontSize: 13, lineHeight: 1.3 }}>{item.title}</div>
                        <div style={{ display: 'flex', gap: 4, marginTop: 2, flexWrap: 'wrap', alignItems: 'center' }}>
                          <span className="pill muted" style={{ padding: '1px 5px', fontSize: 9 }}>{item.os?.toUpperCase()}</span>
                          {[item.genre_1, item.genre_2].filter(Boolean).map(g => (
                            <span key={g} className="pill tag" style={{ padding: '1px 5px', fontSize: 9 }}>{g}</span>
                          ))}
                          {item.initial_evaluator && (
                            <span style={{ fontSize: 10.5, color: 'var(--faint)', fontWeight: 600 }}>{item.initial_evaluator}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div title={item.initial_note || undefined}
                      style={{ fontSize: 12, color: item.initial_note ? 'var(--text)' : 'var(--faint)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: item.initial_note ? 'help' : undefined }}>
                      {item.initial_note || '—'}
                    </div>
                  </td>
                  <td>
                    {item.initial_conclusion
                      ? <span className={`badge ${SL_CONCLUSION_COLORS[item.initial_conclusion] || 'neutral'}`}>{item.initial_conclusion}</span>
                      : <span className="badge idle">Pending</span>}
                  </td>
                  <td>
                    {item.drive_link
                      ? <DriveBtnSmall href={item.drive_link} />
                      : <span style={{ fontSize: 12, color: 'var(--faint)' }}>—</span>}
                  </td>
                  <td>
                    <RecordingCell assignee={item.record_5min_assignee} drive={item.record_5min_drive} />
                  </td>
                  <td>
                    <RecordingCell assignee={item.record_20min_assignee} drive={item.record_20min_drive} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showAssignModal && (
        <AssignRecordModal
          games={unassigned}
          onClose={() => setShowAssignModal(false)}
          onSaved={fetchData}
        />
      )}

      {showReviewModal && (
        <AssignRecordModal
          games={assigned}
          mode="review"
          onClose={() => setShowReviewModal(false)}
          onSaved={fetchData}
        />
      )}

      {showExtractModal && (
        <ExtractChatModal
          games={assigned}
          onClose={() => setShowExtractModal(false)}
        />
      )}

      {detailGameId && (
        <div className="eval-modal-backdrop" onClick={() => setDetailGameId(null)}>
          <div className="eval-modal-container" onClick={e => e.stopPropagation()}
            style={{ padding: '20px 24px 24px' }}>
            <EvalDetailPanel
              initialGameId={detailGameId}
              gameList={data.map(d => ({ game_id: d.game_id, title: d.title }))}
              role={role}
              userName={userName}
              canAssignRecords
              onClose={() => setDetailGameId(null)}
              onNavigate={setDetailGameId}
              onSaved={fetchData}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Record Video Table ───────────────────────────────────────────────────────

function RecordTable({ label, items, loading, onClickGame }: {
  label: string
  items: { item: ShortListItem; assignee: string | null; drive: string | null }[]
  loading: boolean
  onClickGame: (gameId: string) => void
}) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
        <span className="card-label">{label}</span>
        <span style={{ fontSize: 11, color: 'var(--faint)', fontWeight: 600 }}>{items.length} game{items.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="tbl-wrap" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <table className="tbl">
          <thead style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface)', boxShadow: '0 1px 0 var(--border)' }}>
            <tr>
              <th style={{ width: 36 }}>#</th>
              <th>Game</th>
              <th>Category</th>
              <th style={{ width: 200 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !loading && (
              <tr><td colSpan={4} className="empty">No recordings</td></tr>
            )}
            {loading && <SkeletonRows cols={4} />}
            {items.map(({ item, assignee, drive }, idx) => (
              <tr key={item.id} className="tbl-row-premium" style={{ cursor: 'pointer' }}
                onClick={() => onClickGame(item.game_id)}>
                <td className="num" style={{ color: 'var(--faint)', fontSize: 12 }}>{idx + 1}</td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 160 }}>
                    {item.icon_url ? (
                      <img src={item.icon_url} alt="" width={28} height={28} style={{ borderRadius: 6, flexShrink: 0 }} />
                    ) : (
                      <div style={{ width: 28, height: 28, borderRadius: 6, background: 'var(--surface-3)', flexShrink: 0 }} />
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div className="cell-name" style={{ fontSize: 13, lineHeight: 1.3 }}>{item.title}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <span className="pill muted" style={{ fontSize: 10, padding: '1px 6px' }}>{item.category_group}</span>
                </td>
                <td>
                  <RecordingCell assignee={assignee} drive={drive} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Record Video Tab ─────────────────────────────────────────────────────────

function RecordVideoTab() {
  const { data: session } = useSession()
  const userName = session?.user?.name || ''
  const role = session?.user?.role

  const [data, setData] = useState<ShortListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [filterCategory, setFilterCategory] = useState('')
  const [filterType, setFilterType] = useState<'all' | '5min' | '20min'>('all')
  const [filterStatus, setFilterStatus] = useState<'' | 'pending' | 'done'>('')
  const [search, setSearch] = useState('')
  const [detailGameId, setDetailGameId] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const categories = filterCategory ? [filterCategory] : ['puzzle', 'arcade', 'simulation']
      const results = await Promise.all(
        categories.map(cat => {
          const params = new URLSearchParams({ category: cat, limit: '500', has_recording: 'true' })
          if (role !== 'admin' && role !== 'moderator' && userName) params.set('recorder', userName)
          return fetch(`/api/evaluations?${params}`).then(r => r.json())
        })
      )
      const all = results.flatMap(r => r.data || [])
      setData(all)
    } catch { /* ignore */ }
    setLoading(false)
  }, [filterCategory, userName, role])

  useEffect(() => { fetchData() }, [fetchData])

  const baseFiltered = useMemo(() => {
    let list = data
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(d => d.title.toLowerCase().includes(q))
    }
    return list
  }, [data, search])

  const stats = useMemo(() => {
    let r5 = 0, r20 = 0, done5 = 0, done20 = 0
    for (const d of data) {
      if (d.record_5min_assignee) { r5++; if (d.record_5min_drive) done5++ }
      if (d.record_20min_assignee) { r20++; if (d.record_20min_drive) done20++ }
    }
    return { total: data.length, r5, r20, done5, done20, done: done5 + done20, pending: (r5 - done5) + (r20 - done20) }
  }, [data])

  const list5 = useMemo(() => {
    return baseFiltered
      .filter(d => d.record_5min_assignee)
      .filter(d => {
        if (filterStatus === 'done') return !!d.record_5min_drive
        if (filterStatus === 'pending') return !d.record_5min_drive
        return true
      })
      .map(item => ({ item, assignee: item.record_5min_assignee, drive: item.record_5min_drive }))
  }, [baseFiltered, filterStatus])

  const list20 = useMemo(() => {
    return baseFiltered
      .filter(d => d.record_20min_assignee)
      .filter(d => {
        if (filterStatus === 'done') return !!d.record_20min_drive
        if (filterStatus === 'pending') return !d.record_20min_drive
        return true
      })
      .map(item => ({ item, assignee: item.record_20min_assignee, drive: item.record_20min_drive }))
  }, [baseFiltered, filterStatus])

  const show5 = filterType === 'all' || filterType === '5min'
  const show20 = filterType === 'all' || filterType === '20min'
  const totalShown = (show5 ? list5.length : 0) + (show20 ? list20.length : 0)

  return (
    <div className="page" style={{ paddingBottom: 16, height: '100vh', boxSizing: 'border-box', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h1 className="h-title">Videos</h1>
          <p className="h-sub">{data.length} games · Record Video{role !== 'admin' && role !== 'moderator' && userName ? ` · ${userName}` : ''}</p>
        </div>
      </div>

      {/* User context banner */}
      {!loading && data.length > 0 && (
        <div className="user-context-banner">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
              {role !== 'admin' && role !== 'moderator' && userName
                ? <>Hi {userName.split(' ')[0]}! You have <strong>{stats.pending}</strong> recording{stats.pending !== 1 ? 's' : ''} to submit.</>
                : <>{stats.total} games with recording assignments</>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 20 }}>
            <div className="banner-stat">
              <div className="banner-stat-num" style={{ color: 'var(--text)' }}>{stats.r5}</div>
              <div className="banner-stat-label">5 min</div>
            </div>
            <div className="banner-stat">
              <div className="banner-stat-num" style={{ color: 'var(--text)' }}>{stats.r20}</div>
              <div className="banner-stat-label">20 min</div>
            </div>
            <div className="banner-stat">
              <div className="banner-stat-num" style={{ color: 'var(--good)' }}>{stats.done}</div>
              <div className="banner-stat-label">Done</div>
            </div>
            <div className="banner-stat">
              <div className="banner-stat-num" style={{ color: stats.pending > 0 ? 'var(--warn)' : 'var(--faint)' }}>{stats.pending}</div>
              <div className="banner-stat-label">Pending</div>
            </div>
          </div>
        </div>
      )}

      <div className="filter-row" style={{ position: 'relative', zIndex: 30 }}>
        <div className="search-wrap">
          <span className="search-icon-abs">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
          </span>
          <input className="search-input" placeholder="Search games..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div style={{ width: 160 }}>
          <StyledSelect
            value={filterCategory}
            onChange={setFilterCategory}
            placeholder="All categories"
            options={[
              { value: '', label: 'All categories' },
              { value: 'puzzle', label: 'Puzzle' },
              { value: 'arcade', label: 'Arcade' },
              { value: 'simulation', label: 'Simulation' },
            ]}
          />
        </div>

        <div className="seg-wrapper">
          {([
            { value: 'all', label: 'All' },
            { value: '5min', label: '5 min' },
            { value: '20min', label: '20 min' },
          ] as const).map(s => (
            <button key={s.value}
              className={`seg-btn-premium${filterType === s.value ? ' active' : ''}`}
              onClick={() => setFilterType(s.value)}>
              {s.label}
            </button>
          ))}
        </div>

        <div className="seg-wrapper">
          {([
            { value: '', label: 'All' },
            { value: 'pending', label: 'Pending' },
            { value: 'done', label: 'Done' },
          ] as const).map(s => (
            <button key={s.value}
              className={`seg-btn-premium${filterStatus === s.value ? ' active' : ''}`}
              onClick={() => setFilterStatus(s.value)}>
              {s.label}
            </button>
          ))}
        </div>

        <span className="sync" style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600 }}>
          {loading ? 'Loading...' : `${totalShown} results`}
        </span>
      </div>

      {/* Split tables */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 16, overflow: 'hidden' }}>
        {show5 && <RecordTable label="5 MIN" items={list5} loading={loading} onClickGame={setDetailGameId} />}
        {show20 && <RecordTable label="20 MIN" items={list20} loading={loading} onClickGame={setDetailGameId} />}
      </div>

      {detailGameId && (
        <div className="eval-modal-backdrop" onClick={() => setDetailGameId(null)}>
          <div className="eval-modal-container" onClick={e => e.stopPropagation()}
            style={{ padding: '20px 24px 24px' }}>
            <EvalDetailPanel
              initialGameId={detailGameId}
              gameList={data.map(d => ({ game_id: d.game_id, title: d.title }))}
              role={role}
              userName={userName}
              readOnly
              onClose={() => setDetailGameId(null)}
              onNavigate={setDetailGameId}
              onSaved={() => {}}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Page Router ──────────────────────────────────────────────────────────────

// useSearchParams requires a Suspense boundary for static prerendering.
export default function VideosPage() {
  return (
    <React.Suspense>
      <VideosPageInner />
    </React.Suspense>
  )
}

function VideosPageInner() {
  const searchParams = useSearchParams()
  const tab = searchParams.get('tab') || 'youtube'

  if (tab === 'short_list') return <ShortListTab />
  if (tab === 'record_video') return <RecordVideoTab />
  return <YouTubeTab />
}
