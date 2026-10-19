// components/RescuePanel.tsx — stale-backlog rescue. Running one is admin only;
// an evaluator sees History alone (the rescue runs they were in, scoped by
// /api/operations/runs) and this panel never calls the scan API for them.
//
// Reassign asks the manager who to move games from. Rescue answers that itself: it
// scans the whole bucket, marks who is sitting on stale games (SOURCE) and who has
// earned the right to take them (RECEIVER), and shows the reason for every verdict so
// the run can be argued with before it happens.
//
// Three explicit steps, nothing automatic: Scan → Preview → Move (with a confirm
// that states the count). The thresholds live in app_config (key 'rescue_config')
// and are saved on every Scan.
//
// Layout: category group, then the scan form, its preview, then History below.
'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useSession } from 'next-auth/react'
import type { Bucket } from '@/lib/buckets'
import { toast } from '@/lib/toast'
import { BUCKET_OPTS } from '@/components/RosterTable'
import { DistributionResult, type DistResult } from '@/components/DistributionResult'
import { OperationHistory } from '@/components/OperationHistory'
import { FilterBar } from '@/components/ui/FilterBar'
import { Modal } from '@/components/ui/Modal'
import { Seg } from '@/components/ui/Seg'
import { EmptyState, ErrorState } from '@/components/ui/States'
// The "?" popover used across the Report tab — same idiom, same CSS (.rp-qtip).
import { InfoTip } from '@/components/report/charts'
import { DEFAULT_RESCUE_CONFIG, type RescueConfig } from '@/lib/rescue-config'
import { rangeKey, type AssignedRange } from '@/lib/rescue-range'

interface ScanRow {
  name: string
  platform: string | null
  weight: number | null
  available: boolean
  pending: number
  stale: number
  movable: number
  evaluatedRecent: number
  role: 'source' | 'receiver' | 'neutral'
  pull: number
  reason: string
}

interface RescueResult extends DistResult {
  rows: ScanRow[]
  config: RescueConfig
  reason?: 'no_sources' | 'no_receivers' | 'no_stale_games'
  quotas?: Record<string, number>
  per_source?: { from: string; pulled: number; per_evaluator: Record<string, number> }[]
}

// Role is read, not clicked, so it is a badge. Source is amber (behind), not red.
const ROLE_BADGE: Record<ScanRow['role'], string> = { source: 'running', receiver: 'success', neutral: 'neutral' }
const ROLE_LABEL: Record<ScanRow['role'], string> = { source: 'Source', receiver: 'Receiver', neutral: '—' }

// Label + hover description for each threshold, in the order they read as a sentence.
const KNOBS: { key: keyof RescueConfig; label: string; tip: ReactNode }[] = [
  {
    key: 'staleDays', label: 'Stale after (days)',
    tip: <>Days a pending game has sat with <b>its current holder</b>. Counted from <b>assigned_date</b>,
      so anyone who just received a game gets a fresh clock and is never blamed for age they did not cause.
      Lowering this cuts both ways: the pool of stale games grows while more people fail the receiver
      check, because almost everyone then holds something stale.</>,
  },
  {
    key: 'sourceMinBacklog', label: 'Pull if pending ≥',
    tip: <>Only pull from evaluators holding at least this many pending games. Someone a few games behind
      is left alone to clear it themselves.</>,
  },
  {
    key: 'receiverMaxStale', label: 'Receiver max own stale',
    tip: <>How many stale games of their own a receiver may still hold. <b>0</b> means their own shelf must
      be clean before they take on someone else&apos;s debt.</>,
  },
  {
    key: 'activeDays', label: 'Active within (days)',
    tip: <>A receiver must have concluded at least one game inside this window, so a low backlog caused by
      leave or inactivity is not mistaken for speed.</>,
  },
  {
    key: 'cooldownDays', label: 'Cool-down (days)',
    tip: <>Skip games already moved by a reassign, handover or rescue this recently, so the same game cannot
      be kicked around the team run after run.</>,
  },
]

