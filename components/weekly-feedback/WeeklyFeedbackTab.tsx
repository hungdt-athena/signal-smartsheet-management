'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { StyledSelect } from '@/components/StyledSelect'
import { registerUnsavedGuard } from '@/lib/unsaved-guard'
import { FeedbackEditor } from './FeedbackEditor'
import { FeedbackView } from './FeedbackView'

interface WeeklyRecord { batch: string; evaluator: string; feedback: unknown; game_alike: unknown; updated_at: string }

export function WeeklyFeedbackTab() {
  const { data: session } = useSession()
  const role = session?.user?.role
  const isManager = role === 'admin' || role === 'moderator'
  const userName = session?.user?.name || ''

  // List / Week toggle is local state only — NO url params.
  const [view, setView] = useState<'list' | 'week'>('list')

  const [batches, setBatches] = useState<string[]>([])
  const [evaluators, setEvaluators] = useState<string[]>([])
  const [evaluator, setEvaluator] = useState('') // manager-only override; '' = my own
  const [selectedBatch, setSelectedBatch] = useState('')

  const [feedback, setFeedback] = useState<unknown>(null)
  const [gameAlike, setGameAlike] = useState<unknown>(null)
  const [records, setRecords] = useState<WeeklyRecord[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const dirtyRef = useRef(false)

  // Viewing self when: not a manager, or a manager who left the picker empty /
  // picked their own name. Only then do we offer the editors + Save.
  const viewingSelf = !isManager || !evaluator || evaluator.toLowerCase() === userName.toLowerCase()

  // One-shot load of batches (+ evaluators for managers).
  useEffect(() => {
    fetch('/api/weekly-feedback/batches')
      .then(r => r.json())
      .then(d => {
        setBatches(d.batches || [])
        if (isManager) setEvaluators(Array.isArray(d.evaluators) ? d.evaluators : [])
      })
      .catch(() => { setBatches([]); setEvaluators([]) })
  }, [isManager])

  // Week view: load the record for the selected batch.
  useEffect(() => {
    if (view !== 'week' || !selectedBatch) return
    const qs = new URLSearchParams({ batch: selectedBatch })
    if (isManager && evaluator) qs.set('evaluator', evaluator)
    fetch(`/api/weekly-feedback?${qs}`).then(r => r.json()).then(d => {
      setFeedback(d.record?.feedback ?? null)
      setGameAlike(d.record?.game_alike ?? null)
      setDirty(false); dirtyRef.current = false
    })
  }, [view, selectedBatch, evaluator, isManager])

  // List view: load every record for the resolved evaluator.
  useEffect(() => {
    if (view !== 'list') return
    const qs = new URLSearchParams()
    if (isManager && evaluator) qs.set('evaluator', evaluator)
    fetch(`/api/weekly-feedback?${qs}`).then(r => r.json()).then(d => setRecords(d.records || []))
  }, [view, evaluator, isManager])

  const save = useCallback(async () => {
    setSaving(true)
    await fetch('/api/weekly-feedback', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batch: selectedBatch, feedback, game_alike: gameAlike }),
    })
    setSaving(false); setDirty(false); dirtyRef.current = false
  }, [selectedBatch, feedback, gameAlike])

  // Unsaved guard so the deploy watcher / page close never drops edits.
  useEffect(() => registerUnsavedGuard({ isDirty: () => dirtyRef.current, flush: () => save() }), [save])
  const markDirty = () => { setDirty(true); dirtyRef.current = true }

  // Auto-save: persist ~1s after edits stop. Editing feedback/gameAlike changes
  // `save` (it closes over them), which re-runs this effect and resets the timer
  // — a natural debounce. `dirty` gates it; saving clears dirty and stops the loop.
  useEffect(() => {
    if (!dirty || !viewingSelf || !selectedBatch) return
    const t = setTimeout(() => { void save() }, 1000)
    return () => clearTimeout(t)
  }, [dirty, viewingSelf, selectedBatch, save])

  const openBatch = (b: string) => { setSelectedBatch(b); setView('week') }

  const who = viewingSelf ? (userName || 'my own') : evaluator
  const sub = view === 'week'
    ? `${who}${selectedBatch ? ` · ${selectedBatch}` : ''}`
    : `${who} · ${records.length} week${records.length === 1 ? '' : 's'}`

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
        </div>
      </div>

      {(isManager || view === 'week') && (
        <div className="filter-row" style={{ position: 'relative', zIndex: 30 }}>
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
          {view === 'week' && (
            <div style={{ width: 200 }}>
              <StyledSelect
                value={selectedBatch}
                onChange={setSelectedBatch}
                placeholder="Select a week…"
                options={batches.map(b => ({ value: b, label: b }))}
              />
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {view === 'week' ? (
          !selectedBatch ? (
            <p className="h-sub" style={{ padding: 8 }}>Select a week to view or edit feedback.</p>
          ) : viewingSelf ? (
            <>
              <div className="wf-label-row">
                <h3 className="wf-label">Feedback</h3>
                <span className="wf-savestate">{saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'All changes saved'}</span>
              </div>
              <FeedbackEditor value={feedback} onChange={v => { setFeedback(v); markDirty() }} />
              <h3 className="wf-label">Game Alike</h3>
              <FeedbackEditor value={gameAlike} onChange={v => { setGameAlike(v); markDirty() }} />
            </>
          ) : (
            <FeedbackView feedback={feedback} gameAlike={gameAlike} />
          )
        ) : (
          <table className="wf-list" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th>Week</th><th>Feedback</th><th>Game Alike</th></tr></thead>
            <tbody>
              {records.length === 0 && (
                <tr><td colSpan={3}><span className="h-sub">No feedback recorded yet.</span></td></tr>
              )}
              {records.map(r => (
                <tr key={r.batch} onClick={() => openBatch(r.batch)} style={{ cursor: 'pointer' }}>
                  <td className="wf-list-week">{r.batch}</td>
                  <td><FeedbackView feedback={r.feedback} gameAlike={r.game_alike} part="feedback" /></td>
                  <td><FeedbackView feedback={r.feedback} gameAlike={r.game_alike} part="gamealike" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
