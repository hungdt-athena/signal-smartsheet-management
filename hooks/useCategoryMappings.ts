// hooks/useCategoryMappings.ts — active genres per bucket, for Config + Assign Setup.
'use client'
import { useCallback, useEffect, useState } from 'react'
import { BUCKETS, type Bucket } from '@/lib/buckets'

const EMPTY: Record<Bucket, string[]> = { puzzle: [], arcade: [], simulation: [] }

export function useCategoryMappings() {
  const [data, setData] = useState<Record<Bucket, string[]>>(EMPTY)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/config/categories', { cache: 'no-store' })
      if (res.ok) {
        const json = await res.json()
        const next = { ...EMPTY }
        for (const b of BUCKETS) next[b] = Array.isArray(json[b]) ? json[b] : []
        setData(next)
      }
    } catch { /* keep previous */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { refresh() }, [refresh])
  return { data, loading, refresh }
}
