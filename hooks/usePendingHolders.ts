// hooks/usePendingHolders.ts — the evaluators who hold still-pending games in a
// bucket, newest count first. Backs the "re-assign from" / "evaluator on leave"
// dropdowns so they list people with work to move, not the whole roster.
'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Bucket } from '@/lib/buckets'

export interface PendingHolder { name: string; pending: number }

export function usePendingHolders(category: Bucket, enabled = true) {
  const [holders, setHolders] = useState<PendingHolder[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!enabled) { setHolders([]); return }
    setLoading(true)
    try {
      const res = await fetch(`/api/operations/pending-holders?category=${category}`, { cache: 'no-store' })
      const json = await res.json()
      setHolders(res.ok && Array.isArray(json.holders) ? (json.holders as PendingHolder[]) : [])
    } catch { setHolders([]) }
    finally { setLoading(false) }
  }, [category, enabled])

  useEffect(() => { refresh() }, [refresh])

  const options = useMemo(
    () => holders.map(h => ({ value: h.name, label: `${h.name} · ${h.pending.toLocaleString()} pending` })),
    [holders],
  )

  return { holders, options, loading, refresh }
}