// Table columns. `tip` is omitted where the header already says everything.
const COLS: { label: string; width?: number; tip?: ReactNode; num?: boolean }[] = [
  { label: 'Evaluator' },
  { label: 'Pending', width: 78, num: true, tip: <>Games they hold right now with no initial conclusion yet.</> },
  {
    label: 'Stale', width: 70, num: true,
    tip: <>How many of those are past the stale threshold. Games inside their cool-down are <b>included</b>{' '}
      here, because such a game still sits on their shelf even though this run will not move it.</>,
  },
  {
    label: 'Movable', width: 84, num: true,
    tip: <>What can actually be pulled: stale minus anything still in cool-down. A source shows{' '}
      <b>−N</b> (games leaving). After a Preview, a receiver shows <b>+N</b> — the games they would take on.</>,
  },
  { label: 'Done', width: 78, num: true, tip: <>Games concluded within the &quot;Active within&quot; window. This is what separates a fast-moving evaluator from an inactive one.</> },
  {
    label: 'Role', width: 96,
    tip: <><b>Source</b> gives games up, <b>Receiver</b> takes them on, <b>—</b> sits this run out. Nobody can
      be both: a source must hold stale games and a receiver must not.</>,
  },
  {
    label: 'Why', tip: <>The reason behind the role. For anyone sitting out, it is the <b>first</b> check they
      failed, so fixing that one is what would bring them back into the run.</>,
  },
]

const RESULT_MSG: Record<NonNullable<RescueResult['reason']>, string> = {
  no_sources: 'No one is over the backlog threshold with movable stale games. Nothing to rescue.',
  no_receivers: 'No one currently passes the receiver check, so there is nowhere safe to move these games. Moving them onto someone who is also behind would only change the name on the shelf.',
  no_stale_games: 'The selected sources have no stale games outside their cool-down window.',
}

// flash: names the Report's "Move N stale games from X, Y and Z" link meant to ring
// on arrival — never a threshold. `?staleDays=` and friends are not read from the
// URL at all: POST /api/operations/rescue persists whatever config it is handed, so
// a link carrying one would silently rewrite the admin's saved settings the next
// time this panel scans.
//
// category: which bucket is on screen; the page keeps it in ?cat=. A category is a
// VIEW SELECTOR, not a setting — it decides which scan is on screen and is never
// written back to app_config — so unlike a threshold it is safe in a URL. Without
// it a reader on Arcade landed on a puzzle scan where none of the flashed names
// appear and none of the numbers in the sentence exist.
//
// range: the assigned-date range the Report's number was counted over, so the scan reads
// the same games. Same kind of thing as the category: a view selector kept in the URL
// by the page, never saved and never part of the thresholds. onClearRange ("Show all
// backlog") removes it from the URL.
export function RescuePanel({ flash = [], category, onCategoryChange, range = null, onClearRange }: {
  flash?: string[]
  category: Bucket
  onCategoryChange: (b: Bucket) => void
  range?: AssignedRange | null
  onClearRange: () => void
}) {
  const { data: session, status } = useSession()
  const isEvaluator = session?.user?.role === 'evaluator'
  // Wait for the session before the first scan: an evaluator must never call the
  // admin-only scan, not even once while the role is still unknown.
  const canScan = status !== 'loading' && !isEvaluator

  const bucketBar = (
    <FilterBar ariaLabel="Category group">
      <Seg value={category} onChange={onCategoryChange} options={BUCKET_OPTS} ariaLabel="Category group" />
    </FilterBar>
  )

  if (!canScan) {
    return (
      <>
        {bucketBar}
        {isEvaluator && <OperationHistory kind="rescue" category={category} />}
      </>
    )
  }

  return (
    <>
      {bucketBar}
      <RescueRunner flash={flash} category={category} range={range} onClearRange={onClearRange} />
    </>
  )
}

// `to` is exclusive, so the last day shown is the day before it.
function fmtDays(r: AssignedRange): string {
  const d = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' })
  const last = (s: string) => d(new Date(Date.parse(`${s}T00:00:00Z`) - 864e5).toISOString().slice(0, 10))
  if (r.from && r.to) return `${d(r.from)} to ${last(r.to)}`
  if (r.from) return `from ${d(r.from)}`
  return `before ${d(r.to!)}`
}

