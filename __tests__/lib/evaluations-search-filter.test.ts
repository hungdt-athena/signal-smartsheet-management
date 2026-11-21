/**
 * @jest-environment node
 */
jest.mock('@/lib/db', () => ({ sql: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })) }))

import { searchFilter } from '@/lib/evaluations-filters'

// The search predicate has to stay reachable by game_info's trigram indexes
// (idx_game_info_title_trgm, idx_game_info_game_id_trgm, made by Signal Sense on prod).
// Postgres turns an OR into a BitmapOr of those indexes only when EVERY branch of the OR is
// an ILIKE on a game_info column. A branch on game_evaluations (the twin game id of a linked
// pair, migration 054) in the same OR made the planner scan all of game_info instead:
// measured on the sample DB with the prod indexes added, 2-13 ms became 42-64 ms, and on
// prod (625k games) the scan form was measured at 1275 ms against 209 ms in 2026-09.
describe('searchFilter', () => {
  const text = (term: string) => {
    const f = searchFilter(term) as unknown as { strings: string[] }
    return f.strings.join('?')
  }

  it('is empty without a term', () => {
    expect(text('')).toBe('')
  })

  it('narrows by row id, each match source an ILIKE on game_info only', () => {
    const t = text('Carnival Sort')
    expect(t).toMatch(/^AND ge\.id IN \(/)
    // own game: title or store id, through game_info (both trigram-indexed)
    expect(t).toContain('g.title ILIKE ?')
    expect(t).toContain('g.game_id ILIKE ?')
    // twin game: its store id through game_info, mapped back to the front row by pair_eval_id
    expect(t).toContain('pair_eval_id')
    // never an ILIKE on a game_evaluations column, and no OR mixing tables
    expect(t).not.toMatch(/\b(ge|pe|e)\.game_id ILIKE/)
    expect(t).not.toContain('OR EXISTS')
  })

  it('the twin branch matches the back store\'s title too, not only its id', () => {
    const t = text('Carnival Sort')
    const twin = t.slice(t.indexOf('UNION ALL'))
    expect(twin).toContain('pe.pair_eval_id')
    expect(twin).toMatch(/\(g\.title ILIKE \? OR g\.game_id ILIKE \?\) AND pe\.pair_eval_id IS NOT NULL/)
  })

  it('escapes LIKE metacharacters in every bound pattern', () => {
    const f = searchFilter('100%_a') as unknown as { values: unknown[] }
    expect(f.values.length).toBeGreaterThanOrEqual(3)
    for (const v of f.values) expect(v).toBe('%100\\%\\_a%')
  })
})
