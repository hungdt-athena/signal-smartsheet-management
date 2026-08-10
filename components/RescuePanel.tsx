// components/RescuePanel.tsx — stale-backlog rescue (admin only).
//
// Reassign asks the manager who to move games from. Rescue answers that itself: it
// scans the whole bucket, marks who is sitting on stale games (SOURCE) and who has
// earned the right to take them (RECEIVER), and shows the reason for every verdict so
// the run can be argued with before it happens.
//
// Three explicit steps, nothing automatic: Scan → Preview → Approve & commit. The
// thresholds live in app_config (key 'rescue_config') and are saved on every Scan.
'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { BUCKETS, type Bucket } from '@/lib/buckets'
import { DistributionResult, type DistResult } from '@/components/DistributionResult'
import { OperationHistory } from '@/components/OperationHistory'
// The "?" popover used across the Report tab — same idiom, same CSS (.rp-qtip).
import { InfoTip } from '@/components/report/charts'
import { DEFAULT_RESCUE_CONFIG, type RescueConfig } from '@/lib/rescue-config'

const BUCKET_LABELS: Record<Bucket, string> = { puzzle: 'Puzzle', arcade: 'Arcade', simulation: 'Simulation' }

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

const ROLE_PILL: Record<ScanRow['role'], string> = { source: 'off', receiver: 'on', neutral: 'muted' }
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
const COLS: { label: string; width?: number; tip?: ReactNode }[] = [
  { label: 'Evaluator' },
  { label: 'Pending', width: 78, tip: <>Games they hold right now with no initial conclusion yet.</> },
  {
    label: 'Stale', width: 70,
    tip: <>How many of those are past the stale threshold. Games inside their cool-down are <b>included</b>{' '}
      here, because such a game still sits on their shelf even though this run will not move it.</>,
  },
  {
    label: 'Movable', width: 84,
    tip: <>What can actually be pulled: stale minus anything still in cool-down. A source shows{' '}
      <b>−N</b> (games leaving). After a Preview, a receiver shows <b>+N</b> — the games they would take on.</>,
  },
  { label: 'Done', width: 78, tip: <>Games concluded within the &quot;Active within&quot; window. This is what separates a fast-moving evaluator from an inactive one.</> },
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

export function RescuePanel() {
  const [category, setCategory] = useState<Bucket>('puzzle')
  const [config, setConfig] = useState<RescueConfig>(DEFAULT_RESCUE_CONFIG)
  const [rows, setRows] = useState<ScanRow[] | null>(null)
  const [pickedSources, setPickedSources] = useState<Record<string, boolean>>({})
  const [pickedReceivers, setPickedReceivers] = useState<Record<string, boolean>>({})
  const [result, setResult] = useState<RescueResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [histToken, setHistToken] = useState(0)
  // The config the visible table was scanned with, and the picks the visible preview
  // was built from. Either drifting from the current form state means the result on
  // screen no longer describes what a commit would do.
  const [scannedKey, setScannedKey] = useState('')
  const [previewKey, setPreviewKey] = useState('')

  const applyRows = useCallback((next: ScanRow[]) => {
    setRows(next)
    // Everyone the rules qualified starts ticked; the manager unticks exceptions.
    setPickedSources(Object.fromEntries(next.filter(r => r.role === 'source').map(r => [r.name, true])))
    setPickedReceivers(Object.fromEntries(next.filter(r => r.role === 'receiver').map(r => [r.name, true])))
    setResult(null)
  }, [])

  // Initial load per bucket: stored config + a scan against it.
  useEffect(() => {
    let alive = true
    setRows(null); setResult(null); setMsg(null); setScanning(true)
    fetch(`/api/operations/rescue?category=${category}`, { cache: 'no-store' })
      .then(res => res.json())
      .then(json => {
        if (!alive) return
        if (json.config) { setConfig(json.config as RescueConfig); setScannedKey(JSON.stringify(json.config)) }
        applyRows((json.rows ?? []) as ScanRow[])
      })
      .catch(() => { if (alive) setMsg({ type: 'err', text: 'Failed to load the roster scan.' }) })
      .finally(() => { if (alive) setScanning(false) })
    return () => { alive = false }
  }, [category, applyRows])

  async function post(action: 'scan' | 'preview' | 'commit') {
    const body = { action, category, config, ...picks() }
    const res = await fetch('/api/operations/rescue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? 'Failed')
    return json as RescueResult & { action: string; dryRun?: boolean; assigned?: number }
  }

  async function runScan() {
    setScanning(true); setMsg(null)
    try {
      const json = await post('scan')
      if (json.config) { setConfig(json.config); setScannedKey(JSON.stringify(json.config)) }
      applyRows(json.rows ?? [])
    } catch (e) { setMsg({ type: 'err', text: e instanceof Error ? e.message : 'Scan failed' }) }
    finally { setScanning(false) }
  }

  async function runPreview() {
    setPreviewing(true); setMsg(null)
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
    } catch (e) { setMsg({ type: 'err', text: e instanceof Error ? e.message : 'Preview failed' }) }
    finally { setPreviewing(false) }
  }

  async function commit() {
    setCommitting(true); setMsg(null)
    try {
      const json = await post('commit')
      setResult({ ...json, dryRun: false })
      setMsg({ type: 'ok', text: `Rescued ${json.assigned ?? 0} stale games from ${json.per_source?.length ?? 0} evaluators.` })
      setHistToken(t => t + 1)
      // Every number in the table just changed; re-scan so it matches the DB. applyRows
      // clears the result, so hold the committed one and put it back.
      const committed = { ...json, dryRun: false }
      const fresh = await post('scan')
      applyRows(fresh.rows ?? [])
      setResult(committed)
    } catch (e) { setMsg({ type: 'err', text: e instanceof Error ? e.message : 'Commit failed' }) }
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

  const commitBtn = (
    <button className="btn btn-primary btn-sm" disabled={!canCommit || committing || previewStale} onClick={commit}>
      {committing ? 'Rescuing…' : `Approve & commit${toPull ? ` · ${toPull} games` : ''}`}
    </button>
  )

  function setKnob(key: keyof RescueConfig, raw: string) {
    const v = Number(raw)
    setConfig(c => ({ ...c, [key]: Number.isFinite(v) ? Math.max(0, Math.floor(v)) : c[key] }))
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

      <OperationHistory kind="rescue" category={category} reloadToken={histToken} />

      <div className="card">
        <div style={{ padding: 16 }}>
          <p style={{ fontSize: 12.5, color: 'var(--faint)', margin: '0 2px 14px' }}>
            Moves games that have sat too long with one evaluator to evaluators who are clearing
            their own shelf. Nothing moves until you approve the preview.
          </p>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
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
            <p style={{ fontSize: 12, color: 'var(--warn, var(--faint))', margin: '-6px 2px 12px' }}>
              Thresholds changed — Scan again to refresh the table below.
            </p>
          )}

          {rows && rows.length === 0 && <p className="empty">No evaluators on this bucket&apos;s initial roster.</p>}

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
                      <th key={c.label} style={c.width ? { width: c.width } : undefined}>
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
                      <tr key={r.name} style={r.role === 'neutral' ? { opacity: 0.55 } : undefined}>
                        <td>
                          {r.role !== 'neutral' && (
                            <input type="checkbox" checked={picked} onChange={toggle}
                              aria-label={`Include ${r.name}`} />
                          )}
                        </td>
                        <td className="cell-name">
                          {r.name}
                          {!r.available && <span className="pill off" style={{ fontSize: 10, marginLeft: 6 }}>away</span>}
                          {r.platform && r.platform !== 'all' && (
                            <span className="pill tag" style={{ fontSize: 10, marginLeft: 6 }}>{r.platform}</span>
                          )}
                        </td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.pending}</td>
                        <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: r.stale ? 600 : 400 }}>{r.stale}</td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {r.role === 'source' ? <strong>−{r.pull}</strong> : quota ? <strong>+{quota}</strong> : r.movable || '—'}
                        </td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.evaluatedRecent}</td>
                        <td><span className={`pill ${ROLE_PILL[r.role]}`} style={{ fontSize: 10 }}>{ROLE_LABEL[r.role]}</span></td>
                        <td style={{ fontSize: 12, color: 'var(--faint)' }}>{r.reason}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" disabled={!canPreview || previewing || configDirty} onClick={runPreview}>
              {previewing ? 'Previewing…' : 'Preview'}
            </button>
            <span style={{ fontSize: 12, color: 'var(--faint)' }}>
              {canPreview
                ? `${toPull} stale games from ${selSources.length} ${selSources.length === 1 ? 'evaluator' : 'evaluators'} → ${selReceivers.length} ${selReceivers.length === 1 ? 'receiver' : 'receivers'}`
                : toPull === 0
                  ? 'Nothing stale to move under these thresholds.'
                  : 'No eligible receiver — stale games would only change hands, not get done.'}
            </span>
          </div>
        </div>
      </div>

      {result?.reason && <p className="msg-err" style={{ marginTop: 10 }}>{RESULT_MSG[result.reason]}</p>}

      {result && !result.reason && (
        <>
          {previewStale && (
            <p style={{ fontSize: 12, color: 'var(--faint)', margin: '10px 2px 0', fontStyle: 'italic' }}>
              Selection changed — re-run Preview before committing.
            </p>
          )}
          <DistributionResult result={result} action={commitBtn} />
          {!!result.per_source?.length && (
            <div className="card" style={{ marginTop: 12 }}>
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
                      <th style={{ width: 80 }}>Games</th>
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
                        <td style={{ fontWeight: 600 }}>{s.pulled}</td>
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

      {msg && <p className={msg.type === 'ok' ? 'msg-ok' : 'msg-err'} style={{ marginTop: 10 }}>{msg.text}</p>}
    </div>
  )
}
