'use client'
import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { useSession } from 'next-auth/react'
import { StyledSelect } from '@/components/StyledSelect'
import { PageHeader } from '@/components/ui/PageHeader'
import { Seg, type SegOption } from '@/components/ui/Seg'
import { FilterBar, FilterSpacer, ClearFilters, FilterCount } from '@/components/ui/FilterBar'
import { SearchInput } from '@/components/ui/SearchInput'
import { Switch } from '@/components/ui/Switch'
import { CloseButton } from '@/components/ui/CloseButton'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/ui/States'
import { registerUnsavedGuard } from '@/lib/unsaved-guard'
import { useUrlState, useSetUrlParams } from '@/lib/use-url-state'
import { fmtDateTimeVN } from '@/lib/format-date'
import { SectionEditor } from './SectionEditor'
import { FeedbackView, FeedbackCell, AlikeCell } from './FeedbackView'
import { weekLabelOrder } from '@/lib/weekly-feedback'
import { Section, newSection } from './types'
import { isManagerRole } from '@/lib/roles'

interface WeeklyRecord { batch: string; evaluator: string; sections: Section[]; updated_at: string }
interface Snapshot { id: number; sections: Section[]; saved_at: string }

// --- Plain-text helpers for search + summaries (walk the Tiptap doc + alikes) ---
function docText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const n = node as { text?: string; type?: string; attrs?: { title?: string }; content?: unknown[] }
  let s = typeof n.text === 'string' ? n.text : ''
  if (n.type === 'gameMention' && n.attrs?.title) s += ' ' + n.attrs.title
  if (Array.isArray(n.content)) s += ' ' + n.content.map(docText).join(' ')
  return s
}
function sectionText(s: Section): string {
  const games = (s.alikes || []).map(b => `${b.name} ${b.games.map(g => g.title).join(' ')}`).join(' ')
  return `${docText(s.feedback)} ${games}`
}
function recordMatches(r: WeeklyRecord, q: string): boolean {
  if (r.evaluator.toLowerCase().includes(q) || r.batch.toLowerCase().includes(q)) return true
  return (r.sections || []).some(s => sectionText(s).toLowerCase().includes(q))
}
function gameCount(s: Section): number { return (s.alikes || []).reduce((n, b) => n + b.games.length, 0) }
// Deterministic hue (0–359) from the evaluator name — maps onto the full HSL
// hue wheel (continuous, no fixed palette), so any number of evaluators get
// spread-out colors that never "run out". Same name → same color everywhere.
function evalHue(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return (h % 360)
}
function firstLine(s: Section): string { return docText(s.feedback).trim().split('\n')[0].slice(0, 80) || '(no feedback)' }
// A section/record is "empty" when there's no feedback text AND no game-alike
// (a named block or any game). Such records are hidden in the Overview (treated
// as if they don't exist) and mark a batch card as not-yet-written in the Editor.
function isEmptySection(s: Section): boolean {
  const hasText = docText(s.feedback).trim() !== ''
  const hasAlike = (s.alikes || []).some(b => (b?.name?.trim() ?? '') !== '' || (b?.games?.length ?? 0) > 0)
  return !hasText && !hasAlike
}
function isEmptyRecord(r: WeeklyRecord): boolean {
  const secs = r.sections || []
  return secs.length === 0 || secs.every(isEmptySection)
}
const MONTH_ABBR = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// Parse a "W<week> <Month>, <Year>" label into its parts, for the year→month→week
// grouping of the Editor's batch cards. Returns null for unparseable labels.
function parseBatch(label: string): { year: number; week: number; monthAbbr: string } | null {
  const m = (label || '').trim().match(/^W(\d+)\s+([A-Za-z]+),\s*(\d{4})$/i)
  if (!m) return null
  const idx = MONTH_ABBR.findIndex(x => x.toLowerCase() === m[2].slice(0, 3).toLowerCase())
  return { week: parseInt(m[1], 10), monthAbbr: idx > 0 ? MONTH_ABBR[idx] : m[2], year: parseInt(m[3], 10) }
}
// Group already-sorted (newest→oldest) batch labels into year → month → weeks.
// Unparseable labels collect under `other`. Insertion order preserves the sort.
function groupByCalendar(labels: string[]) {
  const years: { year: number; months: { label: string; batches: string[] }[] }[] = []
  const other: string[] = []
  for (const b of labels) {
    const p = parseBatch(b)
    if (!p) { other.push(b); continue }
    let yg = years.find(y => y.year === p.year)
    if (!yg) { yg = { year: p.year, months: [] }; years.push(yg) }
    let mg = yg.months.find(m => m.label === p.monthAbbr)
    if (!mg) { mg = { label: p.monthAbbr, batches: [] }; yg.months.push(mg) }
    mg.batches.push(b)
  }
  return { years, other }
}

