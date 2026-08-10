import { classifyRoster, waterfillQuotas, type RescueStats } from '@/lib/rescue-rules'
import { clampRescueConfig, DEFAULT_RESCUE_CONFIG, parseRescueConfig } from '@/lib/rescue-config'

// Shorthand for a roster row; every field defaults to "holds nothing, does nothing".
function stat(name: string, o: Partial<RescueStats> = {}): RescueStats {
  return {
    name, platform: null, weight: 100, available: true,
    pending: 0, stale: 0, movable: 0, evaluatedRecent: 0, ...o,
  }
}

const cfg = DEFAULT_RESCUE_CONFIG // stale 14 / cooldown 14 / minBacklog 15 / maxStale 0 / active 14

describe('lib/rescue-rules classifyRoster', () => {
  it('marks a deep backlog with movable stale games as SOURCE and pulls all of them', () => {
    const [r] = classifyRoster([stat('Hung', { pending: 32, stale: 21, movable: 21, evaluatedRecent: 6 })], cfg)
    expect(r.role).toBe('source')
    expect(r.pull).toBe(21)
  })

  it('pulls only what is outside the cool-down, and says how much is held back', () => {
    const [r] = classifyRoster([stat('Lan', { pending: 18, stale: 11, movable: 4, evaluatedRecent: 9 })], cfg)
    expect(r.role).toBe('source')
    expect(r.pull).toBe(4)
    expect(r.reason).toContain('7 in cool-down')
  })

  it('leaves a small backlog alone even when some of it is stale', () => {
    const [r] = classifyRoster([stat('Khoa', { pending: 7, stale: 2, movable: 2, evaluatedRecent: 11 })], cfg)
    expect(r.role).toBe('neutral')
    expect(r.pull).toBe(0)
  })

  it('accepts a clean, active, available evaluator as RECEIVER', () => {
    const [r] = classifyRoster([stat('Minh', { pending: 9, evaluatedRecent: 14 })], cfg)
    expect(r.role).toBe('receiver')
    expect(r.pull).toBe(0)
  })

  it('rejects a receiver whose own shelf still has stale games', () => {
    const [r] = classifyRoster([stat('Khoa', { pending: 7, stale: 2, movable: 2, evaluatedRecent: 11 })], cfg)
    expect(r.reason).toContain('own shelf not clean')
  })

  it('rejects a receiver with a low backlog but no recent output', () => {
    const [r] = classifyRoster([stat('Tu', { pending: 4, evaluatedRecent: 0 })], cfg)
    expect(r.role).toBe('neutral')
    expect(r.reason).toContain('nothing concluded in 14d')
  })

  it('rejects a receiver marked away', () => {
    const [r] = classifyRoster([stat('Vy', { pending: 3, evaluatedRecent: 12, available: false })], cfg)
    expect(r.role).toBe('neutral')
    expect(r.reason).toBe('marked away in the roster')
  })

  it('never lets one person be both source and receiver', () => {
    // receiverMaxStale raised above 0, so the gates could otherwise both pass.
    const loose = { ...cfg, receiverMaxStale: 5 }
    const [r] = classifyRoster([stat('Hung', { pending: 20, stale: 3, movable: 3, evaluatedRecent: 8 })], loose)
    expect(r.role).toBe('source')
  })

  it('a source with everything in cool-down drops out of the run entirely', () => {
    const [r] = classifyRoster([stat('Hung', { pending: 30, stale: 12, movable: 0, evaluatedRecent: 5 })], cfg)
    expect(r.role).toBe('neutral')
    expect(r.reason).toContain('own shelf not clean')
  })
})

describe('lib/rescue-rules waterfillQuotas', () => {
  const R = (name: string, pending: number, weight: number | null = 100) => ({ name, platform: null, weight, pending })

  it('levels the shelves instead of splitting evenly', () => {
    // 2 and 8 pending, 6 games: the lighter shelf fills to 8 first, then they share.
    expect(waterfillQuotas([R('A', 2), R('B', 8)], 6)).toEqual({ A: 6 })
    expect(waterfillQuotas([R('A', 2), R('B', 8)], 8)).toEqual({ A: 7, B: 1 })
  })

  it('splits evenly when the shelves already match', () => {
    expect(waterfillQuotas([R('A', 5), R('B', 5), R('C', 5)], 6)).toEqual({ A: 2, B: 2, C: 2 })
  })

  it('lets weight set the depth each receiver settles at', () => {
    // A at weight 100 and B at 50 both start empty: A should end up about twice as deep.
    const q = waterfillQuotas([R('A', 0, 100), R('B', 0, 50)], 9)
    expect(q.A).toBe(6)
    expect(q.B).toBe(3)
  })

  it('treats a blank or zero weight as unset (100), not as no capacity', () => {
    expect(waterfillQuotas([R('A', 0, 0), R('B', 0, null)], 4)).toEqual({ A: 2, B: 2 })
  })

  it('omits zero-quota receivers so assignGames cannot revive them at weight 100', () => {
    const q = waterfillQuotas([R('A', 0), R('B', 50)], 3)
    expect(q).toEqual({ A: 3 })
    expect('B' in q).toBe(false)
  })

  it('always hands out exactly `total` games', () => {
    const q = waterfillQuotas([R('A', 3), R('B', 11), R('C', 7)], 25)
    expect(Object.values(q).reduce((a, b) => a + b, 0)).toBe(25)
  })

  it('returns nothing when there is no receiver or nothing to move', () => {
    expect(waterfillQuotas([], 10)).toEqual({})
    expect(waterfillQuotas([R('A', 0)], 0)).toEqual({})
  })
})

describe('lib/rescue-config', () => {
  it('clamps out-of-range and non-numeric knobs to safe values', () => {
    const c = clampRescueConfig({ staleDays: 0, cooldownDays: -5, sourceMinBacklog: 99999, activeDays: NaN })
    expect(c.staleDays).toBe(1)
    expect(c.cooldownDays).toBe(0)
    expect(c.sourceMinBacklog).toBe(1000)
    expect(c.activeDays).toBe(DEFAULT_RESCUE_CONFIG.activeDays)
  })

  it('falls back to defaults on a missing or malformed blob', () => {
    expect(parseRescueConfig(null)).toEqual(DEFAULT_RESCUE_CONFIG)
    expect(parseRescueConfig('{oops')).toEqual(DEFAULT_RESCUE_CONFIG)
    expect(parseRescueConfig('{"staleDays":10}').staleDays).toBe(10)
  })
})
