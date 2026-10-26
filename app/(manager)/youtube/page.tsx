'use client'
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { StyledSelect } from '@/components/StyledSelect'
import { BatchPicker, batchPickLabel, parseBatchPick } from '@/components/ui/BatchPicker'
import { batchLabelsOfMonth } from '@/lib/batch-month'
import { resolveYtMatches, type YtGame, type YtMatch } from '@/lib/ytb-match'
import { prettyConclusion, BUCKETS } from '@/lib/buckets'
import { useConfig } from '@/hooks/useConfig'
import { LockIcon, UserIcon } from '@/components/icons'
import EvalDetailPanel from '@/components/EvalDetailPanel'
import { weekLabelOrder } from '@/lib/weekly-feedback'
import { SHORTCUT_EVALUATOR } from '@/lib/system-accounts'
import { isManagerRole } from '@/lib/roles'
import { requestLeaveUnsaved } from '@/lib/unsaved-guard'
import { GameIcon } from '@/components/ui/GameIcon'
import { useUrlState, useSetUrlParams } from '@/lib/use-url-state'
import { toast } from '@/lib/toast'
import { RECORD_STATUS_BADGE, type RecordStatus } from '@/lib/conclusion-badge'
import { Seg } from '@/components/ui/Seg'
import { FilterBar, FilterSpacer, ClearFilters, FilterCount } from '@/components/ui/FilterBar'
import { SearchInput, IconX } from '@/components/ui/SearchInput'
import { Modal } from '@/components/ui/Modal'
import { PageHeader, RefreshButton } from '@/components/ui/PageHeader'
import { Switch } from '@/components/ui/Switch'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/ui/States'

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
  FAILED:     { cls: 'error',   label: 'Failed to upload' },
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

// The page opens on the current month (VN time). The URL keeps `year` and `month`
// (1-12) only when they differ from that; 'all' means "any year / any month".
function currentYearMonth(): { year: string; month: string } {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
  return { year: String(now.getFullYear()), month: String(now.getMonth() + 1) }
}

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

// ── Time filter (year, then month of that year) ──────────────────────────────

