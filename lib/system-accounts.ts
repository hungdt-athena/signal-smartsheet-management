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

// Ready to bind into a SQL `<> ALL(...)` predicate.
export const SYSTEM_EVALUATOR_KEY_LIST = SYSTEM_EVALUATOR_KEYS as readonly string[] as string[]
