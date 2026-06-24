'use client'
import { Fragment, useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { useSession } from 'next-auth/react'
import { StyledSelect } from '@/components/StyledSelect'
import { registerUnsavedGuard } from '@/lib/unsaved-guard'
import { SectionEditor } from './SectionEditor'
import { FeedbackView, FeedbackCell, AlikeCell } from './FeedbackView'
import { weekLabelOrder } from '@/lib/weekly-feedback'
import { ImportReviewView } from './ImportReviewView'
import { Section, newSection } from './types'

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
function manualCount(s: Section): number { return (s.alikes || []).reduce((n, b) => n + b.games.filter(g => g.manual).length, 0) }
function firstLine(s: Section): string { return docText(s.feedback).trim().split('\n')[0].slice(0, 80) || '(no feedback)' }

export function WeeklyFeedbackTab() {
  const { data: session } = useSession()
  const role = session?.user?.role
  const isManager = role === 'admin' || role === 'moderator'
  const userName = session?.user?.name || ''

  // Overview / Editor / Import toggle is local state only — NO url params.
  // ('import' is the throwaway legacy-sheet review surface, admin/mod only.)
  const [view, setView] = useState<'list' | 'week' | 'import'>('list')

  const [batches, setBatches] = useState<string[]>([])
  const [evaluators, setEvaluators] = useState<string[]>([])

  // Editor picks (managers can view another evaluator's week).
  const [evaluator, setEvaluator] = useState('') // '' = my own
  const [selectedBatch, setSelectedBatch] = useState('')

  // Overview filters + view options.
  const [listBatch, setListBatch] = useState('')
  const [listEvaluator, setListEvaluator] = useState('')
  const [query, setQuery] = useState('')
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({}) // collapsed weeks (Overview)
  const [collapsedSecs, setCollapsedSecs] = useState<Record<string, boolean>>({}) // collapsed sections (Editor)

  const [sections, setSections] = useState<Section[]>([])
  const [records, setRecords] = useState<WeeklyRecord[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const dirtyRef = useRef(false)
  const dragFrom = useRef<number | null>(null)
  // When we open a week straight from a list row we already hold its sections —
  // seed them and skip exactly one network load so the editor never flashes empty.
  const preseeded = useRef<string | null>(null)

  const [historyOpen, setHistoryOpen] = useState(false)
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])

  const viewingSelf = !isManager || !evaluator || evaluator.toLowerCase() === userName.toLowerCase()

  useEffect(() => {
    fetch('/api/weekly-feedback/batches')
      .then(r => r.json())
      .then(d => {
        setBatches(d.batches || [])
        if (isManager) setEvaluators(Array.isArray(d.evaluators) ? d.evaluators : [])
      })
      .catch(() => { setBatches([]); setEvaluators([]) })
  }, [isManager])

  // Editor: load the record for the selected batch — unless seeded from a row.
  useEffect(() => {
    if (view !== 'week' || !selectedBatch) return
    const self = !isManager || !evaluator || evaluator.toLowerCase() === userName.toLowerCase()
    const key = `${selectedBatch}::${(isManager && evaluator) ? evaluator : ''}`
    if (preseeded.current === key) { preseeded.current = null; return }
    const qs = new URLSearchParams({ batch: selectedBatch })
    if (isManager && evaluator) qs.set('evaluator', evaluator)
    fetch(`/api/weekly-feedback?${qs}`).then(r => r.json()).then(d => {
      const secs: Section[] = Array.isArray(d.record?.sections) ? d.record.sections : []
      setSections(secs.length ? secs : (self ? [newSection()] : []))
      setCollapsedSecs({}); setDirty(false); dirtyRef.current = false
    })
  }, [view, selectedBatch, evaluator, isManager, userName])

  // Overview: load records for the resolved batch + evaluator filters.
  useEffect(() => {
    if (view !== 'list') return
    const qs = new URLSearchParams({ list: '1' })
    if (listBatch) qs.set('batch', listBatch)
    if (isManager && listEvaluator) qs.set('evaluator', listEvaluator)
    fetch(`/api/weekly-feedback?${qs}`).then(r => r.json()).then(d => setRecords(d.records || []))
  }, [view, listBatch, listEvaluator, isManager])

  // Default week-collapse: keep the newest week open, collapse the rest.
  useEffect(() => {
    const ws = Array.from(new Set(records.map(r => r.batch)))
      .sort((a, b) => weekLabelOrder(b) - weekLabelOrder(a) || b.localeCompare(a))
    const c: Record<string, boolean> = {}
    ws.forEach((b, i) => { c[b] = i !== 0 })
    setCollapsed(c)
  }, [records])

  const save = useCallback(async () => {
    setSaving(true)
    await fetch('/api/weekly-feedback', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batch: selectedBatch, sections }),
    })
    setSaving(false); setDirty(false); dirtyRef.current = false
  }, [selectedBatch, sections])

  useEffect(() => registerUnsavedGuard({ isDirty: () => dirtyRef.current, flush: () => save() }), [save])
  const markDirty = () => { setDirty(true); dirtyRef.current = true }

  useEffect(() => {
    if (!dirty || !viewingSelf || !selectedBatch) return
    const t = setTimeout(() => { void save() }, 1500)
    return () => clearTimeout(t)
  }, [dirty, viewingSelf, selectedBatch, save])

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
    setSections(Array.isArray(rec.sections) ? rec.sections : [])
    setSelectedBatch(rec.batch)
    if (isManager) setEvaluator(who)
    setCollapsedSecs({}); setDirty(false); dirtyRef.current = false; setHistoryOpen(false)
    setView('week')
  }

  const loadHistory = () => {
    const next = !historyOpen
    setHistoryOpen(next)
    if (!next) return
    const qs = new URLSearchParams({ batch: selectedBatch })
    if (isManager && evaluator) qs.set('evaluator', evaluator)
    fetch(`/api/weekly-feedback/history?${qs}`).then(r => r.json()).then(d => setSnapshots(d.snapshots || []))
  }
  const restore = (snap: Snapshot) => {
    setSections(Array.isArray(snap.sections) ? snap.sections : [])
    markDirty(); setHistoryOpen(false)
  }

  // --- Overview grouping: filter by search, group by week, newest week first ---
  const q = query.trim().toLowerCase()
  const visible = q ? records.filter(r => recordMatches(r, q)) : records
  const groups: { batch: string; rows: WeeklyRecord[] }[] = []
  const groupIdx = new Map<string, number>()
  for (const r of visible) {
    if (!groupIdx.has(r.batch)) { groupIdx.set(r.batch, groups.length); groups.push({ batch: r.batch, rows: [] }) }
    groups[groupIdx.get(r.batch)!].rows.push(r)
  }
  groups.forEach(g => g.rows.sort((a, b) => a.evaluator.localeCompare(b.evaluator)))
  groups.sort((a, b) => weekLabelOrder(b.batch) - weekLabelOrder(a.batch) || b.batch.localeCompare(a.batch))
  const weekSummary = (g: { rows: WeeklyRecord[] }) => {
    let games = 0, manual = 0
    for (const r of g.rows) for (const s of (r.sections || [])) { games += gameCount(s); manual += manualCount(s) }
    return { members: g.rows.length, games, manual }
  }

  const onRowClick = (e: MouseEvent, rec: WeeklyRecord) => {
    const a = (e.target as HTMLElement).closest('a')
    if (a && a.getAttribute('href')) return
    openRecord(rec)
  }

  const who = viewingSelf ? (userName || 'my own') : evaluator
  const listWho = isManager ? (listEvaluator || 'All evaluators') : (userName || 'my own')
  const sub = view === 'week'
    ? `${who}${selectedBatch ? ` · ${selectedBatch}` : ''}`
    : `${listWho} · ${listBatch || 'all weeks'} · ${visible.length} record${visible.length === 1 ? '' : 's'}`

  return (
    <div className="page" style={{ paddingBottom: 16, height: '100%', minHeight: 0, boxSizing: 'border-box', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h1 className="h-title">Weekly Feedback</h1>
          <p className="h-sub">{sub}</p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className={`seg-btn-premium${view === 'list' ? ' active' : ''}`} onClick={() => setView('list')}>Overview</button>
          <button className={`seg-btn-premium${view === 'week' ? ' active' : ''}`} onClick={() => setView('week')}>Editor</button>
          {isManager && <button className={`seg-btn-premium${view === 'import' ? ' active' : ''}`} onClick={() => setView('import')}>Import</button>}
        </div>
      </div>

      {view !== 'import' && (
        <div className="filter-row" style={{ position: 'relative', zIndex: 30 }}>
          {view === 'list' ? (
            <>
              <div style={{ width: 180 }}>
                <StyledSelect value={listBatch} onChange={setListBatch} placeholder="All weeks"
                  options={[{ value: '', label: 'All weeks' }, ...batches.map(b => ({ value: b, label: b }))]} />
              </div>
              {isManager && (
                <div style={{ width: 180 }}>
                  <StyledSelect value={listEvaluator} onChange={setListEvaluator} placeholder="All evaluators"
                    options={[{ value: '', label: 'All evaluators' }, ...evaluators.map(e => ({ value: e, label: e }))]} />
                </div>
              )}
              <input className="wf-search" value={query} onChange={e => setQuery(e.target.value)}
                placeholder="Search feedback or games…" />
              {query && <button type="button" className="wf-clear" onClick={() => setQuery('')} title="Clear search">✕</button>}
              <div style={{ flex: 1 }} />
              <div className="wf-density">
                <button type="button" className={density === 'comfortable' ? 'active' : ''} onClick={() => setDensity('comfortable')}>Comfortable</button>
                <button type="button" className={density === 'compact' ? 'active' : ''} onClick={() => setDensity('compact')}>Compact</button>
              </div>
              <button type="button" className="wf-collapse-all"
                onClick={() => setCollapsed(c => { const all = groups.every(g => c[g.batch]); const n: Record<string, boolean> = {}; groups.forEach(g => { n[g.batch] = !all }); return n })}>
                {groups.length > 0 && groups.every(g => collapsed[g.batch]) ? 'Expand all' : 'Collapse all'}
              </button>
            </>
          ) : (
            <>
              {isManager && (
                <div style={{ width: 200 }}>
                  <StyledSelect value={evaluator} onChange={setEvaluator} placeholder="My own"
                    options={[{ value: '', label: 'My own' }, ...evaluators.map(e => ({ value: e, label: e }))]} />
                </div>
              )}
              <div style={{ width: 200 }}>
                <StyledSelect value={selectedBatch} onChange={setSelectedBatch} placeholder="Select a week…"
                  options={batches.map(b => ({ value: b, label: b }))} />
              </div>
            </>
          )}
        </div>
      )}

      <div className="card" style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {view === 'import' ? (
          <ImportReviewView />
        ) : view === 'week' ? (
          !selectedBatch ? (
            <p className="h-sub" style={{ padding: 8 }}>Select a week to view or edit feedback.</p>
          ) : viewingSelf ? (
            <>
              <div className="wf-label-row wf-sticky-bar">
                <div className="wf-label-left">
                  <h3 className="wf-label">Sections</h3>
                  {sections.length > 1 && (
                    <div className="wf-outline">
                      {sections.map((s, i) => (
                        <button key={s.id} type="button" title={firstLine(s)} onClick={() => jumpToSec(s.id)}>{i + 1}</button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="wf-label-actions">
                  <span className="wf-savestate">{saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'All changes saved'}</span>
                  <button type="button" className="wf-history-btn" onClick={loadHistory}>History</button>
                </div>
              </div>
              {historyOpen && (
                <div className="wf-history">
                  {snapshots.length === 0 && <p className="h-sub" style={{ margin: 0 }}>No earlier versions saved yet.</p>}
                  {snapshots.map(s => (
                    <div key={s.id} className="wf-history-item">
                      <span className="wf-history-when">{new Date(s.saved_at).toLocaleString()}</span>
                      <span className="wf-history-meta">{s.sections?.length || 0} section{(s.sections?.length || 0) === 1 ? '' : 's'}</span>
                      <button type="button" onClick={() => restore(s)}>Restore</button>
                    </div>
                  ))}
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
              <button type="button" className="wf-addsection" onClick={addSection}>+ Add section</button>
            </>
          ) : (
            <FeedbackView sections={sections} />
          )
        ) : (
          <table className={`wf-list wf-dens-${density}`} style={{ width: '100%' }}>
            <thead><tr><th>Evaluator</th><th>Feedback</th><th>Game Alike</th></tr></thead>
            <tbody>
              {groups.length === 0 && (
                <tr><td colSpan={3}><span className="h-sub">{query ? 'No matches.' : 'No feedback recorded yet.'}</span></td></tr>
              )}
              {groups.map(g => {
                const expanded = q ? true : !collapsed[g.batch]
                const sm = weekSummary(g)
                return (
                  <Fragment key={g.batch}>
                    <tr className="wf-week-row" onClick={() => setCollapsed(c => ({ ...c, [g.batch]: !c[g.batch] }))}>
                      <td colSpan={3}>
                        <span className="wf-week-chev">{expanded ? '▾' : '▸'}</span>
                        <span className="wf-week-label">{g.batch}</span>
                        <span className="wf-week-sum">{sm.members} member{sm.members === 1 ? '' : 's'} · {sm.games} game{sm.games === 1 ? '' : 's'}{sm.manual ? ` · ${sm.manual} manual` : ''}</span>
                      </td>
                    </tr>
                    {expanded && g.rows.map((r, ri) => {
                      const secs: (Section | null)[] = r.sections?.length ? r.sections : [null]
                      return secs.map((s, i) => {
                        const no = secs.length > 1 ? i + 1 : null
                        const cls = i === secs.length - 1 ? 'wf-c-solid' : 'wf-c-sec'
                        return (
                          <tr key={`${g.batch}::${r.evaluator}::${i}`} className={ri % 2 ? 'wf-row-alt' : ''} onClick={e => onRowClick(e, r)} style={{ cursor: 'pointer' }}>
                            {i === 0 && <td className="wf-list-eval" rowSpan={secs.length}>{r.evaluator}</td>}
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
        )}
      </div>
    </div>
  )
}
