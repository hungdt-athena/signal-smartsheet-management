// components/ReassignPanel.tsx — DB-native manual re-assign (migration 025 / Plan A).
// Move a source evaluator's still-pending games to chosen evaluators. Two modes:
// by date range OR by quantity. Per-target weight can be tweaked for this run only
// (does NOT touch Assign Setup). Preview is manual — the Preview button runs a dryRun
// (platform + per-day breakdowns); changing any field clears the stale preview.
// Moving the games asks once more, in a modal that states the count.
//
// Layout: category group, then the form and its preview, then History below.
'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { StyledSelect } from '@/components/StyledSelect'
import { BUCKET_OPTS } from '@/components/RosterTable'
import { FilterBar } from '@/components/ui/FilterBar'
import { Modal } from '@/components/ui/Modal'
import { Seg } from '@/components/ui/Seg'
import { WEIGHTS, type Bucket } from '@/lib/buckets'
import { toast } from '@/lib/toast'
import { DistributionResult, type DistResult } from '@/components/DistributionResult'
import { OperationHistory } from '@/components/OperationHistory'
import { usePendingHolders } from '@/hooks/usePendingHolders'

interface RosterRow { id: number; name: string; today_available: boolean; game_platform: string; weight: number }
type Mode = 'range' | 'quantity'
const WEIGHT_OPTS = WEIGHTS.map(w => ({ value: String(w), label: String(w) }))
const MODE_OPTS: { value: Mode; label: string }[] = [
  { value: 'range', label: 'By date range' },
  { value: 'quantity', label: 'By quantity' },
]

