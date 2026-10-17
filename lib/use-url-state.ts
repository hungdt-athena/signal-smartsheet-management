'use client'
// lib/use-url-state.ts — keep a view or filter value in the URL query string, so
// reload, Back and a shared link all open the same view with the same filters.
//
// The value is read from the URL on every render (the URL is the state). Writing
// uses router.replace, so changing a filter does not stack history entries, and a
// value equal to its default is removed from the URL to keep links short.
import { useCallback } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

export function useUrlState(key: string, fallback: string): [string, (next: string) => void] {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const value = params.get(key) ?? fallback

  const set = useCallback((next: string) => {
    // Read the live URL, not the render-time params: two setters called in the same
    // tick (e.g. Clear filters) must not overwrite each other.
    const live = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : params.toString())
    if (next === fallback || next === '') live.delete(key)
    else live.set(key, next)
    const qs = live.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [key, fallback, params, pathname, router])

  return [value, set]
}

/** Set several query keys in one navigation (e.g. Clear filters). A null or ''
 *  value removes the key. Use this instead of calling several setters in a row:
 *  router.replace is not synchronous, so back-to-back calls can drop each other. */
export function useSetUrlParams(): (patch: Record<string, string | null>) => void {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  return useCallback((patch: Record<string, string | null>) => {
    const live = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') live.delete(k)
      else live.set(k, v)
    }
    const qs = live.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [params, pathname, router])
}
