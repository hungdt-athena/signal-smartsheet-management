// components/ReassignPanel.tsx — DB-native manual re-assign (migration 025 / Plan A).
// Move a source evaluator's still-pending games to chosen evaluators. Two modes:
// by date range OR by quantity. Per-target weight can be tweaked for this run only
// (does NOT touch Assign Setup). Preview is manual — the Preview button runs a dryRun
// (platform + per-day breakdowns); changing any field clears the stale preview.
'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSession } from 'next-auth/react'
import { StyledSelect } from '@/components/StyledSelect'
import { BUCKETS, WEIGHTS, type Bucket } from '@/lib/buckets'
import { DistributionResult, type DistResult } from '@/components/DistributionResult'
import { OperationHistory } from '@/components/OperationHistory'

interface RosterRow { id: number; name: string; today_available: boolean; game_platform: string; weight: number }
type Mode = 'range' | 'quantity'
const BUCKET_LABELS: Record<Bucket, string> = { puzzle: 'Puzzle', arcade: 'Arcade', simulation: 'Simulation' }
const WEIGHT_OPTS = WEIGHTS.map(w => ({ value: String(w), label: String(w) }))

export function ReassignPanel() {
  const { data: session } = useSession()
  const isEvaluator = session?.user?.role === 'evaluator'
  const [category, setCategory] = useState<Bucket>('puzzle')
  const [roster, setRoster] = useState<RosterRow[]>([])
  const [from, setFrom] = useState('')
  const [mode, setMode] = useState<Mode>('range')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [count, setCount] = useState('')
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [weightOverrides, setWeightOverrides] = useState<Record<string, number>>({})
  const [result, setResult] = useState<DistResult | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [histToken, setHistToken] = useState(0) // bump to reload the history container

  // Load the bucket's initial-evaluator roster; reset everything on bucket change.
  const loadRoster = useCallback(async () => {
    try {
      const res = await fetch(`/api/assign-setup?group=${category}`, { cache: 'no-store' })
      const json = await res.json()
      setRoster((json.initial ?? []) as RosterRow[])
    } catch { setRoster([]) }
  }, [category])

  useEffect(() => {
    loadRoster()
    setFrom(''); setChecked({}); setWeightOverrides({}); setResult(null); setMsg(null)
  }, [loadRoster])

  const targets = useMemo(() => roster.filter(r => r.name !== from), [roster, from])
  // Default target selection: everyone available except the source.
  useEffect(() => {
    const init: Record<string, boolean> = {}
    for (const r of targets) init[r.name] = r.today_available
    setChecked(init)
  }, [targets])

  const rosterByName = useMemo(() => new Map(roster.map(r => [r.name, r])), [roster])
  const effWeight = useCallback(
    (name: string) => weightOverrides[name] ?? rosterByName.get(name)?.weight ?? 100,
    [weightOverrides, rosterByName],
  )

  const selected = useMemo(() => targets.filter(r => checked[r.name]).map(r => r.name), [targets, checked])
  const hasRange = mode === 'range' && !!startDate && !!endDate
  const hasCount = mode === 'quantity' && Number(count) > 0
  const canPreview = !!from && (hasRange || hasCount)
  const canCommit = !!result && result.dryRun && selected.length > 0

  // Any change to a preview-affecting field drops the stale preview — the user must
  // re-run Preview to see fresh numbers.
  const configKey = useMemo(
    () => JSON.stringify({ category, from, mode, startDate, endDate, count, sel: selected.map(n => [n, effWeight(n)]) }),
    [category, from, mode, startDate, endDate, count, selected, effWeight],
  )
  useEffect(() => { setResult(null); setMsg(null) }, [configKey])

  const buildBody = useCallback((dryRun: boolean) => ({
    category, evaluator_name: from,
    start_date: hasRange ? startDate : undefined,
    end_date: hasRange ? endDate : undefined,
    count: hasCount ? Number(count) : undefined,
    selected_evaluators: selected,
    evaluator_weights: Object.fromEntries(selected.map(n => [n, effWeight(n)])),
    dryRun,
  }), [category, from, hasRange, hasCount, startDate, endDate, count, selected, effWeight])

  async function runPreview() {
    if (!canPreview) return
    setPreviewing(true); setMsg(null)
    try {
      const res = await fetch('/api/operations/reassign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(true)),
      })
      const json = await res.json()
      if (!res.ok) { setMsg({ type: 'err', text: json.error ?? 'Failed' }); return }
      setResult(json as DistResult)
    } catch { setMsg({ type: 'err', text: 'Network error' }) }
    finally { setPreviewing(false) }
  }

  async function commit() {
    if (!canCommit) return
    setCommitting(true); setMsg(null)
    try {
      const res = await fetch('/api/operations/reassign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(false)),
      })
      const json = await res.json()
      if (!res.ok) { setMsg({ type: 'err', text: json.error ?? 'Failed' }); return }
      setResult(json as DistResult)
      setMsg({ type: 'ok', text: `Re-assigned ${json.assigned ?? 0} games from ${from} to ${selected.length} evaluators.` })
      setHistToken(t => t + 1)
    } catch { setMsg({ type: 'err', text: 'Network error' }) }
    finally { setCommitting(false) }
  }

  const commitBtn = (
    <button className="btn btn-primary btn-sm" disabled={!canCommit || committing} onClick={commit}>
      {committing ? 'Re-assigning…' : `Commit re-assign${selected.length ? ` → ${selected.length} people` : ''}`}
    </button>
  )

  const bucketTabs = (
    <div className="seg-wrapper" style={{ display: 'inline-flex', gap: 4, marginBottom: 14 }}>
      {BUCKETS.map(b => (
        <button key={b} className={`seg-btn-premium${category === b ? ' active' : ''}`} onClick={() => setCategory(b)}>
          {BUCKET_LABELS[b]}
        </button>
      ))}
    </div>
  )

  // Evaluators get a read-only view: just the history container, scoped by the runs
  // API to operations they're involved in (as source or recipient). No form.
  if (isEvaluator) {
    return (
      <div>
        {bucketTabs}
        <p style={{ fontSize: 12.5, color: 'var(--faint)', margin: '-4px 2px 12px' }}>
          Re-assignments involving you — as the source or a recipient.
        </p>
        <OperationHistory kind="reassign" category={category} reloadToken={histToken} />
      </div>
    )
  }

  return (
    <div>
      {bucketTabs}

      <OperationHistory kind="reassign" category={category} reloadToken={histToken} />

      <div className="card">
        <div style={{ padding: 16 }}>
          {/* Row 1 (inline): source · mode · range/quantity */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
            <div className="field" style={{ flex: '1 1 220px', minWidth: 180 }}>
              <span className="label">Re-assign from</span>
              <StyledSelect value={from} onChange={setFrom} placeholder="-- Select evaluator --"
                options={roster.map(r => ({ value: r.name, label: r.name }))} />
            </div>
            <div className="field">
              <span className="label">Mode</span>
              <div className="seg-wrapper" style={{ display: 'inline-flex', gap: 4 }}>
                <button className={`seg-btn-premium${mode === 'range' ? ' active' : ''}`} onClick={() => setMode('range')}>By date range</button>
                <button className={`seg-btn-premium${mode === 'quantity' ? ' active' : ''}`} onClick={() => setMode('quantity')}>By quantity</button>
              </div>
            </div>
            {mode === 'range' ? (
              <>
                <div className="field" style={{ width: 150 }}>
                  <span className="label">Start date</span>
                  <input type="date" className="input" value={startDate} onChange={e => setStartDate(e.target.value)} />
                </div>
                <div className="field" style={{ width: 150 }}>
                  <span className="label">End date</span>
                  <input type="date" className="input" value={endDate} onChange={e => setEndDate(e.target.value)} />
                </div>
              </>
            ) : (
              <div className="field" style={{ width: 180 }}>
                <span className="label">Number of games (oldest first)</span>
                <input type="number" min={1} className="input" value={count}
                  onChange={e => setCount(e.target.value)} placeholder="e.g. 20" />
              </div>
            )}
          </div>

          <div className="field">
            <span className="label">Assign to ({selected.length} selected) · weight is per-run, does not change Assign Setup</span>
            {!from ? (
              <p style={{ fontSize: 12, color: 'var(--faint)', fontStyle: 'italic' }}>Select a source evaluator first.</p>
            ) : targets.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--faint)', fontStyle: 'italic' }}>No other evaluators in this bucket.</p>
            ) : (
              <div className="check-grid">
                {targets.map(r => (
                  <div key={r.id} className={`check-item${checked[r.name] ? ' on' : ''}`}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, cursor: 'pointer' }}>
                      <input type="checkbox" checked={!!checked[r.name]}
                        onChange={e => setChecked(prev => ({ ...prev, [r.name]: e.target.checked }))} />
                      <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
                      <span className={`pill ${r.today_available ? 'on' : 'off'}`} style={{ fontSize: 10 }}>
                        {r.today_available ? 'avail' : 'away'}
                      </span>
                      {r.game_platform && r.game_platform !== 'all' && (
                        <span className="pill tag" style={{ fontSize: 10 }}>{r.game_platform}</span>
                      )}
                    </label>
                    <div onClick={e => e.stopPropagation()} style={{ width: 74, flexShrink: 0 }} title="Weight (this run only)">
                      <StyledSelect value={String(effWeight(r.name))} options={WEIGHT_OPTS}
                        onChange={v => setWeightOverrides(prev => ({ ...prev, [r.name]: Number(v) }))} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
            <button className="btn btn-primary" disabled={!canPreview || previewing} onClick={runPreview}>
              {previewing ? 'Previewing…' : 'Preview'}
            </button>
            {!canPreview && <span style={{ fontSize: 12, color: 'var(--faint)' }}>Pick a source and a date range or quantity.</span>}
          </div>
        </div>
      </div>

      {result && <DistributionResult result={result} action={commitBtn} />}
      {msg && <p className={msg.type === 'ok' ? 'msg-ok' : 'msg-err'} style={{ marginTop: 10 }}>{msg.text}</p>}
    </div>
  )
}
