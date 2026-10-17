// components/HandoverPanel.tsx — DB-native handover (migration 025 / Plan A).
// A leaving evaluator's still-pending games in a date window are redistributed to
// everyone currently available in the bucket. Preview (dryRun) before submit; the
// submit creates a request another manager approves or rejects in History.
//
// Layout: category group, then the form and its preview, then History below.
'use client'
import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { StyledSelect } from '@/components/StyledSelect'
import { BUCKET_OPTS } from '@/components/RosterTable'
import { FilterBar } from '@/components/ui/FilterBar'
import { Seg } from '@/components/ui/Seg'
import type { Bucket } from '@/lib/buckets'
import { toast } from '@/lib/toast'
import { DistributionResult, type DistResult } from '@/components/DistributionResult'
import { OperationHistory } from '@/components/OperationHistory'
import { usePendingHolders } from '@/hooks/usePendingHolders'

interface RosterRow { id: number; name: string; today_available: boolean }

// category: which bucket is on screen; the page keeps it in ?cat=.
export function HandoverPanel({ category, onCategoryChange }: {
  category: Bucket
  onCategoryChange: (b: Bucket) => void
}) {
  const { data: session } = useSession()
  const isEvaluator = session?.user?.role === 'evaluator'
  const selfName = session?.user?.name || ''
  const [roster, setRoster] = useState<RosterRow[]>([])
  const [from, setFrom] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null)
  const [result, setResult] = useState<DistResult | null>(null)
  const [histToken, setHistToken] = useState(0) // bump to reload the history container

  // ?group= matters: without it the API hands back every genre, so anyone on two
  // rosters arrived twice -- both in this list and in the available-target count.
  const loadRoster = useCallback(async () => {
    try {
      const res = await fetch(`/api/assign-setup?group=${category}`, { cache: 'no-store' })
      const json = await res.json()
      const rows = (json.initial ?? []) as RosterRow[]
      const seen = new Set<string>()
      setRoster(rows.filter(r => {
        if (seen.has(r.name)) return false
        seen.add(r.name)
        return true
      }))
    } catch { setRoster([]) }
  }, [category])

  // Source list = who actually holds pending games in this bucket. Evaluators are
  // locked to themselves, so they never need it.
  const { options: fromOptions, loading: holdersLoading } = usePendingHolders(category, !isEvaluator)

  useEffect(() => {
    loadRoster()
    // Evaluators can only hand over their own games — lock the source to themselves.
    setFrom(isEvaluator ? selfName : ''); setResult(null)
  }, [loadRoster, isEvaluator, selfName])

  const canRun = !!from && !!startDate && !!endDate
  const available = roster.filter(r => r.name !== from && r.today_available).length

  async function run(dryRun: boolean) {
    if (!canRun) return
    setBusy(dryRun ? 'preview' : 'commit')
    try {
      const res = await fetch('/api/operations/handover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, evaluator_name: from, start_date: startDate, end_date: endDate, dryRun }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error ?? (dryRun ? 'Preview failed.' : 'Could not submit the request.')); return }
      setResult(json as DistResult)
      if (!dryRun) {
        toast.success(`Request sent for a manager to approve: ${json.assignable ?? 0} games from ${from}.`)
        setHistToken(t => t + 1)
      }
    } catch { toast.error('Could not reach the server.') }
    finally { setBusy(null) }
  }

  return (
    <>
      <FilterBar ariaLabel="Category group">
        <Seg value={category} onChange={onCategoryChange} options={BUCKET_OPTS} ariaLabel="Category group" />
      </FilterBar>

      <div className="card">
        <div className="ops-form-grid">
          <div className="field">
            <span className="label">Evaluator on leave</span>
            <StyledSelect value={from} onChange={setFrom} disabled={isEvaluator || fromOptions.length === 0}
              placeholder={isEvaluator ? selfName
                : holdersLoading ? 'Loading…'
                : fromOptions.length === 0 ? 'Nobody holds pending games here'
                : 'Select evaluator'}
              options={isEvaluator ? [{ value: selfName, label: selfName }] : fromOptions} />
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
        <p className="ops-hint" style={{ marginTop: 10 }}>
          {isEvaluator
            ? 'Your pending games assigned in these dates go to the available evaluators in this category group. Preview shows the split. Submitting sends a request that a manager must approve.'
            : `Their pending games assigned in these dates go to the ${available} available evaluator${available === 1 ? '' : 's'} in this category group. Submitting sends a request that another manager must approve. The split is worked out again at approval.`}
        </p>

        <div className="ops-actions">
          <button className="btn" disabled={!canRun || busy !== null} onClick={() => run(true)}>
            {busy === 'preview' ? 'Previewing…' : 'Preview'}
          </button>
          <button className="btn btn-primary" disabled={!canRun || busy !== null} onClick={() => run(false)}>
            {busy === 'commit' ? 'Submitting…' : 'Submit request'}
          </button>
        </div>
      </div>

      {result && <DistributionResult result={result} />}

      <OperationHistory kind="handover" category={category} reloadToken={histToken} />
    </>
  )
}
