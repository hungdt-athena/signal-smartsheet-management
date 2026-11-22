// lib/eval-pairs.ts — SQL helpers for linked store rows (migration 054).
// Spec: docs/superpowers/specs/2026-11-21-unified-game-playtest-design.md (6.1, 6.3)
//
// Pure: no DB import at runtime (the postgres import is type-only). Each helper takes the
// tag `q` (the caller passes `sql`) and returns a fragment, so it can be unit-tested with
// a fake tag. Aliases are emitted as identifiers via `q(alias)`, never interpolated raw.
import type { Sql } from 'postgres'

/** Conclusions that belong to one store only and are never copied to the twin row. */
export const STORE_SPECIFIC = ['Link_dead', 'Stale_release'] as const

export interface PairStore {
  os: 'ios' | 'android'
  game_id: string
  eval_id: number
  app_link: string | null
  is_active: boolean
  dead: boolean
}

/** List queries: drop every "back" row so each linked pair shows once.
 *  Emits a leading `AND`, so it goes after an existing WHERE condition. */
export function listRowFilter(q: Sql, alias = 'ge') {
  return q`AND NOT ${q(alias)}.pair_back`
}

/**
 * Work-count queries: drop the back row only when it is a copy. Emits a leading `AND`. A back row that is
 * Link_dead / Stale_release is real work of the person who marked it, so it still counts.
 */
export function notPairCopy(q: Sql, alias = 'ge') {
  return q`AND NOT (${q(alias)}.pair_back
    AND ${q(alias)}.initial_conclusion IS DISTINCT FROM 'Link_dead'
    AND ${q(alias)}.initial_conclusion IS DISTINCT FROM 'Stale_release')`
}

/**
 * Media queries (Record slots, recordings, uploads): drop EVERY back row. Emits a leading `AND`.
 * The media columns (recorders, Confirm, videos) are copied onto the back row even when it holds
 * Link_dead / Stale_release, so notPairCopy would count one recording twice. Use notPairCopy for
 * evaluation work and this for recording work.
 */
export function mediaRowFilter(q: Sql, alias = 'ge') {
  return q`AND NOT ${q(alias)}.pair_back`
}

/**
 * SELECT expression for a `stores` column: json array of PairStore, the row's own store
 * plus the twin's (via pair_eval_id), iOS first. Self-contained scalar subquery, so the
 * caller needs no extra JOIN and no extra round-trip.
 */
export function storesSelect(q: Sql, alias = 'ge', giAlias = 'gi') {
  return q`(
    SELECT COALESCE(json_agg(s.j ORDER BY s.ord, s.src), '[]'::json)
    FROM (
      SELECT 0 AS src,
             CASE WHEN ${q(giAlias)}.os = 'ios' THEN 0 ELSE 1 END AS ord,
             json_build_object(
               'os', ${q(giAlias)}.os,
               'game_id', ${q(alias)}.game_id,
               'eval_id', ${q(alias)}.id,
               'app_link', ${q(giAlias)}.app_link,
               'is_active', COALESCE(${q(giAlias)}.is_active, true),
               'dead', ${q(alias)}.initial_conclusion IS NOT DISTINCT FROM 'Link_dead'
             ) AS j
      UNION ALL
      SELECT 1,
             CASE WHEN tg.os = 'ios' THEN 0 ELSE 1 END,
             json_build_object(
               'os', tg.os,
               'game_id', t.game_id,
               'eval_id', t.id,
               'app_link', tg.app_link,
               'is_active', COALESCE(tg.is_active, true),
               'dead', t.initial_conclusion IS NOT DISTINCT FROM 'Link_dead'
             )
      FROM game_evaluations t
      JOIN game_info tg ON tg.game_id = t.game_id
      WHERE t.id = ${q(alias)}.pair_eval_id
    ) s
  )`
}

/**
 * SELECT expression for the `os` of an assign candidate: 'pair' for a linked pair whose
 * two stores are both live, so any evaluator can take it and it counts as one game; else
 * the row's own store. A pair where either row holds Link_dead / Stale_release is a
 * one-store game for the live store: the twin keeps its own state and does not follow
 * the assignment, so the specialist rule applies to the live store's os.
 * Use it with listRowFilter: candidates are front rows only.
 */
export function assignOs(q: Sql, alias = 'ge', giAlias = 'gi') {
  return q`CASE WHEN ${q(alias)}.pair_eval_id IS NOT NULL
      AND ${q(alias)}.initial_conclusion IS DISTINCT FROM 'Link_dead'
      AND ${q(alias)}.initial_conclusion IS DISTINCT FROM 'Stale_release'
      AND NOT EXISTS (
        SELECT 1 FROM game_evaluations t
        WHERE t.id = ${q(alias)}.pair_eval_id
          AND t.initial_conclusion IN ('Link_dead', 'Stale_release')
      )
    THEN 'pair' ELSE ${q(giAlias)}.os END`
}

/** iOS first, then Android; stable for equal os. */
export function sortStores(s: PairStore[]): PairStore[] {
  const rank = (x: PairStore) => (x.os === 'ios' ? 0 : 1)
  return [...s].sort((a, b) => rank(a) - rank(b))
}