type View = 'overview' | 'editor'
const VIEWS: SegOption<View>[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'editor', label: 'Editor' },
]

export function WeeklyFeedbackTab() {
  const { data: session } = useSession()
  const role = session?.user?.role
  const isManager = isManagerRole(role)
  const userName = session?.user?.name || ''

  // The view and the filters live in the URL, so a reload or a shared link opens
  // the same view. Overview filters (batch, ev, q) and the Editor's picks (edit,
  // who) use separate keys: opening one evaluator's batch in the Editor must not
  // narrow the Overview the reader comes back to.
  const [viewParam, setView] = useUrlState('view', 'overview')
  const view: View = viewParam === 'editor' ? 'editor' : 'overview'
  const setUrlParams = useSetUrlParams()

  const [batches, setBatches] = useState<string[]>([])      // weeks that HAVE feedback (Overview filter)
  const [allBatches, setAllBatches] = useState<string[]>([]) // full universe (Editor cards + week picker)
  const [evaluators, setEvaluators] = useState<string[]>([])
  const [filledBatches, setFilledBatches] = useState<Set<string>>(new Set()) // batches the editor's evaluator has non-empty feedback for

  // Editor picks (managers can view another evaluator's week).
  const [whoParam, setEvaluator] = useUrlState('who', '') // '' = my own
  const evaluator = isManager ? whoParam : ''
  const [selectedBatch, setSelectedBatch] = useUrlState('edit', '')

  // Overview filters + view options.
  const [listBatch, setListBatch] = useUrlState('batch', '')
  const [evParam, setListEvaluator] = useUrlState('ev', '')
  const listEvaluator = isManager ? evParam : ''
  // Search keeps its own text while typing and writes ?q= once typing pauses.
  const [qParam, setQParam] = useUrlState('q', '')
  const [query, setQuery] = useState(qParam)
  const qWritten = useRef(qParam)
  useEffect(() => {
    // The URL changed under the box (Clear filters, Back). Our own write is skipped.
    if (qParam === qWritten.current) return
    qWritten.current = qParam
    setQuery(qParam)
  }, [qParam])
  useEffect(() => {
    if (query === qWritten.current) return
    const t = setTimeout(() => { qWritten.current = query; setQParam(query) }, 300)
    return () => clearTimeout(t)
  }, [query, setQParam])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({}) // collapsed weeks (Overview)
  const [collapsedSecs, setCollapsedSecs] = useState<Record<string, boolean>>({}) // collapsed sections (Editor)

  const [sections, setSections] = useState<Section[]>([])
  const [records, setRecords] = useState<WeeklyRecord[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listFailed, setListFailed] = useState(false)
  const [listReload, setListReload] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [autoSave, setAutoSave] = useState(true)
  const dirtyRef = useRef(false)
  const dragFrom = useRef<number | null>(null)
  // When we open a week straight from a list row we already hold its sections —
  // seed them and skip exactly one network load so the editor never flashes empty.
  const preseeded = useRef<string | null>(null)

  const [historyOpen, setHistoryOpen] = useState(false)
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [previewSnap, setPreviewSnap] = useState<Snapshot | null>(null) // history preview before restore
  const [historyVisible, setHistoryVisible] = useState(5) // lazy-scroll page size

  const viewingSelf = !isManager || !evaluator || evaluator.toLowerCase() === userName.toLowerCase()

  useEffect(() => {
    fetch('/api/weekly-feedback/batches')
      .then(r => r.json())
      .then(d => {
        setBatches(d.batches || [])
        setAllBatches(d.allBatches || d.batches || [])
        if (isManager) setEvaluators(Array.isArray(d.evaluators) ? d.evaluators : [])
      })
      .catch(() => { setBatches([]); setAllBatches([]); setEvaluators([]) })
  }, [isManager])

  // Editor landing: which batches the editor's evaluator already has non-empty
  // feedback for — drives the card bold (filled) vs faint "add…" (empty) styling.
  useEffect(() => {
    // Only on the landing (no week selected). Refetches each time the picker is
    // cleared back to cards, so a just-saved batch flips from faint to bold.
    if (view !== 'editor' || selectedBatch) return
    const qs = new URLSearchParams({ list: '1' })
    // Scope to the editor's evaluator: a chosen evaluator (manager), else self.
    const who = (isManager && evaluator) ? evaluator : userName
    if (who) qs.set('evaluator', who)
    fetch(`/api/weekly-feedback?${qs}`).then(r => r.json()).then(d => {
      const recs: WeeklyRecord[] = d.records || []
      setFilledBatches(new Set(recs.filter(r => !isEmptyRecord(r)).map(r => r.batch)))
    }).catch(() => setFilledBatches(new Set()))
  }, [view, selectedBatch, evaluator, isManager, userName])

  // Editor: load the record for the selected batch — unless seeded from a row.
  useEffect(() => {
    if (view !== 'editor' || !selectedBatch) return
    const self = !isManager || !evaluator || evaluator.toLowerCase() === userName.toLowerCase()
    const key = `${selectedBatch}::${(isManager && evaluator) ? evaluator : ''}`
    if (preseeded.current === key) { preseeded.current = null; return }
    const qs = new URLSearchParams({ batch: selectedBatch })
    if (isManager && evaluator) qs.set('evaluator', evaluator)
    fetch(`/api/weekly-feedback?${qs}`).then(r => r.json()).then(d => {
      const secs: Section[] = Array.isArray(d.record?.sections) ? d.record.sections : []
      setSections(secs.length ? secs : (self ? [newSection()] : []))
      setCollapsedSecs({}); setDirty(false); setSaveError(false); dirtyRef.current = false
    })
  }, [view, selectedBatch, evaluator, isManager, userName])

  // Overview: load records for the resolved batch + evaluator filters. A failed
  // read shows as an error with Try again, never as "no feedback".
  useEffect(() => {
    if (view !== 'overview') return
    let live = true
    const qs = new URLSearchParams({ list: '1' })
    if (listBatch) qs.set('batch', listBatch)
    if (isManager && listEvaluator) qs.set('evaluator', listEvaluator)
    setListLoading(true); setListFailed(false)
    fetch(`/api/weekly-feedback?${qs}`)
      .then(r => { if (!r.ok) throw new Error('failed'); return r.json() })
      .then(d => { if (live) setRecords(d.records || []) })
      .catch(() => { if (live) { setRecords([]); setListFailed(true) } })
      .finally(() => { if (live) setListLoading(false) })
    return () => { live = false }
  }, [view, listBatch, listEvaluator, isManager, listReload])

  // Default week-collapse: keep the newest week open, collapse the rest.
  useEffect(() => {
    const ws = Array.from(new Set(records.map(r => r.batch)))
      .sort((a, b) => weekLabelOrder(b) - weekLabelOrder(a) || b.localeCompare(a))
    const c: Record<string, boolean> = {}
    ws.forEach((b, i) => { c[b] = i !== 0 })
    setCollapsed(c)
  }, [records])

  // A failed save keeps the changes marked unsaved and says so. Before, the result was
  // never read, so a 500 or a dropped connection still showed "All changes saved".
  const save = useCallback(async () => {
    setSaving(true); setSaveError(false)
    let ok = false
    try {
      const res = await fetch('/api/weekly-feedback', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ batch: selectedBatch, sections }),
      })
      ok = res.ok
    } catch { ok = false }
    setSaving(false)
    if (ok) { setDirty(false); dirtyRef.current = false } else setSaveError(true)
  }, [selectedBatch, sections])

  useEffect(() => registerUnsavedGuard({ isDirty: () => dirtyRef.current, flush: () => save() }), [save])
  const markDirty = () => { setDirty(true); dirtyRef.current = true }

  useEffect(() => {
    if (!autoSave || !dirty || !viewingSelf || !selectedBatch) return
    const t = setTimeout(() => { void save() }, 1500)
    return () => clearTimeout(t)
  }, [autoSave, dirty, viewingSelf, selectedBatch, save])

  // --- Section mutations (Editor) ---
  const updateSection = (id: string, patch: Partial<Section>) => {
    setSections(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s)); markDirty()
  }
  const reorderSection = (to: number) => {
    const from = dragFrom.current; dragFrom.current = null
    if (from == null || from === to) return
    setSections(prev => { const next = [...prev]; const [m] = next.splice(from, 1); next.splice(to, 0, m); return next })
    markDirty()
  }
  const addSection = () => { setSections(prev => [...prev, newSection()]); markDirty() }
  const removeSection = (id: string) => { setSections(prev => prev.filter(s => s.id !== id)); markDirty() }
  const duplicateSection = (id: string) => {
    setSections(prev => {
      const i = prev.findIndex(s => s.id === id); if (i < 0) return prev
      const next = [...prev]; next.splice(i + 1, 0, { ...prev[i], id: newSection().id }); return next
    })
    markDirty()
  }
  const toggleSec = (id: string) => setCollapsedSecs(c => ({ ...c, [id]: !c[id] }))
  const jumpToSec = (id: string) => {
    setCollapsedSecs(c => ({ ...c, [id]: false }))
    requestAnimationFrame(() => document.getElementById(`wf-sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const openRecord = (rec: WeeklyRecord) => {
    const who = isManager && rec.evaluator.toLowerCase() !== userName.toLowerCase() ? rec.evaluator : ''
    preseeded.current = `${rec.batch}::${who}`
    const secs = Array.isArray(rec.sections) ? rec.sections : []
    // Opening own empty week (a "Tap to add" row) seeds a blank section to type into.
    setSections(secs.length ? secs : (who === '' ? [newSection()] : []))
    setCollapsedSecs({}); setDirty(false); setSaveError(false); dirtyRef.current = false; setHistoryOpen(false)
    // One navigation for all three keys: separate setters would drop each other.
    setUrlParams({ view: 'editor', edit: rec.batch, ...(isManager ? { who: who || null } : {}) })
  }

  const loadHistory = () => {
    const next = !historyOpen
    setHistoryOpen(next)
    setPreviewSnap(null); setHistoryVisible(5)
    if (!next) return
    const qs = new URLSearchParams({ batch: selectedBatch })
    if (isManager && evaluator) qs.set('evaluator', evaluator)
    fetch(`/api/weekly-feedback/history?${qs}`).then(r => r.json()).then(d => setSnapshots(d.snapshots || []))
  }
  const restore = (snap: Snapshot) => {
    setSections(Array.isArray(snap.sections) ? snap.sections : [])
    markDirty(); setHistoryOpen(false); setPreviewSnap(null)
  }
  // Snapshots auto-delete 3 days after saved_at — show the remaining time.
  const ttlText = (savedAt: string): string => {
    const ms = new Date(savedAt).getTime() + 3 * 86400_000 - Date.now()
    if (ms <= 0) return 'expiring now'
    const h = Math.floor(ms / 3600_000)
    if (h >= 24) return `deletes in ${Math.floor(h / 24)}d ${h % 24}h`
    if (h >= 1) return `deletes in ${h}h`
    return `deletes in ${Math.max(1, Math.floor(ms / 60_000))}m`
  }

  // --- Overview grouping: filter by search, group by week, newest week first ---
  const q = query.trim().toLowerCase()
  // Overview shows the user their own weeks only when scoped to themselves:
  // non-managers always are; a manager is when they pick their own name.
  const overviewPersonal = !isManager || (!!listEvaluator && listEvaluator.toLowerCase() === userName.toLowerCase())
  // Real feedback = non-empty records (counted, searchable). Empty records are
  // normally hidden; in the personal view they surface (no search) as a single
  // "Tap to add feedback" row so the user sees weeks still to fill — uncounted.
  const real = records.filter(r => !isEmptyRecord(r) && (!q || recordMatches(r, q)))
  const empties = overviewPersonal && !q ? records.filter(isEmptyRecord) : []
  const visible = [...real, ...empties]
  const groups: { batch: string; rows: WeeklyRecord[] }[] = []
  const groupIdx = new Map<string, number>()
  for (const r of visible) {
    if (!groupIdx.has(r.batch)) { groupIdx.set(r.batch, groups.length); groups.push({ batch: r.batch, rows: [] }) }
    groups[groupIdx.get(r.batch)!].rows.push(r)
  }
  groups.forEach(g => g.rows.sort((a, b) => a.evaluator.localeCompare(b.evaluator)))
  groups.sort((a, b) => weekLabelOrder(b.batch) - weekLabelOrder(a.batch) || b.batch.localeCompare(a.batch))

  const onRowClick = (e: MouseEvent, rec: WeeklyRecord) => {
    const a = (e.target as HTMLElement).closest('a')
    if (a && a.getAttribute('href')) return
    openRecord(rec)
  }

  const nonEmptyCount = records.filter(r => !isEmptyRecord(r)).length
  const filtered = !!listBatch || !!listEvaluator || q !== ''
  const clearFilters = () => { setQuery(''); setUrlParams({ batch: null, ev: null, q: null }) }

  // Switching to the Editor opens its batch cards, as it always has. Switching to
  // the Overview leaves ?edit= alone: the Editor's auto-save timer is keyed on the
  // open batch, and clearing it here would drop an unsaved change.
  const switchView = (v: View) => {
    if (v === 'editor') setUrlParams({ view: 'editor', edit: null })
    else setView(v)
  }

  return (
    <div className="page wf-page">
      <PageHeader
        title="Weekly Feedback"
        sub="Each evaluator's notes on a batch, with the games alike."
        actions={<Seg value={view} onChange={switchView} options={VIEWS} ariaLabel="View" />}
      />

      {view === 'overview' ? (
        <FilterBar>
          <div style={{ width: 180 }}>
            <StyledSelect filter ariaLabel="Batch" value={listBatch} onChange={setListBatch} placeholder="All batches"
              options={[{ value: '', label: 'All batches' }, ...batches.map(b => ({ value: b, label: b }))]} />
          </div>
          {isManager && (
            <div style={{ width: 180 }}>
              <StyledSelect filter ariaLabel="Evaluator" value={listEvaluator} onChange={setListEvaluator} placeholder="All evaluators"
                options={[{ value: '', label: 'All evaluators' }, ...evaluators.map(e => ({ value: e, label: e }))]} />
            </div>
          )}
          <SearchInput value={query} onChange={setQuery} placeholder="Search feedback or games" width={240} />
          <FilterSpacer />
          <ClearFilters visible={filtered} onClear={clearFilters} />
          <FilterCount loading={listLoading && records.length === 0} shown={real.length} total={nonEmptyCount}
            noun={nonEmptyCount === 1 ? 'record' : 'records'} />
          <button type="button" className="btn"
            onClick={() => setCollapsed(c => { const all = groups.every(g => c[g.batch]); const n: Record<string, boolean> = {}; groups.forEach(g => { n[g.batch] = !all }); return n })}>
            {groups.length > 0 && groups.every(g => collapsed[g.batch]) ? 'Expand all' : 'Collapse all'}
          </button>
        </FilterBar>
      ) : (
        <FilterBar ariaLabel="Batch to edit">
          {selectedBatch && (
            <button type="button" className="btn"
              onClick={() => { if (dirtyRef.current && viewingSelf) void save(); setSelectedBatch('') }}
              title="Back to all batches">
              <span aria-hidden="true">←</span> All batches
            </button>
          )}
          {isManager && (
            <div style={{ width: 200 }}>
              <StyledSelect ariaLabel="Evaluator" value={evaluator} onChange={setEvaluator} placeholder="My own"
                options={[{ value: '', label: 'My own' }, ...evaluators.map(e => ({ value: e, label: e }))]} />
            </div>
          )}
          <div style={{ width: 200 }}>
            <StyledSelect ariaLabel="Batch" value={selectedBatch} onChange={setSelectedBatch} placeholder="Select a batch"
              options={allBatches.map(b => ({ value: b, label: b }))} />
          </div>
        </FilterBar>
      )}

      <div className={`card wf-scroll${view === 'editor' ? '' : ' wf-scroll-list'}`} style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {view === 'editor' ? (
          !selectedBatch ? (
            allBatches.length === 0 ? (
              <EmptyState>No batches yet. They show up here once games are assigned to a batch.</EmptyState>
            ) : (() => {
              const renderCard = (b: string) => {
                const filled = filledBatches.has(b)
                const wk = b.match(/^W(\d+)/)?.[1]
                // Pin each card to its week column (W1→col1 … W4→col4) so weeks
                // line up across months even when a month is missing some weeks.
                const style = wk ? { gridColumn: Number(wk) } : undefined
                return (
                  <button type="button" key={b} style={style} className={`wf-card${filled ? '' : ' is-empty'}`} onClick={() => setSelectedBatch(b)}>
                    <span className="wf-card-batch">{wk ? `W${wk}` : b}</span>
                    <span className="wf-card-meta">{filled ? 'View / edit' : 'add…'}</span>
                  </button>
                )
              }
              const { years, other } = groupByCalendar(allBatches)
              return (
                <div className="wf-cal">
                  {years.map(y => (
                    <div className="wf-cal-year" key={y.year}>
                      <h3 className="wf-cal-year-h">{y.year}</h3>
                      {y.months.map(m => (
                        <div className="wf-cal-month" key={m.label}>
                          <span className="wf-cal-month-h">{m.label}</span>
                          <div className="wf-cal-weeks">
                            {[...m.batches].sort((a, b) => (parseBatch(a)?.week ?? 0) - (parseBatch(b)?.week ?? 0)).map(renderCard)}
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                  {other.length > 0 && (
                    <div className="wf-cal-year">
                      <h3 className="wf-cal-year-h">Other</h3>
                      <div className="wf-cal-month"><div className="wf-cal-weeks">{other.map(renderCard)}</div></div>
                    </div>
                  )}
                </div>
              )
            })()
          ) : viewingSelf ? (
            <>
              <div className="wf-label-row wf-sticky-bar">
                <div className="wf-label-left">
                  <h3 className="wf-label">Sections</h3>
                  {sections.length > 1 && (
                    <div className="wf-outline">
                      {sections.map((s, i) => (
                        <button key={s.id} type="button" title={firstLine(s)} aria-label={`Go to section ${i + 1}`} onClick={() => jumpToSec(s.id)}>{i + 1}</button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="wf-label-actions">
                  <span className={`wf-savestate${saveError && !saving ? ' err' : ''}`} role="status">{saving ? 'Saving…' : saveError ? 'Not saved. Try again.' : dirty ? 'Unsaved changes' : 'All changes saved'}</span>
                  <Switch checked={autoSave} onChange={setAutoSave} label="Auto-save" title="Off: save with the Save button" />
                  <button type="button" className="btn btn-sm btn-primary" disabled={saving || !dirty} onClick={() => save()}>{saving ? 'Saving…' : 'Save'}</button>
                  <button type="button" className="btn btn-sm" aria-pressed={historyOpen} onClick={loadHistory}>History</button>
                </div>
              </div>
              {historyOpen && (
                <div className="wf-history">
                  <p className="wf-history-note">Versions auto-delete 3 days after being saved. Preview before restoring.</p>
                  {snapshots.length === 0 && <p className="h-sub" style={{ margin: 0 }}>No earlier versions saved yet.</p>}
                  <div
                    className="wf-history-list"
                    onScroll={e => {
                      const el = e.currentTarget
                      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8 && historyVisible < snapshots.length) setHistoryVisible(v => v + 5)
                    }}
                  >
                    {snapshots.slice(0, historyVisible).map(s => (
                      <div key={s.id} className={`wf-hist-item${previewSnap?.id === s.id ? ' is-active' : ''}`}>
                        <span className="wf-history-when">{fmtDateTimeVN(s.saved_at)}</span>
                        <span className="wf-history-meta">{s.sections?.length || 0} section{(s.sections?.length || 0) === 1 ? '' : 's'}</span>
                        <span className="wf-history-ttl">{ttlText(s.saved_at)}</span>
                        <span style={{ flex: 1 }} />
                        <button type="button" className="btn btn-sm btn-ghost" aria-pressed={previewSnap?.id === s.id}
                          onClick={() => setPreviewSnap(previewSnap?.id === s.id ? null : s)}>
                          {previewSnap?.id === s.id ? 'Hide' : 'Preview'}
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => restore(s)}>Restore</button>
                      </div>
                    ))}
                    {historyVisible < snapshots.length && (
                      <p className="wf-history-more">Scroll for {snapshots.length - historyVisible} more…</p>
                    )}
                  </div>
                  {previewSnap && (
                    <div className="wf-history-preview">
                      <div className="wf-hist-preview-head">
                        <span>Preview · {fmtDateTimeVN(previewSnap.saved_at)}</span>
                        <span style={{ flex: 1 }} />
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => restore(previewSnap)}>Restore this version</button>
                        <CloseButton onClick={() => setPreviewSnap(null)} label="Close preview" />
                      </div>
                      <div className="wf-history-preview-body">
                        <FeedbackView sections={Array.isArray(previewSnap.sections) ? previewSnap.sections : []} />
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="wf-sections">
                {sections.map((s, i) => (
                  collapsedSecs[s.id] ? (
                    <div key={s.id} id={`wf-sec-${s.id}`} className="wf-sec-collapsed" onClick={() => toggleSec(s.id)}>
                      <span className="wf-sec-idx">{i + 1}</span>
                      <span className="wf-sec-collapsed-text">{firstLine(s)}</span>
                      <span className="wf-faint">{gameCount(s)} game{gameCount(s) === 1 ? '' : 's'}</span>
                    </div>
                  ) : (
                    <div key={s.id} id={`wf-sec-${s.id}`}>
                      <SectionEditor
                        section={s}
                        index={i}
                        onChange={patch => updateSection(s.id, patch)}
                        onRemove={() => removeSection(s.id)}
                        onDuplicate={() => duplicateSection(s.id)}
                        onCollapse={() => toggleSec(s.id)}
                        onDragStart={() => { dragFrom.current = i }}
                        onDrop={() => reorderSection(i)}
                      />
                    </div>
                  )
                ))}
              </div>
              <button type="button" className="btn btn-sm" onClick={addSection}>+ Add section</button>
            </>
          ) : (
            <FeedbackView sections={sections} />
          )
        ) : (
          listFailed ? (
            <ErrorState onRetry={() => setListReload(k => k + 1)}>Could not load the feedback.</ErrorState>
          ) : (
          <table className="wf-list tbl tbl-sticky">
            <thead><tr><th>Evaluator</th><th>Feedback</th><th>Game alike</th></tr></thead>
            <tbody>
              {listLoading && records.length === 0 && <SkeletonRows widths={[100, 360, 260]} />}
              {groups.length === 0 && !listLoading && (
                <tr><td colSpan={3}>
                  <EmptyState action={filtered ? { label: 'Clear filters', onClick: clearFilters } : undefined}>
                    {filtered ? 'No feedback matches these filters.' : 'No feedback recorded yet.'}
                  </EmptyState>
                </td></tr>
              )}
              {groups.map(g => {
                const expanded = q ? true : !collapsed[g.batch]
                return (
                  <Fragment key={g.batch}>
                    <tr className="wf-week-row" onClick={() => setCollapsed(c => ({ ...c, [g.batch]: !c[g.batch] }))}>
                      <td colSpan={3}>
                        <span className="wf-week-chev">{expanded ? '▾' : '▸'}</span>
                        <span className="wf-week-label">{g.batch}</span>
                        <span className="wf-week-sum">{g.rows.filter(r => !isEmptyRecord(r)).length} feedback</span>
                      </td>
                    </tr>
                    {expanded && g.rows.map((r) => {
                      const hue = evalHue(r.evaluator)
                      // Personal-view placeholder for a week with no feedback yet.
                      if (isEmptyRecord(r)) {
                        return (
                          <tr key={`${g.batch}::${r.evaluator}::add`} className="wf-evrow wf-evrow-add" onClick={e => onRowClick(e, r)} style={{ cursor: 'pointer', ['--ev-h' as string]: hue } as CSSProperties}>
                            <td className="wf-list-eval"><span className="wf-evname"><span className="wf-evdot" />{r.evaluator}</span></td>
                            <td className="wf-c-solid" colSpan={2}><span className="wf-addrow">+ Tap to add feedback</span></td>
                          </tr>
                        )
                      }
                      const secs: (Section | null)[] = r.sections?.length ? r.sections : [null]
                      return secs.map((s, i) => {
                        const no = secs.length > 1 ? i + 1 : null
                        const cls = i === secs.length - 1 ? 'wf-c-solid' : 'wf-c-sec'
                        return (
                          <tr key={`${g.batch}::${r.evaluator}::${i}`} className="wf-evrow" onClick={e => onRowClick(e, r)} style={{ cursor: 'pointer', ['--ev-h' as string]: hue } as CSSProperties}>
                            {i === 0 && <td className="wf-list-eval" rowSpan={secs.length}><span className="wf-evname"><span className="wf-evdot" />{r.evaluator}</span></td>}
                            <td className={cls}><FeedbackCell doc={s?.feedback ?? null} no={no} /></td>
                            <td className={cls}><AlikeCell alikes={s?.alikes} no={no} /></td>
                          </tr>
                        )
                      })
                    })}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
          )
        )}
      </div>
    </div>
  )
}
