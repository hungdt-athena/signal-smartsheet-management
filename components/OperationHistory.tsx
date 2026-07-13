// components/OperationHistory.tsx — per-bucket history of reassign/handover runs
// (operation_runs, migration 028). Mounted above the form in ReassignPanel and
// HandoverPanel. One row per operation; "Details" opens the snapshot popup. Handover
// rows carry a status pill; pending ones show Approve/Reject to any manager who is
// NOT the submitter.
'use client'
import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import type { Bucket } from '@/lib/buckets'
import type { DistResult } from '@/components/DistributionResult'
import { OperationDetailModal } from '@/components/OperationDetailModal'

export interface OperationRun {
  id: number
  kind: 'reassign' | 'handover'
  category_group: string
  from_evaluator: string
  params: { start_date?: string; end_date?: string; count?: number; mode?: string; selected_evaluators?: string[] }
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

const STATUS_PILL: Record<string, string> = {
  committed: 'on', approved: 'on', pending: 'tag', rejected: 'off',
}

function fmtDate(d?: string | null): string {
  if (!d) return '—'
  const [y, m, day] = d.slice(0, 10).split('-')
  return `${day}/${m}/${y.slice(2)}`
}

function targetCount(run: OperationRun): number {
  const dist = run.result ?? run.snapshot
  return Object.keys(dist?.per_evaluator ?? {}).length
}

export function OperationHistory({ kind, category, reloadToken, onChanged }: {
  kind: 'reassign' | 'handover'
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

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/operations/runs?kind=${kind}&category=${category}&limit=200`, { cache: 'no-store' })
      if (!res.ok) throw new Error()
      const json = await res.json()
      setRows(json.rows ?? [])
      setViewer(json.viewer ?? null)
    } catch { setError('Failed to load history.') }
    finally { setLoading(false) }
  }, [kind, category])

  useEffect(() => { refresh() }, [refresh, reloadToken])

  async function resolve(id: number, action: 'approve' | 'reject') {
    setBusyId(id); setError(null)
    try {
      const res = await fetch('/api/operations/handover/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      })
      const json = await res.json()
      if (!res.ok) { setError(json.error ?? `Failed to ${action}.`); return }
      await refresh()
      onChanged?.()
    } catch { setError('Network error.') }
    finally { setBusyId(null) }
  }

  const isHandover = kind === 'handover'
  const cols = isHandover ? 6 : 5

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="card-label">
          History
          {rows.length > 0 && <span style={{ color: 'var(--faint)', fontWeight: 400, marginLeft: 8 }}>{rows.length}</span>}
        </span>
        <button className="btn btn-sm" onClick={refresh} disabled={loading}>
          <span className={loading ? 'spin' : ''}>↻</span>{loading ? '...' : 'Refresh'}
        </button>
      </div>

      {error && <p className="msg-err" style={{ margin: '8px 0' }}>{error}</p>}

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 130 }}>Date</th>
              <th>From</th>
              {isHandover ? <th style={{ width: 150 }}>Window</th> : <th style={{ width: 80 }}>Targets</th>}
              <th style={{ width: 70 }}>Games</th>
              {isHandover && <th style={{ width: 170 }}>Status</th>}
              <th style={{ width: 90 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr><td colSpan={cols} className="empty">No history yet</td></tr>
            )}
            {rows.map(r => {
              // Only managers resolve; evaluators never see Approve/Reject.
              const canResolve = isHandover && !isEvaluator && r.status === 'pending' && (!r.submitted_by || r.submitted_by !== viewer)
              const isOwn = isHandover && r.status === 'pending' && !!r.submitted_by && r.submitted_by === viewer
              return (
                <tr key={r.id}>
                  <td>{fmtDate(r.submitted_at)}</td>
                  <td className="cell-name">{r.from_evaluator}</td>
                  {isHandover
                    ? <td style={{ fontSize: 12 }}>{fmtDate(r.params?.start_date)} → {fmtDate(r.params?.end_date)}</td>
                    : <td style={{ fontWeight: 600 }}>{targetCount(r)}</td>}
                  <td style={{ fontWeight: 600 }}>{r.game_count}</td>
                  {isHandover && (
                    <td>
                      <span className={`pill ${STATUS_PILL[r.status] ?? 'tag'}`} style={{ fontSize: 10 }}>{r.status}</span>
                      {canResolve && (
                        <span style={{ marginLeft: 6, display: 'inline-flex', gap: 4 }}>
                          <button className="btn btn-primary btn-sm" disabled={busyId === r.id} onClick={() => resolve(r.id, 'approve')}>
                            {busyId === r.id ? '…' : 'Approve'}
                          </button>
                          <button className="btn btn-sm" disabled={busyId === r.id} onClick={() => resolve(r.id, 'reject')}>Reject</button>
                        </span>
                      )}
                      {isOwn && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--faint)', fontStyle: 'italic' }}>your request</span>}
                    </td>
                  )}
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn btn-sm" onClick={() => setDetail(r)}>Details</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {detail && <OperationDetailModal run={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}
