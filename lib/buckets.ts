// lib/buckets.ts — shared bucket / weight / category helpers for Config + Assign Setup.

export const BUCKETS = ['puzzle', 'arcade', 'simulation'] as const
export type Bucket = (typeof BUCKETS)[number]
export function isBucket(v: unknown): v is Bucket {
  return typeof v === 'string' && (BUCKETS as readonly string[]).includes(v)
}

export const WEIGHTS = [30, 50, 70, 100] as const
export type Weight = (typeof WEIGHTS)[number]
export function isWeight(v: unknown): v is Weight {
  return typeof v === 'number' && (WEIGHTS as readonly number[]).includes(v)
}

/**
 * Display label for a conclusion value. 'List_Idea' is a logic-critical stored
 * value (drives batch bucketing), so it stays underscored everywhere in code/DB
 * but reads as "List Idea" in the UI.
 */
export function prettyConclusion(v: string | null | undefined): string {
  if (!v) return '—'
  return v === 'List_Idea' ? 'List Idea' : v
}

/** Normalize a category multi-select value to storage form: 'All' or 'a,b,c'. */
export function normalizeCategory(v: unknown): string {
  const parts = Array.isArray(v)
    ? v
    : typeof v === 'string'
      ? v.split(',')
      : []
  const clean = parts.map(p => String(p).trim()).filter(Boolean)
  if (clean.length === 0) return 'All'
  if (clean.length === 1 && clean[0].toLowerCase() === 'all') return 'All'
  return clean.filter(p => p.toLowerCase() !== 'all').join(',')
}