function RescueRunner({ flash, category, range, onClearRange }: {
  flash: string[]; category: Bucket; range: AssignedRange | null; onClearRange: () => void
}) {
  const [config, setConfig] = useState<RescueConfig>(DEFAULT_RESCUE_CONFIG)
  // The range the scan is limited to, or null for the whole backlog. The load effect
  // reads it through a ref and re-runs on its key, so a new object with the same days
  // does not refetch.
  const rKey = rangeKey(range)
  const rangeRef = useRef(range)
  rangeRef.current = range
  const [rows, setRows] = useState<ScanRow[] | null>(null)
  const [pickedSources, setPickedSources] = useState<Record<string, boolean>>({})
  const [pickedReceivers, setPickedReceivers] = useState<Record<string, boolean>>({})
  const [result, setResult] = useState<RescueResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [loadTick, setLoadTick] = useState(0) // bump to retry the initial load
  const [histToken, setHistToken] = useState(0)
  // The config the visible table was scanned with, and the picks the visible preview
  // was built from. Either drifting from the current form state means the result on
  // screen no longer describes what a commit would do.
  const [scannedKey, setScannedKey] = useState('')
  const [previewKey, setPreviewKey] = useState('')

  const ring = useMemo(() => new Set(flash.map(n => n.toLowerCase())), [flash])
  // Same idiom as the Config page's ?highlight=: scroll the first row the link
  // named into view once the scan that produced it resolves, and only that once —
  // a later Preview/Commit reshuffling `rows` should not re-trigger the scroll.
  const scrolledRef = useRef(false)
  useEffect(() => {
    if (scrolledRef.current || ring.size === 0 || !rows) return
    const first = rows.find(r => ring.has(r.name.toLowerCase()))
    if (!first) return
    scrolledRef.current = true
    const t = setTimeout(() => {
      document.getElementById(`rescue-row-${first.name}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 60)
    return () => clearTimeout(t)
  }, [rows, ring])

  const applyRows = useCallback((next: ScanRow[]) => {
    setRows(next)
    // Everyone the rules qualified starts ticked; the manager unticks exceptions.
    setPickedSources(Object.fromEntries(next.filter(r => r.role === 'source').map(r => [r.name, true])))
    setPickedReceivers(Object.fromEntries(next.filter(r => r.role === 'receiver').map(r => [r.name, true])))
    setResult(null)
  }, [])

  // Initial load per bucket: stored config + a scan against it. A GET, so a retry
  // after a failure is safe: it never writes the config the way a POST scan does.
  useEffect(() => {
    let alive = true
    setRows(null); setResult(null); setLoadError(false); setScanning(true)
    const qs = new URLSearchParams({ category })
    const r = rangeRef.current
    if (r?.from) qs.set('assignedFrom', r.from)
    if (r?.to) qs.set('assignedTo', r.to)
    fetch(`/api/operations/rescue?${qs}`, { cache: 'no-store' })
      .then(res => { if (!res.ok) throw new Error(); return res.json() })
      .then(json => {
        if (!alive) return
        if (json.config) { setConfig(json.config as RescueConfig); setScannedKey(JSON.stringify(json.config)) }
        applyRows((json.rows ?? []) as ScanRow[])
      })
      .catch(() => { if (alive) setLoadError(true) })
      .finally(() => { if (alive) setScanning(false) })
    return () => { alive = false }
  }, [category, rKey, applyRows, loadTick])

  async function post(action: 'scan' | 'preview' | 'commit') {
    const body = { action, category, config, range, ...picks() }
    const res = await fetch('/api/operations/rescue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? 'Failed')
    return json as RescueResult & { action: string; dryRun?: boolean; assigned?: number }
  }

  async function runScan() {
    setScanning(true)
    try {
      const json = await post('scan')
      if (json.config) { setConfig(json.config); setScannedKey(JSON.stringify(json.config)) }
      applyRows(json.rows ?? [])
      setLoadError(false)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Scan failed.') }
    finally { setScanning(false) }
  }

  async function runPreview() {
    setPreviewing(true)
    const sent = pickKey // what this preview is about to be built from
    try {
      const json = await post('preview')
      // The route re-scans on every action; adopt the fresh numbers but keep the
      // manager's tick marks, defaulting anyone newly qualified to ticked.
      if (json.rows) {
        setRows(json.rows)
        setPickedSources(prev => Object.fromEntries(
          json.rows.filter(r => r.role === 'source').map(r => [r.name, prev[r.name] ?? true]),
        ))
        setPickedReceivers(prev => Object.fromEntries(
          json.rows.filter(r => r.role === 'receiver').map(r => [r.name, prev[r.name] ?? true]),
        ))
      }
      setResult({ ...json, dryRun: true })
      setPreviewKey(sent)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Preview failed.') }
    finally { setPreviewing(false) }
  }

  async function commit() {
    setCommitting(true)
    try {
      const json = await post('commit')
      setResult({ ...json, dryRun: false })
      setConfirming(false)
      toast.success(`Moved ${json.assigned ?? 0} stale games from ${json.per_source?.length ?? 0} evaluators.`)
      setHistToken(t => t + 1)
      // Every number in the table just changed; re-scan so it matches the DB. applyRows
      // clears the result, so hold the committed one and put it back.
      const committed = { ...json, dryRun: false }
      const fresh = await post('scan')
      applyRows(fresh.rows ?? [])
      setResult(committed)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Rescue failed.') }
    finally { setCommitting(false) }
  }

  const sources = useMemo(() => (rows ?? []).filter(r => r.role === 'source'), [rows])
  const receivers = useMemo(() => (rows ?? []).filter(r => r.role === 'receiver'), [rows])
  const selSources = sources.filter(r => pickedSources[r.name])
  const selReceivers = receivers.filter(r => pickedReceivers[r.name])
  const toPull = selSources.reduce((n, r) => n + r.pull, 0)
  const canPreview = toPull > 0 && selReceivers.length > 0
  const canCommit = !!result && result.dryRun && (result.assignable ?? 0) > 0

  function picks() {
    return {
      sources: selSources.map(r => r.name),
      receivers: selReceivers.map(r => r.name),
    }
  }

  // Editing a threshold invalidates the scanned table; changing the ticks invalidates
  // the preview built from them.
  const configDirty = scannedKey !== JSON.stringify(config)
  const pickKey = JSON.stringify(picks())
  const previewStale = !!result && result.dryRun && previewKey !== pickKey

  // The count the preview says will move: the button and the confirm both say it.
  const toMove = result?.dryRun ? (result.assignable ?? 0) : 0
  const moveLabel = `Move ${toMove} ${toMove === 1 ? 'game' : 'games'}`

  const commitBtn = (
    <button className="btn btn-primary btn-sm" disabled={!canCommit || committing || previewStale}
      onClick={() => setConfirming(true)}>
      {moveLabel}
    </button>
  )

  function setKnob(key: keyof RescueConfig, raw: string) {
    const v = Number(raw)
    setConfig(c => ({ ...c, [key]: Number.isFinite(v) ? Math.max(0, Math.floor(v)) : c[key] }))
  }

  return (
    <>
      <div className="card">
        {range && (
          <p className="ops-hint">
            Only games assigned {fmtDays(range)}
            <button type="button" className="btn btn-link btn-sm" onClick={onClearRange}>Show all backlog</button>
          </p>
        )}
        <div className="ops-knobs">
          {KNOBS.map(k => (
            <div className="field" key={k.key} style={{ width: 178 }}>
              <span className="label">
                {k.label}
                <InfoTip title={k.label}>{k.tip}</InfoTip>
              </span>
              <input type="number" min={0} className="input" value={config[k.key]}
                onChange={e => setKnob(k.key, e.target.value)} />
            </div>
          ))}
          <button className="btn btn-primary" disabled={scanning} onClick={runScan}>
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
        </div>

        {configDirty && (
          <p className="ops-hint ops-warn">Thresholds changed. Scan again to refresh the table below.</p>
        )}

        {loadError && !rows && (
          <ErrorState onRetry={() => setLoadTick(t => t + 1)}>Could not load the roster scan.</ErrorState>
        )}

        {rows && rows.length === 0 && <EmptyState>No evaluators on this category group&apos;s initial roster.</EmptyState>}

        {rows && rows.length > 0 && (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 34 }}>
                    <InfoTip title="Include in this run">
                      Ticked rows take part. Untick a source to leave its backlog for a later run, or a
                      receiver to keep games off their shelf. Unticking re-splits the games among whoever
                      is left, so run Preview again afterwards.
                    </InfoTip>
                  </th>
                  {COLS.map(c => (
                    <th key={c.label} className={c.num ? 'tnum' : undefined} style={c.width ? { width: c.width } : undefined}>
                      {c.label === 'Done' ? `Done ${config.activeDays}d` : c.label}
                      {c.tip && <InfoTip title={c.label}>{c.tip}</InfoTip>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const picked = r.role === 'source' ? !!pickedSources[r.name]
                    : r.role === 'receiver' ? !!pickedReceivers[r.name] : false
                  const toggle = () => (r.role === 'source' ? setPickedSources : setPickedReceivers)(
                    prev => ({ ...prev, [r.name]: !prev[r.name] }),
                  )
                  const quota = result?.quotas?.[r.name]
                  return (
                    <tr key={r.name} id={`rescue-row-${r.name}`}
                      className={ring.has(r.name.toLowerCase()) ? 'cfg-highlightable cfg-highlight' : undefined}
                      style={r.role === 'neutral' ? { opacity: 0.55 } : undefined}>
                      <td>
                        {r.role !== 'neutral' && (
                          <input type="checkbox" checked={picked} onChange={toggle}
                            aria-label={`Include ${r.name}`} />
                        )}
                      </td>
                      <td className="cell-name">
                        {r.name}
                        {/* Away is grey, not red: being off today is not an error. */}
                        {!r.available && <span className="pill muted" style={{ marginLeft: 6 }}>away</span>}
                        {r.platform && r.platform !== 'all' && (
                          <span className="pill tag" style={{ marginLeft: 6 }}>{r.platform}</span>
                        )}
                      </td>
                      <td className="tnum">{r.pending}</td>
                      <td className="tnum" style={{ fontWeight: r.stale ? 600 : 400 }}>{r.stale}</td>
                      <td className="tnum">
                        {r.role === 'source' ? <strong>−{r.pull}</strong> : quota ? <strong>+{quota}</strong> : r.movable || '—'}
                      </td>
                      <td className="tnum">{r.evaluatedRecent}</td>
                      <td><span className={`badge ${ROLE_BADGE[r.role]}`}>{ROLE_LABEL[r.role]}</span></td>
                      <td style={{ fontSize: 12, color: 'var(--faint)' }}>{r.reason}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="ops-actions">
          <button className="btn btn-primary" disabled={!canPreview || previewing || configDirty} onClick={runPreview}>
            {previewing ? 'Previewing…' : 'Preview'}
          </button>
          <span className="ops-hint">
            {canPreview
              ? `${toPull} stale games from ${selSources.length} ${selSources.length === 1 ? 'evaluator' : 'evaluators'} → ${selReceivers.length} ${selReceivers.length === 1 ? 'receiver' : 'receivers'}`
              : toPull === 0
                ? 'Nothing stale to move under these thresholds.'
                : 'No receiver qualifies. Stale games would only change hands, not get done.'}
          </span>
        </div>
      </div>

      {result?.reason && (
        <div className="card"><EmptyState>{RESULT_MSG[result.reason]}</EmptyState></div>
      )}

      {result && !result.reason && (
        <>
          {previewStale && (
            <p className="ops-hint">Selection changed. Run Preview again before moving.</p>
          )}
          <DistributionResult result={result} action={result.dryRun ? commitBtn : undefined} />
          {!!result.per_source?.length && (
            <div className="card">
              <div className="card-head">
                <span className="card-label">
                  Pulled from
                  <InfoTip title="Pulled from">
                    The same run seen per source: which shelf each batch of games left, and who ended up with
                    it. The games are pooled before being split, so one source&apos;s games can land with
                    several receivers.
                  </InfoTip>
                </span>
              </div>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th className="tnum" style={{ width: 80 }}>Games</th>
                      <th>
                        Went to
                        <InfoTip title="Went to">Receivers and how many of THIS source&apos;s games each took.</InfoTip>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.per_source.map(s => (
                      <tr key={s.from}>
                        <td className="cell-name">{s.from}</td>
                        <td className="tnum" style={{ fontWeight: 600 }}>{s.pulled}</td>
                        <td style={{ fontSize: 12 }}>
                          {Object.entries(s.per_evaluator).map(([n, c]) => `${n} (${c})`).join(', ') || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      <OperationHistory kind="rescue" category={category} reloadToken={histToken} />

      {confirming && (
        <Modal title={`${moveLabel}?`} width={460} busy={committing} onClose={() => setConfirming(false)}
          footer={<>
            <button type="button" className="btn" disabled={committing} onClick={() => setConfirming(false)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={committing} onClick={commit}>
              {committing ? 'Moving…' : moveLabel}
            </button>
          </>}>
          <p className="ops-confirm">
            {toMove} stale {toMove === 1 ? 'game moves' : 'games move'} from {selSources.length}{' '}
            {selSources.length === 1 ? 'evaluator' : 'evaluators'} ({selSources.map(r => r.name).join(', ')}) to{' '}
            {selReceivers.length} {selReceivers.length === 1 ? 'receiver' : 'receivers'} ({selReceivers.map(r => r.name).join(', ')}).
          </p>
        </Modal>
      )}
    </>
  )
}
