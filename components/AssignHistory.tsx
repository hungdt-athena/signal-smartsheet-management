// components/AssignHistory.tsx — per-bucket assignment_history reader (migration 025).
// Shows one row per (run, evaluator): daily auto-assign, manual re-assign, handover.
'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Bucket } from '@/lib/buckets'

interface HistoryRow {
  id: number
  run_date: string
  run_at: string
  category_group: string
  action: 'assign' | 'reassign' | 'handover'
  evaluator_name: string
  from_evaluator: string | null
  game_count: number
  created_by: string | null
}

const ACTION_LABEL: Record<HistoryRow['action'], string> = {
  assign: 'Assign', reassign: 'Reassign', handover: 'Handover',
}
// Reuse the shared pill palette: on=accent, tag=neutral, off=muted.
const ACTION_PILL: Record<HistoryRow['action'], string> = {
  assign: 'on', reassign: 'tag', handover: 'off',
}

function fmtDate(d: string): string {
  // run_date is a plain YYYY-MM-DD (VN date) — render without a timezone shift.
  const [y, m, day] = d.slice(0, 10).split('-')
  return `${day}/${m}/${y.slice(2)}`
}

export function AssignHistory({ bucket }: { bucket: Bucket }) {
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/admin/assignment-history?category=${bucket}&limit=500`, { cache: 'no-store' })
      if (!res.ok) throw new Error()
      const json = await res.json()
      setRows(json.rows ?? [])
    } catch { setError('Failed to load history.') }
    finally { setLoading(false) }
  }, [bucket])

  useEffect(() => { refresh() }, [refresh])

  const totalGames = useMemo(() => rows.reduce((s, r) => s + (r.game_count || 0), 0), [rows])

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="card-label">
          History
          {rows.length > 0 && (
            <span style={{ color: 'var(--faint)', fontWeight: 400, marginLeft: 8 }}>
              {rows.length} runs · {totalGames} games
            </span>
          )}
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
              <th style={{ width: 90 }}>Date</th>
              <th style={{ width: 100 }}>Action</th>
              <th>Evaluator</th>
              <th>From</th>
              <th style={{ width: 70 }}>Games</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr><td colSpan={5} className="empty">No history yet</td></tr>
            )}
            {rows.map(r => (
              <tr key={r.id}>
                <td>{fmtDate(r.run_date)}</td>
                <td><span className={`pill ${ACTION_PILL[r.action]}`} style={{ fontSize: 10 }}>{ACTION_LABEL[r.action] ?? r.action}</span></td>
                <td className="cell-name">{r.evaluator_name}</td>
                <td style={{ color: r.from_evaluator ? undefined : 'var(--faint)' }}>{r.from_evaluator ?? '—'}</td>
                <td style={{ fontWeight: 600 }}>{r.game_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
