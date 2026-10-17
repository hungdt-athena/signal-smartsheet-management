// components/DistributionResult.tsx — shared preview/commit result for reassign + handover.
// Two clearly-separated sections: the SOURCE pool broken down by day, and the
// resulting DISTRIBUTION broken down by evaluator (with per-platform split when the
// reassign route supplies it). An optional `action` (e.g. the Commit button) sits in
// the card header so committing lives right next to what it will do.
'use client'
import { useMemo, type ReactNode, type CSSProperties } from 'react'
import { EmptyState } from '@/components/ui/States'
import { fmtDateVN } from '@/lib/format-date'

export interface DistResult {
  candidate_count: number
  assignable?: number
  unassignable?: number
  assigned?: number // present after a commit
  per_evaluator: Record<string, number>
  per_evaluator_platform?: Record<string, { ios: number; android: number; other: number }>
  by_platform?: { ios: number; android: number; other: number }
  by_date?: { date: string; count: number }[]
  dryRun: boolean
}

const SUB_BOX: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 12,
  background: 'var(--surface-2)',
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--faint)', margin: '2px 2px 8px' }}>
      {children}
    </div>
  )
}

export function DistributionResult({ result, action }: { result: DistResult; action?: ReactNode }) {
  const committed = !result.dryRun
  const detail = result.per_evaluator_platform

  // Distribution rows: prefer the per-platform detail (reassign), else plain counts.
  const rows = useMemo(() => {
    if (detail) {
      return Object.entries(detail)
        .map(([name, p]) => ({ name, ios: p.ios, android: p.android, other: p.other, total: p.ios + p.android + p.other }))
        .sort((a, b) => b.total - a.total)
    }
    // Guard against a snapshot missing per_evaluator (e.g. legacy/malformed rows) so
    // the "Details" popup renders an empty distribution instead of throwing.
    return Object.entries(result.per_evaluator ?? {})
      .map(([name, n]) => ({ name, ios: 0, android: 0, other: 0, total: n }))
      .sort((a, b) => b.total - a.total)
  }, [detail, result.per_evaluator])

  const hasOther = rows.some(r => r.other > 0)
  const hasByDate = !!(result.by_date && result.by_date.length > 0)
  const moved = committed ? (result.assigned ?? 0) : (result.assignable ?? rows.reduce((s, r) => s + r.total, 0))

  return (
    // No top margin: the page (and a modal body) space their children with gap.
    <div className="card">
      <div className="card-head" style={{ alignItems: 'center' }}>
        <span className="card-label">{committed ? 'Result' : 'Preview'}</span>
        {action}
      </div>

      {/* Summary — the source pool being moved */}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', padding: '4px 2px 14px' }}>
        <Stat label="Candidates" value={result.candidate_count} />
        <Stat label={committed ? 'Assigned' : 'Will assign'} value={moved} accent />
        {typeof result.unassignable === 'number' && result.unassignable > 0 && (
          <Stat label="Unassignable" value={result.unassignable} warn />
        )}
        {result.by_platform && (
          <>
            <Stat label="iOS" value={result.by_platform.ios} />
            <Stat label="Android" value={result.by_platform.android} />
            {result.by_platform.other > 0 && <Stat label="Other" value={result.by_platform.other} />}
          </>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: hasByDate ? '1fr 1fr' : '1fr', gap: 14, alignItems: 'start' }}>
        {/* Source pool by day */}
        {hasByDate && (
          <div style={SUB_BOX}>
            <SectionLabel>Source · games by day</SectionLabel>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>Date</th><th className="tnum" style={{ width: 80 }}>Games</th></tr>
                </thead>
                <tbody>
                  {result.by_date?.map(d => (
                    <tr key={d.date}>
                      <td>{fmtDateVN(d.date)}</td>
                      <td className="tnum" style={{ fontWeight: 600 }}>{d.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Resulting distribution by evaluator */}
        <div style={SUB_BOX}>
          <SectionLabel>Distribution · by evaluator</SectionLabel>
          {rows.length > 0 ? (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Evaluator</th>
                    {detail && <th className="tnum" style={{ width: 60 }}>iOS</th>}
                    {detail && <th className="tnum" style={{ width: 74 }}>Android</th>}
                    {detail && hasOther && <th className="tnum" style={{ width: 60 }}>Other</th>}
                    <th className="tnum" style={{ width: 64 }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.name}>
                      <td className="cell-name">{r.name}</td>
                      {detail && <td className="tnum" style={{ color: r.ios ? undefined : 'var(--faint)' }}>{r.ios}</td>}
                      {detail && <td className="tnum" style={{ color: r.android ? undefined : 'var(--faint)' }}>{r.android}</td>}
                      {detail && hasOther && <td className="tnum" style={{ color: r.other ? undefined : 'var(--faint)' }}>{r.other}</td>}
                      <td className="tnum" style={{ fontWeight: 700 }}>{r.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>
              {result.candidate_count === 0 ? 'No pending games match, so nothing moves.' : 'Pick target evaluators to see the split.'}
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, warn, accent }: { label: string; value: number; warn?: boolean; accent?: boolean }) {
  const color = warn ? 'var(--bad)' : accent ? 'var(--accent)' : undefined
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
    </div>
  )
}
