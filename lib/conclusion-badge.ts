// lib/conclusion-badge.ts — the ONE colour map for conclusions and record status.
//
// Before this file there were six maps (list page, Quick stats, eval panel, Record
// tab, Individual review, charts) and they disagreed: Link_dead red on one page and
// grey on another, Not Found green in Individual review, List_Idea purple in charts.
// Every surface reads from here now. Initial and final conclusions are two fields
// that share a word ("Bypass"), so they are two maps, never one.
//
// Initial conclusion (evaluator): Bypass is the normal outcome (80%+ of games) and is
// grey, so red is left for Link_dead — a broken source someone may need to look at.

/** `.badge` modifier class for an initial conclusion. */
export const CONCLUSION_COLORS: Record<string, string> = {
  'List_Idea': 'success', 'Good': 'success', 'Conclusion': 'success', 'Priority I': 'success', 'Priority II': 'success',
  'Link_dead': 'error',
  'Bypass': 'neutral', 'M_ByPass': 'neutral', 'Skip': 'neutral',
  'Playtest & Bypass': 'neutral-strong',
  // Stale_release: pushed by mistake (back-catalog game), taken out of the queue
  // without anyone evaluating it. Not selectable — set by the prune script only.
  'Stale_release': 'idle',
  'Wait for PlayTest': 'running', 'Need deeper testing': 'running', 'Check Market Data': 'running',
  'Need Direction': 'running', 'Priority III: Watchlist for next phase': 'running',
  'Priority IV: Idea': 'running', 'Watchlist for next milestone': 'running',
}

export function conclusionBadgeClass(c: string | null | undefined): string {
  return (c && CONCLUSION_COLORS[c]) || 'neutral'
}

/** Final conclusion (admin, Short List). The two that send a game to Record
 *  (Priority IV → 20 min, Insight → 5 min) are solid; the rest are tinted. */
export const FINAL_CONCLUSION_STYLES: Record<string, { bg: string; color: string }> = {
  'Priority IV': { bg: 'var(--fc-p4)', color: '#ffffff' },
  'Insight':     { bg: 'var(--fc-insight)', color: '#ffffff' },
  'Watch List':  { bg: 'var(--fc-watch-bg)', color: 'var(--fc-watch)' },
  'Priority V':  { bg: 'var(--fc-p5-bg)', color: 'var(--fc-p5)' },
  'Theme/Art':   { bg: 'var(--fc-theme-bg)', color: 'var(--fc-theme)' },
  'Bypass':      { bg: 'var(--bad)', color: '#ffffff' },
  'Not Found':   { bg: 'var(--fc-notfound)', color: '#e5e7eb' },
}
const FINAL_FALLBACK = { bg: 'var(--surface-3)', color: 'var(--muted)' }

export function finalConclusionStyle(v: string | null | undefined): { bg: string; color: string } {
  return (v && FINAL_CONCLUSION_STYLES[v]) || FINAL_FALLBACK
}

/** One solid colour per value, for charts. Hex, because SVG fills and canvas need it. */
export const INITIAL_CHART_COLORS: Record<string, string> = {
  'List_Idea': '#1f9d57', 'Bypass': '#9ca3af', 'Playtest & Bypass': '#6b7280',
  'Link_dead': '#d23b3b', 'Stale_release': '#cbd5e1', 'Wait for PlayTest': '#b9760a',
}
export const FINAL_CHART_COLORS: Record<string, string> = {
  'Priority IV': '#0f766e', 'Insight': '#15803d', 'Watch List': '#16a34a', 'Priority V': '#6d28d9',
  'Theme/Art': '#2563eb', 'Bypass': '#d23b3b', 'Not Found': '#374151',
}

/** Record status: same badge on the Record tab and in the eval panel. */
export type RecordStatus = 'pending' | 'draft' | 'recording' | 'recorded'
export const RECORD_STATUS_BADGE: Record<RecordStatus, { cls: string; label: string }> = {
  pending:   { cls: 'idle', label: 'Pending' },
  draft:     { cls: 'running', label: 'Draft' },
  recording: { cls: 'info', label: 'Recording' },
  recorded:  { cls: 'success', label: 'Recorded' },
}
