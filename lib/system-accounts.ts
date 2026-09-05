// lib/system-accounts.ts — names that appear in evaluator/recorder columns but do
// not belong to a real person doing evaluation work.
//
// `Shortcut` is the attribution used when a game is pulled straight into Record
// without a genuine evaluation (see POST /api/evaluations/add-to-record). It has
// no dashboard_users row — it is a label, never a login.
//
// `vinhtd` is the moderator who owns the final-conclusion step; rows where he is
// the *initial* evaluator are bulk/administrative, not evaluation output.
//
// Both are excluded from every per-evaluator aggregation (Report tab + Quick Stats)
// so leaderboards and team averages describe actual evaluators only. Keys are
// lowercase — compare with lower().
export const SHORTCUT_EVALUATOR = 'Shortcut'

export const SYSTEM_EVALUATOR_KEYS = ['shortcut', 'vinhtd'] as const

// A narrower list: names with NOBODY behind them. `vinhtd` is on the list above
// because his initial-evaluator rows are administrative, but he is a real user
// with a real login; `Shortcut` is only a label. So these keys never get a user
// account, never appear in Config > People, and never appear in an evaluator
// dropdown — there is no person to manage. Lowercase, compare with lower().
export const SYSTEM_LABEL_KEYS = ['shortcut'] as const

export const SYSTEM_LABEL_KEY_LIST = SYSTEM_LABEL_KEYS as readonly string[] as string[]

export function isSystemLabel(name: string | null | undefined): boolean {
  return !!name && SYSTEM_LABEL_KEY_LIST.includes(name.trim().toLowerCase())
}

// Ready to bind into a SQL `<> ALL(...)` predicate.
export const SYSTEM_EVALUATOR_KEY_LIST = SYSTEM_EVALUATOR_KEYS as readonly string[] as string[]
