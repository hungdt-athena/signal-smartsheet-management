'use client'
import { useState, useEffect, useCallback, useRef, useMemo, Suspense } from 'react'
import { useSession } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import { StyledSelect } from '@/components/StyledSelect'
import { MultiSelect } from '@/components/MultiSelect'
import { DateFilter, dateFilterParams, monthToValue, valueToYearMonth, valueLabel } from '@/components/DateFilter'
import type { YearMonth } from '@/components/DateFilter'
import { useDateFilter } from '@/hooks/useDateFilter'
import { useConfig } from '@/hooks/useConfig'
import EvalDetailPanel, { weekBatches } from '@/components/EvalDetailPanel'
import { QuickStatsModal } from '@/components/QuickStatsModal'
import { AssignSetup } from '@/components/AssignSetup'
import { BUCKETS, type Bucket } from '@/lib/buckets'
import type { EvalDetail, EvalListItem } from '@/components/EvalDetailPanel'

interface Evaluation {
  id: number
  game_id: string
  category_group: string
  genre_1: string | null
  genre_2: string | null
  initial_evaluator: string | null
  final_evaluator: string | null
  assigned_date: string | null
  evaluate_date: string | null
  initial_note: string | null
  initial_conclusion: string | null
  drive_link: string | null
  imported_at: string
  title: string
  os: string
  app_link: string
  icon_url: string | null
  release_date: string | null
  publisher_name: string | null
}


