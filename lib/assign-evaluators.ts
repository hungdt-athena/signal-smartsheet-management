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
  let rem = total - base.reduce((a, b) => a + b, 0)
  const order = raw.map((_, i) => i).sort((a, b) => (raw[b] - base[b]) - (raw[a] - base[a]))
  for (let i = 0; i < rem; i++) base[order[i]]++
  return base
}

function gameMatchesPlatform(game: AssignableGame, platform: string): boolean {
  if (!platform || platform === 'all') return true
  return (game.os || '').toLowerCase() === platform
}

// Returns Map<gameId, evaluatorName>. Games may be left out when only
// platform-specific evaluators remain and no game matches their platform.
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

  const targets = splitByWeight(evaluators.map(e => e.weight), games.length)
  const assignment = new Map<number, string>()
  let remaining = [...games]

  // Phase 1: platform-specific evaluators take matching games up to target.
  evaluators.forEach((e, i) => {
    if (e.platform === 'all') return
    const take = remaining.filter(g => gameMatchesPlatform(g, e.platform)).slice(0, targets[i])
    for (const g of take) assignment.set(g.id, e.name)
    remaining = remaining.filter(g => !assignment.has(g.id))
  })

  // Phase 2: everything left is split among 'all' evaluators by weight.
  const alls = evaluators.filter(e => e.platform === 'all')
  if (alls.length > 0 && remaining.length > 0) {
    const share = splitByWeight(alls.map(e => e.weight), remaining.length)
    let k = 0
    alls.forEach((e, i) => {
      for (let j = 0; j < share[i]; j++) assignment.set(remaining[k++].id, e.name)
    })
  }

  return assignment
}
