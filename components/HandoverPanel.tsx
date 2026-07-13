// components/HandoverPanel.tsx — DB-native handover (migration 025 / Plan A).
// A leaving evaluator's still-pending games in a date window are redistributed to
// everyone currently available in the bucket. Preview (dryRun) before commit.
'use client'
import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { StyledSelect } from '@/components/StyledSelect'
import { BUCKETS, type Bucket } from '@/lib/buckets'
import { DistributionResult, type DistResult } from '@/components/DistributionResult'
import { OperationHistory } from '@/components/OperationHistory'

interface RosterRow { id: number; name: string; today_available: boolean }
const BUCKET_LABELS: Record<Bucket, string> = { puzzle: 'Puzzle', arcade: 'Arcade', simulation: 'Simulation' }

export function HandoverPanel() {
  const { data: session } = useSession()
  const isEvaluator = session?.user?.role === 'evaluator'
  const selfName = session?.user?.name || ''
  const [category, setCategory] = useState<Bucket>('puzzle')
  const [roster, setRoster] = useState<RosterRow[]>([])
  const [from, setFrom] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null)
  const [result, setResult] = useState<DistResult | null>(null)
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [histToken, setHistToken] = useState(0) // bump to reload the history container

  const loadRoster = useCallback(async () => {
    try {
      const res = await fetch(`/api/assign-setup?group=${category}`, { cache: 'no-store' })
      const json = await res.json()
      setRoster((json.initial ?? []) as RosterRow[])
    } catch { setRoster([]) }
  }, [category])

  useEffect(() => {
    loadRoster()
    // Evaluators can only hand over their own games — lock the source to themselves.
    setFrom(isEvaluator ? selfName : ''); setResult(null); setMsg(null)
  }, [loadRoster, isEvaluator, selfName])

  const canRun = !!from && !!startDate && !!endDate
  const available = roster.filter(r => r.name !== from && r.today_available).length

  async function run(dryRun: boolean) {
    if (!canRun) return
    setBusy(dryRun ? 'preview' : 'commit'); setMsg(null)
    try {
      const res = await fetch('/api/operations/handover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, evaluator_name: from, start_date: startDate, end_date: endDate, dryRun }),
      })
      const json = await res.json()
      if (!res.ok) { setMsg({ type: 'err', text: json.error ?? 'Failed' }); return }
      setResult(json as DistResult)
      if (!dryRun) {
        setMsg({ type: 'ok', text: `Handover request submitted for a manager to approve (${json.assignable ?? 0} games would move from ${from}).` })
        setHistToken(t => t + 1)
      }
    } catch { setMsg({ type: 'err', text: 'Network error' }) }
    finally { setBusy(null) }
  }

  return (
    <div>
      <div className="seg-wrapper" style={{ display: 'inline-flex', gap: 4, marginBottom: 14 }}>
        {BUCKETS.map(b => (
          <button key={b} className={`seg-btn-premium${category === b ? ' active' : ''}`} onClick={() => setCategory(b)}>
            {BUCKET_LABELS[b]}
          </button>
        ))}
      </div>

      <OperationHistory kind="handover" category={category} reloadToken={histToken} />

      <div className="card">
        <div style={{ padding: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <div className="field">
              <span className="label">Evaluator on leave</span>
              <StyledSelect value={from} onChange={setFrom} placeholder="-- Select evaluator --" disabled={isEvaluator}
                options={isEvaluator
                  ? [{ value: selfName, label: selfName }]
                  : roster.map(r => ({ value: r.name, label: r.name }))} />
            </div>
            <div className="field">
              <span className="label">Start date</span>
              <input type="date" className="input" value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
            <div className="field">
              <span className="label">End date</span>
              <input type="date" className="input" value={endDate} onChange={e => setEndDate(e.target.value)} />
            </div>
          </div>
          <p style={{ fontSize: 12, color: 'var(--faint)', marginTop: 10 }}>
            {isEvaluator
              ? 'Your pending games assigned in this window are redistributed to the available evaluators in this bucket. Preview to see the split; submitting creates a request a manager must approve.'
              : `Their pending games assigned in this window go to the ${available} currently-available evaluator${available === 1 ? '' : 's'} in this bucket. Submitting creates a request another manager must approve — the split is recomputed at approval time.`}
          </p>

          {msg && <p className={msg.type === 'ok' ? 'msg-ok' : 'msg-err'} style={{ marginTop: 10 }}>{msg.text}</p>}

          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="btn" disabled={!canRun || busy !== null} onClick={() => run(true)}>
              {busy === 'preview' ? 'Previewing…' : 'Preview'}
            </button>
            <button className="btn btn-primary" disabled={!canRun || busy !== null} onClick={() => run(false)}>
              {busy === 'commit' ? 'Submitting…' : 'Submit request'}
            </button>
          </div>
        </div>
      </div>

      {result && <DistributionResult result={result} />}
    </div>
  )
}