// Same logic as before the cleanup: one button per year that has uploads, a ▸ that
// opens that year's months (only months with uploads), click a selected year or
// month again to clear it. It takes its own line in the filter bar, so new years
// and months wrap there instead of pushing the other filters out of shape.
function TimeFilter({ year, month, options, onSelect }: {
  year: string    // '' = any year
  month: string   // 0-11, '' = any month
  options: ReturnType<typeof getFilterOptions>
  onSelect: (year: string, month: string) => void
}) {
  const [expanded, setExpanded] = useState<string | null>(year || null)
  useEffect(() => { if (year) setExpanded(year) }, [year])
  const years = options.years.includes(year) || !year ? options.years : [year, ...options.years]

  return (
    <div className="tf" role="group" aria-label="Upload month">
      {years.map(y => {
        const isYear = year === y
        const isOpen = expanded === y
        const months = options.monthsByYear[y] ?? []
        return (
          <div key={y} className="tf-item">
            <button type="button" className="tf-exp" aria-expanded={isOpen}
              aria-label={`${isOpen ? 'Hide' : 'Show'} months of ${y}`}
              onClick={() => setExpanded(isOpen ? null : y)}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5l10 7-10 7z" /></svg>
            </button>
            <button type="button" className={`tf-year${isYear ? ' on' : ''}`} aria-pressed={isYear}
              onClick={() => { if (isYear) onSelect('', ''); else { onSelect(y, ''); setExpanded(y) } }}>
              {y}
            </button>
            {isOpen && months.length > 0 && (
              <div className="tf-months">
                {months.map(m => {
                  const on = isYear && month === String(m)
                  return (
                    <button key={m} type="button" className={`tf-month${on ? ' on' : ''}`} aria-pressed={on}
                      onClick={() => onSelect(y, on ? '' : String(m))}>
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
      if (!res.ok) throw new Error()
      setBlocking(newVal)
      toast.success(newVal === 'yes' ? 'Auto-upload to YouTube is off' : 'Auto-upload to YouTube is on')
    } catch {
      toast.error('Could not change auto-upload.', { label: 'Try again', run: () => { void toggle() } })
    }
    setSaving(false)
  }

  if (blocking === null) {
    return <span className="sync">Loading…</span>
  }

  // The sheet stores "blocking"; the switch shows the opposite, "auto-upload on".
  const isBlocked = blocking === 'yes'
  return (
    <Switch checked={!isBlocked} onChange={() => { void toggle() }} disabled={saving}
      label="Auto-upload to YouTube"
      title={isBlocked ? 'Off: new Drive videos are not uploaded' : 'On: new Drive videos are uploaded'} />
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
      <col style={{ width: '15%' }} />
      <col style={{ width: '8%' }} />
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
  const [openDays, setOpenDays] = useState<Set<string>>(new Set())
  const initialOpenDone = useRef(false)

  // Filters live in the URL (reload and shared links keep them).
  const cur = useMemo(currentYearMonth, [])
  const [yearParam]  = useUrlState('year', cur.year)
  const [monthParam] = useUrlState('month', cur.month)
  const [evaluator, setEvaluator] = useUrlState('ev', '')
  const [duration, setDuration]   = useUrlState('dur', '')
  const setParams = useSetUrlParams()
  const filters: Filters = useMemo(() => {
    const year = yearParam === 'all' ? '' : yearParam
    const m = Number(monthParam)
    const month = !year || monthParam === 'all' || !(m >= 1 && m <= 12) ? '' : String(m - 1)
    return { year, month, evaluator, duration }
  }, [yearParam, monthParam, evaluator, duration])
  const filtersOn = yearParam !== cur.year || monthParam !== cur.month || !!evaluator || !!duration
  const clearFilters = () => setParams({ year: null, month: null, ev: null, dur: null })
  // Year and month in one navigation. No key = the current year/month (the default);
  // 'all' = any. The month key is ignored while the year is "any".
  const pickYearMonth = (y: string, m: string) => {
    if (!y) { setParams({ year: 'all', month: null }); return }
    const mv = m === '' ? 'all' : String(Number(m) + 1)
    setParams({ year: y === cur.year ? null : y, month: mv === cur.month ? null : mv })
  }

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
      toast.success('YouTube ID saved')
    } catch {
      toast.error('Could not save the YouTube ID.', { label: 'Try again', run: () => { void saveEdits(rowIndex) } })
    } finally {
      setSaving(s => { const n = new Set(s); n.delete(rowIndex); return n })
    }
  }

  function cancelEdits(rowIndex: number) {
    setEdits(prev => { const n = { ...prev }; delete n[rowIndex]; return n })
  }

  const evaluatorOpts = [{ value: '', label: 'All evaluators' }, ...filterOptions.evaluators.map(e => ({ value: e, label: e }))]
  const durationOpts  = [{ value: '', label: 'All durations' }, ...filterOptions.durations.map(d => ({ value: d, label: d }))]

  return (
    <div className="page yt-page">
      <PageHeader title="YouTube" sub="Drive videos and their YouTube upload."
        actions={<><BlockingToggle /><RefreshButton onClick={refresh} loading={loading} /></>} />

      {rows.length > 0 && (
        <FilterBar>
          {filterOptions.years.length > 0 && (
            <TimeFilter year={filters.year} month={filters.month} options={filterOptions}
              onSelect={pickYearMonth} />
          )}
          <StyledSelect filter ariaLabel="Evaluator" value={evaluator} onChange={setEvaluator}
            options={evaluatorOpts} placeholder="All evaluators" style={{ width: 170 }} />
          <StyledSelect filter ariaLabel="Duration" value={duration} onChange={setDuration}
            options={durationOpts} placeholder="All durations" style={{ width: 150 }} />
          <FilterSpacer />
          <ClearFilters visible={filtersOn} onClear={clearFilters} />
          <FilterCount shown={filteredRows.length} total={rows.length} noun="videos" />
        </FilterBar>
      )}

      <div className="card yt-card">
        {/* Table header */}
        <div style={{ flexShrink: 0 }}>
          <table className="tbl" style={{ tableLayout: 'fixed' }}>
            <ColGroup />
            <thead>
              <tr>
                <th>Time</th>
                <th>Game title</th>
                <th>Evaluator</th>
                <th>Duration</th>
                <th>Status</th>
                <th>File name</th>
                <th>YouTube link</th>
                <th></th>
              </tr>
            </thead>
          </table>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
          {error && (
            <ErrorState onRetry={refresh}>Could not load the videos. {error}</ErrorState>
          )}
          {!error && filteredRows.length === 0 && !loading && (
            rows.length === 0
              ? <EmptyState>No videos yet.</EmptyState>
              : <EmptyState action={filtersOn ? { label: 'Clear filters', onClick: clearFilters } : undefined}>
                  No videos match these filters.
                </EmptyState>
          )}
          {loading && rows.length === 0 && (
            <table className="tbl" style={{ tableLayout: 'fixed' }}>
              <ColGroup />
              <tbody><SkeletonRows widths={[40, 160, 80, 50, 90, 140, 110, 40]} rows={4} /></tbody>
            </table>
          )}
          {dayGroups.map((group, gi) => {
            const isOpen  = openDays.has(group.day)
            const isToday = group.label === 'Today'
            return (
              <div key={group.day}>
                {gi > 0 && <div style={{ height: 4, background: 'var(--border)' }} />}

                {/* Day header */}
                <button type="button" className={`yt-day${isToday ? ' is-today' : ''}`}
                  aria-expanded={isOpen} onClick={() => toggleDay(group.day)}>
                  <span className="yt-day-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                  <span className="yt-day-label">{group.label}</span>
                  {isToday && <span className="badge running">live</span>}
                  <span className="yt-day-count">
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
                                  aria-label="YouTube ID"
                                  autoFocus
                                  className="input"
                                  style={{ padding: '3px 7px', fontSize: 12, fontFamily: 'var(--num)', width: '100%', maxWidth: 160 }}
                                />
                              ) : (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  {ytUrl ? (
                                    <a href={ytUrl} target="_blank" rel="noreferrer"
                                      style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 12, textDecoration: 'underline', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                      youtu.be/{youtubeId}
                                    </a>
                                  ) : (
                                    <span style={{ color: 'var(--faint)', fontStyle: 'italic', fontSize: 12 }}>
                                      not synced yet
                                    </span>
                                  )}
                                  <button type="button" className="btn btn-sm btn-ghost"
                                    onClick={() => setEdit(row.row_index, 'youtubeId', youtubeId)}
                                    title="Edit YouTube ID" aria-label="Edit YouTube ID">✎</button>
                                </div>
                              )}
                            </td>
                            <td>
                              {isDirty && (
                                <div style={{ display: 'flex', gap: 4 }}>
                                  <button type="button" className="btn btn-sm btn-ghost" aria-label="Cancel edit" title="Cancel"
                                    onClick={() => cancelEdits(row.row_index)} disabled={isSaving}><IconX size={12} /></button>
                                  <button type="button" className="btn btn-sm btn-primary"
                                    onClick={() => saveEdits(row.row_index)} disabled={isSaving}>
                                    {isSaving ? 'Saving…' : 'Save'}
                                  </button>
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
    // A game goes under its own bucket only, the same recorder the grid shows.
    // The other bucket's column can still hold a stale name.
    build("20'", g => effectiveBucket(g) === '20min' ? recorderOf(g) || null : null)
    build("5'", g => effectiveBucket(g) === '5min' ? recorderOf(g) || null : null)
    return sections.join('\n\n')
  }, [games, selected])

  async function copy() {
    try {
      await navigator.clipboard.writeText(message)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Could not copy. Select the text and copy it by hand.')
    }
  }

  return (
    <Modal title="Extract chat text" onClose={onClose} width={980}
      sub={`${selected.size} of ${games.length} game${games.length !== 1 ? 's' : ''} selected`}
      footer={<>
        <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={copy} disabled={!message}>
          {copied ? 'Copied' : 'Copy message'}
        </button>
      </>}>
      {/* Two columns: selection list + preview */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
        {/* Selection list */}
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span className="card-label">Games</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={toggleAll}>
              {allSelected ? 'Deselect all' : 'Select all'}
            </button>
          </div>
          <div style={{ maxHeight: 'calc(80vh - 260px)', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
            {games.length === 0 ? (
              <EmptyState>No games have a recorder yet.</EmptyState>
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
                  <span className="cell-name" style={{ fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.title}</span>
                  <span className="rec-meta" style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    {recorderOf(g) && (effectiveBucket(g) === '20min'
                      ? <span className="badge info">20&apos; {recorderOf(g)}</span>
                      : <span className="badge neutral">5&apos; {recorderOf(g)}</span>)}
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
            aria-label="Message preview"
            placeholder="Select at least one game."
            style={{
              width: '100%', height: 'calc(80vh - 260px)', resize: 'none',
              fontFamily: 'var(--num, monospace)', fontSize: 13, lineHeight: 1.6,
              padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border)',
              background: 'var(--surface-2)', color: 'var(--text)', boxSizing: 'border-box',
            }}
          />
        </div>
      </div>
    </Modal>
  )
}

// ── Record status helpers ────────────────────────────────────────────────────

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

function recordStatus(item: ShortListItem, ytMap: Map<number | string, YtMatch>): { status: RecordStatus; youtubeId?: string; approx?: string } {
  const bucket = effectiveBucket(item)
  const assignee = bucket === '20min' ? item.record_20min_assignee : item.record_5min_assignee
  const yt = ytMap.get(item.id)
  if (yt) return { status: 'recorded', youtubeId: yt.id, approx: yt.approx }
  if (!assignee) return { status: 'pending' }
  if (item.record_confirmed_at) return { status: 'recording' }
  return { status: 'draft' }
}

function RecordStatusBadge({ status, youtubeId, approx }: { status: RecordStatus; youtubeId?: string; approx?: string }) {
  const s = RECORD_STATUS_BADGE[status]
  if (status === 'recorded' && youtubeId) {
    return (
      <a
        href={`https://www.youtube.com/watch?v=${youtubeId}`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={e => e.stopPropagation()}
        title={approx ? `Matched to upload "${approx}" — open on YouTube` : 'Open on YouTube'}
        className={`badge ${s.cls} yt-link`}
        style={{ textDecoration: 'none', cursor: 'pointer' }}
      >
        ▶ {s.label}
      </a>
    )
  }
  return <span className={`badge ${s.cls}`}>{s.label}</span>
}

// ── Record Table ─────────────────────────────────────────────────────────────

function RecordTable({
  label, items, loading, isManager, recorders, onAssign, onReset, ytMap, onClickGame, activeGameId,
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
  ytMap: Map<number | string, YtMatch>
  onClickGame: (gameId: string) => void
  /** The game open in the panel; its row is highlighted. */
  activeGameId: string | null
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
    <div className={`card rec-table${dragOver ? ' is-drop' : ''}`}>
      <div className="rec-table-head">
        <span className="card-label">{label}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Per-bucket split; the list total is in the filter bar. */}
          <span className="sync">{items.length} game{items.length !== 1 ? 's' : ''}</span>
          {isManager && onHeaderAdd && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={onHeaderAdd}>+ Add game</button>
          )}
        </div>
      </div>
      <div className="tbl-wrap" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <table className="tbl tbl-sticky">
          <thead>
            <tr>
              <th style={{ width: 36 }}>#</th>
              <th>Game</th>
              <th style={{ width: 160 }}>Recorder</th>
              <th style={{ width: 130 }}>Status</th>
              {isManager && <th style={{ width: 36 }} aria-label="Remove" />}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !loading && (
              <tr><td colSpan={cols}><EmptyState>No games.</EmptyState></td></tr>
            )}
            {loading && items.length === 0 && (
              <SkeletonRows widths={isManager ? [16, 200, 120, 80, 16] : [16, 200, 120, 80]} />
            )}
            {items.map((item, idx) => {
              const eb = effectiveBucket(item)
              const assignee = eb === '20min' ? item.record_20min_assignee : item.record_5min_assignee
              const { status, youtubeId, approx } = recordStatus(item, ytMap)
              // Once confirmed (recording) — or already recorded — the recorder
              // is locked; no reassigning.
              const assignLocked = status === 'recording' || status === 'recorded'
              const confirming = confirmRemoveId === item.id
              return (
                <tr key={item.id} className={`tbl-row-premium${item.game_id === activeGameId ? ' tbl-row-active' : ''}`}
                  style={{ cursor: isManager ? 'grab' : 'pointer' }}
                  draggable={isManager}
                  onDragStart={isManager && onRowDragStart ? e => onRowDragStart(e, item) : undefined}
                  onClick={() => onClickGame(item.game_id)}>
                  <td className="num" style={{ color: 'var(--faint)', fontSize: 12 }}>{idx + 1}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 160 }}>
                      <GameIcon src={item.icon_url} os={item.os} size={40} />
                      <div style={{ minWidth: 0 }}>
                        {/* Row 1: title */}
                        <div className="cell-name" style={{ fontSize: 13, lineHeight: 1.3 }}>{item.title}</div>
                        {/* Row 2: who evaluated it. The conclusions are left out: every game
                            here is already List_Idea + Insight / Priority IV (that is how
                            it got into this container), so they said nothing. The platform
                            is the mark on the icon. */}
                        {item.initial_evaluator && (
                          <div className="rec-meta"><span className="rec-meta-name">{item.initial_evaluator}</span></div>
                        )}
                      </div>
                    </div>
                  </td>
                  {confirming ? (
                    <td colSpan={isManager ? 3 : 2} onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Remove from list? The recorder is cleared.</span>
                        <button type="button" className="btn btn-sm" onClick={() => onCancelRemove && onCancelRemove()}>Cancel</button>
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => onConfirmRemove && onConfirmRemove(item.id)}>Remove</button>
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
                            ariaLabel="Recorder"
                            style={{ fontSize: 12 }}
                          />
                        ) : (
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 13, color: assignee ? 'var(--text)' : 'var(--faint)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              {assignLocked && <LockIcon />}{assignee || '—'}
                            </span>
                            {/* Recording (confirmed, not yet recorded): allow un-confirm → reassign. */}
                            {isManager && status === 'recording' && (
                              <button type="button" className="btn btn-sm btn-ghost" title="Back to draft so you can change the recorder"
                                onClick={e => { e.stopPropagation(); onReset(item.id) }}>↺ Reset</button>
                            )}
                          </div>
                        )}
                      </td>
                      <td>
                        <RecordStatusBadge status={status} youtubeId={youtubeId} approx={approx} />
                      </td>
                      {isManager && (
                        <td onClick={e => e.stopPropagation()} style={{ textAlign: 'center' }}>
                          {status === 'recorded' ? (
                            <span title="Recorded, cannot remove" style={{ color: 'var(--faint)', display: 'inline-flex' }}><LockIcon /></span>
                          ) : (
                            <button type="button" className="btn btn-sm btn-ghost" title="Remove from list" aria-label="Remove from list"
                              onClick={() => onRemoveRequest && onRemoveRequest(item.id)}><IconX size={14} /></button>
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
  /** Known for games listed from a batch; absent for catalog search results. */
  category_group?: string
}

const CAT_LABEL = (b: string) => b[0].toUpperCase() + b.slice(1)

// Final conclusion each bucket implies, and the reverse (final → bucket) so that
// changing the final conclusion in the confirm popup re-derives the container.
const FINAL_FOR_BUCKET: Record<'5min' | '20min', string> = { '5min': 'Insight', '20min': 'Priority IV' }
function bucketForFinal(final: string, fallback: '5min' | '20min'): '5min' | '20min' {
  return final === 'Priority IV' ? '20min' : final === 'Insight' ? '5min' : fallback
}
const BYPASS_RE = /bypass/i

interface OriginalEval {
  initial_evaluator: string | null
  initial_conclusion: string | null
  final_conclusion: string | null
  final_evaluator: string | null
}

// Confirm step for adding a game to a record bucket. Shows the game's current
// evaluation (Original) beside editable inputs and only writes on Confirm — this
// guards against accidental adds and lets the adder correct the auto-attribution.
// A game never really evaluated (no initial conclusion) or only bypassed is
// pre-filled with the Shortcut / List_Idea / bucket-final defaults; a genuine
// evaluation is pre-filled with its own values (kept unless the adder edits them).
function ConfirmAddModal({ game, category, batch, targetBucket, recorders, onConfirmed, onCancel }: {
  game: CatalogGame
  category: string
  batch: string
  targetBucket: '5min' | '20min'
  recorders: string[]
  onConfirmed: () => void
  onCancel: () => void
}) {
  const { conclusion: conclusionOptions, final_conclusion: finalOptions } = useConfig()
  const [orig, setOrig] = useState<OriginalEval | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [initEvaluator, setInitEvaluator] = useState('')
  const [initConclusion, setInitConclusion] = useState('')
  const [finalConclusion, setFinalConclusion] = useState('')
  const [finalEvaluator, setFinalEvaluator] = useState('')

  // Load the current evaluation and seed the form (smart defaults by case).
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/evaluations/${game.game_id}?${new URLSearchParams({ category })}`)
      .then(r => (r.ok ? r.json() : null))
      .then((json: { data?: OriginalEval } | null) => {
        if (cancelled) return
        const d = json?.data ?? null
        setOrig(d)
        const ic = d?.initial_conclusion ?? null
        const eligible = !ic || BYPASS_RE.test(ic)
        if (eligible) {
          setInitEvaluator(SHORTCUT_EVALUATOR)
          setInitConclusion('List_Idea')
          setFinalConclusion(FINAL_FOR_BUCKET[targetBucket])
          setFinalEvaluator(SHORTCUT_EVALUATOR)
        } else {
          setInitEvaluator(d?.initial_evaluator ?? '')
          setInitConclusion(ic ?? '')
          setFinalConclusion(d?.final_conclusion ?? '')
          setFinalEvaluator(d?.final_evaluator ?? '')
        }
      })
      .catch(() => { if (!cancelled) setOrig(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [game.game_id, category, targetBucket])

  // Container the game will land in — driven by the chosen final conclusion.
  const resolvedBucket = bucketForFinal(finalConclusion, targetBucket)
  // Name suggestions for the evaluator inputs — team members plus the Shortcut
  // system account (no dashboard_users row, so it must be added explicitly).
  const nameOptions = useMemo(
    () => Array.from(new Set([SHORTCUT_EVALUATOR, ...recorders])),
    [recorders]
  )

  async function confirm() {
    setSaving(true)
    try {
      const res = await fetch('/api/evaluations/add-to-record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          game_id: game.game_id, category_group: category, bucket: resolvedBucket, batch,
          initial_evaluator: initEvaluator, initial_conclusion: initConclusion,
          final_conclusion: finalConclusion, final_evaluator: finalEvaluator,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        toast.error(`Could not add the game. ${j?.error ?? ''}`.trim())
        setSaving(false)
        return
      }
    } catch { toast.error('Could not add the game. Check your connection.'); setSaving(false); return }
    toast.success(`Added ${game.title} to ${resolvedBucket === '20min' ? '20 min' : '5 min'}`)
    onConfirmed()
  }

  const nameListId = `confirm-add-names-${game.game_id}`
  const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.3 }
  const origStyle: React.CSSProperties = { fontSize: 13, color: 'var(--faint)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
  const fieldStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '6px 9px', borderRadius: 8,
    border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13,
  }

  return (
    <Modal onClose={onCancel} busy={saving} width={560} zIndex={1010}
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {game.icon_url ? (
            <img src={game.icon_url} alt="" width={32} height={32} style={{ borderRadius: 7, flexShrink: 0 }} />
          ) : (
            <span style={{ width: 32, height: 32, borderRadius: 7, background: 'var(--surface-3)', flexShrink: 0 }} />
          )}
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{game.title}</span>
        </span>
      }
      sub={`Add to Record · ${category} · ${batch || 'no batch'}`}
      footer={<>
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={confirm} disabled={loading || saving}>
          {saving ? 'Adding…' : 'Add game'}
        </button>
      </>}>
      {loading ? (
        <p className="empty">Loading…</p>
      ) : (
        <div>
          {/* Column headers */}
          <div style={{ display: 'grid', gridTemplateColumns: '116px 1fr 1fr', gap: '6px 10px', alignItems: 'center', marginBottom: 4 }}>
            <span />
            <span style={labelStyle}>Original</span>
            <span style={labelStyle}>New (applied)</span>

            {/* Initial evaluator */}
            <span style={labelStyle}>Init. evaluator</span>
            <span style={origStyle}>{orig?.initial_evaluator || '—'}</span>
            <input list={nameListId} value={initEvaluator} onChange={e => setInitEvaluator(e.target.value)} style={fieldStyle} placeholder="evaluator" aria-label="Initial evaluator" />

            {/* Initial conclusion */}
            <span style={labelStyle}>Init. conclusion</span>
            <span style={origStyle}>{orig?.initial_conclusion ? prettyConclusion(orig.initial_conclusion) : '—'}</span>
            <select value={initConclusion} onChange={e => setInitConclusion(e.target.value)} style={fieldStyle} aria-label="Initial conclusion">
              <option value="">(none)</option>
              {conclusionOptions.map(c => <option key={c} value={c}>{prettyConclusion(c)}</option>)}
            </select>

            {/* Final conclusion */}
            <span style={labelStyle}>Final conclusion</span>
            <span style={origStyle}>{orig?.final_conclusion ? prettyConclusion(orig.final_conclusion) : '—'}</span>
            <select value={finalConclusion} onChange={e => setFinalConclusion(e.target.value)} style={fieldStyle} aria-label="Final conclusion">
              <option value="">(none)</option>
              {finalOptions.map(c => <option key={c} value={c}>{prettyConclusion(c)}</option>)}
            </select>

            {/* Final evaluator */}
            <span style={labelStyle}>Final evaluator</span>
            <span style={origStyle}>{orig?.final_evaluator || '—'}</span>
            <input list={nameListId} value={finalEvaluator} onChange={e => setFinalEvaluator(e.target.value)} style={fieldStyle} placeholder="evaluator" aria-label="Final evaluator" />
          </div>
          <datalist id={nameListId}>
            {nameOptions.map(n => <option key={n} value={n} />)}
          </datalist>

          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '12px 0 0' }}>
            Goes to <b style={{ color: 'var(--text)' }}>{resolvedBucket === '20min' ? '20 MIN' : '5 MIN'}</b>
            {resolvedBucket !== targetBucket && <span style={{ color: 'var(--accent)' }}> (moved by the final conclusion)</span>}
          </p>
        </div>
      )}
    </Modal>
  )
}

function AddGameModal({ category, batch, month = null, excludeGameIds, targetBucket, recorders, onAdded, onClose }: {
  category: string
  /** The single batch an added game goes into ('' = leave its batch as is). */
  batch: string
  /** When the view is a whole month: list that month's games, not just `batch`. */
  month?: string | null
  excludeGameIds: Set<string>
  targetBucket: '5min' | '20min'
  recorders: string[]
  onAdded: () => void
  onClose: () => void
}) {
  const [batchGames, setBatchGames] = useState<CatalogGame[]>([])
  const [batchLoading, setBatchLoading] = useState(true)
  const [results, setResults] = useState<CatalogGame[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  // The game awaiting confirmation. Picking a game no longer adds it directly —
  // it opens ConfirmAddModal so the adder can review/override its evaluation.
  const [pending, setPending] = useState<CatalogGame | null>(null)
  // Where an added game goes. With "All" category groups on the page, the adder picks
  // it here (a game picked from the batch list brings its own group).
  const [addCat, setAddCat] = useState(category === 'all' ? 'puzzle' : category)

  // Default (empty query): the games in the selected batch/category — the common
  // case is pulling one of those into a bucket without having to type.
  useEffect(() => {
    const params = new URLSearchParams({ category, limit: '500' })
    if (month) params.set('batch_month', month)
    else if (batch) params.set('batch', batch)
    fetch(`/api/evaluations?${params}`)
      .then(r => r.ok ? r.json() : { data: [] })
      .then(json => setBatchGames(((json.data || []) as ShortListItem[]).map(g => ({
        game_id: g.game_id, title: g.title, app_link: g.app_link, icon_url: g.icon_url,
        category_group: g.category_group,
      }))))
      .catch(() => {})
      .finally(() => setBatchLoading(false))
  }, [category, batch, month])

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

  return (
    <>
      <Modal title={`Add a game to ${targetBucket === '20min' ? '20 MIN' : '5 MIN'}`} onClose={onClose} width={520}
        sub={searching ? `Search all games · ${CAT_LABEL(addCat)}`
          : `${month ? batchPickLabel(`month:${month}`) : batch || 'All batches'} · ${category === 'all' ? 'All category groups' : CAT_LABEL(category)}`}>
        {category === 'all' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="label">Add to</span>
            <Seg ariaLabel="Category group for the added game" value={addCat} onChange={setAddCat}
              options={BUCKETS.map(b => ({ value: b, label: CAT_LABEL(b) }))} />
          </div>
        )}
        <div className="rec-add-search">
          <SearchInput value={query} onChange={setQuery} autoFocus width="100%"
            placeholder="Search by name or paste a store link" ariaLabel="Search games" />
        </div>

        <div style={{ maxHeight: 'calc(70vh - 180px)', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
          {(searching ? loading : batchLoading) ? (
            <p className="empty">{searching ? 'Searching…' : 'Loading…'}</p>
          ) : candidates.length === 0 ? (
            <EmptyState>{searching ? 'No game found.' : 'No games in this batch.'}</EmptyState>
          ) : candidates.map(g => (
            <button key={g.game_id} type="button" className="rec-add-row"
              onClick={() => { if (category === 'all' && g.category_group) setAddCat(g.category_group); setPending(g) }}>
              {g.icon_url ? (
                <img src={g.icon_url} alt="" width={24} height={24} style={{ borderRadius: 6, flexShrink: 0 }} />
              ) : (
                <span style={{ width: 24, height: 24, borderRadius: 6, background: 'var(--surface-3)', flexShrink: 0 }} />
              )}
              <span className="cell-name" style={{ fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.title}</span>
            </button>
          ))}
        </div>
      </Modal>

      {/* Stacked on top; its own Cancel / Esc / backdrop close only this step. */}
      {pending && (
        <ConfirmAddModal
          game={pending}
          category={addCat}
          batch={batch}
          targetBucket={targetBucket}
          recorders={recorders}
          onConfirmed={() => { onAdded(); onClose() }}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  )
}

// ── Record Tab ───────────────────────────────────────────────────────────────

function RecordTab() {
  const { data: session } = useSession()
  const userName = session?.user?.name || ''
  const role = session?.user?.role
  const isManager = isManagerRole(role)

  const [data, setData] = useState<ShortListItem[]>([])
  const [loading, setLoading] = useState(true)
  // View and filters live in the URL: cat, batch, status.
  // Category group: All by default; one group narrows the containers.
  const [catParam, setCatParam] = useUrlState('cat', 'all')
  const filterCategory = (BUCKETS as readonly string[]).includes(catParam) ? catParam : 'all'
  // batch: absent = the server's default batch (once known), 'all' = All batches,
  // `month:YYYY-MM` = every batch of that month.
  const [batchParam, setBatchParam] = useUrlState('batch', '')
  const [defaultBatch, setDefaultBatch] = useState<string | null>(null)
  const batchPick = batchParam === 'all' ? '' : (batchParam || defaultBatch || '')
  const setBatchPick = (v: string) => setBatchParam(v === '' ? 'all' : v === defaultBatch ? '' : v)
  const { batch: pickedBatch, month: filterMonth } = parseBatchPick(batchPick)
  const filterBatch = pickedBatch ?? ''
  const [currentBatch, setCurrentBatch] = useState<string | null>(null)
  const [statusParam, setStatusParam] = useUrlState('status', '')
  const filterStatus: '' | RecordStatus = statusParam in RECORD_STATUS_BADGE ? statusParam as RecordStatus : ''
  const setParams = useSetUrlParams()
  const filtersOn = filterCategory !== 'all' || batchParam !== '' || filterStatus !== ''
  const clearFilters = () => setParams({ cat: null, batch: null, status: null })
  const [recorders, setRecorders] = useState<string[]>([])
  const [ytRows, setYtRows] = useState<YtbRow[]>([])
  // Every Record-view game, unfiltered: what the YouTube matcher resolves over.
  const [recordGames, setRecordGames] = useState<YtGame[]>([])
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
  const [loadError, setLoadError] = useState(false)

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
      if (filterMonth) params.set('batch_month', filterMonth)
      else if (filterBatch) params.set('batch', filterBatch)
      if (!isManager && userName) params.set('recorder', userName)
      const [res, gamesRes] = await Promise.all([
        fetch(`/api/evaluations?${params}`),
        fetch('/api/evaluations/record-games', { cache: 'no-store' }).catch(() => null),
      ])
      if (!res.ok) throw new Error()
      const json = await res.json()
      const games: YtGame[] | null = gamesRes?.ok ? await gamesRes.json().catch(() => null) : null
      if (seq !== fetchSeqRef.current) return
      setLoadError(false)
      setData(json.data || [])
      if (games) setRecordGames(games)
      if (json.available_batches) setAvailableBatches(json.available_batches)
      if (json.current_batch !== undefined) {
        setCurrentBatch(json.current_batch)
        if (!batchDefaultedRef.current) {
          batchDefaultedRef.current = true
          // Pre-select the team's current batch, but fall back to the most recent
          // batch with games (server-resolved default_batch) when current is empty.
          const def = json.default_batch !== undefined ? json.default_batch : json.current_batch
          if (def) setDefaultBatch(def)
        }
      }
    } catch {
      if (seq === fetchSeqRef.current) setLoadError(true)
    }
    setLoading(false)
  }, [filterCategory, filterBatch, filterMonth, isManager, userName])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Recorder options + YouTube uploaded map fetched once on mount.
  useEffect(() => {
    fetch('/api/team/recorders').then(r => r.ok ? r.json() : []).then(setRecorders).catch(() => {})
    fetch('/api/sheets/ytb-uploaded', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : [])
      .then((rows: YtbRow[]) => setYtRows(rows))
      .catch(() => {})
  }, [])

  // Auto-sync recorders from YouTube once per (category, batch): a game recorded
  // by someone other than the assignee (they uploaded directly) has its DB
  // recorder silently corrected to match the uploader (sheet `pic`). Managers
  // only — evaluators can't write and see only their own rows.
  useEffect(() => {
    if (!isManager) return
    const key = `${filterCategory}|${batchPick}`
    if (syncedKeyRef.current === key) return
    syncedKeyRef.current = key
    // The API scopes to one batch (or all). A month runs it once per batch of the
    // month, one after another, so it never touches games outside the view.
    const scopes: (string | undefined)[] = filterMonth
      ? batchLabelsOfMonth(filterMonth)
      : [filterBatch || undefined]
    let cancelled = false
    ;(async () => {
      let applied = 0
      let linksApplied = 0
      for (const batch of scopes) {
        try {
          const res = await fetch('/api/evaluations/reconcile-recorders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'apply', category: filterCategory === 'all' ? undefined : filterCategory, batch }),
          })
          if (cancelled) return
          if (!res.ok) continue
          const json = await res.json()
          applied += json.applied || 0
          linksApplied += json.links_applied || 0
        } catch { /* ignore */ }
      }
      if (cancelled || (!applied && !linksApplied)) return
      const parts = []
      if (applied) parts.push(`${applied} recorder${applied === 1 ? '' : 's'}`)
      if (linksApplied) parts.push(`${linksApplied} YouTube link${linksApplied === 1 ? '' : 's'}`)
      toast.success(`Updated ${parts.join(' and ')} from YouTube`)
      if (applied) fetchData()
    })()
    return () => { cancelled = true }
  }, [isManager, filterCategory, batchPick, filterBatch, filterMonth, fetchData])

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
  // Then take the row the server saved: it keeps a round that already has its
  // video (and the target's own recorder and Confirm), which the guess cannot know.
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
      const json = res.ok ? await res.json().catch(() => null) : null
      if (!json?.data) { await fetchData(); return }
      const saved = json.data as Partial<ShortListItem>
      setData(prev => prev.map(d => d.id === id ? {
        ...d,
        record_bucket: saved.record_bucket ?? null,
        record_5min_assignee: saved.record_5min_assignee ?? null,
        record_20min_assignee: saved.record_20min_assignee ?? null,
        record_confirmed_at: saved.record_confirmed_at ?? null,
      } : d))
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

  // Each game's YouTube upload: exact title+bucket first, then the closest
  // unclaimed upload (typo, dropped subtitle, wrong duration) — see lib/ytb-match.
  // Resolved over every Record-view game, not just this batch or recorder: an
  // upload is "unclaimed" only if no game anywhere in Record owns it. The rows on
  // screen override their entry so a drag to the other bucket re-matches at once.
  const ytMap = useMemo(() => {
    const games = new Map<number | string, YtGame>(recordGames.map(g => [g.key, g]))
    for (const d of data) {
      const known = games.get(d.id)
      games.set(d.id, { key: d.id, title: d.title, bucket: effectiveBucket(d), recorder: recorderOf(d), since: known?.since, heldVideo: known?.heldVideo })
    }
    return resolveYtMatches(Array.from(games.values()), ytRows)
  }, [recordGames, data, ytRows])

  // Split into the two buckets by effective bucket, then apply the status filter.
  const list5 = useMemo(() => data.filter(d => effectiveBucket(d) === '5min'), [data])
  const list20 = useMemo(() => data.filter(d => effectiveBucket(d) === '20min'), [data])

  const filterByStatus = useCallback((list: ShortListItem[]) => {
    if (!filterStatus) return list
    return list.filter(d => recordStatus(d, ytMap).status === filterStatus)
  }, [filterStatus, ytMap])

  // Always grouped by recorder (unassigned last), the same way Extract Chat groups
  // them; there is no toggle any more. Stable sort keeps the server's date order
  // within each recorder.
  const arrange = useCallback((list: ShortListItem[]) => {
    const filtered = filterByStatus(list)
    return [...filtered].sort((a, b) => {
      const ra = recorderOf(a).toLowerCase() || '￿'
      const rb = recorderOf(b).toLowerCase() || '￿'
      return ra < rb ? -1 : ra > rb ? 1 : 0
    })
  }, [filterByStatus])

  const shown5 = useMemo(() => arrange(list5), [arrange, list5])
  const shown20 = useMemo(() => arrange(list20), [arrange, list20])

  // Visible draft rows are the targets of Confirm Assign.
  const visibleDraftGames = useMemo(() => {
    return [...shown5, ...shown20].filter(d => recordStatus(d, ytMap).status === 'draft')
  }, [shown5, shown20, ytMap])
  const visibleDraftIds = useMemo(() => visibleDraftGames.map(d => d.id), [visibleDraftGames])

  // Games that have a recorder — fed to the Extract Chat modal.
  const assignedGames = useMemo(() =>
    data.filter(d => recorderOf(d)),
    [data]
  )

  const confirmAssign = useCallback(async () => {
    if (visibleDraftIds.length === 0) return
    setConfirming(true)
    const n = visibleDraftIds.length
    try {
      const res = await fetch('/api/evaluations/confirm-records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: visibleDraftIds }),
      })
      if (!res.ok) throw new Error()
      toast.success(`Confirmed ${n} game${n === 1 ? '' : 's'}: now Recording`)
      await fetchData()
    } catch {
      toast.error('Could not confirm the games.')
    }
    setConfirming(false)
    setShowConfirm(false)
  }, [visibleDraftIds, fetchData])

  // Batch filter options come straight from the server (all batches with games
  // in this view), newest first.
  const batchOptions = [...availableBatches].sort((a, b) => weekLabelOrder(b) - weekLabelOrder(a))
  if (currentBatch && !batchOptions.includes(currentBatch)) batchOptions.unshift(currentBatch)
  if (filterBatch && !batchOptions.includes(filterBatch)) batchOptions.unshift(filterBatch)
  // Add game needs one real batch. In a month view: the current batch when it is in
  // that month, else the month's newest batch with games, else its first batch.
  const monthLabels = filterMonth ? batchLabelsOfMonth(filterMonth) : []
  const addBatch = !filterMonth ? filterBatch
    : (currentBatch && monthLabels.includes(currentBatch)) ? currentBatch
      : (batchOptions.find(b => monthLabels.includes(b)) ?? monthLabels[0] ?? '')

  const totalShown = shown5.length + shown20.length

  // Status counts for the Seg: across both buckets, before the status filter.
  const statusCounts = useMemo(() => {
    const c: Record<RecordStatus, number> = { pending: 0, draft: 0, recording: 0, recorded: 0 }
    for (const d of data) c[recordStatus(d, ytMap).status]++
    return c
  }, [data, ytMap])
  const nDraft = visibleDraftGames.length
  const gamesWord = (n: number) => `${n} game${n === 1 ? '' : 's'}`

  const tableProps = {
    loading, isManager, recorders, onAssign: assignRecorder, onReset: resetRecording,
    ytMap, onClickGame: setDetailGameId, activeGameId: detailGameId,
    onRowDragStart: handleRowDragStart, confirmRemoveId,
    onRemoveRequest: setConfirmRemoveId, onConfirmRemove: removeGame,
    onCancelRemove: () => setConfirmRemoveId(null),
  }

  return (
    <div className="page rec-page">
      <PageHeader title="Record" sub="Assign recorders to games and follow each video to YouTube."
        actions={isManager ? <>
          <button type="button" className="btn btn-sm" onClick={() => setShowExtract(true)} disabled={assignedGames.length === 0}>
            Extract chat
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setShowConfirm(true)}
            disabled={confirming || nDraft === 0}
            title={nDraft === 0 ? 'No draft games in this view' : 'Draft → Recording'}>
            {confirming ? 'Confirming…' : `Confirm ${gamesWord(nDraft)}`}
          </button>
        </> : undefined} />

      <FilterBar className="rec-filters">
        <Seg ariaLabel="Category group" value={filterCategory} onChange={setCatParam}
          options={[{ value: 'all', label: 'All' }, ...BUCKETS.map(b => ({ value: b, label: CAT_LABEL(b) }))]} />
        <BatchPicker filter={batchParam !== ''} allowAll allowMonth current={currentBatch}
          ariaLabel="Batch" value={batchPick} onChange={setBatchPick} batches={batchOptions} width={160} />
        <Seg ariaLabel="Record status" value={filterStatus || 'all'}
          onChange={v => setStatusParam(v === 'all' ? '' : v)}
          options={[
            { value: 'all', label: 'All', count: data.length },
            ...(Object.keys(RECORD_STATUS_BADGE) as RecordStatus[]).map(k => ({
              value: k, label: RECORD_STATUS_BADGE[k].label, count: statusCounts[k],
            })),
          ]} />
        <FilterSpacer />
        <ClearFilters visible={filtersOn} onClear={clearFilters} />
        <FilterCount shown={totalShown} total={data.length} loading={loading && data.length === 0} />
      </FilterBar>

      {loadError && <ErrorState onRetry={fetchData}>Could not load the games.</ErrorState>}

      {/* Split tables: 5 MIN and 20 MIN (effective bucket) */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 16, overflow: 'hidden' }}>
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}
          onDragOver={isManager ? (e => { e.preventDefault(); if (dragOverBucket !== '5min') setDragOverBucket('5min') }) : undefined}
          onDragLeave={isManager ? (e => { if (e.currentTarget === e.target) setDragOverBucket(null) }) : undefined}
          onDrop={isManager ? (e => { e.preventDefault(); handleDrop('5min') }) : undefined}>
          <RecordTable label="5 MIN" items={shown5} {...tableProps}
            dragOver={dragOverBucket === '5min'}
            onHeaderAdd={() => setAddBucket('5min')} />
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}
          onDragOver={isManager ? (e => { e.preventDefault(); if (dragOverBucket !== '20min') setDragOverBucket('20min') }) : undefined}
          onDragLeave={isManager ? (e => { if (e.currentTarget === e.target) setDragOverBucket(null) }) : undefined}
          onDrop={isManager ? (e => { e.preventDefault(); handleDrop('20min') }) : undefined}>
          <RecordTable label="20 MIN" items={shown20} {...tableProps}
            dragOver={dragOverBucket === '20min'}
            onHeaderAdd={() => setAddBucket('20min')} />
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
          batch={addBatch}
          month={filterMonth}
          excludeGameIds={new Set(data.map(d => d.game_id))}
          targetBucket={addBucket}
          recorders={recorders}
          onAdded={fetchData}
          onClose={() => setAddBucket(null)}
        />
      )}

      {detailGameId && (
        <div className="eval-modal-backdrop" onClick={() => requestLeaveUnsaved(() => setDetailGameId(null))}>
          <div className="eval-modal-container" onClick={e => e.stopPropagation()}
            style={{ padding: '20px 24px 24px' }}>
            <EvalDetailPanel
              logContext="record"
              initialGameId={detailGameId}
              gameList={data.map(d => ({ game_id: d.game_id, title: d.title }))}
              category={filterCategory === 'all'
                ? data.find(d => d.game_id === detailGameId)?.category_group
                : filterCategory}
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
        <Modal title="Confirm assign" onClose={() => setShowConfirm(false)} busy={confirming} width={480}
          sub={`${gamesWord(nDraft)} · Draft → Recording`}
          footer={<>
            <button type="button" className="btn btn-sm" onClick={() => setShowConfirm(false)} disabled={confirming}>Cancel</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={confirmAssign} disabled={confirming || nDraft === 0}>
              {confirming ? 'Confirming…' : `Confirm ${gamesWord(nDraft)}`}
            </button>
          </>}>
          <div style={{ maxHeight: 'calc(70vh - 200px)', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
            {visibleDraftGames.map(g => (
              <div key={g.id} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                borderBottom: '1px solid var(--border)',
              }}>
                <span style={{ fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.title}</span>
                <span className="badge idle">{effectiveBucket(g) === '20min' ? '20 MIN' : '5 MIN'}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}><UserIcon />{recorderOf(g) || '—'}</span>
              </div>
            ))}
          </div>
        </Modal>
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
