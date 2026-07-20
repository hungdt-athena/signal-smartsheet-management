'use client'
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { StyledSelect } from '@/components/StyledSelect'
import { buildYtMap, ytLookup, type YtMatch } from '@/lib/ytb-match'
import { prettyConclusion } from '@/lib/buckets'
import { LockIcon, UserIcon } from '@/components/icons'
import EvalDetailPanel from '@/components/EvalDetailPanel'
import { weekLabelOrder } from '@/lib/weekly-feedback'

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
  final_conclusion: string | null
  drive_link: string | null
  record_confirmed_at: string | null
  record_5min_assignee: string | null
  record_5min_drive: string | null
  record_20min_assignee: string | null
  record_20min_drive: string | null
  record_bucket: string | null
  genre_1: string | null
  genre_2: string | null
  publisher_name: string | null
  category_group: string
  batch: string | null
  app_link: string | null
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

// ── Record status helpers ────────────────────────────────────────────────────

type RecordStatus = 'pending' | 'draft' | 'recording' | 'recorded'

// normalizeTitle, buildYtMap, ytLookup live in '@/lib/ytb-match' (shared with
// the detail panel) so the grid and panel match titles identically.

// Effective bucket: a manual record_bucket override ('5min'/'20min') wins,
// otherwise fall back to deriving it from final_conclusion.
function effectiveBucket(item: ShortListItem): '5min' | '20min' {
  return item.record_bucket === '5min' || item.record_bucket === '20min'
    ? item.record_bucket
    : (item.final_conclusion === 'Priority IV' ? '20min' : '5min')
}

// The recorder currently assigned to a game (the assignee of its bucket).
function recorderOf(item: ShortListItem): string {
  return (effectiveBucket(item) === '20min' ? item.record_20min_assignee : item.record_5min_assignee) || ''
}

function osLabel(os: string | null): string {
  const o = (os || '').toLowerCase()
  if (o === 'ios') return 'iOS'
  if (o === 'android') return 'Android'
  return os ? os.toUpperCase() : '—'
}

// Badge colors for the few final conclusions surfaced here; others fall back.
const FINAL_CONC_STYLES: Record<string, { bg: string; color: string }> = {
  'Priority IV': { bg: '#0f766e', color: '#ffffff' },
  'Insight':     { bg: '#15803d', color: '#ffffff' },
  'Priority V':  { bg: '#ede9fe', color: '#6d28d9' },
  'Bypass':      { bg: '#d23b3b', color: '#ffffff' },
  'Theme/Art':   { bg: '#dbeafe', color: '#2563eb' },
  'Watch List':  { bg: '#dcfce7', color: '#16a34a' },
  'Not Found':   { bg: '#374151', color: '#e5e7eb' },
}

function recordStatus(item: ShortListItem, ytMap: Map<string, YtMatch>): { status: RecordStatus; youtubeId?: string } {
  const bucket = effectiveBucket(item)
  const assignee = bucket === '20min' ? item.record_20min_assignee : item.record_5min_assignee
  const yt = ytLookup(ytMap, item.title, bucket)
  if (yt) return { status: 'recorded', youtubeId: yt.id }
  if (!assignee) return { status: 'pending' }
  if (item.record_confirmed_at) return { status: 'recording' }
  return { status: 'draft' }
}

// Maps to globals.css badge classes. No blue badge class exists, so `recording`
// gets an inline blue override; `running` is the project's amber badge → draft.
const RECORD_STATUS_STYLES: Record<RecordStatus, { cls: string; label: string; style?: React.CSSProperties }> = {
  pending:   { cls: 'idle',    label: 'Pending' },
  draft:     { cls: 'running', label: 'Draft' },
  recording: { cls: 'neutral', label: 'Recording', style: { background: 'var(--accent-weak)', color: 'var(--accent-strong)' } },
  recorded:  { cls: 'success', label: 'Recorded' },
}

