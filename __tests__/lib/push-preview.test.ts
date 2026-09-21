import {
  buildPushPreview, splitAmong, isPushPreview, emptyOs,
  type CrewMember, type GenreInput, type OsCounts,
} from '@/lib/push-preview'
import { assignGames } from '@/lib/assign-evaluators'
import type { Bucket } from '@/lib/buckets'
import type { GenreTarget } from '@/lib/genre-config'

const target = (bucket: Bucket, enabled: boolean, available: number): GenreTarget =>
  ({ bucket, enabled, available, active: enabled && available > 0 })

const OFF: GenreTarget[] = [target('puzzle', false, 0), target('arcade', false, 0), target('simulation', false, 0)]
const on = (bucket: Bucket, available: number) => [target(bucket, true, available), ...OFF.filter(t => t.bucket !== bucket)]

const os = (ios = 0, android = 0, other = 0): OsCounts => ({ ios, android, other })
const who = (name: string, weight = 100, platform = 'all'): CrewMember => ({ name, platform, weight })
const genre = (o: Partial<GenreInput>): GenreInput =>
  ({ incoming: emptyOs(), waiting: emptyOs(), crew: [], ...o })

describe('splitAmong', () => {
  it('splits by weight', () => {
    const r = splitAmong(os(0, 10), [who('A', 100), who('B', 100)])
    expect(r.assigned).toBe(10)
    expect(r.perEvaluator).toEqual([{ name: 'A', count: 5 }, { name: 'B', count: 5 }])
  })

  it('weight changes the split, which is the whole point of previewing', () => {
    const r = splitAmong(os(0, 10), [who('A', 100), who('B', 30)])
    expect(r.perEvaluator).toEqual([{ name: 'A', count: 8 }, { name: 'B', count: 2 }])
  })

  it('a rostered evaluator who would get nothing still gets a line', () => {
    const r = splitAmong(os(1, 0), [who('IosOnly', 100, 'ios'), who('Idle', 100, 'android')])
    expect(r.perEvaluator).toEqual([{ name: 'IosOnly', count: 1 }, { name: 'Idle', count: 0 }])
  })

  it('games no included platform can take are unmatched, not assigned', () => {
    const r = splitAmong(os(0, 2), [who('IosOnly', 100, 'ios')])
    expect(r).toMatchObject({ assigned: 0, unmatched: 2 })
  })

  it('an empty crew assigns nothing and leaves the pool unmatched', () => {
    expect(splitAmong(os(3, 3), [])).toMatchObject({ assigned: 0, unmatched: 6, perEvaluator: [] })
  })

  it('counting by platform gives the same per-person totals as the real game list', () => {
    // This is the assumption that lets the panel ship three numbers per genre
    // instead of six thousand rows, and re-run the split in the browser. If it
    // ever stops holding, the panel has to carry the real sequence instead.
    const crew = [who('A', 100, 'ios'), who('B', 70), who('C', 50, 'android')]
    const counts = os(37, 61, 11)

    // The same multiset in a deliberately jumbled order.
    const kinds: (string | null)[] = []
    for (let i = 0; i < counts.ios; i++) kinds.push('ios')
    for (let i = 0; i < counts.android; i++) kinds.push('android')
    for (let i = 0; i < counts.other; i++) kinds.push(null)
    let seed = 7
    for (let i = kinds.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) % 2147483648
      const j = seed % (i + 1)
      ;[kinds[i], kinds[j]] = [kinds[j], kinds[i]]
    }

    const direct = assignGames(kinds.map((o, i) => ({ id: i, os: o })), crew)
    const tally: Record<string, number> = { A: 0, B: 0, C: 0 }
    direct.forEach(name => { tally[name] += 1 })

    const viaCounts = splitAmong(counts, crew)
    expect(Object.fromEntries(viaCounts.perEvaluator.map(p => [p.name, p.count]))).toEqual(tally)
    expect(viaCounts.assigned).toBe(direct.size)
  })
})