const CONCLUSION_COLORS: Record<string, string> = {
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

// Final Conclusion is the moderator's triage verdict (distinct from the
// evaluator's initial_conclusion). Options are managed from the Config tab
// (see useConfig); these are just the badge colors keyed by value.
const FINAL_CONCLUSION_STYLES: Record<string, { bg: string; color: string }> = {
  'Priority V':  { bg: '#ede9fe', color: '#6d28d9' },
  'Priority IV': { bg: '#0f766e', color: '#ffffff' },
  'Bypass':      { bg: '#d23b3b', color: '#ffffff' },
  'Theme/Art':   { bg: '#dbeafe', color: '#2563eb' },
  'Insight':     { bg: '#15803d', color: '#ffffff' },
  'Watch List':  { bg: '#dcfce7', color: '#16a34a' },
  'Not Found':   { bg: '#374151', color: '#e5e7eb' },
}

function osLabel(os: string) {
  const o = (os || '').toLowerCase()
  if (o === 'ios') return 'iOS'
  if (o === 'android') return 'Android'
  return os ? os.toUpperCase() : '—'
}

// Tiny per-cell copy button. Reveals on row hover; copies the given text
// (a URL for hyperlink cells, the displayed value otherwise).
function CopyBtn({ text }: { text: string | null | undefined }) {
  const [done, setDone] = useState(false)
  if (!text) return null
  return (
    <button
      type="button"
      className={`cell-copy${done ? ' done' : ''}`}
      title="Copy to clipboard"
      onClick={e => {
        e.stopPropagation()
        navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        }).catch(() => {})
      }}
    >
      {done ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

function FinalConclusionBadge({ value }: { value: string }) {
  const s = FINAL_CONCLUSION_STYLES[value] || { bg: 'var(--surface-3)', color: 'var(--muted)' }
  return (
    <span style={{
      display: 'inline-block', fontSize: 11, fontWeight: 700, padding: '3px 10px',
      borderRadius: 999, background: s.bg, color: s.color, whiteSpace: 'nowrap', lineHeight: 1.5,
    }}>{value}</span>
  )
}

interface ShortListItem {
  id: number
  game_id: string
  title: string
  icon_url: string | null
  os: string
  app_link: string | null
  genre_1: string | null
  genre_2: string | null
  initial_evaluator: string | null
  initial_note: string | null
  initial_conclusion: string | null
  final_conclusion: string | null
  batch: string | null
  drive_link: string | null
  publisher_name: string | null
  assigned_date: string | null
  evaluate_date: string | null
  category_group: string
}

function FinalConclusionCell({ item, isManager, options, onSaved }: {
  item: ShortListItem
  isManager: boolean
  options: string[]
  onSaved: (id: number, value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const val = item.final_conclusion

  const save = async (v: string) => {
    if (!v || v === val) { setEditing(false); return }
    setSaving(true)
    try {
      const res = await fetch('/api/evaluations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, final_conclusion: v }),
      })
      if (res.ok) onSaved(item.id, v)
    } catch { /* ignore */ }
    setSaving(false)
    setEditing(false)
  }

  // Native select used while editing — it reliably fires onBlur so the cell
  // never gets stuck in edit mode. Display state shows the colored badge.
  if (editing && isManager) {
    return (
      <select
        autoFocus
        className="input"
        style={{ fontSize: 11, padding: '3px 6px', minWidth: 130 }}
        defaultValue={val || ''}
        onChange={e => save(e.target.value)}
        onBlur={() => setEditing(false)}
        onClick={e => e.stopPropagation()}
        disabled={saving}
      >
        <option value="">— select —</option>
        {options.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
    )
  }

  return (
    <span
      onClick={e => { if (isManager) { e.stopPropagation(); setEditing(true) } }}
      title={isManager ? 'Click to set final conclusion' : undefined}
      style={{ cursor: isManager ? 'pointer' : 'default', display: 'inline-flex' }}
    >
      {val
        ? <FinalConclusionBadge value={val} />
        : <span style={{ fontSize: 12, color: isManager ? 'var(--accent)' : 'var(--faint)', fontWeight: isManager ? 600 : 400 }}>{isManager ? '+ set' : '—'}</span>}
    </span>
  )
}

// Demo Video cell with inline import. Games without a demo video show "+ Import";
// clicking reveals an input to paste a Drive/video link, saved via PATCH drive_link.
// Anyone who can see the row may attach a video (view is access-controlled upstream).
function DemoVideoCell({ item, onSaved }: {
  item: ShortListItem
  onSaved: (id: number, value: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(item.drive_link || '')
  const [saving, setSaving] = useState(false)

  const cancel = () => { setVal(item.drive_link || ''); setEditing(false) }

  const save = async () => {
    const v = val.trim()
    if (v === (item.drive_link || '')) { setEditing(false); return }
    setSaving(true)
    try {
      const res = await fetch('/api/evaluations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, drive_link: v || null }),
      })
      if (res.ok) onSaved(item.id, v || null)
    } catch { /* ignore */ }
    setSaving(false)
    setEditing(false)
  }

  if (editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={e => e.stopPropagation()}>
        <input
          autoFocus
          className="input"
          style={{ fontSize: 11, padding: '3px 6px', width: 150 }}
          placeholder="Paste video link…"
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel() }}
          disabled={saving}
        />
        <button className="btn btn-primary btn-sm" style={{ padding: '3px 7px', fontSize: 11 }} onClick={save} disabled={saving} title="Save link">✓</button>
        <button className="btn btn-ghost btn-sm" style={{ padding: '3px 6px', fontSize: 11 }} onClick={cancel} disabled={saving} title="Cancel">✕</button>
      </span>
    )
  }

  if (item.drive_link) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>
        <a href={item.drive_link} target="_blank" rel="noopener" onClick={e => e.stopPropagation()} className="drive-btn">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
          Video
        </a>
        <button className="cell-copy" title="Replace video link"
          onClick={e => { e.stopPropagation(); setVal(item.drive_link || ''); setEditing(true) }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </button>
        <CopyBtn text={item.drive_link} />
      </span>
    )
  }

  return (
    <button onClick={e => { e.stopPropagation(); setEditing(true) }}
      title="Import a demo video link"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', background: 'transparent',
        cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--accent)', padding: 0,
      }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
      </svg>
      Import
    </button>
  )
}

