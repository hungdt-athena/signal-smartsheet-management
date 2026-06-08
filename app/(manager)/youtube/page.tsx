'use client'
import { useState, useCallback, useEffect, useMemo, useRef } from 'react'

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

export default function YouTubePage() {
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
          {loading && <p className="empty">Loading...</p>}
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
