// components/PushPreview.tsx — "if the run happened now, this is what everyone
// would get". Sits under Push targets, because the two answer the same question
// from opposite ends: the targets say what is allowed to run, this says what
// that actually produces against today's roster.
//
// Breakdown opens a modal, not an inline panel: it carries a tab per genre, a
// row per evaluator and a run button, which is more than the ~340px side column
// can hold, and it is something you open to decide with rather than part of the
// card you read at a glance.
//
// Unticking an evaluator re-runs the real split in the browser — `splitAmong`
// is the same pure function the server used, over the same platform tally — so
// the numbers move without a round trip and cannot disagree with the server's.
'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { BUCKET_LABELS } from '@/components/RosterTable'
import { BUCKETS, type Bucket } from '@/lib/buckets'
import { DEFAULT_PUSH_WINDOW, PUSH_WINDOW_NOTE } from '@/lib/push-window'
import { splitAmong, type GenrePreview, type PushPreview as Preview } from '@/lib/push-preview'

const STATUS_NOTE: Record<GenrePreview['status'], string> = {
  ready: '',
  off: 'turned off',
  'no-evaluator': 'nobody available',
  'no-games': 'nothing waiting',
}

const CONFIG_HREF = '/config?highlight=push-window'
const n = (v: number) => v.toLocaleString('en-US')

export function PushPreview({ preview, loading, canRun, onRan }: {
  preview: Preview | null
  loading: boolean
  canRun: boolean
  onRan: () => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-label">Next run</span>
        <span className="card-note">as configured right now</span>
      </div>

      {!preview ? (
        <p className="pp-empty">{loading ? 'Working it out…' : 'Not available.'}</p>
      ) : (
        <>
          <div className={`pp-total${loading ? ' pp-stale' : ''}`}>
            <span className="pp-n">{n(preview.total)}</span>
            <span className="pp-unit">
              {preview.total === 1 ? 'game would be assigned' : 'games would be assigned'}
            </span>
          </div>
          {/* Where the pool comes from. Without this the headline looks like it
              was invented: "incoming" is the push step, "waiting" is what the
              last run left behind. */}
          <p className="pp-src">
            {n(preview.incoming)} new to push
            {preview.waiting > 0 && ` · ${n(preview.waiting)} still waiting`}
          </p>

          <ul className="pp-rows">
            {preview.genres.map(g => {
              const days = preview.windows?.[g.bucket]
              return (
                <li key={g.bucket} className={g.status === 'ready' ? '' : 'pp-idle'}>
                  <span className="pp-g">
                    {BUCKET_LABELS[g.bucket]}
                    {/* The window is what makes the count mean something, and it
                        is the number people come here wanting to change. */}
                    {days !== undefined && (
                      <span className={`pp-win${days !== DEFAULT_PUSH_WINDOW ? ' set' : ''}`}>{days}d</span>
                    )}
                  </span>
                  <span className="pp-v">{g.status === 'ready' ? n(g.assigned) : '—'}</span>
                  <span className="pp-why">
                    {g.status === 'ready'
                      ? `${g.perEvaluator.filter(p => p.count > 0).length} of ${g.crew.length}`
                      : STATUS_NOTE[g.status]}
                  </span>
                </li>
              )
            })}
          </ul>

          {/* Only say something when there is something to do about it. */}
          {preview.blocked > 0 && (
            <p className="pp-warn" role="status">
              {n(preview.blocked)} held back by a genre that will not run.
            </p>
          )}

          <button type="button" className="pp-toggle" onClick={() => setOpen(true)}>
            Breakdown
            <span className="pp-chev" aria-hidden="true">▸</span>
          </button>

          {open && (
            <BreakdownModal preview={preview} canRun={canRun}
              onRan={onRan} onClose={() => setOpen(false)} />
          )}
        </>
      )}
    </div>
  )
}

