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
