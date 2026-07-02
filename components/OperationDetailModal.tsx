// components/OperationDetailModal.tsx — "Details" popup for a Team Operations run.
// Re-renders the stored snapshot (or the committed result, for an approved handover)
// through the shared DistributionResult, so the Source pool + Distribution look
// exactly as they were previewed. Reuses the eval-modal-* backdrop/container.
'use client'
import { DistributionResult } from '@/components/DistributionResult'
import type { OperationRun } from '@/components/OperationHistory'

const STATUS_PILL: Record<string, string> = {
  committed: 'on', approved: 'on', pending: 'tag', rejected: 'off',
}

function fmtDate(d: string | null): string {
  if (!d) return '—'
  const [y, m, day] = d.slice(0, 10).split('-')
  return `${day}/${m}/${y.slice(2)}`
}

function fmtWhen(ts: string | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'short' })
}

export function OperationDetailModal({ run, onClose }: { run: OperationRun; onClose: () => void }) {
  // Approved handover carries the committed result; everything else shows the snapshot.
  const dist = run.result ?? run.snapshot
  const window = run.params?.start_date && run.params?.end_date
    ? `${fmtDate(run.params.start_date)} → ${fmtDate(run.params.end_date)}`
    : run.params?.count
      ? `${run.params.count} games (oldest first)`
      : null

  return (
    <div className="eval-modal-backdrop" onClick={onClose}>
      <div className="eval-modal-container" onClick={e => e.stopPropagation()}
        style={{ padding: '20px 24px 24px', maxWidth: 760, width: '96vw', maxHeight: '90vh', overflowY: 'auto' }}>

        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, textTransform: 'capitalize' }}>
            {run.kind} · {run.from_evaluator}
          </h2>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: '4px 10px', fontSize: 12 }}>✕</button>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5, color: 'var(--faint)', marginBottom: 4 }}>
          <span className={`pill ${STATUS_PILL[run.status] ?? 'tag'}`} style={{ fontSize: 10 }}>{run.status}</span>
          <span>{run.category_group}</span>
          {window && <span>· {window}</span>}
          <span>· submitted {fmtWhen(run.submitted_at)}{run.submitted_by ? ` by ${run.submitted_by}` : ''}</span>
          {run.reviewed_at && <span>· {run.status} {fmtWhen(run.reviewed_at)}{run.reviewed_by ? ` by ${run.reviewed_by}` : ''}</span>}
        </div>
        {run.review_note && (
          <p style={{ fontSize: 12.5, color: 'var(--faint)', margin: '2px 0 0' }}>Note: {run.review_note}</p>
        )}
        {run.kind === 'handover' && run.status === 'pending' && (
          <p style={{ fontSize: 12, color: 'var(--faint)', margin: '6px 0 0', fontStyle: 'italic' }}>
            Preview from submit time — the actual distribution is recomputed when approved.
          </p>
        )}

        <DistributionResult result={dist} />
      </div>
    </div>
  )
}