function BreakdownModal({ preview, canRun, onRan, onClose }: {
  preview: Preview
  canRun: boolean
  onRan: () => void
  onClose: () => void
}) {
  // A genre is unticked per evaluator, so the exclusions are keyed by genre —
  // being off for Puzzle says nothing about Arcade.
  const [excluded, setExcluded] = useState<Record<string, ReadonlySet<string>>>({})
  const [tab, setTab] = useState<Bucket>(() =>
    preview.genres.find(g => g.status === 'ready')?.bucket ?? 'puzzle')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  // Esc closes — except while the confirmation is up, where it backs out of the
  // confirmation instead. A stray keypress must not dismiss the warning and the
  // modal together, leaving the operator unsure whether the run went ahead. It
  // is ignored entirely mid-run, which is not cancellable.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || running) return
      if (confirming) setConfirming(false)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirming, running, onClose])

  const toggle = useCallback((bucket: Bucket, name: string) => {
    setExcluded(prev => {
      const next = new Set(prev[bucket] ?? [])
      if (!next.delete(name)) next.add(name)
      return { ...prev, [bucket]: next }
    })
    setResult(null)
  }, [])

  // The live recomputation. Same function, same tally, so what is on screen is
  // what the server would have sent for this crew.
  const live = useMemo(() => {
    const out: Partial<Record<Bucket, ReturnType<typeof splitAmong>>> = {}
    for (const g of preview.genres) {
      if (g.status !== 'ready') continue
      const off = excluded[g.bucket] ?? new Set<string>()
      out[g.bucket] = off.size === 0
        ? { assigned: g.assigned, unmatched: g.unmatched, perEvaluator: g.perEvaluator }
        : splitAmong(g.os, g.crew.filter(c => !off.has(c.name)))
    }
    return out
  }, [preview, excluded])

  const runnable = preview.genres.filter(g => g.status === 'ready')
  const liveTotal = runnable.reduce((acc, g) => acc + (live[g.bucket]?.assigned ?? 0), 0)
  const allExcluded = runnable.filter(g => (excluded[g.bucket]?.size ?? 0) >= g.crew.length)
  const anyExcluded = runnable.some(g => (excluded[g.bucket]?.size ?? 0) > 0)

  async function run() {
    setRunning(true); setResult(null); setConfirming(false)
    try {
      // Exclusions go per genre, exactly as the tabs hold them: someone
      // unticked under Puzzle must not vanish from Arcade as well.
      const res = await fetch('/api/assign-setup/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          genres: runnable.map(g => g.bucket),
          exclude: Object.fromEntries(
            runnable.map(g => [g.bucket, Array.from(excluded[g.bucket] ?? [])]),
          ),
        }),
      })
      const json = await res.json()
      if (!res.ok) { setResult(json.error ? `Failed: ${json.error}` : 'Failed.'); return }
      setResult(`Pushed ${json.pushed}, assigned ${json.assigned}.`)
      onRan()
    } catch {
      setResult('Failed to reach the server.')
    } finally {
      setRunning(false)
    }
  }

  const current = preview.genres.find(g => g.bucket === tab)
  const currentLive = current ? live[current.bucket] : undefined
  const currentDays = current ? preview.windows?.[current.bucket] : undefined

  return (
    <div className="modal-backdrop" onClick={() => { if (!running) onClose() }}>
      <div className="modal pp-modal" role="dialog" aria-modal="true" aria-label="Next run breakdown"
        onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">Next run · breakdown</span>
          <div className="pp-head-acts">
            {/* The window is the lever behind every number in here, and it
                lives on another page. Say so, and take them there. */}
            <Link className="btn btn-sm" href={CONFIG_HREF}>Push window…</Link>
            <button type="button" className="x-btn" aria-label="Close" disabled={running}
              onClick={onClose}>✕</button>
          </div>
        </div>

        <div className="modal-body pp-modal-body">
          {runnable.length === 0 ? (
            <p className="pp-empty">No genre would run, so nothing would be handed out.</p>
          ) : (
            <>
              <div className="pp-tabs" role="tablist" aria-label="Genre breakdown">
                {BUCKETS.filter(b => preview.genres.some(g => g.bucket === b)).map(b => {
                  const g = preview.genres.find(x => x.bucket === b)!
                  const ready = g.status === 'ready'
                  return (
                    <button key={b} type="button" role="tab" id={`pp-tab-${b}`}
                      aria-selected={tab === b} aria-controls={`pp-panel-${b}`}
                      className={`pp-tab${tab === b ? ' on' : ''}${ready ? '' : ' idle'}`}
                      onClick={() => setTab(b)}>
                      {BUCKET_LABELS[b]}
                      <span className="pp-tab-n">{ready ? n(live[b]?.assigned ?? g.assigned) : '—'}</span>
                    </button>
                  )
                })}
              </div>

              {current && (
                <div role="tabpanel" id={`pp-panel-${current.bucket}`}
                  aria-labelledby={`pp-tab-${current.bucket}`}>
                  {current.status !== 'ready' || !currentLive ? (
                    <p className="pp-empty">
                      {BUCKET_LABELS[current.bucket]} is {STATUS_NOTE[current.status]}.
                    </p>
                  ) : (
                    <>
                      <p className="pp-pool">
                        {n(current.pool)} in the pool
                        <span> · {n(current.incoming)} new</span>
                        {current.waiting > 0 && <span> · {n(current.waiting)} waiting</span>}
                        {currentDays !== undefined && <span> · last {currentDays} days</span>}
                      </p>
                      <ul className="pp-crew">
                        {current.crew.map(c => {
                          const off = excluded[current.bucket]?.has(c.name) ?? false
                          const count = currentLive.perEvaluator.find(p => p.name === c.name)?.count ?? 0
                          const share = currentLive.assigned > 0 ? (count / currentLive.assigned) * 100 : 0
                          return (
                            <li key={c.name} className={off ? 'pp-out' : count === 0 ? 'pp-zero' : ''}>
                              <label className="pp-pick">
                                <input type="checkbox" checked={!off}
                                  onChange={() => toggle(current.bucket, c.name)}
                                  aria-label={`Include ${c.name} in ${BUCKET_LABELS[current.bucket]}`} />
                                <span className="pp-name">{c.name}</span>
                              </label>
                              <span className="pp-meta">{c.platform === 'all' ? '' : c.platform} {c.weight}</span>
                              <span className="pp-bar" aria-hidden="true">
                                <span style={{ width: `${off ? 0 : share}%` }} />
                              </span>
                              <span className="pp-c">{off ? '—' : n(count)}</span>
                            </li>
                          )
                        })}
                      </ul>
                      {currentLive.unmatched > 0 && (
                        <p className="pp-warn">
                          {n(currentLive.unmatched)} match no included evaluator&rsquo;s platform.
                        </p>
                      )}
                      <p className="pp-fine">{PUSH_WINDOW_NOTE}</p>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {runnable.length > 0 && (
          <div className="modal-foot pp-foot">
            <div className="pp-foot-msg">
              {anyExcluded && (
                <p className="pp-note">
                  {n(liveTotal)} with your selection. Unticking here changes this run only —
                  the roster is not edited.
                </p>
              )}
              {allExcluded.length > 0 && (
                <p className="pp-warn">
                  {allExcluded.map(g => BUCKET_LABELS[g.bucket]).join(', ')}: everyone is unticked,
                  so nothing would be assigned there.
                </p>
              )}
              {result && (
                <p className={`pp-note${result.startsWith('Failed') ? ' pp-warn' : ''}`} role="status">
                  {result}
                </p>
              )}
              {!canRun && <p className="pp-note">Only an admin can run this.</p>}
            </div>

            {canRun && (confirming ? (
              <div className="pp-confirm" role="alertdialog" aria-label="Confirm run">
                <p>
                  Push and assign <strong>{runnable.map(g => BUCKET_LABELS[g.bucket]).join(', ')}</strong> now?
                  This hands out about {n(liveTotal)} games to real people and cannot be undone from here.
                </p>
                <div className="pp-confirm-acts">
                  <button type="button" className="btn btn-sm btn-primary" disabled={running} onClick={run}>
                    {running ? 'Running…' : 'Yes, run it'}
                  </button>
                  <button type="button" className="btn btn-sm" disabled={running}
                    onClick={() => setConfirming(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <button type="button" className="btn btn-sm btn-primary pp-go" disabled={running}
                onClick={() => setConfirming(true)}>
                Push &amp; assign now
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
