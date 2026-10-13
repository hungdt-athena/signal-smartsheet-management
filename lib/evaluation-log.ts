// lib/evaluation-log.ts — helpers for writing evaluation_log rows (migration 046).
// Spec: docs/superpowers/specs/2026-10-10-evaluation-time-log-design.md
//
// Pure: no DB import at runtime (the postgres import is type-only). The `kind` CASE is
// returned as a fragment of the tag the caller passes (the route passes `sql`), so it
// can be unit-tested with a fake tag.
import type { Sql } from 'postgres'

export const LOG_CONTEXTS = ['evaluate', 'shortlist', 'record', 'tagging'] as const
export type LogContext = (typeof LOG_CONTEXTS)[number]

export interface Timing {
  source: 'panel' | 'other'
  context: LogContext | null
  viewS: number | null
  hiddenS: number | null
  idleS: number | null
}

const MAX_VIEW_S = 86_400

function clampInt(v: unknown, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0
  return Math.min(max, Math.max(0, n))
}

/** A save carries timing only when the panel measured it (`view_s` is a number). */
export function readTiming(body: Record<string, unknown>): Timing {
  const v = body.view_s
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return { source: 'other', context: null, viewS: null, hiddenS: null, idleS: null }
  }
  const viewS = clampInt(v, MAX_VIEW_S)
  const context = (LOG_CONTEXTS as readonly string[]).includes(body.context as string)
    ? (body.context as LogContext)
    : null
  return {
    source: 'panel',
    context,
    viewS,
    hiddenS: clampInt(body.hidden_s, viewS),
    idleS: clampInt(body.idle_s, viewS),
  }
}

const INITIAL_FIELDS = ['initial_note', 'initial_note_parts', 'initial_conclusion', 'batch', 'game_alike', 'drive_link']
const FINAL_FIELDS = ['final_conclusion', 'final_note']

export interface TouchedFlags { initialTouched: boolean; finalTouched: boolean }

export function touchedFlags(body: Record<string, unknown>): TouchedFlags {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k)
  return { initialTouched: INITIAL_FIELDS.some(has), finalTouched: FINAL_FIELDS.some(has) }
}

/**
 * The log row's `kind`, read from the pre-update row (`old`) and the updated row (`upd`),
 * never from earlier log rows, so it is right with or without the seed. "Unjudged" is
 * `evaluate_date IS NULL`: Stale_release rows carry a conclusion but no date.
 */
export function logKindSql(q: Sql, f: TouchedFlags) {
  return q`CASE
    WHEN NOT ${f.initialTouched} AND ${f.finalTouched} THEN 'final'
    WHEN NOT ${f.initialTouched} THEN 'other'
    WHEN old.evaluate_date IS NULL
         AND upd.initial_conclusion IS NOT NULL
         AND upd.initial_conclusion <> 'Stale_release'
         AND old.initial_conclusion IS DISTINCT FROM upd.initial_conclusion THEN 'first'
    WHEN old.initial_conclusion IS NOT NULL AND upd.initial_conclusion IS NULL THEN 'clear'
    ELSE 'revise'
  END`
}

export const EVALUATION_LOG_MISSING = 'evaluation_log missing — apply migration 046'

export const DEMO_COLUMN_MISSING = 'evaluation_log.demo_added missing — apply migration 047'

/** Postgres 42703 (undefined_column) on demo_added: migration 047 was not applied. */
export function isMissingDemoColumn(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null
  return !!e && e.code === '42703' && /demo_added/.test(String(e.message ?? ''))
}

/** Postgres 42P01 (undefined_table) on evaluation_log: migration 046 was not applied. */
export function isMissingLogTable(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null
  return !!e && e.code === '42P01' && /evaluation_log/.test(String(e.message ?? ''))
}
