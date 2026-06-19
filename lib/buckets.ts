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
