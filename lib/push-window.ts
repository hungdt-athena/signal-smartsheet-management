// lib/push-window.ts — how far back the push step looks for new games, per genre.
//
// PURE module: no DB import, same reason as genre-config.ts — the Config page
// and the Assign panel both pull it into the client bundle. Persistence lives
// in push-window-db.ts.
//
// WHAT THE WINDOW MEASURES. A game is in the window when its RELEASE DATE
// (initial_release, else temp_release) falls inside it. Only when the store
// gave us no release date at all does the window fall back to created_date —
// the day a scraper first saw the game.
//
// That fallback is narrow on purpose. Admitting anything merely *crawled*
// recently is what put 2,876 games in the queue on 2026-08-19, when the apkcombo
// scraper reached a publisher's back catalogue: those games were years old, and
// only their created_date was new. So the rule is "released recently, or new to
// us and undated" — never "crawled recently".
//
// Per genre, because the genres do not move at the same speed: puzzle gets
// hundreds of new releases a month and a short window keeps the queue
// reviewable, while simulation may need a month to find the same volume.

import { BUCKETS, type Bucket } from '@/lib/buckets'

export const PUSH_WINDOW_KEY = 'push_window_config'

/** The only windows offered. A free-text number invites 1 and 365. */
export const PUSH_WINDOWS = [3, 7, 14, 30] as const
export type PushWindow = (typeof PUSH_WINDOWS)[number]

export function isPushWindow(v: unknown): v is PushWindow {
  return typeof v === 'number' && (PUSH_WINDOWS as readonly number[]).includes(v)
}

export type PushWindowConfig = Record<Bucket, PushWindow>

/** 30 days everywhere — what every genre used before this was configurable, so
 *  turning the feature on changes nothing until somebody chooses. */
export const DEFAULT_PUSH_WINDOW: PushWindow = 30
export const DEFAULT_PUSH_WINDOW_CONFIG: PushWindowConfig =
  Object.fromEntries(BUCKETS.map(b => [b, DEFAULT_PUSH_WINDOW])) as PushWindowConfig

/** Tolerant parse: a hand-edited or older blob must never stop the daily run. */
export function parsePushWindowConfig(raw: string | null | undefined): PushWindowConfig {
  const cfg = { ...DEFAULT_PUSH_WINDOW_CONFIG }
  if (!raw) return cfg
  try {
    const o = JSON.parse(raw) as Partial<Record<string, unknown>>
    for (const b of BUCKETS) {
      const v = o[b]
      // A number that is not on the list is ignored rather than clamped: a
      // stored 45 means somebody edited the blob by hand, and guessing at 30 or
      // 14 on their behalf would be silent either way. The default is loud in
      // the UI, which is where it gets noticed.
      if (isPushWindow(v)) cfg[b] = v
    }
    return cfg
  } catch {
    return cfg
  }
}

export function pushWindowFor(cfg: PushWindowConfig, bucket: Bucket): PushWindow {
  return cfg[bucket] ?? DEFAULT_PUSH_WINDOW
}

/** One sentence for the UI, so the rule is never only in this file's comments. */
export const PUSH_WINDOW_NOTE =
  'Counted from the release date. A game with no release date from the store falls back to the day we first saw it.'
