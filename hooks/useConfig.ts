import { useState, useEffect } from 'react'

// Editable dropdown option lists (managed from the Config tab) plus their
// hardcoded fallbacks. Fallbacks mirror migration 014's seed so the UI behaves
// identically if /api/config is unreachable or hasn't loaded yet.
export interface ConfigLists {
  conclusion: string[]
  final_conclusion: string[]
}

export const CONFIG_FALLBACK: ConfigLists = {
  conclusion: [
    'Bypass', 'Conclusion', 'Good', 'Link_dead', 'M_ByPass', 'Need deeper testing', 'Skip',
    'Wait for PlayTest', 'Priority IV: Idea', 'Priority III: Watchlist for next phase',
    'Check Market Data', 'Watchlist for next milestone', 'Priority II', 'Priority I',
    'Need Direction', 'List_Idea',
  ],
  final_conclusion: [
    'Priority V', 'Priority IV', 'Bypass', 'Theme/Art', 'Insight', 'Watch List', 'Not Found',
  ],
}

/** Fetches the active dropdown option lists once. Returns fallbacks until loaded. */
export function useConfig(): ConfigLists {
  const [lists, setLists] = useState<ConfigLists>(CONFIG_FALLBACK)

  useEffect(() => {
    let cancelled = false
    fetch('/api/config', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then((json: Partial<ConfigLists> | null) => {
        if (cancelled || !json) return
        setLists({
          conclusion: json.conclusion?.length ? json.conclusion : CONFIG_FALLBACK.conclusion,
          final_conclusion: json.final_conclusion?.length ? json.final_conclusion : CONFIG_FALLBACK.final_conclusion,
        })
      })
      .catch(() => { /* keep fallbacks */ })
    return () => { cancelled = true }
  }, [])

  return lists
}
