import type { Sql } from 'postgres'
import { STORE_SPECIFIC, listRowFilter, notPairCopy, storesSelect, sortStores, assignOs, PairStore } from '@/lib/eval-pairs'

// Fake tag: q`...` joins strings, q('alias') acts as the identifier helper.
const q = ((strings: unknown, ...vals: unknown[]) => {
  if (typeof strings === 'string') return strings
  const s = strings as TemplateStringsArray
  return s.reduce((acc, part, i) => acc + part + (i < vals.length ? String(vals[i]) : ''), '')
}) as unknown as Sql

const st = (os: 'ios' | 'android'): PairStore => ({
  os, game_id: os, eval_id: 1, app_link: null, is_active: true, dead: false,
})

describe('eval-pairs', () => {
  it('STORE_SPECIFIC lists both store-only conclusions', () => {
    expect([...STORE_SPECIFIC]).toEqual(['Link_dead', 'Stale_release'])
  })
  it('listRowFilter drops back rows, default alias ge', () => {
    expect(String(listRowFilter(q))).toContain('NOT ge.pair_back')
    expect(String(listRowFilter(q, 'x'))).toContain('NOT x.pair_back')
  })
  it('notPairCopy keeps back rows that are store-specific', () => {
    const s = String(notPairCopy(q, 'x'))
    expect(s).toContain('x.pair_back')
    expect(s).toContain('Link_dead')
    expect(s).toContain('Stale_release')
  })
  it('storesSelect reads the twin through pair_eval_id', () => {
    const s = String(storesSelect(q, 'a', 'g'))
    expect(s).toContain('a.pair_eval_id')
    expect(s).toContain('g.os')
  })
  it('assignOs is pair only for a linked row with no store-only result on either side', () => {
    const s = String(assignOs(q, 'a', 'g'))
    expect(s).toContain("'pair'")
    expect(s).toContain('a.pair_eval_id IS NOT NULL')
    expect(s).toContain('a.initial_conclusion')
    // the twin is read through pair_eval_id; a dead twin makes it a one-store game
    expect(s).toMatch(/t\.id = a\.pair_eval_id/)
    expect(s).toContain('Link_dead')
    expect(s).toContain('Stale_release')
    expect(s).toContain('ELSE g.os')
  })
  it('sortStores puts ios first without mutating', () => {
    const input = [st('android'), st('ios')]
    expect(sortStores(input).map((x) => x.os)).toEqual(['ios', 'android'])
    expect(input[0].os).toBe('android')
  })
})
