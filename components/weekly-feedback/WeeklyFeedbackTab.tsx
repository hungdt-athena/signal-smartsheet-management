'use client'
import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { useSession } from 'next-auth/react'
import { StyledSelect } from '@/components/StyledSelect'
import { registerUnsavedGuard } from '@/lib/unsaved-guard'
import { SectionEditor } from './SectionEditor'
import { FeedbackView, FeedbackCell, AlikeCell } from './FeedbackView'
import { weekLabelOrder } from '@/lib/weekly-feedback'
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
// Deterministic hue (0–359) from the evaluator name — maps onto the full HSL
// hue wheel (continuous, no fixed palette), so any number of evaluators get
// spread-out colors that never "run out". Same name → same color everywhere.
function evalHue(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return (h % 360)
}
function firstLine(s: Section): string { return docText(s.feedback).trim().split('\n')[0].slice(0, 80) || '(no feedback)' }

export function WeeklyFeedbackTab() {
  const { data: session } = useSession()
  const role = session?.user?.role
  const isManager = role === 'admin' || role === 'moderator'
  const userName = session?.user?.name || ''

  // Overview / Editor toggle is local state only — NO url params.
  const [view, setView] = useState<'list' | 'week'>('list')

  const [batches, setBatches] = useState<string[]>([])
  const [evaluators, setEvaluators] = useState<string[]>([])

  // Editor picks (managers can view another evaluator's week).
  const [evaluator, setEvaluator] = useState('') // '' = my own
  const [selectedBatch, setSelectedBatch] = useState('')

  // Overview filters + view options.
  const [listBatch, setListBatch] = useState('')
  const [listEvaluator, setListEvaluator] = useState('')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({}) // collapsed weeks (Overview)
  const [collapsedSecs, setCollapsedSecs] = useState<Record<string, boolean>>({}) // collapsed sections (Editor)

  const [sections, setSections] = useState<Section[]>([])
  const [records, setRecords] = useState<WeeklyRecord[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
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
    setSections(Array.isArray(rec.sections) ? rec.sections : [])
    setSelectedBatch(rec.batch)
    if (isManager) setEvaluator(who)
    setCollapsedSecs({}); setDirty(false); dirtyRef.current = false; setHistoryOpen(false)
    setView('week')
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
  const visible = q ? records.filter(r => recordMatches(r, q)) : records
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

  const who = viewingSelf ? (userName || 'my own') : evaluator
  const listWho = isManager ? (listEvaluator || 'All evaluators') : (userName || 'my own')
  const sub = view === 'week'
    ? `${who}${selectedBatch ? ` · ${selectedBatch}` : ''}`
    : `${listWho} · ${listBatch || 'all weeks'} · ${visible.length} record${visible.length === 1 ? '' : 's'}`

  return (
    <div className="page" style={{ paddingBottom: 16, height: '100vh', boxSizing: 'border-box', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h1 className="h-title">Weekly Feedback</h1>
          <p className="h-sub">{sub}</p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className={`seg-btn-premium${view === 'list' ? ' active' : ''}`} onClick={() => setView('list')}>Overview</button>
          <button className={`seg-btn-premium${view === 'week' ? ' active' : ''}`} onClick={() => setView('week')}>Editor</button>
        </div>
      </div>

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

      <div className="card wf-scroll" style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {view === 'week' ? (
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
                  <button type="button" className={`wf-autosave${autoSave ? ' on' : ''}`} onClick={() => setAutoSave(v => !v)} title="Toggle auto-save (off = save manually)">
                    <span className="wf-autosave-dot" />Auto-save {autoSave ? 'On' : 'Off'}
                  </button>
                  <button type="button" className="wf-save-btn" disabled={saving || !dirty} onClick={() => save()}>{saving ? 'Saving…' : 'Save'}</button>
                  <button type="button" className="wf-history-btn" onClick={loadHistory}>History</button>
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
                      <div key={s.id} className={`wf-history-item${previewSnap?.id === s.id ? ' is-active' : ''}`}>
                        <span className="wf-history-when">{new Date(s.saved_at).toLocaleString()}</span>
                        <span className="wf-history-meta">{s.sections?.length || 0} section{(s.sections?.length || 0) === 1 ? '' : 's'}</span>
                        <span className="wf-history-ttl">{ttlText(s.saved_at)}</span>
                        <span style={{ flex: 1 }} />
                        <button type="button" onClick={() => setPreviewSnap(previewSnap?.id === s.id ? null : s)}>
                          {previewSnap?.id === s.id ? 'Hide' : 'Preview'}
                        </button>
                        <button type="button" className="wf-history-restore" onClick={() => restore(s)}>Restore</button>
                      </div>
                    ))}
                    {historyVisible < snapshots.length && (
                      <p className="wf-history-more">Scroll for {snapshots.length - historyVisible} more…</p>
                    )}
                  </div>
                  {previewSnap && (
                    <div className="wf-history-preview">
                      <div className="wf-history-preview-head">
                        <span>Preview · {new Date(previewSnap.saved_at).toLocaleString()}</span>
                        <span style={{ flex: 1 }} />
                        <button type="button" className="wf-save-btn" onClick={() => restore(previewSnap)}>Restore this version</button>
                        <button type="button" onClick={() => setPreviewSnap(null)}>Close</button>
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
              <button type="button" className="wf-addsection" onClick={addSection}>+ Add section</button>
            </>
          ) : (
            <FeedbackView sections={sections} />
          )
        ) : (
          <table className="wf-list" style={{ width: '100%' }}>
            <thead><tr><th>Evaluator</th><th>Feedback</th><th>Game Alike</th></tr></thead>
            <tbody>
              {groups.length === 0 && (
                <tr><td colSpan={3}><span className="h-sub">{query ? 'No matches.' : 'No feedback recorded yet.'}</span></td></tr>
              )}
              {groups.map(g => {
                const expanded = q ? true : !collapsed[g.batch]
                return (
                  <Fragment key={g.batch}>
                    <tr className="wf-week-row" onClick={() => setCollapsed(c => ({ ...c, [g.batch]: !c[g.batch] }))}>
                      <td colSpan={3}>
                        <span className="wf-week-chev">{expanded ? '▾' : '▸'}</span>
                        <span className="wf-week-label">{g.batch}</span>
                        <span className="wf-week-sum">{g.rows.length} feedback</span>
                      </td>
                    </tr>
                    {expanded && g.rows.map((r) => {
                      const secs: (Section | null)[] = r.sections?.length ? r.sections : [null]
                      const hue = evalHue(r.evaluator)
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
        )}
      </div>
    </div>
  )
}
