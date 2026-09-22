// Pure assignment algorithm, ported from the n8n "auto-assign-game-evaluator"
// flow (code node `assigned2`). No I/O — callers load games/roster and persist.

export interface AssignableGame {
  id: number
  os: string | null // game_info.os: 'ios' | 'android' | other/null
}

export interface RosterEvaluator {
  name: string
  platform: string // 'all' | 'ios' | 'android' (blank/unknown → 'all')
  weight: number   // blank/0 → 100
}

// Largest-remainder split of `total` proportional to `weights`; sums to total.
export function splitByWeight(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum <= 0 || total <= 0) return weights.map(() => 0)
  const raw = weights.map(w => (total * w) / sum)
  const base = raw.map(x => Math.floor(x))
  const rem = total - base.reduce((a, b) => a + b, 0)
  const order = raw.map((_, i) => i).sort((a, b) => ((raw[b] - base[b]) - (raw[a] - base[a])) || (a - b))
  for (let i = 0; i < rem; i++) base[order[i]]++
  return base
}

// Returns Map<gameId, evaluatorName>. Games may be left out when only
// platform-specific evaluators remain and no game matches their platform.
//
// Shares are weighted max-min fair, capped by what each platform can actually
// supply. The version this replaced walked the platform-specific evaluators in
// roster order and let each take its FULL target off the top, so a platform pool
// smaller than what its specialists were collectively owed did not get shared:
// the shortfall landed entirely on whoever came last. On 2026-09-22 that handed
// 814 puzzle games to eleven people and gave QuangVN - four ios evaluators deep,
// and holding the smallest backlog on the team - exactly zero. It also leaked the
// freed capacity to the generalists alone, so an android specialist on weight 100
// got 90 games while a generalist on the same weight got 117.
//
// The rule now: everyone is served at one rate per unit of weight. If a platform
// cannot cover what its own specialists are owed at that rate, they take all of it,
// split between them by weight, and drop out - then the rate is recomputed for
// everyone still in, which is what lets the surplus reach the other specialists and
// the generalists together instead of only the generalists.
export function assignGames(
  games: AssignableGame[],
  roster: { name: string; platform?: string | null; weight?: number | null }[],
): Map<number, string> {
  const evaluators = roster
    .map(e => ({
      name: String(e.name ?? '').trim(),
      platform: String(e.platform ?? 'all').trim().toLowerCase() || 'all',
      weight: Number(e.weight) || 100,
    }))
    .filter(e => e.name)
  if (evaluators.length === 0) throw new Error('evaluator list empty')

  // Games by the platform tag a specialist has to match. A game with no platform
  // lands under '', which no specialist claims, so only generalists can take it.
  const pools = new Map<string, AssignableGame[]>()
  for (const g of games) {
    const k = (g.os || '').trim().toLowerCase()
    const list = pools.get(k)
    if (list) list.push(g); else pools.set(k, [g])
  }
  const supply = new Map<string, number>()
  for (const [k, v] of Array.from(pools)) supply.set(k, v.length)
  // A specialist whose platform brought nothing still has a pool - an empty one -
  // or it would never be found over-subscribed and would sit in the split holding a
  // share it can never take.
  for (const e of evaluators) if (e.platform !== 'all' && !supply.has(e.platform)) supply.set(e.platform, 0)

  const quota = new Map<string, number>()
  let active = evaluators.slice()
  let left = games.length
  for (;;) {
    const totalWeight = active.reduce((s, e) => s + e.weight, 0)
    if (totalWeight <= 0 || left <= 0) break
    const rate = left / totalWeight // games per unit of weight, if nothing were scarce

    // The pool whose own specialists are owed the most beyond what it holds. They
    // have nowhere else to draw from, so it is settled first and the rest re-rated.
    let worst: string | null = null
    let gap = 1e-9
    for (const [p, n] of Array.from(supply)) {
      const sw = active.reduce((s, e) => (e.platform === p ? s + e.weight : s), 0)
      if (sw <= 0) continue
      const over = rate * sw - n
      if (over > gap) { gap = over; worst = p }
    }

    if (!worst) {
      // Nothing is scarce: one rate serves everyone still in.
      for (const e of active) quota.set(e.name, rate * e.weight)
      break
    }

    const held = supply.get(worst) ?? 0
    const spec = active.filter(e => e.platform === worst)
    const sw = spec.reduce((s, e) => s + e.weight, 0)
    for (const e of spec) quota.set(e.name, (held * e.weight) / sw)
    active = active.filter(e => e.platform !== worst)
    supply.set(worst, 0)
    left -= held
  }

  // Real shares to whole games. splitByWeight IS largest-remainder rounding when the
  // total it is given is the sum it is splitting, and it is already covered by tests.
  const want = evaluators.map(e => quota.get(e.name) ?? 0)
  const counts = splitByWeight(want, Math.round(want.reduce((a, b) => a + b, 0)))

  const assignment = new Map<number, string>()
  const rest = new Map<string, AssignableGame[]>()
  for (const [k, v] of Array.from(pools)) rest.set(k, v.slice())
  // Specialists draw from their own pool; by construction it holds enough.
  evaluators.forEach((e, i) => {
    if (e.platform === 'all') return
    for (const g of (rest.get(e.platform) ?? []).splice(0, counts[i])) assignment.set(g.id, e.name)
  })
  // Generalists take what is left, oldest first, whatever platform it is.
  const leftovers = games.filter(g => !assignment.has(g.id))
  let k = 0
  evaluators.forEach((e, i) => {
    if (e.platform !== 'all') return
    for (let j = 0; j < counts[i] && k < leftovers.length; j++) assignment.set(leftovers[k++].id, e.name)
  })

  return assignment
}
