'use client'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { Modal } from '@/components/ui/Modal'
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
  const word = LEAVE_WORD[action]
  const blocked = saveBlockedReason != null
  const saveRef = useRef<HTMLButtonElement>(null)
  const stayRef = useRef<HTMLButtonElement>(null)
  // Enter answers the prompt: Save when it can run, else Keep editing. Set here and
  // not with autoFocus: Modal's own effect runs first (it is the child) and moves
  // focus to the box, so this effect, which runs after it, has the last word.
  useEffect(() => {
    ;(blocked ? stayRef.current : saveRef.current)?.focus()
    // Only on open: re-focusing on every render would pull focus back mid-click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc means Keep editing (nothing while a save runs). Modal with no X swallows Esc, so
  // this listener has to be on window first: a layout effect runs before Modal's passive
  // one. Marking the key handled makes Modal and the panel's own handler leave it.
  const stay = useRef({ onStay, saving })
  stay.current = { onStay, saving }
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      if (!stay.current.saving) stay.current.onStay()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Above the History modal (1500) and the panel's backdrop (900), below the Lightbox (2000).
  return (
    <Modal role="alertdialog" hideClose zIndex={1600} width={460} busy={saving}
      title="You have unsaved changes" onClose={onStay}
      footer={<>
        {/* Discard sits apart on the left so it is never hit by mistake for Save. */}
        <button className="btn btn-sm btn-danger" onClick={onDiscard} disabled={saving} style={{ marginRight: 'auto' }}>
          Discard &amp; {word}
        </button>
        <button ref={stayRef} className="btn btn-sm" onClick={onStay} disabled={saving}>Keep editing</button>
        <button ref={saveRef} className="btn btn-sm btn-primary" onClick={onSave} disabled={saving || blocked}>
          {saving ? 'Saving…' : `Save & ${word}`}
        </button>
      </>}>
      <div id="unsaved-fields" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {fields.map(f => <span key={f} className="badge neutral">{f}</span>)}
      </div>
      {blocked && <div style={{ fontSize: 'var(--fs-13)', color: 'var(--warn)' }}>{saveBlockedReason}</div>}
    </Modal>
  )
}