function RecordStatusBadge({ status, youtubeId }: { status: RecordStatus; youtubeId?: string }) {
  const s = RECORD_STATUS_STYLES[status]
  if (status === 'recorded' && youtubeId) {
    return (
      <a
        href={`https://www.youtube.com/watch?v=${youtubeId}`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={e => e.stopPropagation()}
        title="Open on YouTube"
        className={`badge ${s.cls} yt-link`}
        style={{ textDecoration: 'none', cursor: 'pointer', ...s.style }}
      >
        ▶ {s.label}
      </a>
    )
  }
  return <span className={`badge ${s.cls}`} style={s.style}>{s.label}</span>
}

// ── Record Table ─────────────────────────────────────────────────────────────

function RecordTable({
  label, items, loading, isManager, recorders, onAssign, onReset, ytMap, onClickGame,
  dragOver, onHeaderAdd, onRowDragStart, confirmRemoveId,
  onRemoveRequest, onConfirmRemove, onCancelRemove,
}: {
  label: string
  items: ShortListItem[]
  loading: boolean
  isManager: boolean
  recorders: string[]
  onAssign: (item: ShortListItem, name: string) => void
  onReset: (id: number) => void
  ytMap: Map<string, YtMatch>
  onClickGame: (gameId: string) => void
  dragOver: boolean
  onHeaderAdd?: () => void
  onRowDragStart?: (e: React.DragEvent, item: ShortListItem) => void
  confirmRemoveId: number | null
  onRemoveRequest?: (id: number) => void
  onConfirmRemove?: (id: number) => void
  onCancelRemove?: () => void
}) {
  const recOpts = [{ value: '', label: '—' }, ...recorders.map(r => ({ value: r, label: r }))]
  const cols = isManager ? 5 : 4
  return (
    <div className="card"
      style={{
        padding: 0, overflow: 'hidden', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
        border: dragOver ? '2px solid var(--accent-strong)' : undefined,
        background: dragOver ? 'var(--accent-weak)' : undefined,
        transition: 'background .1s, border-color .1s',
      }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
        <span className="card-label">{label}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--faint)', fontWeight: 600 }}>{items.length} game{items.length !== 1 ? 's' : ''}</span>
          {isManager && onHeaderAdd && (
            <button className="btn btn-sm btn-ghost" onClick={onHeaderAdd}
              style={{ fontSize: 11, padding: '2px 8px' }}>+ Add</button>
          )}
        </div>
      </div>
      <div className="tbl-wrap" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <table className="tbl">
          <thead style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface)', boxShadow: '0 1px 0 var(--border)' }}>
            <tr>
              <th style={{ width: 36 }}>#</th>
              <th>Game</th>
              <th style={{ width: 160 }}>Recorder</th>
              <th style={{ width: 130 }}>Status</th>
              {isManager && <th style={{ width: 36 }}></th>}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !loading && (
              <tr><td colSpan={cols} className="empty">No games</td></tr>
            )}
            {loading && <SkeletonRows cols={cols} />}
            {items.map((item, idx) => {
              const eb = effectiveBucket(item)
              const assignee = eb === '20min' ? item.record_20min_assignee : item.record_5min_assignee
              const { status, youtubeId } = recordStatus(item, ytMap)
              // Once confirmed (recording) — or already recorded — the recorder
              // is locked; no reassigning.
              const assignLocked = status === 'recording' || status === 'recorded'
              const confirming = confirmRemoveId === item.id
              return (
                <tr key={item.id} className="tbl-row-premium"
                  style={{ cursor: isManager ? 'grab' : 'pointer' }}
                  draggable={isManager}
                  onDragStart={isManager && onRowDragStart ? e => onRowDragStart(e, item) : undefined}
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
                        {/* Row 1: title */}
                        <div className="cell-name" style={{ fontSize: 13, lineHeight: 1.3 }}>{item.title}</div>
                        {/* Row 2: evaluator · initial conclusion · final conclusion */}
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 3 }}>
                          {item.initial_evaluator && (
                            <span style={{ fontSize: 10.5, color: 'var(--faint)', fontWeight: 600 }}>{item.initial_evaluator}</span>
                          )}
                          {item.initial_conclusion && (
                            <span className="pill muted" style={{ fontSize: 9, padding: '1px 5px' }}>{prettyConclusion(item.initial_conclusion)}</span>
                          )}
                          {item.final_conclusion && (() => {
                            const fc = FINAL_CONC_STYLES[item.final_conclusion] || { bg: 'var(--surface-3)', color: 'var(--muted)' }
                            return (
                              <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: fc.bg, color: fc.color, whiteSpace: 'nowrap' }}>
                                {item.final_conclusion}
                              </span>
                            )
                          })()}
                        </div>
                        {/* Row 3: platform */}
                        <div style={{ marginTop: 3 }}>
                          <span className="pill muted" style={{ fontSize: 9, padding: '1px 5px' }}>{osLabel(item.os)}</span>
                        </div>
                      </div>
                    </div>
                  </td>
                  {confirming ? (
                    <td colSpan={isManager ? 3 : 2} onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Remove from list? (clears recorder)</span>
                        <button className="btn btn-sm btn-danger" onClick={() => onConfirmRemove && onConfirmRemove(item.id)}
                          style={{ fontSize: 11, padding: '2px 10px' }}>Remove</button>
                        <button className="btn btn-sm btn-ghost" onClick={() => onCancelRemove && onCancelRemove()}
                          style={{ fontSize: 11, padding: '2px 8px' }}>Cancel</button>
                      </div>
                    </td>
                  ) : (
                    <>
                      <td onClick={isManager && !assignLocked ? e => e.stopPropagation() : undefined}>
                        {isManager && !assignLocked ? (
                          <StyledSelect
                            value={assignee || ''}
                            onChange={v => onAssign(item, v)}
                            placeholder="—"
                            options={recOpts}
                            style={{ fontSize: 12 }}
                          />
                        ) : (
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 12.5, color: assignee ? 'var(--text)' : 'var(--faint)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              {assignLocked && <LockIcon />}{assignee || '—'}
                            </span>
                            {/* Recording (confirmed, not yet recorded): allow un-confirm → reassign. */}
                            {isManager && status === 'recording' && (
                              <button className="btn btn-sm btn-ghost" title="Reset — un-confirm to reassign"
                                onClick={e => { e.stopPropagation(); onReset(item.id) }}
                                style={{ fontSize: 11, padding: '1px 7px', color: 'var(--muted)', lineHeight: 1.4 }}>↺ Reset</button>
                            )}
                          </div>
                        )}
                      </td>
                      <td>
                        <RecordStatusBadge status={status} youtubeId={youtubeId} />
                      </td>
                      {isManager && (
                        <td onClick={e => e.stopPropagation()} style={{ textAlign: 'center' }}>
                          {status === 'recorded' ? (
                            <span title="Recorded — cannot remove" style={{ color: 'var(--faint)', display: 'inline-flex' }}><LockIcon /></span>
                          ) : (
                            <button className="btn btn-sm btn-ghost" title="Remove from list"
                              onClick={() => onRemoveRequest && onRemoveRequest(item.id)}
                              style={{ fontSize: 14, padding: '0 6px', color: 'var(--faint)', lineHeight: 1 }}>×</button>
                          )}
                        </td>
                      )}
                    </>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Add Game Modal ───────────────────────────────────────────────────────────

interface CatalogGame {
  game_id: string
  title: string
  app_link: string | null
  icon_url: string | null
}

function AddGameModal({ category, batch, excludeGameIds, targetBucket, onAdded, onClose }: {
  category: string
  batch: string
  excludeGameIds: Set<string>
  targetBucket: '5min' | '20min'
  onAdded: () => void
  onClose: () => void
}) {
  const [batchGames, setBatchGames] = useState<CatalogGame[]>([])
  const [batchLoading, setBatchLoading] = useState(true)
  const [results, setResults] = useState<CatalogGame[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState<string | null>(null)

  // Default (empty query): the games in the selected batch/category — the common
  // case is pulling one of those into a bucket without having to type.
  useEffect(() => {
    const params = new URLSearchParams({ category, limit: '500' })
    if (batch) params.set('batch', batch)
    fetch(`/api/evaluations?${params}`)
      .then(r => r.ok ? r.json() : { data: [] })
      .then(json => setBatchGames(((json.data || []) as ShortListItem[]).map(g => ({
        game_id: g.game_id, title: g.title, app_link: g.app_link, icon_url: g.icon_url,
      }))))
      .catch(() => {})
      .finally(() => setBatchLoading(false))
  }, [category, batch])

  // Whole-catalog search (game_info) — title substring, or exact resolve when a
  // store URL is pasted. Debounced; ≥2 chars keeps the large catalog snappy.
  useEffect(() => {
    const q = query.trim()
    const isLink = /^https?:\/\//i.test(q)
    if (!isLink && q.length < 2) {
      setResults([]); setLoading(false)
      return
    }
    setLoading(true)
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      const params = new URLSearchParams(isLink ? { link: q } : { q })
      fetch(`/api/games/search?${params}`, { signal: ctrl.signal })
        .then(r => r.ok ? r.json() : { results: [] })
        .then(json => setResults((json.results || []) as CatalogGame[]))
        .catch(() => { /* aborted or failed */ })
        .finally(() => setLoading(false))
    }, 250)
    return () => { clearTimeout(t); ctrl.abort() }
  }, [query])

  const searching = query.trim().length > 0
  const candidates = useMemo(
    () => (searching ? results : batchGames).filter(g => !excludeGameIds.has(g.game_id)),
    [searching, results, batchGames, excludeGameIds]
  )

  async function add(g: CatalogGame) {
    setAdding(g.game_id)
    try {
      const res = await fetch('/api/evaluations/add-to-record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game_id: g.game_id, category_group: category, bucket: targetBucket, batch }),
      })
      if (!res.ok) { setAdding(null); return }
    } catch { setAdding(null); return }
    onAdded()
    onClose()
  }

  return (
    <div className="eval-modal-backdrop" onClick={onClose}>
      <div className="eval-modal-container" onClick={e => e.stopPropagation()}
        style={{ padding: '22px 24px 22px', maxWidth: 520, width: '92vw' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div>
            <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Add game to {targetBucket === '20min' ? '20 MIN' : '5 MIN'}</h2>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 0' }}>
              {searching ? `Search all games · ${category}` : `${batch || 'all batches'} · ${category}`}
            </p>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} style={{ fontSize: 18, padding: '2px 8px' }}>x</button>
        </div>

        <input
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search by name or paste a store link…"
          style={{
            width: '100%', boxSizing: 'border-box', marginBottom: 12,
            padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border)',
            background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13,
          }}
        />

        <div style={{ maxHeight: 'calc(70vh - 180px)', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
          {(searching ? loading : batchLoading) ? (
            <p className="empty">{searching ? 'Searching…' : 'Loading…'}</p>
          ) : candidates.length === 0 ? (
            <p className="empty">{searching ? 'Không tìm thấy game trong DB' : 'No games in this batch'}</p>
          ) : candidates.map(g => (
            <button key={g.game_id}
              onClick={() => add(g)}
              disabled={adding !== null}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                padding: '8px 12px', borderBottom: '1px solid var(--border)',
                background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
                color: 'var(--text)', opacity: adding !== null && adding !== g.game_id ? 0.5 : 1,
              }}>
              {g.icon_url ? (
                <img src={g.icon_url} alt="" width={24} height={24} style={{ borderRadius: 6, flexShrink: 0 }} />
              ) : (
                <div style={{ width: 24, height: 24, borderRadius: 6, background: 'var(--surface-3)', flexShrink: 0 }} />
              )}
              <span className="cell-name" style={{ fontSize: 12.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.title}</span>
              {adding === g.game_id && <span style={{ fontSize: 11, color: 'var(--faint)' }}>Adding…</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Record Tab ───────────────────────────────────────────────────────────────

function RecordTab() {
  const { data: session } = useSession()
  const userName = session?.user?.name || ''
  const role = session?.user?.role
  const isManager = role === 'admin' || role === 'moderator'

  const [data, setData] = useState<ShortListItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [filterCategory, setFilterCategory] = useState('puzzle')
  const [filterBatch, setFilterBatch] = useState('')
  const [currentBatch, setCurrentBatch] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<'' | RecordStatus>('')
  // Cluster games by recorder within each container (same person adjacent),
  // matching how Extract Chat groups them. Default on; toggle back to date order.
  const [groupByRecorder, setGroupByRecorder] = useState(true)
  const [recorders, setRecorders] = useState<string[]>([])
  const [ytMap, setYtMap] = useState<Map<string, YtMatch>>(new Map())
  const [detailGameId, setDetailGameId] = useState<string | null>(null)
  const [showExtract, setShowExtract] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  // Manual bucket override: drag/drop, add-game modal, inline remove-confirm.
  const [dragOverBucket, setDragOverBucket] = useState<'5min' | '20min' | null>(null)
  const [addBucket, setAddBucket] = useState<'5min' | '20min' | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<number | null>(null)
  const dragRef = useRef<{ id: number; from: '5min' | '20min' } | null>(null)
  const [availableBatches, setAvailableBatches] = useState<string[]>([])
  const [syncToast, setSyncToast] = useState<string | null>(null)

  const fetchSeqRef = useRef(0)
  // One recorder auto-sync per (category, batch) view — see the sync effect.
  const syncedKeyRef = useRef('')
  // Default the batch filter to the team's current batch once (later manual
  // "All batches" choices stick).
  const batchDefaultedRef = useRef(false)

  const fetchData = useCallback(async () => {
    const seq = ++fetchSeqRef.current
    setLoading(true)
    try {
      const params = new URLSearchParams({ category: filterCategory, limit: '500' })
      params.set('record_view', '1')
      if (filterBatch) params.set('batch', filterBatch)
      if (!isManager && userName) params.set('recorder', userName)
      const res = await fetch(`/api/evaluations?${params}`)
      const json = await res.json()
      if (seq !== fetchSeqRef.current) return
      setData(json.data || [])
      setTotal(json.total || 0)
      if (json.available_batches) setAvailableBatches(json.available_batches)
      if (json.current_batch !== undefined) {
        setCurrentBatch(json.current_batch)
        if (!batchDefaultedRef.current) {
          batchDefaultedRef.current = true
          // Pre-select the team's current batch, but fall back to the most recent
          // batch with games (server-resolved default_batch) when current is empty.
          const def = json.default_batch !== undefined ? json.default_batch : json.current_batch
          if (def) setFilterBatch(def)
        }
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [filterCategory, filterBatch, isManager, userName])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Recorder options + YouTube uploaded map fetched once on mount.
  useEffect(() => {
    fetch('/api/team/recorders').then(r => r.ok ? r.json() : []).then(setRecorders).catch(() => {})
    fetch('/api/sheets/ytb-uploaded', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : [])
      .then((rows: YtbRow[]) => setYtMap(buildYtMap(rows)))
      .catch(() => {})
  }, [])

  // Auto-sync recorders from YouTube once per (category, batch): a game recorded
  // by someone other than the assignee (they uploaded directly) has its DB
  // recorder silently corrected to match the uploader (sheet `pic`). Managers
  // only — evaluators can't write and see only their own rows.
  useEffect(() => {
    if (!isManager) return
    const key = `${filterCategory}|${filterBatch}`
    if (syncedKeyRef.current === key) return
    syncedKeyRef.current = key
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/evaluations/reconcile-recorders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'apply', category: filterCategory, batch: filterBatch || undefined }),
        })
        if (!res.ok || cancelled) return
        const json = await res.json()
        if (cancelled || (!json.applied && !json.links_applied)) return
        const parts = []
        if (json.applied) parts.push(`${json.applied} recorder`)
        if (json.links_applied) parts.push(`${json.links_applied} link YouTube`)
        setSyncToast(`Đã đồng bộ ${parts.join(' + ')} từ YouTube`)
        if (json.applied) fetchData()
        setTimeout(() => { if (!cancelled) setSyncToast(null) }, 6000)
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [isManager, filterCategory, filterBatch, fetchData])

  // Optimistically assign a recorder to a game's bucket and drop it to draft.
  const assignRecorder = useCallback(async (item: ShortListItem, name: string) => {
    const bucket = effectiveBucket(item)
    const field = bucket === '20min' ? 'record_20min_assignee' : 'record_5min_assignee'
    setData(prev => prev.map(d => d.id === item.id
      ? { ...d, [field]: name || null, record_confirmed_at: null }
      : d))
    try {
      await fetch('/api/evaluations/assign-records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments: [{ id: item.id, [field]: name || null }] }),
      })
    } catch { /* ignore — optimistic state already applied */ }
  }, [])

  // Move a game to another bucket. Optimistic: set record_bucket and carry the
  // current effective recorder into the target duration column, clear the other.
  const moveBucket = useCallback(async (id: number, bucket: '5min' | '20min') => {
    setData(prev => prev.map(d => {
      if (d.id !== id) return d
      const cur = effectiveBucket(d)
      const oldAssignee = cur === '20min' ? d.record_20min_assignee : d.record_5min_assignee
      return {
        ...d,
        record_bucket: bucket,
        record_5min_assignee: bucket === '5min' ? oldAssignee : null,
        record_20min_assignee: bucket === '20min' ? oldAssignee : null,
      }
    }))
    try {
      const res = await fetch('/api/evaluations/record-bucket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, bucket }),
      })
      if (!res.ok) await fetchData()
    } catch { await fetchData() }
  }, [fetchData])

  // Remove a game from the record list ('none'). Optimistic: drop the row.
  const removeGame = useCallback(async (id: number) => {
    setConfirmRemoveId(null)
    setData(prev => prev.filter(d => d.id !== id))
    try {
      const res = await fetch('/api/evaluations/record-bucket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, bucket: 'none' }),
      })
      if (!res.ok) await fetchData()
    } catch { await fetchData() }
  }, [fetchData])

  // Reset a confirmed (recording) game back to draft so it can be reassigned.
  // Optimistic: clear record_confirmed_at → status becomes draft → dropdown
  // unlocks. Only offered for 'recording' (never 'recorded').
  const resetRecording = useCallback(async (id: number) => {
    setData(prev => prev.map(d => d.id === id ? { ...d, record_confirmed_at: null } : d))
    try {
      const res = await fetch('/api/evaluations/confirm-records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id], unset: true }),
      })
      if (!res.ok) await fetchData()
    } catch { await fetchData() }
  }, [fetchData])

  // Drag start: remember the dragged game + its source bucket.
  const handleRowDragStart = useCallback((e: React.DragEvent, item: ShortListItem) => {
    const from = effectiveBucket(item)
    dragRef.current = { id: item.id, from }
    e.dataTransfer.setData('text/plain', String(item.id))
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  // Drop into a container: move iff the target bucket differs from the source.
  const handleDrop = useCallback((target: '5min' | '20min') => {
    setDragOverBucket(null)
    const dragged = dragRef.current
    dragRef.current = null
    if (!dragged) return
    if (dragged.from === target) return
    moveBucket(dragged.id, target)
  }, [moveBucket])

  // Split into the two buckets by effective bucket, then apply the status filter.
  const list5 = useMemo(() => data.filter(d => effectiveBucket(d) === '5min'), [data])
  const list20 = useMemo(() => data.filter(d => effectiveBucket(d) === '20min'), [data])

  const filterByStatus = useCallback((list: ShortListItem[]) => {
    if (!filterStatus) return list
    return list.filter(d => recordStatus(d, ytMap).status === filterStatus)
  }, [filterStatus, ytMap])

  // Group adjacent by recorder (unassigned last). Stable sort keeps the
  // server's date order within each recorder group.
  const arrange = useCallback((list: ShortListItem[]) => {
    const filtered = filterByStatus(list)
    if (!groupByRecorder) return filtered
    return [...filtered].sort((a, b) => {
      const ra = recorderOf(a).toLowerCase() || '￿'
      const rb = recorderOf(b).toLowerCase() || '￿'
      return ra < rb ? -1 : ra > rb ? 1 : 0
    })
  }, [filterByStatus, groupByRecorder])

  const shown5 = useMemo(() => arrange(list5), [arrange, list5])
  const shown20 = useMemo(() => arrange(list20), [arrange, list20])

  // Visible draft rows are the targets of Confirm Assign.
  const visibleDraftGames = useMemo(() => {
    return [...shown5, ...shown20].filter(d => recordStatus(d, ytMap).status === 'draft')
  }, [shown5, shown20, ytMap])
  const visibleDraftIds = useMemo(() => visibleDraftGames.map(d => d.id), [visibleDraftGames])

  // Games that have a recorder — fed to the Extract Chat modal.
  const assignedGames = useMemo(() =>
    data.filter(d => d.record_5min_assignee || d.record_20min_assignee),
    [data]
  )

  const confirmAssign = useCallback(async () => {
    if (visibleDraftIds.length === 0) return
    setConfirming(true)
    try {
      await fetch('/api/evaluations/confirm-records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: visibleDraftIds }),
      })
      await fetchData()
    } catch { /* ignore */ }
    setConfirming(false)
    setShowConfirm(false)
  }, [visibleDraftIds, fetchData])

  // Batch filter options come straight from the server (all batches with games
  // in this view), newest first.
  const batchOptions = [...availableBatches].sort((a, b) => weekLabelOrder(b) - weekLabelOrder(a))
  if (currentBatch && !batchOptions.includes(currentBatch)) batchOptions.unshift(currentBatch)
  if (filterBatch && !batchOptions.includes(filterBatch)) batchOptions.unshift(filterBatch)

  const totalShown = shown5.length + shown20.length

  return (
    <div className="page" style={{ paddingBottom: 16, height: '100vh', boxSizing: 'border-box', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h1 className="h-title">Record</h1>
          <p className="h-sub">{total} games · {filterBatch || 'all batches'} · {filterCategory}{!isManager && userName ? ` · ${userName}` : ''}</p>
        </div>
      </div>

      {syncToast && (
        <div style={{
          position: 'fixed', bottom: 20, right: 20, zIndex: 100,
          background: 'var(--accent, #2563eb)', color: '#fff',
          padding: '10px 16px', borderRadius: 10, fontSize: 12.5, fontWeight: 600,
          boxShadow: '0 6px 20px rgba(0,0,0,.25)',
        }}>
          ✓ {syncToast}
        </div>
      )}

      <div className="filter-row" style={{ position: 'relative', zIndex: 30 }}>
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

        <div style={{ width: 160 }}>
          <StyledSelect
            value={filterBatch}
            onChange={setFilterBatch}
            placeholder="All batches"
            options={[{ value: '', label: 'All batches' }, ...batchOptions.map(b => ({ value: b, label: b }))]}
          />
        </div>

        <div className="seg-wrapper">
          {([
            { value: '', label: 'All' },
            { value: 'pending', label: 'Pending' },
            { value: 'draft', label: 'Draft' },
            { value: 'recording', label: 'Recording' },
            { value: 'recorded', label: 'Recorded' },
          ] as const).map(s => (
            <button key={s.value}
              className={`seg-btn-premium${filterStatus === s.value ? ' active' : ''}`}
              onClick={() => setFilterStatus(s.value)}>
              {s.label}
            </button>
          ))}
        </div>

        <button
          className={`btn btn-sm${groupByRecorder ? ' btn-primary' : ''}`}
          title={groupByRecorder ? 'Grouped by recorder — click for date order' : 'Date order — click to group by recorder'}
          onClick={() => setGroupByRecorder(v => !v)}
          style={{ whiteSpace: 'nowrap' }}>
          {groupByRecorder ? '☰ Grouped' : '☰ Group by recorder'}
        </button>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="sync" style={{ fontSize: 12.5, fontWeight: 600 }}>
            {loading ? 'Loading...' : `${totalShown} results`}
          </span>
          {isManager && (
            <>
              <button className="btn btn-sm btn-primary" onClick={() => setShowConfirm(true)}
                disabled={confirming || visibleDraftIds.length === 0}>
                {confirming ? 'Confirming...' : 'Confirm Assign'}
                {visibleDraftIds.length > 0 && <span className="badge-count">{visibleDraftIds.length}</span>}
              </button>
              <button className="btn btn-sm" onClick={() => setShowExtract(true)} disabled={assignedGames.length === 0}>
                Extract Chat
              </button>
            </>
          )}
        </div>
      </div>

      {/* Split tables: 5 MIN and 20 MIN (effective bucket) */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 16, overflow: 'hidden' }}>
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}
          onDragOver={isManager ? (e => { e.preventDefault(); if (dragOverBucket !== '5min') setDragOverBucket('5min') }) : undefined}
          onDragLeave={isManager ? (e => { if (e.currentTarget === e.target) setDragOverBucket(null) }) : undefined}
          onDrop={isManager ? (e => { e.preventDefault(); handleDrop('5min') }) : undefined}>
          <RecordTable label="5 MIN" items={shown5} loading={loading}
            isManager={isManager} recorders={recorders} onAssign={assignRecorder} onReset={resetRecording}
            ytMap={ytMap} onClickGame={setDetailGameId}
            dragOver={dragOverBucket === '5min'}
            onHeaderAdd={() => setAddBucket('5min')}
            onRowDragStart={handleRowDragStart}
            confirmRemoveId={confirmRemoveId}
            onRemoveRequest={setConfirmRemoveId}
            onConfirmRemove={removeGame}
            onCancelRemove={() => setConfirmRemoveId(null)} />
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}
          onDragOver={isManager ? (e => { e.preventDefault(); if (dragOverBucket !== '20min') setDragOverBucket('20min') }) : undefined}
          onDragLeave={isManager ? (e => { if (e.currentTarget === e.target) setDragOverBucket(null) }) : undefined}
          onDrop={isManager ? (e => { e.preventDefault(); handleDrop('20min') }) : undefined}>
          <RecordTable label="20 MIN" items={shown20} loading={loading}
            isManager={isManager} recorders={recorders} onAssign={assignRecorder} onReset={resetRecording}
            ytMap={ytMap} onClickGame={setDetailGameId}
            dragOver={dragOverBucket === '20min'}
            onHeaderAdd={() => setAddBucket('20min')}
            onRowDragStart={handleRowDragStart}
            confirmRemoveId={confirmRemoveId}
            onRemoveRequest={setConfirmRemoveId}
            onConfirmRemove={removeGame}
            onCancelRemove={() => setConfirmRemoveId(null)} />
        </div>
      </div>

      {showExtract && (
        <ExtractChatModal
          games={assignedGames}
          onClose={() => setShowExtract(false)}
        />
      )}

      {addBucket && (
        <AddGameModal
          category={filterCategory}
          batch={filterBatch}
          excludeGameIds={new Set(data.map(d => d.game_id))}
          targetBucket={addBucket}
          onAdded={fetchData}
          onClose={() => setAddBucket(null)}
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
              onClose={() => setDetailGameId(null)}
              onNavigate={setDetailGameId}
              onSaved={fetchData}
            />
          </div>
        </div>
      )}

      {showConfirm && (
        <div className="eval-modal-backdrop" onClick={() => !confirming && setShowConfirm(false)}>
          <div className="eval-modal-container" onClick={e => e.stopPropagation()}
            style={{ padding: '22px 24px 22px', maxWidth: 480, width: '92vw' }}>
            <div style={{ marginBottom: 14 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Confirm Assign</h2>
              <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '4px 0 0' }}>
                {visibleDraftGames.length} game{visibleDraftGames.length === 1 ? '' : 's'} · Draft → Recording
              </p>
            </div>

            <div style={{ maxHeight: 'calc(70vh - 200px)', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
              {visibleDraftGames.map(g => (
                <div key={g.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                  borderBottom: '1px solid var(--border)',
                }}>
                  <span style={{ fontSize: 12.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.title}</span>
                  <span className="badge idle" style={{ fontSize: 10 }}>{effectiveBucket(g) === '20min' ? '20 MIN' : '5 MIN'}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--muted)', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}><UserIcon />{recorderOf(g) || '—'}</span>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button className="btn btn-sm" onClick={() => setShowConfirm(false)} disabled={confirming}>Cancel</button>
              <button className="btn btn-sm btn-primary" onClick={confirmAssign} disabled={confirming || visibleDraftGames.length === 0}>
                {confirming ? 'Confirming...' : `Confirm ${visibleDraftGames.length}`}
              </button>
            </div>
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

  if (tab === 'record_video') return <RecordTab />
  return <YouTubeTab />
}
