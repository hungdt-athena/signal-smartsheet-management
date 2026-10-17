'use client'
// The one close button for modals, popovers and panels: an X icon, 28×28,
// always labelled for screen readers.
import { IconX } from './SearchInput'

export function CloseButton({ onClick, label = 'Close', disabled }: { onClick: () => void; label?: string; disabled?: boolean }) {
  return (
    <button type="button" className="x-btn" aria-label={label} title={label} onClick={onClick} disabled={disabled}>
      <IconX size={16} />
    </button>
  )
}
