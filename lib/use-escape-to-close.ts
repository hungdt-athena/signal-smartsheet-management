import { useEffect, useRef } from 'react'

// Open dialogs. Esc closes only the newest one, so a confirm stacked on another
// dialog does not take its parent down with it.
const open = new Set<number>()
let seq = 0

/**
 * Esc closes this dialog. Listens in the capture phase and marks the key handled
 * (preventDefault), so a page-level handler underneath, like the evaluation panel's,
 * leaves it alone. Pass `enabled = false` while the dialog is closed or busy.
 */
export function useEscapeToClose(onClose: () => void, enabled = true): void {
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // "Newest" is decided at render, not in the effect: effects run child-first, so a
  // parent and child dialog mounted together would otherwise rank the parent on top.
  // Rendering runs parent-first, and a dialog opened later renders later.
  const idRef = useRef(0)
  const wasEnabled = useRef(false)
  if (enabled && !wasEnabled.current) idRef.current = ++seq
  wasEnabled.current = enabled

  useEffect(() => {
    if (!enabled) return
    const id = idRef.current
    open.add(id)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (id !== Math.max(...Array.from(open))) return
      e.preventDefault()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      open.delete(id)
    }
  }, [enabled])
}
