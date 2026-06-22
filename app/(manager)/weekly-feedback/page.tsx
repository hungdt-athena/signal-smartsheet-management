'use client'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { FeedbackEditor } from '@/components/weekly-feedback/FeedbackEditor'
import { GameAlikeEditor } from '@/components/weekly-feedback/GameAlikeEditor'
import { FeedbackView } from '@/components/weekly-feedback/FeedbackView'
import { GameAlikeSection } from '@/components/weekly-feedback/types'
import { registerUnsavedGuard } from '@/lib/unsaved-guard'

interface WeeklyRecord { batch: string; evaluator: string; feedback: unknown; game_alike: GameAlikeSection[]; updated_at: string }

function Inner() {
  const { data: session } = useSession()
  const role = session?.user?.role
  const isManager = role === 'admin' || role === 'moderator'
  const params = useSearchParams()
  const router = useRouter()
  const view = params.get('view') === 'list' ? 'list' : 'batch'
  const selectedBatch = params.get('batch') || ''

  const [batches, setBatches] = useState<string[]>([])
  const [evaluators, setEvaluators] = useState<string[]>([])
  const [evaluator, setEvaluator] = useState('') // manager-only override
  const [feedback, setFeedback] = useState<unknown>(null)
  const [gameAlike, setGameAlike] = useState<GameAlikeSection[]>([])
  const [records, setRecords] = useState<WeeklyRecord[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const dirtyRef = useRef(false)

  const viewingSelf = !isManager || !evaluator || evaluator.toLowerCase() === (session?.user?.name || '').toLowerCase()

  useEffect(() => {
    fetch('/api/weekly-feedback/batches').then(r => r.json()).then(d => setBatches(d.batches || [])).catch(() => setBatches([]))
    if (isManager) {
      fetch('/api/evaluators')
        .then(r => (r.ok ? r.json() : []))
        .then(d => setEvaluators(Array.isArray(d) ? d.map((ev: { name: string }) => ev.name).filter(Boolean) : []))
        .catch(() => setEvaluators([]))
    }
  }, [isManager])

  // Load the record for the selected batch (batch view).
  useEffect(() => {
    if (view !== 'batch' || !selectedBatch) return
    const qs = new URLSearchParams({ batch: selectedBatch })
    if (isManager && evaluator) qs.set('evaluator', evaluator)
    fetch(`/api/weekly-feedback?${qs}`).then(r => r.json()).then(d => {
      setFeedback(d.record?.feedback ?? null)
      setGameAlike(d.record?.game_alike ?? [])
      setDirty(false); dirtyRef.current = false
    })
  }, [view, selectedBatch, evaluator, isManager])

  // Load the list (list view).
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

  const goBatch = (b: string) => router.push(`/weekly-feedback?view=batch&batch=${encodeURIComponent(b)}`)

  return (
    <div className="bean-card wf-page">
      <div className="wf-head">
        <h1>Weekly Feedback</h1>
        {isManager && (
          <select value={evaluator} onChange={e => setEvaluator(e.target.value)}>
            <option value="">— my own —</option>
            {evaluators.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        )}
        <Link href="/weekly-feedback?view=batch">By Week</Link>
        <Link href="/weekly-feedback?view=list">List</Link>
      </div>

      {view === 'batch' && (
        <>
          <select value={selectedBatch} onChange={e => goBatch(e.target.value)}>
            <option value="">Select a week…</option>
            {batches.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
          {selectedBatch && (viewingSelf ? (
            <>
              <h3>Feedback</h3>
              <FeedbackEditor value={feedback} onChange={v => { setFeedback(v); markDirty() }} />
              <h3>Game Alike</h3>
              <GameAlikeEditor value={gameAlike} onChange={v => { setGameAlike(v); markDirty() }} />
              <button type="button" disabled={!dirty || saving} onClick={save}>
                {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
              </button>
            </>
          ) : (
            <FeedbackView feedback={feedback} gameAlike={gameAlike} />
          ))}
        </>
      )}

      {view === 'list' && (
        <table className="wf-list">
          <thead><tr><th>Week</th><th>Feedback</th><th>Game Alike</th></tr></thead>
          <tbody>
            {records.map(r => (
              <tr key={r.batch} onClick={() => goBatch(r.batch)} style={{ cursor: 'pointer' }}>
                <td>{r.batch}</td>
                <td colSpan={2}><FeedbackView feedback={r.feedback} gameAlike={r.game_alike} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export default function WeeklyFeedbackPage() {
  return <Suspense><Inner /></Suspense>
}