// initialFrom: who the Report's "Reassign PhuongNT1's backlog" link meant. It only
// preselects the source — it can never carry a date range, a quantity or a target
// pick, because those are decisions the manager still has to make here.
//
// category: which bucket is on screen. The page keeps it in ?cat=, so a Reassign
// link from an Arcade report opens the arcade roster that contains the named
// person. Same rule as `initialFrom`: it picks the VIEW, never a setting.
export function ReassignPanel({ initialFrom, category, onCategoryChange }: {
  initialFrom?: string
  category: Bucket
  onCategoryChange: (b: Bucket) => void
}) {
  const { data: session } = useSession()
  const isEvaluator = session?.user?.role === 'evaluator'
  const setCategory = onCategoryChange
  const [roster, setRoster] = useState<RosterRow[]>([])
  const [from, setFrom] = useState(initialFrom ?? '')
  const [mode, setMode] = useState<Mode>('range')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [count, setCount] = useState('')
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [weightOverrides, setWeightOverrides] = useState<Record<string, number>>({})
  const [result, setResult] = useState<DistResult | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [histToken, setHistToken] = useState(0) // bump to reload the history container

  // Load THIS bucket's initial-evaluator roster; reset everything on bucket change.
  // ?group= matters: the route ignored it until now and handed back every genre, so
  // anyone on two rosters (HuyDD and NhiLV are on both arcade and puzzle) arrived
  // twice and was listed twice. Dedupe by name as well, so one stale cache or a
  // future duplicate row cannot put the same person in the list twice again.
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

  // The first run should keep whatever the URL preselected; only a later category
  // switch clears the source, since the roster underneath it just changed.
  const mounted = useRef(false)
  useEffect(() => {
    loadRoster()
    if (mounted.current) setFrom('')
    mounted.current = true
    setChecked({}); setWeightOverrides({}); setResult(null)
  }, [loadRoster])

  // The source list is the people actually HOLDING pending games in this bucket. The
  // roster answers a different question -- who may RECEIVE this genre -- and the two
  // sets drift: someone on the arcade roster can hold zero arcade games (nothing to
  // move), and someone dropped from the roster can still be holding games that have
  // to be moved off them. Listing the roster showed all eleven people under Arcade
  // when only HuyDD and NhiLV had anything there.
  const { holders, options: fromOptions, loading: holdersLoading, refresh: refreshHolders } =
    usePendingHolders(category, !isEvaluator)

  // A link can only say a name; it cannot guarantee that name still holds games in
  // this bucket by the time it loads, or that it spells it the same way. The Report's
  // names and this list both come from game_evaluations.initial_evaluator now, but the
  // match stays case-insensitive and the select is seeded with the LIST's own spelling
  // (never the URL's) because casing has drifted between tables before. A name that
  // resolves to nothing real drops the preselection rather than leaving the select on
  // a value it cannot display.
  useEffect(() => {
    if (!initialFrom || holders.length === 0) return
    const match = holders.find(h => h.name.toLowerCase() === initialFrom.toLowerCase())
    setFrom(match ? match.name : '')
  }, [holders, initialFrom])

  // Switching bucket, or draining a source to zero, drops a source that holds
  // nothing here rather than leaving a name in the box that the list no longer has.
  // Case-insensitive on purpose: the effect above runs first and hands this one a
  // `from` still holding the URL's spelling, so a case-sensitive test would throw
  // away a ?from=phuongnt1 the instant the effect above resolved it to PhuongNT1.
  const holderNames = useMemo(() => new Set(holders.map(h => h.name.toLowerCase())), [holders])
  useEffect(() => {
    if (from && !holdersLoading && holders.length > 0 && !holderNames.has(from.toLowerCase())) setFrom('')
  }, [from, holders.length, holderNames, holdersLoading])

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
  useEffect(() => { setResult(null) }, [configKey])

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
    setPreviewing(true)
    try {
      const res = await fetch('/api/operations/reassign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(true)),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error ?? 'Preview failed.'); return }
      setResult(json as DistResult)
    } catch { toast.error('Could not reach the server.') }
    finally { setPreviewing(false) }
  }

  async function commit() {
    if (!canCommit) return
    setCommitting(true)
    const movedFrom = from
    try {
      const res = await fetch('/api/operations/reassign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(false)),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error ?? 'Reassign failed.'); return }
      setResult(json as DistResult)
      setConfirming(false)
      toast.success(`Moved ${json.assigned ?? 0} games from ${movedFrom} to ${selected.length} evaluators.`)
      setHistToken(t => t + 1)
      refreshHolders() // the counts just moved; a drained source drops off the list
    } catch { toast.error('Could not reach the server.') }
    finally { setCommitting(false) }
  }

  // What the preview says will move. The confirm button and modal both say it.
  const toMove = result ? (result.assignable ?? Object.values(result.per_evaluator ?? {}).reduce((a, b) => a + b, 0)) : 0
  const moveLabel = `Move ${toMove} ${toMove === 1 ? 'game' : 'games'}`

  const commitBtn = (
    <button className="btn btn-primary btn-sm" disabled={!canCommit || committing || toMove === 0}
      onClick={() => setConfirming(true)}>
      {moveLabel}
    </button>
  )

  const bucketBar = (
    <FilterBar ariaLabel="Category group">
      <Seg value={category} onChange={setCategory} options={BUCKET_OPTS} ariaLabel="Category group" />
    </FilterBar>
  )

  // Evaluators get a read-only view: just the history container, scoped by the runs
  // API to operations they're involved in (as source or recipient). No form.
  if (isEvaluator) {
    return (
      <>
        {bucketBar}
        <OperationHistory kind="reassign" category={category} reloadToken={histToken} />
      </>
    )
  }

  return (
    <>
      {bucketBar}

      <div className="card">
        {/* Row 1 (inline): source · mode · range/quantity */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
          <div className="field" style={{ flex: '1 1 220px', minWidth: 180 }}>
            <span className="label">Re-assign from</span>
            <StyledSelect value={from} onChange={setFrom}
              disabled={fromOptions.length === 0}
              placeholder={holdersLoading ? 'Loading…'
                : fromOptions.length === 0 ? 'Nobody holds pending games here'
                : 'Select evaluator'}
              options={fromOptions} />
          </div>
          <div className="field">
            <span className="label">Mode</span>
            <Seg value={mode} onChange={setMode} options={MODE_OPTS} ariaLabel="Mode" />
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
          <span className="label">Assign to ({selected.length} selected) · weight is for this run only, Assign is not changed</span>
          {!from ? (
            <p className="ops-hint">Select a source evaluator first.</p>
          ) : targets.length === 0 ? (
            <p className="ops-hint">No other evaluators in this category group.</p>
          ) : (
            <div className="check-grid">
              {targets.map(r => (
                <div key={r.id} className={`check-item${checked[r.name] ? ' on' : ''}`}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!checked[r.name]}
                      onChange={e => setChecked(prev => ({ ...prev, [r.name]: e.target.checked }))} />
                    <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
                    {/* Away is grey, not red: being off today is not an error. */}
                    <span className={`pill ${r.today_available ? 'on' : 'muted'}`}>
                      {r.today_available ? 'available' : 'away'}
                    </span>
                    {r.game_platform && r.game_platform !== 'all' && (
                      <span className="pill tag">{r.game_platform}</span>
                    )}
                  </label>
                  <div onClick={e => e.stopPropagation()} style={{ width: 74, flexShrink: 0 }} title="Weight (this run only)">
                    <StyledSelect value={String(effWeight(r.name))} options={WEIGHT_OPTS} ariaLabel={`Weight for ${r.name}`}
                      onChange={v => setWeightOverrides(prev => ({ ...prev, [r.name]: Number(v) }))} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="ops-actions">
          <button className="btn btn-primary" disabled={!canPreview || previewing} onClick={runPreview}>
            {previewing ? 'Previewing…' : 'Preview'}
          </button>
          {!canPreview && <span className="ops-hint">Pick a source and a date range or quantity.</span>}
        </div>
      </div>

      {result && <DistributionResult result={result} action={result.dryRun ? commitBtn : undefined} />}

      <OperationHistory kind="reassign" category={category} reloadToken={histToken} />

      {confirming && (
        <Modal title={`${moveLabel} from ${from}?`} width={460} busy={committing}
          onClose={() => setConfirming(false)}
          footer={<>
            <button type="button" className="btn" disabled={committing} onClick={() => setConfirming(false)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={committing} onClick={commit}>
              {committing ? 'Moving…' : moveLabel}
            </button>
          </>}>
          <p className="ops-confirm">
            {toMove} pending {toMove === 1 ? 'game moves' : 'games move'} from {from} to {selected.length}{' '}
            {selected.length === 1 ? 'evaluator' : 'evaluators'}: {selected.join(', ')}.
          </p>
        </Modal>
      )}
    </>
  )
}
