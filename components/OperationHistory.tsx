// components/OperationHistory.tsx — per-bucket history of reassign/handover runs
// (operation_runs, migration 028). Mounted below the form in ReassignPanel,
// RescuePanel and HandoverPanel (the action first, its record after), and alone for
// an evaluator. One row per operation; "Details" opens the snapshot popup. Handover
// rows carry a status badge; pending ones show Approve/Reject to any manager who is
// NOT the submitter, and each asks once, with the game count, before it runs.
'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import type { Bucket } from '@/lib/buckets'
import type { DistResult } from '@/components/DistributionResult'
import { OperationDetailModal, STATUS_BADGE } from '@/components/OperationDetailModal'
import { Modal } from '@/components/ui/Modal'
import { RefreshButton } from '@/components/ui/PageHeader'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/ui/States'
import { fmtDateVN } from '@/lib/format-date'
import { toast } from '@/lib/toast'

export interface OperationRun {
  id: number
  kind: 'reassign' | 'handover' | 'rescue'
  category_group: string
  from_evaluator: string
  params: {
    start_date?: string; end_date?: string; count?: number; mode?: string; selected_evaluators?: string[]
    stale_days?: number; source_pending?: number | null; source_stale?: number | null // rescue
  }
  snapshot: DistResult
  result: DistResult | null
  status: 'committed' | 'pending' | 'approved' | 'rejected'
  game_count: number
  submitted_by: string | null
  submitted_at: string
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string | null
}


function targetCount(run: OperationRun): number {
  const dist = run.result ?? run.snapshot
  return Object.keys(dist?.per_evaluator ?? {}).length
}

// How the run's game set was picked: by a date window, by a quantity cap, or both.
// Handover is always date-windowed; rescue is always rule-picked (games past the stale
// threshold); reassign stores it in params.mode ('range' | 'quantity' |
// 'range+quantity'), with a shape-based fallback for old rows.
function runMode(r: OperationRun): 'date' | 'quantity' | 'date+qty' | 'stale' {
  if (r.kind === 'rescue') return 'stale'
  if (r.kind === 'handover') return 'date'
  const m = r.params?.mode
  if (m === 'range+quantity') return 'date+qty'
  if (m === 'quantity') return 'quantity'
  if (m === 'range') return 'date'
  if (r.params?.start_date && r.params?.count) return 'date+qty'
  return r.params?.count ? 'quantity' : 'date'
}

const MODE_LABEL: Record<ReturnType<typeof runMode>, string> = {
  date: 'Date', quantity: 'Quantity', 'date+qty': 'Date + Qty', stale: 'Stale',
}

function modeValue(r: OperationRun): string {
  const mode = runMode(r)
  const window = `${fmtDateVN(r.params?.start_date)} → ${fmtDateVN(r.params?.end_date)}`
  const qty = r.params?.count != null ? String(r.params.count) : '—'
  // Rescue: the rule that selected the games, plus the backlog the source held then.
  if (mode === 'stale') {
    const held = r.params?.source_pending != null ? ` of ${r.params.source_pending} pending` : ''
    return `>${r.params?.stale_days ?? '?'}d${held}`
  }
  if (mode === 'date') return window
  if (mode === 'quantity') return qty
  return `${window} · ${qty}`
}

// Rows revealed per infinite-scroll step (and the initial window).
const PAGE = 5

