// lib/toast.ts — one toast system for the whole app. Call toast.success / toast.error
// from anywhere on the client; <Toaster/> (mounted once in the root layout) shows them
// bottom-right. Success hides after 3s. An error stays until closed, and can carry a
// retry action.

export interface ToastItem {
  id: number
  kind: 'ok' | 'err'
  text: string
  action?: { label: string; run: () => void }
}

type Listener = (items: ToastItem[]) => void
let items: ToastItem[] = []
let seq = 0
const listeners = new Set<Listener>()
const emit = () => listeners.forEach(l => l(items))

export function subscribeToasts(l: Listener): () => void {
  listeners.add(l)
  l(items)
  return () => { listeners.delete(l) }
}

export function dismissToast(id: number): void {
  items = items.filter(t => t.id !== id)
  emit()
}

function push(t: Omit<ToastItem, 'id'>, ms: number | null): number {
  const id = ++seq
  items = [...items.slice(-3), { ...t, id }]
  emit()
  if (ms != null) setTimeout(() => dismissToast(id), ms)
  return id
}

export const toast = {
  success: (text: string) => push({ kind: 'ok', text }, 3000),
  error: (text: string, action?: ToastItem['action']) => push({ kind: 'err', text, action }, null),
}
