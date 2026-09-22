/**
 * @jest-environment node
 */
import { splitByWeight, assignGames } from '@/lib/assign-evaluators'

describe('splitByWeight', () => {
  it('splits total proportionally and sums exactly to total', () => {
    expect(splitByWeight([100, 100], 10)).toEqual([5, 5])
    const r = splitByWeight([100, 50, 50], 10)
    expect(r.reduce((a, b) => a + b, 0)).toBe(10)
    expect(r).toEqual([5, 3, 2]) // largest remainder
  })
  it('returns zeros for zero total or zero weights', () => {
    expect(splitByWeight([100, 100], 0)).toEqual([0, 0])
    expect(splitByWeight([0, 0], 5)).toEqual([0, 0])
  })
})

describe('assignGames', () => {
  const g = (id: number, os: string | null) => ({ id, os })

  it('splits evenly between two equal-weight "all" evaluators', () => {
    const games = [g(1, 'ios'), g(2, 'android'), g(3, 'ios'), g(4, 'android')]
    const evals = [
      { name: 'A', platform: 'all', weight: 100 },
      { name: 'B', platform: 'all', weight: 100 },
    ]
    const m = assignGames(games, evals)
    expect(m.size).toBe(4)
    const counts = Array.from(m.values()).reduce((acc: Record<string, number>, n) => {
      acc[n] = (acc[n] || 0) + 1; return acc
    }, {})
    expect(counts).toEqual({ A: 2, B: 2 })
  })

  it('gives platform-specific evaluators only matching-platform games', () => {
    const games = [g(1, 'ios'), g(2, 'android'), g(3, 'ios'), g(4, 'ios')]
    const evals = [
      { name: 'IOS', platform: 'ios', weight: 100 },
      { name: 'ALL', platform: 'all', weight: 300 },
    ]
    const m = assignGames(games, evals)
    expect(m.size).toBe(4)
    for (const [id, name] of Array.from(m.entries())) {
      if (name === 'IOS') expect(games.find(x => x.id === id)!.os).toBe('ios')
    }
    // IOS target = round(4 * 100/400) = 1
    expect(Array.from(m.values()).filter(n => n === 'IOS').length).toBe(1)
  })

  it('leaves games unassigned when no "all" evaluator can take the rest', () => {
    const games = [g(1, 'android'), g(2, 'android')]
    const evals = [{ name: 'IOS', platform: 'ios', weight: 100 }]
    const m = assignGames(games, evals)
    expect(m.size).toBe(0)
  })

  // ---- the starvation bug, found in production on 2026-09-22 ----
  // 814 puzzle games went out to 11 people and QuangVN got ZERO, while holding the
  // smallest backlog on the team. The old algorithm walked the platform-specific
  // evaluators in roster order and let each take its FULL target off the top, so when
  // a platform pool was smaller than what its specialists were collectively owed, the
  // shortfall did not get shared - it landed entirely on whoever came last.

  const counts = (m: Map<number, string>) => Array.from(m.values())
    .reduce((acc: Record<string, number>, n) => { acc[n] = (acc[n] || 0) + 1; return acc }, {})

  it('shares a short platform pool between its specialists instead of starving the last one', () => {
    // 2 ios games, two ios-only evaluators of equal weight, one generalist.
    // Taking targets off the top gave A both ios games and B nothing.
    const games = [g(1, 'ios'), g(2, 'ios'), g(3, 'android'), g(4, 'android')]
    const evals = [
      { name: 'A', platform: 'ios', weight: 100 },
      { name: 'B', platform: 'ios', weight: 100 },
      { name: 'C', platform: 'all', weight: 100 },
    ]
    expect(counts(assignGames(games, evals))).toEqual({ A: 1, B: 1, C: 2 })
  })

  it('recomputes everyone else\'s share once a platform pool is used up', () => {
    // The production roster, to the game: 268 ios + 546 android, four ios-only people
    // who between them are owed 362, and the 94-game shortfall spread evenly instead
    // of falling on one head. What is left over is then shared by the android
    // specialist and the generalists at the SAME rate per unit of weight - the old
    // version handed the surplus to the generalists alone (117 against 90).
    const games = [
      ...Array.from({ length: 268 }, (_, i) => g(i + 1, 'ios')),
      ...Array.from({ length: 546 }, (_, i) => g(i + 1000, 'android')),
    ]
    const evals = [
      { name: 'NhiLV', platform: 'all', weight: 50 },
      { name: 'MyTL', platform: 'all', weight: 100 },
      { name: 'MiTT', platform: 'all', weight: 50 },
      { name: 'HuyDD', platform: 'all', weight: 50 },
      { name: 'KietCD', platform: 'android', weight: 50 },
      { name: 'ThuDT', platform: 'all', weight: 100 },
      { name: 'DuyenLP', platform: 'ios', weight: 100 },
      { name: 'MinhLQ1', platform: 'android', weight: 100 },
      { name: 'NhanTT', platform: 'ios', weight: 100 },
      { name: 'PhuongNT1', platform: 'ios', weight: 100 },
      { name: 'QuangVN', platform: 'ios', weight: 100 },
    ]
    const c = counts(assignGames(games, evals))
    // the four ios-only people split the 268 ios games evenly - nobody at zero
    expect([c.DuyenLP, c.NhanTT, c.PhuongNT1, c.QuangVN]).toEqual([67, 67, 67, 67])
    // and the android specialist is served at the same rate as a generalist of equal weight
    expect(c.MinhLQ1).toBe(c.MyTL)
    expect(c.MinhLQ1).toBe(109)
    expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(814)
  })

  it('gives a specialist nothing when its platform brought no games, without hanging', () => {
    const games = [g(1, 'android'), g(2, 'android'), g(3, 'android')]
    const evals = [
      { name: 'IOS', platform: 'ios', weight: 100 },
      { name: 'ALL', platform: 'all', weight: 100 },
    ]
    // The ios evaluator cannot be served at all, so the whole pile goes to ALL
    // rather than half of it being reserved for someone who can never take it.
    expect(counts(assignGames(games, evals))).toEqual({ ALL: 3 })
  })

  it('throws on empty evaluator list', () => {
    expect(() => assignGames([g(1, 'ios')], [])).toThrow('evaluator list empty')
  })

  it('returns empty map when games list is empty (no throw)', () => {
    const m = assignGames([], [{ name: 'A', platform: 'all', weight: 100 }])
    expect(m.size).toBe(0)
  })

  it('treats unknown/blank platform and weight as all/100', () => {
    const games = [g(1, null), g(2, 'ios')]
    const evals = [{ name: 'A', platform: '', weight: 0 }]
    const m = assignGames(games, evals)
    expect(m.size).toBe(2)
  })
})
