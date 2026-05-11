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

const STATUS_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  DONE:       { bg: '#E8F5C8', color: '#3A6010', label: 'Uploaded' },
  FAILED:     { bg: '#FEE2E2', color: '#b91c1c', label: 'Failed to Upload' },
  PROCESSING: { bg: '#FEF3C7', color: '#92400E', label: 'Processing' },
  IN_BATCH:   { bg: '#FFF9C4', color: '#A16207', label: 'Waiting for processing' },
  PENDING:    { bg: '#F3F4F6', color: '#6B7280', label: 'Pending' },
}

function StatusBadge({ status }: { status: string }) {
  const key = status?.toUpperCase() as keyof typeof STATUS_STYLES
  const s = STATUS_STYLES[key] ?? { bg: '#F5EDD8', color: '#6B5A3A', label: status || '—' }
  return (
    <span style={{ background: s.bg, color: s.color, borderRadius: 6, padding: '2px 8px', fontWeight: 700, fontSize: 11, whiteSpace: 'nowrap' }}>
      {s.label}
    </span>
  )
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

// Normalize evaluator name for case-insensitive grouping while keeping trailing numbers distinct.
// "MYTL" and "MyTL" → same key. "ABC2" and "Abc2" → same. "ABC23" and "ABC2" → different.
// When merging, prefer the version WITH a trailing number as canonical display name
// (e.g. "PhuongNT" + "PhuongNT1" → "PhuongNT1").
function normalizeEvaluator(name: string): string {
  const match = name.match(/^(.*?)(\d+)$/)
  if (match) {
    return match[1].toLowerCase() + match[2]
  }
  return name.toLowerCase()
}

function getFilterOptions(rows: YtbRow[]) {
  const years = new Set<string>()
  const monthsByYear = new Map<string, Set<number>>()
  // key = normalized name, value = canonical display name
  // Prefer the version with a trailing number as the display name.
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
        // Prefer the version with trailing digits as canonical
        const hasDigits = /\d+$/.test(row.pic)
        const existingHasDigits = /\d+$/.test(existing)
        if (hasDigits && !existingHasDigits) {
          evaluatorMap.set(key, row.pic)
        }
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

// Group filtered rows by day string (YYYY-MM-DD)
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
          border: `1.5px solid ${isActive ? '#7A8C1E' : '#D4C4A0'}`,
          borderRadius: 8, padding: '5px 10px',
          fontSize: 12, fontWeight: 600,
          color: isActive ? '#3A6010' : '#2A1F08',
          background: isActive ? '#E8F5C8' : '#FAF5EC',
          cursor: 'pointer', whiteSpace: 'nowrap',
          transition: 'all 0.15s ease',
        }}
      >
        {selectedLabel}
        <span style={{ fontSize: 9, color: '#9A8A6A', marginLeft: 2, transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'none' }}>▼</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 50,
          background: '#3D3022', borderRadius: 10, padding: '4px 0',
          minWidth: 160, maxHeight: 260, overflowY: 'auto',
          boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
        }}>
          {allOptions.map(opt => {
            const selected = opt.value === value
            return (
              <button
                key={opt.value}
                onClick={() => { onChange(opt.value); setOpen(false) }}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                  padding: '7px 12px', border: 'none',
                  background: selected ? 'rgba(255,255,255,0.08)' : 'transparent',
                  color: '#F5EDD8', fontSize: 12, fontWeight: selected ? 700 : 500,
                  cursor: 'pointer', textAlign: 'left',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
                onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{ width: 16, flexShrink: 0, fontSize: 11, color: '#A8C44E' }}>
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

// ── Nested Time Filter (Year → Month chips) ──────────────────────────────────

function TimeFilter({ filters, options, onChange }: {
  filters: Filters
  options: ReturnType<typeof getFilterOptions>
  onChange: (f: Filters) => void
}) {
  const [expandedYear, setExpandedYear] = useState<string | null>(filters.year || null)

  useEffect(() => {
    if (filters.year && expandedYear !== filters.year) {
      setExpandedYear(filters.year)
    }
  }, [filters.year, expandedYear])

  function selectYear(y: string) {
    if (filters.year === y) {
      onChange({ ...filters, year: '', month: '' })
      setExpandedYear(null)
    } else {
      onChange({ ...filters, year: y, month: '' })
      setExpandedYear(y)
    }
  }

  function selectMonth(m: number) {
    if (filters.month === String(m)) {
      onChange({ ...filters, month: '' })
    } else {
      onChange({ ...filters, month: String(m) })
    }
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
                  cursor: 'pointer', color: '#9A8A6A', fontSize: 9,
                  transition: 'transform 0.15s',
                  transform: isExpanded ? 'rotate(90deg)' : 'none',
                }}
              >
                ▶
              </button>
              <button
                onClick={() => selectYear(year)}
                style={{
                  border: `1.5px solid ${isSelected ? '#7A8C1E' : '#D4C4A0'}`,
                  borderRadius: 8, padding: '4px 12px',
                  fontSize: 12, fontWeight: 700,
                  color: isSelected ? '#fff' : '#2A1F08',
                  background: isSelected ? '#7A8C1E' : '#EFE3C8',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                {year}
              </button>
            </div>

            {isExpanded && months.length > 0 && (
              <div style={{
                display: 'flex', gap: 4, flexWrap: 'wrap',
                marginLeft: 22, paddingLeft: 8,
                borderLeft: '2px solid #D4C4A0',
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
                        border: `1.5px solid ${mSelected ? '#7A8C1E' : 'transparent'}`,
                        borderRadius: 6, padding: '3px 10px',
                        fontSize: 11, fontWeight: 600,
                        color: mSelected ? '#fff' : '#5A3E1B',
                        background: mSelected ? '#7A8C1E' : '#E8DCC8',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      {MONTH_SHORT[m]}
                    </button>
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
          <button onClick={onClear}
            style={{
              background: 'none', color: '#9A8A6A', border: '1px dashed #D4C4A0',
              borderRadius: 7, padding: '5px 10px', fontSize: 11, fontWeight: 600,
              cursor: 'pointer', transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = '#b91c1c'; e.currentTarget.style.borderColor = '#b91c1c' }}
            onMouseLeave={e => { e.currentTarget.style.color = '#9A8A6A'; e.currentTarget.style.borderColor = '#D4C4A0' }}
          >
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

// ── Blocking Pill Toggle ─────────────────────────────────────────────────────

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
      if (res.ok) {
        setBlocking(newVal)
      }
    } catch { /* silent */ }
    setSaving(false)
  }

  if (blocking === null) {
    return (
      <span style={{ fontSize: 11, color: '#9A8A6A' }}>Loading...</span>
    )
  }

  const isBlocked = blocking === 'yes'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 11, color: '#9A8A6A' }}>Automated uploading to YouTube</span>
      <span style={{ fontSize: 11, fontWeight: 600, color: isBlocked ? '#b91c1c' : '#3A6010' }}>
        {isBlocked ? 'Blocked' : 'Active'}
      </span>
      <button
        onClick={toggle}
        disabled={saving}
        style={{
          position: 'relative',
          width: 44, height: 24, borderRadius: 12, border: 'none',
          background: isBlocked ? '#b91c1c' : '#7A8C1E',
          cursor: saving ? 'not-allowed' : 'pointer',
          opacity: saving ? 0.6 : 1,
          transition: 'background 0.2s ease',
          flexShrink: 0,
        }}
        title={isBlocked ? 'Upload routing is blocked — click to activate' : 'Upload routing is active — click to block'}
      >
        <span style={{
          position: 'absolute', top: 3, left: isBlocked ? 3 : 23,
          width: 18, height: 18, borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          transition: 'left 0.2s ease',
        }} />
      </button>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function Btn({ onClick, disabled, children, variant = 'default' }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode; variant?: 'default' | 'primary'
}) {
  const bg = variant === 'primary' ? '#5A3E1B' : '#D4C4A0'
  const color = variant === 'default' ? '#5A3E1B' : '#fff'
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ background: bg, color, border: 'none', borderRadius: 7, padding: '3px 10px', fontSize: 12, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1 }}>
      {children}
    </button>
  )
}

// ── Colgroup (shared) ────────────────────────────────────────────────────────

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

  const filteredRows = useMemo(() => applyFilters(rows, filters), [rows, filters])

  const dayGroups = useMemo(() => groupByDay(filteredRows), [filteredRows])

  // Auto-open today's group on first load
  useEffect(() => {
    if (dayGroups.length > 0 && openDays.size === 0) {
      const todayGroup = dayGroups.find(g => g.label === 'Today')
      if (todayGroup) {
        setOpenDays(new Set([todayGroup.day]))
      } else {
        setOpenDays(new Set([dayGroups[0].day]))
      }
    }
  }, [dayGroups, openDays.size])

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

  const th: React.CSSProperties = { padding: '6px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6B5A3A', background: '#D4C4A0', borderBottom: '2px solid #C8B896', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
  const td: React.CSSProperties = { padding: '6px 10px', fontSize: 12, color: '#2A1F08', borderBottom: '1px solid #EFE3C8', verticalAlign: 'middle', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

  return (
    <div className="space-y-4 w-full">
      {/* Title + Blocking toggle */}
      <div className="flex items-center justify-between">
        <h1 className="font-extrabold text-2xl" style={{ color: '#2A1F08' }}>Videos</h1>
        <BlockingToggle />
      </div>

      <div className="bean-card p-4">
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <p className="bean-section-label">Drive Videos</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: '#9A8A6A' }}>
              {filteredRows.length}/{rows.length} videos
            </span>
            <Btn onClick={refresh} disabled={loading}>
              <span style={{ display: 'inline-block', animation: loading ? 'spin 1s linear infinite' : 'none' }}>↻</span>
              {' '}{loading ? 'Loading...' : 'Refresh'}
            </Btn>
          </div>
        </div>

        {/* Filter bar */}
        {rows.length > 0 && (
          <div style={{ background: '#FAF5EC', borderRadius: 10, padding: '10px 14px', marginBottom: 12, border: '1px solid #E8DCC8' }}>
            <FilterBar
              filters={filters}
              options={filterOptions}
              onChange={setFilters}
              onClear={() => setFilters(EMPTY_FILTERS)}
            />
          </div>
        )}

        {error && <p style={{ fontSize: 11, color: '#b91c1c', marginBottom: 6 }}>{error}</p>}

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed' }}>
            <ColGroup />
            <thead>
              <tr>
                <th style={th}>Time</th>
                <th style={th}>Game Title</th>
                <th style={th}>Evaluator</th>
                <th style={th}>Duration</th>
                <th style={th}>Status</th>
                <th style={th}>File Name</th>
                <th style={th}>YouTube Link</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 && !loading && (
                <tr><td colSpan={8} style={{ ...td, color: '#9A8A6A', textAlign: 'center', padding: 16 }}>
                  {rows.length === 0 ? 'No data — click Refresh to load' : 'No rows match the selected filters'}
                </td></tr>
              )}
              {loading && (
                <tr><td colSpan={8} style={{ ...td, color: '#9A8A6A', textAlign: 'center', padding: 16 }}>Loading...</td></tr>
              )}
              {!loading && dayGroups.map((group, gi) => {
                const isOpen = openDays.has(group.day)
                const isToday = group.label === 'Today'
                return (
                  <tr key={`group-${group.day}`} style={{ cursor: 'default' }}>
                    <td colSpan={8} style={{ padding: 0, border: 'none' }}>
                      {/* Spacer between day groups (not before first) */}
                      {gi > 0 && (
                        <div style={{ height: 6, background: '#D4C4A0' }} />
                      )}

                      {/* Day header */}
                      <button
                        onClick={() => toggleDay(group.day)}
                        style={{
                          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                          background: isToday ? '#5A6A10' : '#C8B896',
                          padding: '7px 12px', border: 'none',
                          borderBottom: `2px solid ${isToday ? '#4A5A08' : '#B0A080'}`,
                          cursor: 'pointer', textAlign: 'left',
                        }}
                      >
                        <span style={{ fontSize: 10, color: isToday ? '#C8E070' : '#6B5A3A' }}>
                          {isOpen ? '▾' : '▸'}
                        </span>
                        <span style={{ fontWeight: 700, color: isToday ? '#fff' : '#2A1F08', fontSize: 12 }}>
                          {group.label}
                        </span>
                        {isToday && (
                          <span style={{
                            background: 'rgba(255,255,255,0.2)', color: '#fff', borderRadius: 4,
                            padding: '1px 6px', fontSize: 10, fontWeight: 700,
                          }}>Now</span>
                        )}
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: isToday ? 'rgba(255,255,255,0.7)' : '#6B5A3A', fontWeight: 600 }}>
                          {group.rows.length} video{group.rows.length !== 1 ? 's' : ''}
                        </span>
                      </button>

                      {/* Day rows */}
                      {isOpen && (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed' }}>
                          <ColGroup />
                          <tbody>
                            {group.rows.map(row => {
                              const pending   = edits[row.row_index] ?? {}
                              const isDirty   = Object.keys(pending).length > 0
                              const isSaving  = saving.has(row.row_index)
                              const youtubeId = pending.youtubeId ?? row.youtubeId
                              const ytUrl     = youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : null

                              return (
                                <tr key={row.row_index} style={{ background: isDirty ? '#FDFAF2' : 'transparent' }}>
                                  <td style={{ ...td, color: '#6B5A3A' }}>
                                    {row.time ? new Date(row.time).toLocaleTimeString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' }) : '—'}
                                  </td>
                                  <td style={td}>{row.gameTitle || '—'}</td>
                                  <td style={td}>{row.pic || '—'}</td>
                                  <td style={{ ...td, color: '#6B5A3A' }}>{row.duration || '—'}</td>
                                  <td style={td}>
                                    <StatusBadge status={row.status} />
                                  </td>
                                  <td style={td}>{row.fileName || '—'}</td>
                                  <td style={td}>
                                    {isDirty ? (
                                      <input
                                        value={youtubeId}
                                        onChange={e => setEdit(row.row_index, 'youtubeId', e.target.value)}
                                        placeholder="YouTube ID"
                                        autoFocus
                                        style={{ border: '1px solid #5A3E1B', borderRadius: 5, padding: '2px 6px', fontSize: 11, fontFamily: 'monospace', width: 160, background: '#FAF5EC', color: '#2A1F08' }}
                                      />
                                    ) : (
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        {ytUrl ? (
                                          <a href={ytUrl} target="_blank" rel="noreferrer"
                                            style={{ color: '#1A5A9A', fontWeight: 600, fontSize: 11, textDecoration: 'underline', whiteSpace: 'nowrap' }}>
                                            youtu.be/{youtubeId}
                                          </a>
                                        ) : (
                                          <span style={{ color: '#B0A090', fontStyle: 'italic', fontSize: 11 }}>
                                            not synced yet
                                          </span>
                                        )}
                                        <button
                                          onClick={() => setEdit(row.row_index, 'youtubeId', youtubeId)}
                                          title="Edit YouTube ID"
                                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9A8A6A', fontSize: 12, lineHeight: 1, padding: '1px 3px', borderRadius: 4, flexShrink: 0 }}
                                          onMouseEnter={e => (e.currentTarget.style.color = '#5A3E1B')}
                                          onMouseLeave={e => (e.currentTarget.style.color = '#9A8A6A')}
                                        >
                                          ✎
                                        </button>
                                      </div>
                                    )}
                                  </td>
                                  <td style={{ ...td, width: 90 }}>
                                    {isDirty && (
                                      <div style={{ display: 'flex', gap: 4 }}>
                                        <Btn onClick={() => saveEdits(row.row_index)} disabled={isSaving} variant="primary">
                                          {isSaving ? '...' : 'Save'}
                                        </Btn>
                                        <Btn onClick={() => cancelEdits(row.row_index)} disabled={isSaving}>✕</Btn>
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
