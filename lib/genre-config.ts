// lib/genre-config.ts — which genres the daily push/assign pipeline runs today.
//
// PURE module: no DB import. It is pulled into the client bundle by the Assign
// Setup toggles, so `lib/db` must stay out of here (same split as
// report-config.ts / report-config-db.ts). Persistence lives in genre-config-db.ts.
//
// Stored as one JSON blob in app_config under key 'genre_push_config' (no
// migration: app_config is an existing key/value table). A genre runs only when
// BOTH hold: the toggle is on AND at least one initial evaluator is available for
// it. The toggle alone is a promise, not a plan — assigning games to nobody just
// grows a backlog, which is the thing this gate exists to prevent.

import { BUCKETS, type Bucket } from '@/lib/buckets'

export const GENRE_CONFIG_KEY = 'genre_push_config'

export type GenreConfig = Record<Bucket, boolean>

// Puzzle is the genre the pipeline has always run; arcade and simulation start off
// so turning them on is a deliberate act with someone watching the queue.
export const DEFAULT_GENRE_CONFIG: GenreConfig = { puzzle: true, arcade: false, simulation: false }

export interface GenreTarget {
  bucket: Bucket
  enabled: boolean   // the toggle
  available: number  // initial evaluators marked available today
  active: boolean    // enabled && available > 0 — the only thing the cron reads
}

/** Tolerant parse: a hand-edited or older blob must never stop the daily run. */
export function parseGenreConfig(raw: string | null | undefined): GenreConfig {
  if (!raw) return { ...DEFAULT_GENRE_CONFIG }
  try {
    const o = JSON.parse(raw) as Partial<Record<string, unknown>>
    const cfg = { ...DEFAULT_GENRE_CONFIG }
    for (const b of BUCKETS) {
      if (b in o) cfg[b] = o[b] === true
    }
    return cfg
  } catch {
    return { ...DEFAULT_GENRE_CONFIG }
  }
}

/** Fixed genre order so the API, the cron log and the UI all read the same way. */
export function resolveGenreTargets(
  config: GenreConfig,
  availability: Partial<Record<Bucket, number>>,
): GenreTarget[] {
  return BUCKETS.map(bucket => {
    const enabled = config[bucket] === true
    const available = availability[bucket] ?? 0
    return { bucket, enabled, available, active: enabled && available > 0 }
  })
}
