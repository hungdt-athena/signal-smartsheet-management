import { mergeRosters } from '@/lib/rescue-merge'
import type { RescueStats } from '@/lib/rescue-rules'

const s = (name: string, o: Partial<RescueStats>): RescueStats => ({
  name, platform: null, weight: null, available: true,
  pending: 0, stale: 0, movable: 0, evaluatedRecent: 0, ...o,
})

describe('mergeRosters', () => {
  it('adds stale, staleAll, movable and pending across buckets, one row per person', () => {
    const out = mergeRosters([
      [s('A', { pending: 10, stale: 3, staleAll: 5, movable: 3 })],
      [s('A', { pending: 4, stale: 1, staleAll: 2, movable: 1 }), s('B', { pending: 2 })],
    ])
    expect(out).toHaveLength(2)
    expect(out.find(r => r.name === 'A')).toMatchObject({ pending: 14, stale: 4, staleAll: 7, movable: 4 })
  })

  it('treats a missing staleAll as stale', () => {
    const [a] = mergeRosters([[s('A', { stale: 3 })], [s('A', { stale: 2, staleAll: 6 })]])
    expect(a.staleAll).toBe(9)
  })
})
