'use client'
// lib/use-url-state.ts — keep a view or filter value in the URL query string, so
// reload, Back and a shared link all open the same view with the same filters.
//
// The value is read from the URL on every render (the URL is the state). Writing
// uses window.history.replaceState, which Next (14.1+) patches so useSearchParams
// updates. Not router.replace: that fetches from the server before it changes the
// URL, so two quick filter changes could each start from the old URL and the second
// would drop the first. replaceState changes location at once, adds no history
// entry, and costs no round-trip. A value equal to its default is left out.
import { useCallback } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'

function writeQuery(pathname: string, patch: Record<string, string | null>) {
  const live = new URLSearchParams(window.location.search)
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '') live.delete(k)
    else live.set(k, v)
  }
  const qs = live.toString()
  window.history.replaceState(window.history.state, '', qs ? `${pathname}?${qs}` : pathname)
}

export function useUrlState(key: string, fallback: string): [string, (next: string) => void] {
  const params = useSearchParams()
  const pathname = usePathname()
  const value = params.get(key) ?? fallback

  const set = useCallback((next: string) => {
    writeQuery(pathname, { [key]: next === fallback ? null : next })
  }, [key, fallback, pathname])

  return [value, set]
}

/** Set several query keys in one write (e.g. Clear filters). A null or '' value
 *  removes the key. */
export function useSetUrlParams(): (patch: Record<string, string | null>) => void {
  const pathname = usePathname()
  return useCallback((patch: Record<string, string | null>) => { writeQuery(pathname, patch) }, [pathname])
}
