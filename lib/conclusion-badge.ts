// lib/conclusion-badge.ts — which .badge colour an initial conclusion gets.
// Shared by the eval panel and its History modal. (The list page, Quick Stats and the
// report charts still keep their own copies.)

export const CONCLUSION_COLORS: Record<string, string> = {
  'Bypass': 'error', 'M_ByPass': 'error', 'Skip': 'error', 'Link_dead': 'error',
  // Stale_release: pushed by mistake (back-catalog game), taken out of the queue
  // without anyone evaluating it. Not selectable — set by the prune script only.
  'Stale_release': 'error',
  'Playtest & Bypass': 'error',
  'Good': 'success', 'Conclusion': 'success',
  'List_Idea': 'success', 'Priority I': 'success', 'Priority II': 'success',
  'Priority III: Watchlist for next phase': 'running',
  'Priority IV: Idea': 'running', 'Watchlist for next milestone': 'running',
  'Need deeper testing': 'running', 'Wait for PlayTest': 'running',
  'Check Market Data': 'running', 'Need Direction': 'running',
}

export function conclusionBadgeClass(c: string | null | undefined): string {
  return (c && CONCLUSION_COLORS[c]) || 'neutral'
}