export function OperationHistory({ kind, category, reloadToken, onChanged }: {
  kind: 'reassign' | 'handover' | 'rescue'
  category: Bucket
  reloadToken?: number
  onChanged?: () => void
}) {
  const { data: session } = useSession()
  const isEvaluator = session?.user?.role === 'evaluator'
  const [rows, setRows] = useState<OperationRun[]>([])
  const [viewer, setViewer] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<OperationRun | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  // Approve and Reject both move (or settle) a whole batch of games, so each asks
  // once in a modal that states the count.
  const [confirm, setConfirm] = useState<{ run: OperationRun; action: 'approve' | 'reject' } | null>(null)
  // Client-side infinite scroll: the API returns the whole window (≤200 rows);
  // only `visible` of them render, and scrolling the wrap reveals PAGE more.
  const [visible, setVisible] = useState(PAGE)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLTableRowElement | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/operations/runs?kind=${kind}&category=${category}&limit=200`, { cache: 'no-store' })
      if (!res.ok) throw new Error()
      const json = await res.json()
      setRows(json.rows ?? [])
      setViewer(json.viewer ?? null)
    } catch { setError('Could not load the history.') }
    finally { setLoading(false) }
  }, [kind, category])

  useEffect(() => { refresh() }, [refresh, reloadToken])
  useEffect(() => { setVisible(PAGE) }, [kind, category])

  const hasMore = visible < rows.length
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore) return
    const io = new IntersectionObserver(
      entries => { if (entries.some(e => e.isIntersecting)) setVisible(v => v + PAGE) },
      { root: scrollRef.current, rootMargin: '80px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, rows.length])

  async function resolve(run: OperationRun, action: 'approve' | 'reject') {
    const id = run.id
    setBusyId(id)
    try {
      const res = await fetch('/api/operations/handover/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error ?? `Could not ${action} the handover.`); return }
      toast.success(action === 'approve'
        ? `Approved the handover from ${run.from_evaluator}.`
        : `Rejected the handover from ${run.from_evaluator}.`)
      setConfirm(null)
      await refresh()
      onChanged?.()
    } catch { toast.error('Could not reach the server.') }
    finally { setBusyId(null) }
  }

  const isHandover = kind === 'handover'
  const cols = 7
  const shown = rows.slice(0, visible)

  return (
    <div className="card">
      <div className="card-head ophist-head">
        <span className="card-label">History</span>
        <RefreshButton onClick={refresh} loading={loading} />
      </div>

      {error ? <ErrorState onRetry={refresh}>{error}</ErrorState> : (
      <div className="tbl-wrap ophist-scroll" ref={scrollRef}>
        <table className="tbl tbl-sticky">
          <thead>
            <tr>
              <th style={{ width: 90 }}>Date</th>
              <th>From</th>
              <th style={{ width: 90 }}>Mode</th>
              <th style={{ width: 160 }}>Value</th>
              {!isHandover && <th className="tnum" style={{ width: 70 }}>Targets</th>}
              <th className="tnum" style={{ width: 70 }}>Games</th>
              {isHandover && <th style={{ width: 120 }}>Status</th>}
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <SkeletonRows widths={isHandover ? [60, 90, 50, 110, 30, 70, 50] : [60, 90, 50, 110, 30, 30, 50]} />
            )}
            {rows.length === 0 && !loading && (
              <tr><td colSpan={cols}><EmptyState>No {kind} runs in this category group yet.</EmptyState></td></tr>
            )}
            {shown.map(r => {
              // Only managers resolve; evaluators never see Approve/Reject.
              const canResolve = isHandover && !isEvaluator && r.status === 'pending' && (!r.submitted_by || r.submitted_by !== viewer)
              const isOwn = isHandover && r.status === 'pending' && !!r.submitted_by && r.submitted_by === viewer
              return (
                <tr key={r.id}>
                  <td>{fmtDateVN(r.submitted_at)}</td>
                  <td className="cell-name">{r.from_evaluator}</td>
                  <td><span className="badge neutral">{MODE_LABEL[runMode(r)]}</span></td>
                  <td style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{modeValue(r)}</td>
                  {!isHandover && <td className="tnum" style={{ fontWeight: 600 }}>{targetCount(r)}</td>}
                  <td className="tnum" style={{ fontWeight: 600 }}>{r.game_count}</td>
                  {isHandover && (
                    <td>
                      <span className={`badge ${STATUS_BADGE[r.status] ?? 'neutral'}`}>{r.status.charAt(0).toUpperCase() + r.status.slice(1)}</span>
                      {isOwn && <span className="ophist-own">your request</span>}
                    </td>
                  )}
                  {/* Status and actions live in separate cells: in one cell the badge and the
                      two buttons wrapped onto each other. */}
                  <td>
                    <span className="ophist-acts">
                      {canResolve && (
                        <>
                          <button className="btn btn-sm btn-danger" disabled={busyId === r.id}
                            onClick={() => setConfirm({ run: r, action: 'reject' })}>Reject</button>
                          <button className="btn btn-sm btn-primary" disabled={busyId === r.id}
                            onClick={() => setConfirm({ run: r, action: 'approve' })}>Approve</button>
                        </>
                      )}
                      <button className="btn btn-sm" onClick={() => setDetail(r)}>Details</button>
                    </span>
                  </td>
                </tr>
              )
            })}
            {hasMore && (
              <tr ref={sentinelRef}>
                <td colSpan={cols} className="ophist-more">Loading more…</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      )}

      {detail && <OperationDetailModal run={detail} onClose={() => setDetail(null)} />}

      {confirm && (() => {
        const { run, action } = confirm
        const busy = busyId === run.id
        const games = `${run.game_count} ${run.game_count === 1 ? 'game' : 'games'}`
        return (
          <Modal title={action === 'approve' ? `Approve handover from ${run.from_evaluator}?` : `Reject handover from ${run.from_evaluator}?`}
            width={440} busy={busy} onClose={() => setConfirm(null)}
            footer={<>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
              <button type="button" className={`btn ${action === 'approve' ? 'btn-primary' : 'btn-danger'}`} disabled={busy}
                onClick={() => resolve(run, action)}>
                {action === 'approve'
                  ? (busy ? 'Approving…' : `Approve, move ${games}`)
                  : (busy ? 'Rejecting…' : `Reject ${games}`)}
              </button>
            </>}>
            <p className="ophist-confirm">
              {action === 'approve'
                ? `${games} from ${run.from_evaluator} go to the available evaluators in ${run.category_group}. The split is worked out again now, so it can differ from the preview.`
                : `${games} stay with ${run.from_evaluator}. Nothing moves.`}
            </p>
          </Modal>
        )
      })()}
    </div>
  )
}