describe('buildPushPreview', () => {
  it('the pool is the push plus whatever the last run left behind', () => {
    const p = buildPushPreview(
      { puzzle: genre({ incoming: os(0, 90), waiting: os(0, 10), crew: [who('A'), who('B')] }) },
      on('puzzle', 2),
    )
    const puzzle = p.genres.find(g => g.bucket === 'puzzle')!
    expect(puzzle).toMatchObject({ incoming: 90, waiting: 10, pool: 100, assigned: 100, status: 'ready' })
    expect(p).toMatchObject({ total: 100, incoming: 90, waiting: 10, blocked: 0 })
  })

  it('counts the push even when nothing is waiting — the case that read zero before', () => {
    // The assign step empties its own queue every morning, so a preview built
    // only on unassigned rows reports 0 forever.
    const p = buildPushPreview(
      { puzzle: genre({ incoming: os(222, 568), waiting: emptyOs(), crew: [who('A')] }) },
      on('puzzle', 1),
    )
    expect(p.total).toBe(790)
    expect(p.waiting).toBe(0)
  })

  it('a genre that is off hands out nothing, and its pool counts as blocked', () => {
    const p = buildPushPreview(
      { arcade: genre({ incoming: os(0, 2), crew: [who('A')] }) },
      [target('puzzle', true, 0), target('arcade', false, 1), target('simulation', false, 0)],
    )
    expect(p.genres.find(g => g.bucket === 'arcade')).toMatchObject({ status: 'off', assigned: 0, pool: 2 })
    expect(p).toMatchObject({ total: 0, blocked: 2 })
  })

  it('on but nobody available reads as no-evaluator, not as off', () => {
    const p = buildPushPreview({ puzzle: genre({ incoming: os(1) }) }, on('puzzle', 0))
    // The two need different fixes, so they must not share a label.
    expect(p.genres.find(g => g.bucket === 'puzzle')!.status).toBe('no-evaluator')
    expect(p.blocked).toBe(1)
  })

  it('off wins over no-evaluator when both are true', () => {
    // Turning the genre on is the first step; naming availability first would
    // send the reader to fix the second thing.
    const p = buildPushPreview({ puzzle: genre({ incoming: os(1) }) }, OFF)
    expect(p.genres.find(g => g.bucket === 'puzzle')!.status).toBe('off')
  })

  it('a live genre with an empty pool is no-games, and is not blocked', () => {
    const p = buildPushPreview({ puzzle: genre({ crew: [who('A')] }) }, on('puzzle', 1))
    const puzzle = p.genres.find(g => g.bucket === 'puzzle')!
    expect(puzzle.status).toBe('no-games')
    // The crew still shows, so the panel can list who is standing by.
    expect(puzzle.perEvaluator).toEqual([{ name: 'A', count: 0 }])
    expect(p.blocked).toBe(0)
  })

  it('carries the platform tally and the crew, so the browser can re-split', () => {
    const p = buildPushPreview(
      { puzzle: genre({ incoming: os(3, 4), waiting: os(1, 2), crew: [who('A', 70, 'ios')] }) },
      on('puzzle', 1),
    )
    const puzzle = p.genres.find(g => g.bucket === 'puzzle')!
    expect(puzzle.os).toEqual({ ios: 4, android: 6, other: 0 })
    expect(puzzle.crew).toEqual([{ name: 'A', platform: 'ios', weight: 70 }])
  })

  it('totals across several running genres', () => {
    const p = buildPushPreview(
      {
        puzzle: genre({ incoming: os(0, 2), crew: [who('A')] }),
        arcade: genre({ incoming: os(1), crew: [who('B')] }),
        simulation: genre({ incoming: os(0, 1) }),
      },
      [target('puzzle', true, 1), target('arcade', true, 1), target('simulation', false, 0)],
    )
    expect(p).toMatchObject({ total: 3, incoming: 4, blocked: 1 })
  })

  it('always reports all three genres, in the standard order', () => {
    expect(buildPushPreview({}, OFF).genres.map(g => g.bucket))
      .toEqual(['puzzle', 'arcade', 'simulation'])
  })

  it('an empty everything is zero, not a crash', () => {
    const p = buildPushPreview({}, [])
    expect(p).toMatchObject({ total: 0, incoming: 0, waiting: 0, blocked: 0 })
    expect(p.genres.every(g => g.status === 'off')).toBe(true)
  })
})

describe('isPushPreview', () => {
  it('accepts what the endpoint sends', () => {
    expect(isPushPreview(buildPushPreview({}, OFF))).toBe(true)
  })

  it('rejects anything else, so a stray 200 cannot take the tab down', () => {
    for (const bad of [null, undefined, 42, 'preview', {}, { genres: [] }, { initial: [], final: [] }]) {
      expect(isPushPreview(bad)).toBe(false)
    }
  })
})
