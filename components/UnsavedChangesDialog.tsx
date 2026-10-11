'use client'
import { createPortal } from 'react-dom'
import { LEAVE_WORD, type LeaveAction } from '@/lib/leave-decision'

export interface UnsavedChangesDialogProps {
  action: LeaveAction
  fields: string[]
  saving: boolean
  /** Why Save is unavailable (e.g. the note is too short); null when it can run. */
  saveBlockedReason: string | null
  onSave: () => void
  onDiscard: () => void
  onStay: () => void
}

/** Shown when the user leaves a game that has edits nobody saved (auto-save off). */
export function UnsavedChangesDialog({ action, fields, saving, saveBlockedReason, onSave, onDiscard, onStay }: UnsavedChangesDialogProps) {
  if (typeof document === 'undefined') return null
  const word = LEAVE_WORD[action]
  const blocked = saveBlockedReason != null
  // Above the History modal (1500) and the panel's backdrop (900), below the Lightbox (2000).
  return createPortal(
    <div className="modal-backdrop" style={{ zIndex: 1600 }} onClick={saving ? undefined : onStay}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="unsaved-title" aria-describedby="unsaved-fields"
        style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title" id="unsaved-title">You have unsaved changes</div>
        </div>
        <div className="modal-body" style={{ gap: 12 }}>
          <div id="unsaved-fields" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {fields.map(f => <span key={f} className="pill muted" style={{ fontSize: 12 }}>{f}</span>)}
          </div>
          {blocked && <div style={{ fontSize: 12.5, color: 'var(--warn)' }}>{saveBlockedReason}</div>}
        </div>
        <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
          <button className="btn btn-sm btn-ghost" onClick={onDiscard} disabled={saving} style={{ color: 'var(--bad)' }}>
            Discard &amp; {word}
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm" onClick={onStay} disabled={saving} autoFocus={blocked}>Keep editing</button>
            <button className="btn btn-sm btn-primary" onClick={onSave} disabled={saving || blocked} autoFocus={!blocked}>
              {saving ? 'Saving…' : `Save & ${word}`}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
