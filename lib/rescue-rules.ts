// lib/rescue-rules.ts — the rules behind a stale-backlog rescue, as pure functions.
//
// PURE module: no DB import, so the rules are unit-testable and safe to reason about on
// their own. The queries that feed them live in lib/rescue-core.ts.
//
// Role rules (knobs documented in lib/rescue-config.ts):
//   SOURCE   pending >= sourceMinBacklog AND movable > 0
//   RECEIVER stale <= receiverMaxStale AND evaluatedRecent > 0 AND available
//   NEUTRAL  everyone else — untouched by the run, with the failing reason shown.
// A source needs movable > 0 (hence stale > 0) and a receiver needs
// stale <= receiverMaxStale, so on the default config (0) the two sets cannot overlap.
// SOURCE is still resolved first, which decides the case where someone raises
// receiverMaxStale above zero: clearing a big backlog outranks helping with someone
// else's.

import type { RescueConfig } from '@/lib/rescue-config'

export type RescueRole = 'source' | 'receiver' | 'neutral'

// Per-evaluator numbers, as produced by scanRoster().
export interface RescueStats {
  name: string
  platform: string | null // evaluator_roster.game_platform
  weight: number | null
  available: boolean
  pending: number // pending games held right now (initial_conclusion IS NULL)
  stale: number // of those, past staleDays with this holder — cool-down INCLUDED,
  //                because a game in cool-down still sits on their shelf
  movable: number // stale MINUS games still inside their cool-down window
  evaluatedRecent: number // games concluded within activeDays
}

export interface RescueRow extends RescueStats {
  role: RescueRole
  pull: number // games this source would give up (0 unless role === 'source')
  reason: string // why this role — shown verbatim in the panel
}

// Assign each roster member a role plus the human-readable reason behind it.
export function classifyRoster(stats: RescueStats[], cfg: RescueConfig): RescueRow[] {
  return stats.map(s => {
    // SOURCE first: deep enough in backlog, with genuinely movable stale games.
    if (s.pending >= cfg.sourceMinBacklog && s.movable > 0) {
      const cooling = s.stale - s.movable
      const note = cooling > 0 ? `, ${cooling} in cool-down` : ''
      return { ...s, role: 'source', pull: s.movable, reason: `${s.pending} pending, ${s.stale} stale${note}` }
    }
    // Then the receiver gate. Every condition must hold, and the FIRST failure is the
    // reason shown, so the panel always explains its own verdict.
    if (s.stale > cfg.receiverMaxStale) {
      const limit = cfg.receiverMaxStale === 0 ? 'own shelf not clean' : `over the ${cfg.receiverMaxStale} stale allowance`
      return { ...s, role: 'neutral', pull: 0, reason: `${s.stale} stale of their own — ${limit}` }
    }
    if (s.evaluatedRecent <= 0) {
      return { ...s, role: 'neutral', pull: 0, reason: `nothing concluded in ${cfg.activeDays}d — low backlog is not speed` }
    }
    if (!s.available) {
      return { ...s, role: 'neutral', pull: 0, reason: 'marked away in the roster' }
    }
    return { ...s, role: 'receiver', pull: 0, reason: `${s.pending} pending, ${s.evaluatedRecent} done in ${cfg.activeDays}d` }
  })
}

export interface Receiver {
  name: string
  platform: string | null
  weight: number | null
  pending: number
}

// Water-filling: hand out `total` games one at a time to whoever currently has the
// lowest weight-adjusted backlog. This levels the team's shelves rather than splitting
// by weight alone — the point of a rescue is that the load ends up even, so someone
// already holding 20 games should not receive as much as someone holding 2. Weight
// still matters: it divides the projected backlog, so a 50-weight evaluator settles at
// half the depth of a 100-weight one.
//
// Returns quotas keyed by name, with zero-quota receivers omitted: assignGames() reads
// a 0 weight as "unset" and restores it to 100, which would undo the levelling.
export function waterfillQuotas(receivers: Receiver[], total: number): Record<string, number> {
  const pool = receivers
    .filter(r => r.name && r.name.trim())
    .map(r => ({
      name: r.name.trim(),
      // Roster weight is 30/50/70/100; 0 or blank means "unset", not "no capacity".
      w: (Number(r.weight) > 0 ? Number(r.weight) : 100) / 100,
      projected: Math.max(0, Number(r.pending) || 0),
      got: 0,
    }))
  if (pool.length === 0 || total <= 0) return {}

  for (let i = 0; i < total; i++) {
    let best = pool[0]
    // Strict < keeps ties on the earlier roster position, matching the display order.
    for (const p of pool) if (p.projected / p.w < best.projected / best.w) best = p
    best.projected += 1
    best.got += 1
  }

  const out: Record<string, number> = {}
  for (const p of pool) if (p.got > 0) out[p.name] = p.got
  return out
}
