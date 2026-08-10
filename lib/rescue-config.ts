// lib/rescue-config.ts — tunable thresholds for the stale-backlog Rescue panel.
//
// PURE module: no DB import. RescuePanel is a client component and imports the
// defaults + parser, so pulling `lib/db` in here would drag the postgres driver
// into the browser bundle (same trap documented in lib/report-config.ts).
// Persistence lives in lib/rescue-config-db.ts.
//
// Stored as one JSON blob in app_config under key 'rescue_config' (no migration:
// app_config is an existing key/value table).

export const RESCUE_CONFIG_KEY = 'rescue_config'

export interface RescueConfig {
  // A pending game is STALE once it has sat this many days with its current holder
  // (today - assigned_date > staleDays). Deliberately measured against assigned_date,
  // not first_assigned_date: whoever receives a game gets a fresh clock, so a rescue
  // recipient is never punished for age they did not cause.
  staleDays: number
  // A game moved by any reassign/handover/rescue within this many days is skipped, so
  // the same game cannot be kicked around the team run after run.
  cooldownDays: number
  // Only pull from evaluators holding at least this many pending games. Someone with a
  // couple of late games is left alone to clear them.
  sourceMinBacklog: number
  // A receiver may hold at most this many stale games of their own. 0 = "your own shelf
  // must be clean before you take on someone else's debt".
  receiverMaxStale: number
  // A receiver must have concluded at least one game within this window, so a low
  // backlog caused by leave or inactivity is not mistaken for speed.
  activeDays: number
}

// staleDays defaults to 14, not 7, from measuring the live puzzle backlog: at 7 days the
// pool was 1597 games with only 3 people passing the receiver gate, and at 3 days it was
// 2300 games with ONE. Tightening the threshold cuts both ways — it enlarges the pool and
// simultaneously disqualifies receivers, because almost everyone then holds something
// stale. At 14 days the pool halved and two evaluators flipped from source to receiver.
// (Nothing in that backlog was older than 30 days, so values above ~21 select nothing.)
export const DEFAULT_RESCUE_CONFIG: RescueConfig = {
  staleDays: 14,
  cooldownDays: 14,
  sourceMinBacklog: 15,
  receiverMaxStale: 0,
  activeDays: 14,
}

// Bounds keep a hand-edited blob (or a fat-fingered input) from producing a scan that
// either moves nothing or moves everything.
const LIMITS: Record<keyof RescueConfig, { min: number; max: number }> = {
  staleDays: { min: 1, max: 365 },
  cooldownDays: { min: 0, max: 365 },
  sourceMinBacklog: { min: 1, max: 1000 },
  receiverMaxStale: { min: 0, max: 100 },
  activeDays: { min: 1, max: 365 },
}

export function clampRescueConfig(o: Partial<RescueConfig> | null | undefined): RescueConfig {
  const out = { ...DEFAULT_RESCUE_CONFIG }
  for (const k of Object.keys(LIMITS) as (keyof RescueConfig)[]) {
    const v = Number(o?.[k])
    if (Number.isFinite(v)) out[k] = Math.min(LIMITS[k].max, Math.max(LIMITS[k].min, Math.floor(v)))
  }
  return out
}

// Tolerant parse: a malformed blob must never break the panel.
export function parseRescueConfig(raw: string | null | undefined): RescueConfig {
  if (!raw) return DEFAULT_RESCUE_CONFIG
  try {
    return clampRescueConfig(JSON.parse(raw) as Partial<RescueConfig>)
  } catch {
    return DEFAULT_RESCUE_CONFIG
  }
}
