// components/OperationDetailModal.tsx — "Details" popup for a Team Operations run.
// Re-renders the stored snapshot (or the committed result, for an approved handover)
// through the shared DistributionResult, so the Source pool + Distribution look
// exactly as they were previewed. Uses the shared <Modal> (Esc, focus trap, X).
'use client'
import { DistributionResult } from '@/components/DistributionResult'
import type { OperationRun } from '@/components/OperationHistory'
import { Modal } from '@/components/ui/Modal'
import { fmtDateTimeVN, fmtDateVN } from '@/lib/format-date'

// Status is a badge (it is read, not clicked). OperationHistory uses the same map.
// It lives here so the two files import each other only for types.
export const STATUS_BADGE: Record<string, string> = {
  committed: 'success', approved: 'success', pending: 'running', rejected: 'error',
}

const KIND_LABEL: Record<OperationRun['kind'], string> = {
  reassign: 'Reassign', handover: 'Handover', rescue: 'Rescue',
}

export function OperationDetailModal({ run, onClose }: { run: OperationRun; onClose: () => void }) {
  // Approved handover carries the committed result; everything else shows the snapshot.
  const dist = run.result ?? run.snapshot
  const window = run.params?.start_date && run.params?.end_date
    ? `${fmtDateVN(run.params.start_date)} → ${fmtDateVN(run.params.end_date)}`
    : run.params?.count
      ? `${run.params.count} games (oldest first)`
      : null

  return (
    <Modal width={760} onClose={onClose}
      title={`${KIND_LABEL[run.kind] ?? run.kind} · ${run.from_evaluator}`}
      sub={
        <span className="opdet-meta">
          <span className={`badge ${STATUS_BADGE[run.status] ?? 'neutral'}`}>{run.status}</span>
          <span>{run.category_group}</span>
          {window && <span>· {window}</span>}
          <span>· submitted {fmtDateTimeVN(run.submitted_at)}{run.submitted_by ? ` by ${run.submitted_by}` : ''}</span>
          {run.reviewed_at && <span>· {run.status} {fmtDateTimeVN(run.reviewed_at)}{run.reviewed_by ? ` by ${run.reviewed_by}` : ''}</span>}
        </span>
      }>
      {run.review_note && <p className="opdet-note">Note: {run.review_note}</p>}
      {run.kind === 'handover' && run.status === 'pending' && (
        <p className="opdet-note">
          This is the preview from when it was submitted. The split is worked out again when a manager approves it.
        </p>
      )}

      <DistributionResult result={dist} />
    </Modal>
  )
}
