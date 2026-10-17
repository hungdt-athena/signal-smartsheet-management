'use client'
// One modal frame: title on the left, X on the right, body, footer on the right
// (Cancel first, the main action last). role="dialog", Esc closes the newest open
// dialog only, focus moves in on open and back to the opener on close, and Tab
// stays inside. Rendered in a portal so a parent's overflow or z-index cannot clip it.
//
// z-index scale (keep in step with globals.css):
//   page modals 1000 · eval panel 900 sits below them only when opened from a page
//   stacked dialog over the eval panel 1500 · unsaved/confirm 1600 · lightbox 2000
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeToClose } from '@/lib/use-escape-to-close'
import { CloseButton } from './CloseButton'

export interface ModalProps {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** Max width in px. Default 540. */
  width?: number
  /** While true: Esc, backdrop click and X do nothing (a save is running). */
  busy?: boolean
  /** Clicking the backdrop closes. Default true; false for a blocking prompt. */
  closeOnBackdrop?: boolean
  /** Hide the X (a prompt that must be answered with a footer button). */
  hideClose?: boolean
  zIndex?: number
  role?: 'dialog' | 'alertdialog'
  /** Extra class on the .modal box. */
  className?: string
  /** Optional line under the title. */
  sub?: ReactNode
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
let titleSeq = 0

export function Modal({ title, sub, onClose, children, footer, width = 540, busy = false, closeOnBackdrop = true, hideClose = false, zIndex, role = 'dialog', className = '' }: ModalProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const titleId = useRef(`modal-title-${++titleSeq}`).current
  useEscapeToClose(onClose, !busy && !hideClose)

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const box = boxRef.current
    // Focus the first field if there is one, else the box itself.
    const first = box?.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled])')
      || box?.querySelector<HTMLElement>('[autofocus]')
    ;(first || box)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !box) return
      const els = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.offsetParent !== null)
      if (els.length === 0) { e.preventDefault(); return }
      const a = els[0], z = els[els.length - 1]
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus() }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus() }
    }
    box?.addEventListener('keydown', onKey)
    return () => {
      box?.removeEventListener('keydown', onKey)
      if (opener && document.contains(opener)) opener.focus()
    }
  }, [])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="modal-backdrop" style={zIndex != null ? { zIndex } : undefined}
      onClick={e => { e.stopPropagation(); if (closeOnBackdrop && !busy) onClose() }}>
      <div ref={boxRef} className={`modal ${className}`.trim()} role={role} aria-modal="true" aria-labelledby={titleId}
        tabIndex={-1} style={{ maxWidth: width }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div style={{ minWidth: 0 }}>
            <div className="modal-title" id={titleId}>{title}</div>
            {sub && <div className="modal-sub">{sub}</div>}
          </div>
          {!hideClose && <CloseButton onClick={onClose} disabled={busy} />}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
