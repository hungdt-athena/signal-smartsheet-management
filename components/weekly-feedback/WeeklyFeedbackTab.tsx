'use client'
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
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

export function WeeklyFeedbackTab() {
  const { data: session } = useSession()
  const role = session?.user?.role
  const isManager = role === 'admin' || role === 'moderator'
  const userName = session?.user?.name || ''

  // List / Week / Import toggle is local state only — NO url params.
  // ('import' is the throwaway legacy-sheet review surface, admin/mod only.)
  const [view, setView] = useState<'list' | 'week' | 'import'>('list')

  const [batches, setBatches] = useState<string[]>([])
  const [evaluators, setEvaluators] = useState<string[]>([])

  // Week-view picks (managers can view another evaluator's week).
  const [evaluator, setEvaluator] = useState('') // '' = my own
  const [selectedBatch, setSelectedBatch] = useState('')

  // List-view filters: batch ('' = all weeks, defaults to the current batch) and
  // evaluator ('' = all evaluators, managers only; non-managers are locked to self).
  const [listBatch, setListBatch] = useState('')
  const [listEvaluator, setListEvaluator] = useState('')

  const [sections, setSections] = useState<Section[]>([])
  const [records, setRecords] = useState<WeeklyRecord[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const dirtyRef = useRef(false)
  // When we open a week straight from a list row we already hold its sections —
  // seed them and skip exactly one network load so the editor never flashes
  // empty (and can't be wiped by a save before the real data arrives).
  const preseeded = useRef<string | null>(null)

  // History panel.
  const [historyOpen, setHistoryOpen] = useState(false)
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])

  // Viewing self when: not a manager, or a manager who left the picker empty /
  // picked their own name. Only then do we offer the editors + Save.
  const viewingSelf = !isManager || !evaluator || evaluator.toLowerCase() === userName.toLowerCase()

  // One-shot load of batches (+ evaluators for managers). List-view batch filter
  // defaults to '' (All weeks); batches arrive already sorted newest → oldest.
  useEffect(() => {
    fetch('/api/weekly-feedback/batches')
      .then(r => r.json())
      .then(d => {
        const bs: string[] = d.batches || []
        setBatches(bs)
        if (isManager) setEvaluators(Array.isArray(d.evaluators) ? d.evaluators : [])
      })
      .catch(() => { setBatches([]); setEvaluators([]) })
  }, [isManager])

  // Week view: load the record for the selected batch — unless we were just
  // seeded from a list row. Seed a single blank section when editing your own
  // empty week so there's something to type into.
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
      setDirty(false); dirtyRef.current = false
    })
  }, [view, selectedBatch, evaluator, isManager, userName])

  // List view: load records for the resolved batch + evaluator filters.
  useEffect(() => {
    if (view !== 'list') return
    const qs = new URLSearchParams({ list: '1' })
    if (listBatch) qs.set('batch', listBatch)
    if (isManager && listEvaluator) qs.set('evaluator', listEvaluator)
    fetch(`/api/weekly-feedback?${qs}`).then(r => r.json()).then(d => setRecords(d.records || []))
  }, [view, listBatch, listEvaluator, isManager])

  const save = useCallback(async () => {
    setSaving(true)
    await fetch('/api/weekly-feedback', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batch: selectedBatch, sections }),
    })
    setSaving(false); setDirty(false); dirtyRef.current = false
  }, [selectedBatch, sections])

  // Unsaved guard so the deploy watcher / page close never drops edits.
  useEffect(() => registerUnsavedGuard({ isDirty: () => dirtyRef.current, flush: () => save() }), [save])
  const markDirty = () => { setDirty(true); dirtyRef.current = true }

  // Auto-save: persist 1.5s after edits stop. Editing sections changes `save` (it
  // closes over them), which re-runs this effect and resets the timer — a
  // natural debounce. `dirty` gates it; saving clears dirty and stops the loop.
  useEffect(() => {
    if (!dirty || !viewingSelf || !selectedBatch) return
    const t = setTimeout(() => { void save() }, 1500)
    return () => clearTimeout(t)
  }, [dirty, viewingSelf, selectedBatch, save])

  // Section mutations — every one marks the week dirty so auto-save kicks in.
  const updateSection = (id: string, patch: Partial<Section>) => {
    setSections(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s)); markDirty()
  }
  const moveSection = (index: number, dir: -1 | 1) => {
    setSections(prev => {
      const j = index + dir
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]; [next[index], next[j]] = [next[j], next[index]]; return next
    })
    markDirty()
  }
  const addSection = () => { setSections(prev => [...prev, newSection()]); markDirty() }
  const removeSection = (id: string) => { setSections(prev => prev.filter(s => s.id !== id)); markDirty() }

  // Open a row's week. We already have the row's sections, so seed them directly
  // (and mark them preseeded to skip the redundant fetch). Managers jump to that
  // evaluator (read-only unless it's them); non-managers always view their own.
  const openRecord = (rec: WeeklyRecord) => {
    const who = isManager && rec.evaluator.toLowerCase() !== userName.toLowerCase() ? rec.evaluator : ''
    preseeded.current = `${rec.batch}::${who}`
    setSections(Array.isArray(rec.sections) ? rec.sections : [])
    setSelectedBatch(rec.batch)
    if (isManager) setEvaluator(who)
    setDirty(false); dirtyRef.current = false
    setHistoryOpen(false)
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
    markDirty()
    setHistoryOpen(false)
  }

  // Group list rows by batch so the Batch cell can span its evaluators (rowspan).
  // Groups are ordered newest week → oldest by their "W<n> <Month>, <Year>" label;
  // evaluators are sorted within each batch.
  const groups: { batch: string; rows: WeeklyRecord[] }[] = []
  const groupIdx = new Map<string, number>()
  for (const r of records) {
    if (!groupIdx.has(r.batch)) { groupIdx.set(r.batch, groups.length); groups.push({ batch: r.batch, rows: [] }) }
    groups[groupIdx.get(r.batch)!].rows.push(r)
  }
  groups.forEach(g => g.rows.sort((a, b) => a.evaluator.localeCompare(b.evaluator)))
  groups.sort((a, b) => weekLabelOrder(b.batch) - weekLabelOrder(a.batch) || b.batch.localeCompare(a.batch))

  // Flatten to one display row PER SECTION so feedback ↔ game-alike align by row.
  // Batch cell spans all sections of its group; Evaluator cell spans its sections.
  // `secLast` marks an evaluator/batch boundary (solid divider) vs an inner
  // section boundary (faint dashed divider).
  interface FlatRow { rec: WeeklyRecord; section: Section | null; secIndex: number; secCount: number; secLast: boolean; batchSpan?: number; evalSpan?: number }
  const flatRows: { batch: string; row: FlatRow }[] = []
  for (const g of groups) {
    const batchSpan = g.rows.reduce((acc, r) => acc + Math.max(r.sections?.length || 0, 1), 0)
    let firstOfBatch = true
    for (const r of g.rows) {
      const secs: (Section | null)[] = r.sections?.length ? r.sections : [null]
      secs.forEach((s, i) => {
        flatRows.push({
          batch: g.batch,
          row: {
            rec: r, section: s, secIndex: i, secCount: secs.length, secLast: i === secs.length - 1,
            batchSpan: firstOfBatch ? batchSpan : undefined,
            evalSpan: i === 0 ? secs.length : undefined,
          },
        })
        firstOfBatch = false
      })
    }
  }

  // A click anywhere in a row opens the week — except on a real link (feedback
  // links, game chips), which should follow their href instead of navigating.
  const onRowClick = (e: MouseEvent, rec: WeeklyRecord) => {
    const a = (e.target as HTMLElement).closest('a')
    if (a && a.getAttribute('href')) return
    openRecord(rec)
  }

  const who = viewingSelf ? (userName || 'my own') : evaluator
  const listWho = isManager ? (listEvaluator || 'All evaluators') : (userName || 'my own')
  const sub = view === 'week'
    ? `${who}${selectedBatch ? ` · ${selectedBatch}` : ''}`
    : `${listWho} · ${listBatch || 'all weeks'} · ${records.length} record${records.length === 1 ? '' : 's'}`

  return (
    <div className="page" style={{ paddingBottom: 16, height: '100vh', boxSizing: 'border-box', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h1 className="h-title">Weekly Feedback</h1>
          <p className="h-sub">{sub}</p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className={`seg-btn-premium${view === 'list' ? ' active' : ''}`} onClick={() => setView('list')}>List</button>
          <button className={`seg-btn-premium${view === 'week' ? ' active' : ''}`} onClick={() => setView('week')}>Week</button>
          {isManager && <button className={`seg-btn-premium${view === 'import' ? ' active' : ''}`} onClick={() => setView('import')}>Import</button>}
        </div>
      </div>

      {view !== 'import' && (
      <div className="filter-row" style={{ position: 'relative', zIndex: 30 }}>
        {view === 'list' ? (
          <>
            <div style={{ width: 200 }}>
              <StyledSelect
                value={listBatch}
                onChange={setListBatch}
                placeholder="All weeks"
                options={[{ value: '', label: 'All weeks' }, ...batches.map(b => ({ value: b, label: b }))]}
              />
            </div>
            {isManager && (
              <div style={{ width: 200 }}>
                <StyledSelect
                  value={listEvaluator}
                  onChange={setListEvaluator}
                  placeholder="All evaluators"
                  options={[{ value: '', label: 'All evaluators' }, ...evaluators.map(e => ({ value: e, label: e }))]}
                />
              </div>
            )}
          </>
        ) : (
          <>
            {isManager && (
              <div style={{ width: 200 }}>
                <StyledSelect
                  value={evaluator}
                  onChange={setEvaluator}
                  placeholder="My own"
                  options={[{ value: '', label: 'My own' }, ...evaluators.map(e => ({ value: e, label: e }))]}
                />
              </div>
            )}
            <div style={{ width: 200 }}>
              <StyledSelect
                value={selectedBatch}
                onChange={setSelectedBatch}
                placeholder="Select a week…"
                options={batches.map(b => ({ value: b, label: b }))}
              />
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
              <div className="wf-label-row">
                <h3 className="wf-label">Sections</h3>
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
                  <SectionEditor
                    key={s.id}
                    section={s}
                    index={i}
                    total={sections.length}
                    onChange={patch => updateSection(s.id, patch)}
                    onMove={dir => moveSection(i, dir)}
                    onRemove={() => removeSection(s.id)}
                  />
                ))}
              </div>
              <button type="button" className="wf-addsection" onClick={addSection}>+ Add section</button>
            </>
          ) : (
            <FeedbackView sections={sections} />
          )
        ) : (
          <table className="wf-list" style={{ width: '100%' }}>
            <thead><tr><th>Batch</th><th>Evaluator</th><th>Feedback</th><th>Game Alike</th></tr></thead>
            <tbody>
              {records.length === 0 && (
                <tr><td colSpan={4}><span className="h-sub">No feedback recorded yet.</span></td></tr>
              )}
              {flatRows.map(({ batch, row }) => {
                const no = row.secCount > 1 ? row.secIndex + 1 : null
                const cls = row.secLast ? 'wf-c-solid' : 'wf-c-sec'
                return (
                  <tr key={`${batch}::${row.rec.evaluator}::${row.secIndex}`} onClick={e => onRowClick(e, row.rec)} style={{ cursor: 'pointer' }}>
                    {row.batchSpan != null && <td className="wf-list-batch" rowSpan={row.batchSpan}>{batch}</td>}
                    {row.evalSpan != null && <td className="wf-list-eval" rowSpan={row.evalSpan}>{row.rec.evaluator}</td>}
                    <td className={cls}><FeedbackCell doc={row.section?.feedback ?? null} no={no} /></td>
                    <td className={cls}><AlikeCell alikes={row.section?.alikes} no={no} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