function ShortListEvalTab() {
  const { data: session } = useSession()
  const role = session?.user?.role
  const userName = session?.user?.name || ''
  const isManager = role === 'admin' || role === 'moderator'
  const { final_conclusion: finalConclusionOptions } = useConfig()

  const [data, setData] = useState<ShortListItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [availableEvaluators, setAvailableEvaluators] = useState<string[]>([])
  const [filterCategory, setFilterCategory] = useState('puzzle')
  const [filterConclusions, setFilterConclusions] = useState<string[]>(['List_Idea'])
  const [availableConclusions, setAvailableConclusions] = useState<string[]>(CONCLUSION_OPTIONS)
  const [filterEvaluator, setFilterEvaluator] = useState('')
  const [filterBatch, setFilterBatch] = useState('')
  const [currentBatch, setCurrentBatch] = useState<string | null>(null)
  // Short List groups by when games were evaluated → default basis = evaluated.
  const df = useDateFilter('evaluated')
  const [sortAsc, setSortAsc] = useState(true)
  const fetchSeqRef = useRef(0)
  const [detailGameId, setDetailGameId] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    const seq = ++fetchSeqRef.current
    setLoading(true)
    try {
      const params = new URLSearchParams({ category: filterCategory, limit: '500' })
      params.set('sort', sortAsc ? 'asc' : 'desc')
      if (filterConclusions.length > 0) params.set('conclusions', filterConclusions.join(','))
      if (filterEvaluator) params.set('evaluator', filterEvaluator)
      for (const [k, v] of Object.entries(dateFilterParams(df.value, df.autoMonth))) params.set(k, v)
      const res = await fetch(`/api/evaluations?${params}`)
      const json = await res.json()
      if (seq !== fetchSeqRef.current) return
      setData(json.data || [])
      setTotal(json.total || 0)
      if (json.available_months) df.setAvailableMonths(json.available_months)
      if (json.available_evaluators) setAvailableEvaluators(json.available_evaluators)
      if (json.current_batch !== undefined) setCurrentBatch(json.current_batch)
      if (df.autoMonth && json.applied_month !== undefined) {
        const ap = json.applied_month as YearMonth | null
        df.suppressFetchRef.current = true
        df.setAutoMonth(false)
        df.setValue(v => ap ? monthToValue(ap, v.basis) : { ...v, from: null, to: null })
      }
      if (json.available_conclusions?.length) {
        const merged = Array.from(new Set([...json.available_conclusions, ...filterConclusions]))
        setAvailableConclusions(CONCLUSION_OPTIONS.filter(c => merged.includes(c)).concat(merged.filter(c => !CONCLUSION_OPTIONS.includes(c))))
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [filterCategory, filterConclusions, filterEvaluator, df.value, df.autoMonth, sortAsc])

  useEffect(() => {
    if (df.suppressFetchRef.current) { df.suppressFetchRef.current = false; return }
    fetchData()
  }, [fetchData])

  const handleFinalConclusionSaved = (id: number, value: string) => {
    setData(prev => prev.map(d => d.id === id ? { ...d, final_conclusion: value } : d))
  }

  const handleDriveLinkSaved = (id: number, value: string | null) => {
    setData(prev => prev.map(d => d.id === id ? { ...d, drive_link: value } : d))
  }

  // Batch filter options follow the month in the picker (UI-generated W1-W4).
  const filterYM = valueToYearMonth(df.value)
  const batchOptions = filterYM ? weekBatches(filterYM.year, filterYM.month) : []
  // "All batches" = overall view; otherwise filter client-side on loaded rows.
  const shown = filterBatch ? data.filter(d => d.batch === filterBatch) : data

  // Manager control: set the team's current batch. Offer this + next calendar
  // month's weeks so W4→W1-next-month rollover (after the 28th) is one click.
  const saveCurrentBatch = async (v: string) => {
    setCurrentBatch(v || null)
    try {
      await fetch('/api/evaluations/current-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: filterCategory, batch: v || null }),
      })
    } catch { /* ignore */ }
  }
  const currentBatchOptions = (() => {
    const now = new Date()
    const y = now.getFullYear(), m = now.getMonth() + 1
    const nextY = m === 12 ? y + 1 : y
    const nextM = m === 12 ? 1 : m + 1
    const opts = [...weekBatches(y, m), ...weekBatches(nextY, nextM)]
    if (currentBatch && !opts.includes(currentBatch)) opts.unshift(currentBatch)
    return opts
  })()

  return (
    <div className="page" style={{ paddingBottom: 16, height: '100vh', boxSizing: 'border-box', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="page-head" style={{ marginBottom: 10, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 className="h-title">Short List</h1>
          <p className="h-sub">{total} games · {filterCategory}{filterBatch ? ` · ${filterBatch}` : ''}</p>
        </div>
        {isManager && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Current batch</span>
              <span style={{ fontSize: 10.5, color: 'var(--faint)' }}>evaluators auto-fill this for List_Idea</span>
            </div>
            <div style={{ width: 170 }}>
              <StyledSelect
                value={currentBatch || ''}
                onChange={saveCurrentBatch}
                placeholder="Not set"
                options={[{ value: '', label: '— none —' }, ...currentBatchOptions.map(b => ({ value: b, label: b }))]}
              />
            </div>
          </div>
        )}
      </div>

      <div className="filter-row" style={{ position: 'relative', zIndex: 30 }}>
        <DateFilter value={df.value}
          onChange={v => { df.setAutoMonth(false); df.setValue(v) }} />

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

        <div style={{ width: 180 }}>
          <StyledSelect
            value={filterEvaluator}
            onChange={setFilterEvaluator}
            placeholder="All evaluators"
            options={[{ value: '', label: 'All evaluators' }, ...availableEvaluators.map(e => ({ value: e, label: e }))]}
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

        <div style={{ width: 200 }}>
          <MultiSelect
            value={filterConclusions}
            onChange={setFilterConclusions}
            placeholder="Conclusions"
            options={availableConclusions.map(c => ({ value: c, label: c }))}
          />
        </div>

        <button
          className="btn btn-sm"
          title={sortAsc ? 'Sorted oldest first — click to sort newest first' : 'Sorted newest first — click to sort oldest first'}
          onClick={() => setSortAsc(v => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
          {sortAsc ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          )}
          {sortAsc ? 'Oldest first' : 'Newest first'}
        </button>

        <span className="sync" style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600 }}>
          {loading ? 'Loading...' : `${shown.length}${filterBatch ? ` / ${data.length}` : ''} results`}
        </span>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="tbl-wrap" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <table className="tbl">
            <thead style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface)', boxShadow: '0 1px 0 var(--border)' }}>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th>Game</th>
                <th style={{ width: 110 }}>Link</th>
                <th style={{ width: 150 }}>Final Conclusion</th>
                <th style={{ width: 90 }}>Demo Video</th>
                <th>Note</th>
                <th style={{ width: 96 }}>Assigned</th>
                <th style={{ width: 96 }}>Evaluated</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && !loading && (
                <tr><td colSpan={8} className="empty">No games found</td></tr>
              )}
              {loading && Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 8 }).map((__, c) => (
                  <td key={c}><span className="skeleton" style={{ width: [30, 200, 70, 110, 60, 160, 80, 80][c] || 80, height: 14 }} /></td>
                ))}</tr>
              ))}
              {shown.map((item, idx) => (
                <tr key={item.id} className="tbl-row-premium" style={{ cursor: 'pointer' }}
                  onClick={() => setDetailGameId(item.game_id)}>
                  <td className="num" style={{ color: 'var(--faint)', fontSize: 12 }}>{idx + 1}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 200 }}>
                      {item.icon_url ? (
                        <img src={item.icon_url} alt="" width={30} height={30} style={{ borderRadius: 7, flexShrink: 0 }} />
                      ) : (
                        <div style={{ width: 30, height: 30, borderRadius: 7, background: 'var(--surface-3)', flexShrink: 0 }} />
                      )}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                          <span className="cell-name" style={{ fontSize: 13, lineHeight: 1.3 }}>{item.title}</span>
                          <CopyBtn text={item.title} />
                        </div>
                        <div style={{ display: 'flex', gap: 4, marginTop: 2, flexWrap: 'wrap', alignItems: 'center' }}>
                          {item.batch && (
                            <span className="pill" style={{ padding: '1px 6px', fontSize: 9, fontWeight: 700, background: 'var(--accent-weak)', color: 'var(--accent)', border: '1px solid var(--accent-border)' }}>{item.batch}</span>
                          )}
                          {[item.genre_1, item.genre_2].filter(Boolean).map(g => (
                            <span key={g} className="pill tag" style={{ padding: '1px 5px', fontSize: 9 }}>{g}</span>
                          ))}
                          {item.initial_conclusion
                            ? <span className={`badge ${CONCLUSION_COLORS[item.initial_conclusion] || 'neutral'}`} style={{ fontSize: 9 }}>{item.initial_conclusion}</span>
                            : <span className="badge idle" style={{ fontSize: 9 }}>Pending</span>}
                          {item.initial_evaluator && (
                            <span style={{ fontSize: 10.5, color: 'var(--faint)', fontWeight: 600 }}>{item.initial_evaluator}</span>
                          )}
                        </div>
                        {item.publisher_name && (
                          <div style={{ display: 'flex', alignItems: 'center', marginTop: 2 }}>
                            <span style={{ fontSize: 11, color: 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }}
                              title={item.publisher_name}>
                              {item.publisher_name}
                            </span>
                            <CopyBtn text={item.publisher_name} />
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                      {item.app_link ? (
                        <a href={item.app_link} target="_blank" rel="noopener" onClick={e => e.stopPropagation()}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, fontWeight: 600, color: 'var(--accent)', textDecoration: 'none' }}>
                          {osLabel(item.os)}
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" />
                          </svg>
                        </a>
                      ) : (
                        <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>{osLabel(item.os)}</span>
                      )}
                      <CopyBtn text={item.app_link} />
                    </span>
                  </td>
                  <td onClick={e => e.stopPropagation()}>
                    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                      <FinalConclusionCell item={item} isManager={isManager} options={finalConclusionOptions} onSaved={handleFinalConclusionSaved} />
                      <CopyBtn text={item.final_conclusion} />
                    </span>
                  </td>
                  <td onClick={e => e.stopPropagation()}>
                    <DemoVideoCell item={item} onSaved={handleDriveLinkSaved} />
                  </td>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', maxWidth: 260 }}>
                      <span title={item.initial_note || undefined}
                        style={{ fontSize: 12, color: item.initial_note ? 'var(--text)' : 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: item.initial_note ? 'help' : undefined }}>
                        {item.initial_note || '—'}
                      </span>
                      <CopyBtn text={item.initial_note} />
                    </span>
                  </td>
                  <td className="num" style={{ fontSize: 12, whiteSpace: 'nowrap', color: 'var(--faint)' }}>
                    {fmtDate(item.assigned_date)}
                  </td>
                  <td className="num" style={{ fontSize: 12, whiteSpace: 'nowrap', color: 'var(--faint)' }}>
                    {fmtDate(item.evaluate_date)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
              hideRecordSections
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

function conclusionBadge(c: string | null) {
  if (!c) return <span className="badge idle">Pending</span>
  return <span className={`badge ${CONCLUSION_COLORS[c] || 'neutral'}`}>{c}</span>
}

function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

const PAGE_SIZE = 200

// useSearchParams requires a Suspense boundary for static prerendering.
export default function EvaluationsPage() {
  return (
    <Suspense>
      <EvaluationsRouter />
    </Suspense>
  )
}

// Dispatch on category at the top level so Short List and the standard tab are
// separate component subtrees — switching between them mounts/unmounts cleanly
// (no rules-of-hooks violation from a conditional early return mid-component).
function EvaluationsRouter() {
  const searchParams = useSearchParams()
  const category = searchParams.get('cat') || 'puzzle'
  if (category === 'assign_setup') return <AssignSetup />
  return category === 'short_list' ? <ShortListEvalTab /> : <EvaluationsPageInner />
}

function EvaluationsPageInner() {
  const { data: session } = useSession()
  const role = session?.user?.role
  const userName = session?.user?.name || ''

  // The three buckets are merged into one "Evaluate" tab; the active bucket is
  // in-page state (was the ?cat= query param when each bucket had its own nav entry).
  const [category, setCategory] = useState<Bucket>('puzzle')

  const [data, setData] = useState<Evaluation[]>([])
  const [total, setTotal] = useState(0)
  const [conclusionOptions, setConclusionOptions] = useState<string[]>([])
  const [evaluatorOptions, setEvaluatorOptions] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)

  const [filterEvaluator, setFilterEvaluator] = useState('')
  const [filterConclusion, setFilterConclusion] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [sortAsc, setSortAsc] = useState(true)
  // Standard evaluators tab tracks when work was assigned → default basis =
  // assigned. First load sends month=auto; the server resolves the default month
  // (current month, falling back to latest with data) and echoes it back.
  const df = useDateFilter('assigned')
  const fetchSeqRef = useRef(0)

  const [search, setSearch] = useState('')
  const [tableExpanded, setTableExpanded] = useState(false)
  const [showQuickStats, setShowQuickStats] = useState(false)
  const [detailGameId, setDetailGameId] = useState<string | null>(null)
  const [detailList, setDetailList] = useState<EvalListItem[]>([])
  const [activeGameId, setActiveGameId] = useState<string | null>(null)
  const activeRowRef = useRef<HTMLTableRowElement | null>(null)

  const [apiStats, setApiStats] = useState({ total: 0, evaluated: 0, pending: 0 })
  const stats = useMemo(() => ({
    totalCount: apiStats.total,
    evaluatedCount: apiStats.evaluated,
    pendingCount: apiStats.pending,
    percent: apiStats.total > 0 ? Math.round((apiStats.evaluated / apiStats.total) * 100) : 0,
  }), [apiStats])

  const pageRef = useRef(1)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const fetchPage = useCallback(async (page: number, append: boolean) => {
    const seq = ++fetchSeqRef.current
    if (append) setLoadingMore(true); else setLoading(true)
    try {
      const params = new URLSearchParams({ category, page: String(page), limit: String(PAGE_SIZE) })
      const isManager = role === 'admin' || role === 'moderator'
      if (!isManager) {
        if (userName) params.set('evaluator', userName)
      } else if (filterEvaluator) {
        params.set('evaluator', filterEvaluator)
      }
      if (filterConclusion) params.set('conclusion', filterConclusion)
      if (filterStatus) params.set('status', filterStatus)
      params.set('sort', sortAsc ? 'asc' : 'desc')
      for (const [k, v] of Object.entries(dateFilterParams(df.value, df.autoMonth))) params.set(k, v)
      const res = await fetch(`/api/evaluations?${params}`)
      const json = await res.json()
      if (seq !== fetchSeqRef.current) return // stale response; a newer fetch owns the state
      const rows = json.data || []
      if (append) {
        setData(prev => [...prev, ...rows])
      } else {
        setData(rows)
      }
      if (json.total !== undefined) setTotal(json.total)
      if (json.stats) setApiStats(json.stats)
      if (json.available_conclusions) setConclusionOptions(json.available_conclusions)
      if (json.available_evaluators) setEvaluatorOptions(json.available_evaluators)
      if (json.available_months) df.setAvailableMonths(json.available_months)
      if (df.autoMonth && json.applied_month !== undefined) {
        // Lock in the server-resolved month: the picker shows it and all
        // later fetches use explicit params instead of re-resolving auto.
        const ap = json.applied_month as YearMonth | null
        df.suppressFetchRef.current = true
        df.setAutoMonth(false)
        df.setValue(v => ap ? monthToValue(ap, v.basis) : { ...v, from: null, to: null })
      }
      setHasMore(rows.length === PAGE_SIZE)
    } catch { /* ignore */ }
    setLoading(false)
    setLoadingMore(false)
  }, [category, filterEvaluator, filterConclusion, filterStatus, df.value, df.autoMonth, role, userName, sortAsc])

  useEffect(() => {
    if (df.suppressFetchRef.current) {
      df.suppressFetchRef.current = false
      return
    }
    pageRef.current = 1
    fetchPage(1, false)
  }, [fetchPage])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore && !loading && !loadingMore) {
        pageRef.current += 1
        fetchPage(pageRef.current, true)
      }
    }, { rootMargin: '200px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loading, loadingMore, fetchPage])

  const filtered = useMemo(() => {
    if (!search.trim()) return data
    const q = search.toLowerCase()
    return data.filter(d => d.title.toLowerCase().includes(q) || d.game_id.toLowerCase().includes(q))
  }, [data, search])

  // Server-provided full list for the category (ignores month + pagination);
  // fall back to deriving from loaded rows until the first page-1 response lands.
  const evaluators = evaluatorOptions.length > 0
    ? evaluatorOptions
    : Array.from(new Set(data.map(d => d.initial_evaluator).filter(Boolean) as string[]))

  const openDetail = (gameId: string) => {
    const list = filtered.map(d => ({ game_id: d.game_id, title: d.title }))
    setDetailList(list)
    setDetailGameId(gameId)
    setActiveGameId(gameId)
  }

  const handleNavigate = (gameId: string) => {
    setActiveGameId(gameId)
  }

  const handleClose = () => {
    setDetailGameId(null)
    // activeGameId remains set so the row stays highlighted after close
    // Scroll the highlighted row into view
    setTimeout(() => {
      activeRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 50)
  }

  return (
    <div className="page" style={{ paddingBottom: 16, height: '100vh', boxSizing: 'border-box', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h1 className="h-title">Evaluations</h1>
          <p className="h-sub">
            {total} games · {category}
            {df.value.from ? ` · ${valueLabel(df.value)}` : ''}
            {role !== 'admin' && role !== 'moderator' && userName ? ` · ${userName}` : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {BUCKETS.map(b => (
            <button key={b} className={`seg-btn-premium${category === b ? ' active' : ''}`}
              onClick={() => setCategory(b)}>
              {b.charAt(0).toUpperCase() + b.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Summary Stats Widgets */}
      <div className="stats-grid" style={{ display: tableExpanded ? 'none' : undefined }}>
        <div className="stat-card">
          <span className="stat-label">Total Games</span>
          <div className="stat-val">{stats.totalCount}</div>
          <span className="stat-subtext">Listed in database</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Evaluated</span>
          <div className="stat-val">
            {stats.evaluatedCount}
            <span className="pill success" style={{ fontSize: 10, padding: '2px 6px', marginLeft: 8 }}>{stats.percent}%</span>
          </div>
          <span className="stat-subtext">Completed reviews</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Pending</span>
          <div className="stat-val" style={{ color: stats.pendingCount > 0 ? 'var(--warn)' : 'var(--text)' }}>
            {stats.pendingCount}
          </div>
          <span className="stat-subtext">Awaiting evaluation</span>
        </div>
        <div className="stat-card" role="button" tabIndex={0}
          onClick={() => setShowQuickStats(true)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setShowQuickStats(true) }}
          style={{ cursor: 'pointer' }}>
          <span className="stat-label">Quick Stats</span>
          <div className="stat-val" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--accent)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="20" x2="18" y2="10" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="6" y1="20" x2="6" y2="14" />
            </svg>
            View
          </div>
          <span className="stat-subtext">Per-evaluator breakdown</span>
        </div>
      </div>

      {/* Filters */}
      <div className="filter-row" style={{ position: 'relative', zIndex: 30, display: tableExpanded ? 'none' : undefined }}>
        <div className="search-wrap">
          <span className="search-icon-abs">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
          </span>
          <input className="search-input" placeholder="Search games..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>

        <DateFilter
          value={df.value}
          onChange={v => { df.setAutoMonth(false); df.setValue(v) }}
        />

        <div className="seg-wrapper">
          {[
            { value: '', label: 'All' },
            { value: 'pending', label: 'Pending' },
            { value: 'done', label: 'Done' },
          ].map(s => (
            <button key={s.value} className={`seg-btn-premium${filterStatus === s.value ? ' active' : ''}`}
              onClick={() => setFilterStatus(s.value)}>
              {s.label}
            </button>
          ))}
        </div>

        <button
          className="btn btn-sm"
          title={sortAsc ? 'Sorted oldest first — click to sort newest first' : 'Sorted newest first — click to sort oldest first'}
          onClick={() => { setSortAsc(v => !v); pageRef.current = 1 }}
          style={{ display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
          {sortAsc ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          )}
          {sortAsc ? 'Oldest first' : 'Newest first'}
        </button>

        {(role === 'admin' || role === 'moderator') && (
          <div style={{ width: 180 }}>
            <StyledSelect
              value={filterEvaluator}
              onChange={setFilterEvaluator}
              placeholder="All evaluators"
              options={[{ value: '', label: 'All evaluators' }, ...evaluators.map(e => ({ value: e, label: e }))]}
            />
          </div>
        )}

        <div style={{ width: 220 }}>
          <StyledSelect
            value={filterConclusion}
            onChange={setFilterConclusion}
            placeholder="All conclusions"
            options={[{ value: '', label: 'All conclusions' }, ...conclusionOptions.map(c => ({ value: c, label: c }))]}
          />
        </div>

        <span className="sync" style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600 }}>{loading ? 'Loading...' : `${filtered.length}${search ? ` / ${total}` : ''} results`}</span>
      </div>

      {/* Table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Expand/collapse toggle */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '4px 8px 0', flexShrink: 0 }}>
          <button
            className="btn btn-ghost btn-sm"
            title={tableExpanded ? 'Show filters' : 'Expand table'}
            onClick={() => setTableExpanded(v => !v)}
            style={{ padding: '3px 8px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
            {tableExpanded ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 15l6-6 6 6" />
                </svg>
                Show filters
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 9l6 6 6-6" />
                </svg>
                Expand table
              </>
            )}
          </button>
        </div>
        <div className="tbl-wrap" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <table className="tbl">
            <thead style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface)', boxShadow: '0 1px 0 var(--border)' }}>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th>Game</th>
                <th>Initial</th>
                <th>Final</th>
                <th>Assigned</th>
                <th>Note</th>
                <th>Conclusion</th>
                <th>Evaluated</th>
                <th>Drive</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && !loading && (
                <tr><td colSpan={9} className="empty">{search ? 'No games match your search' : 'No evaluations found'}</td></tr>
              )}
              {filtered.map((ev, idx) => {
                const genres = [ev.genre_1, ev.genre_2].filter(Boolean) as string[]
                const isActive = ev.game_id === activeGameId
                return (
                  <tr key={ev.id}
                    ref={isActive ? activeRowRef : null}
                    className={`tbl-row-premium${isActive ? ' tbl-row-active' : ''}`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => openDetail(ev.game_id)}>
                    <td className="num" style={{ color: 'var(--faint)', fontSize: 12 }}>
                      {idx + 1}
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 220 }}>
                        {ev.icon_url ? (
                          <img src={ev.icon_url} alt="" width={32} height={32}
                            style={{ borderRadius: 7, flexShrink: 0 }} />
                        ) : (
                          <div style={{ width: 32, height: 32, borderRadius: 7, background: 'var(--surface-3)', flexShrink: 0 }} />
                        )}
                        <div style={{ minWidth: 0 }}>
                          <div className="cell-name" style={{ fontSize: 13, lineHeight: 1.3 }}>{ev.title}</div>
                          <div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
                            <span className="pill muted" style={{ padding: '1px 6px', fontSize: 10 }}>
                              {ev.os?.toUpperCase()}
                            </span>
                            {genres.map(g => (
                              <span key={g} className="pill tag" style={{ padding: '1px 6px', fontSize: 10 }}>
                                {g}
                              </span>
                            ))}
                          </div>
                          {ev.publisher_name && (
                            <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {ev.publisher_name}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', color: ev.initial_evaluator ? 'var(--text)' : 'var(--faint)' }}>
                      {ev.initial_evaluator || '—'}
                    </td>
                    <td style={{ fontSize: 12.5, whiteSpace: 'nowrap', color: ev.final_evaluator ? 'var(--text)' : 'var(--faint)' }}>
                      {ev.final_evaluator || '—'}
                    </td>
                    <td className="num" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                      {fmtDate(ev.assigned_date)}
                    </td>
                    <td>
                      <div style={{ fontSize: 12, color: ev.initial_note ? 'var(--text)' : 'var(--faint)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ev.initial_note || '—'}
                      </div>
                    </td>
                    <td>{conclusionBadge(ev.initial_conclusion)}</td>
                    <td className="num" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                      {fmtDate(ev.evaluate_date)}
                    </td>
                    <td>
                      {ev.drive_link ? (
                        <a href={ev.drive_link} target="_blank" rel="noopener"
                          onClick={e => e.stopPropagation()}
                          className="drive-btn">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="23 7 16 12 23 17 23 7" />
                            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                          </svg>
                          Video
                        </a>
                      ) : (
                        <span style={{ fontSize: 12, color: 'var(--faint)' }}>—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div ref={sentinelRef} style={{ height: 1 }} />
          {loadingMore && (
            <div style={{ textAlign: 'center', padding: '12px 0', fontSize: 12, color: 'var(--faint)' }}>
              Loading more...
            </div>
          )}
        </div>
      </div>

      {/* Quick Stats Modal */}
      {showQuickStats && (
        <QuickStatsModal
          category={category}
          month={valueToYearMonth(df.value)}
          onClose={() => setShowQuickStats(false)}
        />
      )}

      {/* Detail Modal */}
      {detailGameId && (
        <div className="eval-modal-backdrop" onClick={handleClose}>
          <div className="eval-modal-container" onClick={e => e.stopPropagation()}
            style={{ padding: '20px 24px 24px' }}>
            <EvalDetailPanel
              initialGameId={detailGameId}
              gameList={detailList}
              role={role}
              userName={userName}
              hideRecordSections={false}
              onClose={handleClose}
              onNavigate={handleNavigate}
              onSaved={(fresh: EvalDetail) => {
                setData(prev => prev.map(d => d.game_id === fresh.game_id
                  ? { ...d, initial_conclusion: fresh.initial_conclusion, initial_note: fresh.initial_note, evaluate_date: fresh.evaluate_date, drive_link: fresh.drive_link }
                  : d
                ))
              }}
            />
          </div>
        </div>
      )}

    </div>
  )
}
