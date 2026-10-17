'use client'
// Mounted once in the root layout. Shows toasts from lib/toast.ts bottom-right.
import { useEffect, useState } from 'react'
import { dismissToast, subscribeToasts, type ToastItem } from '@/lib/toast'
import { CloseButton } from './CloseButton'

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([])
  useEffect(() => subscribeToasts(setItems), [])
  if (items.length === 0) return null
  return (
    <div className="toast-wrap" aria-live="polite">
      {items.map(t => (
        <div key={t.id} className={`toast${t.kind === 'err' ? ' err' : ''}`} role={t.kind === 'err' ? 'alert' : 'status'}>
          <span style={{ flex: 1, minWidth: 0 }}>{t.text}</span>
          {t.action && (
            <button type="button" className="btn btn-sm btn-link" onClick={() => { dismissToast(t.id); t.action!.run() }}>{t.action.label}</button>
          )}
          {t.kind === 'err' && <CloseButton onClick={() => dismissToast(t.id)} label="Dismiss" />}
        </div>
      ))}
    </div>
  )
}
