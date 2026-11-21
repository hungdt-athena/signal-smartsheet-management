/**
 * @jest-environment node
 */
// Task 7 (unified playtest): assign by pair. Every query that picks games to hand out
// takes only the front row of a linked pair (NOT ge.pair_back) and tags a live pair as
// os 'pair', so assignGames can give it to anyone. The back row follows through the 054
// sync trigger. History logs both store ids, and counts the pair as 1.
// The mock composes nested fragments into one text, so checks run on the whole statement.
import { NextRequest } from 'next/server'

type Responder = (text: string, binds: unknown[]) => unknown[]
let respond: Responder = () => []

jest.mock('@/lib/db', () => {
  type Frag = { __text: string; __binds: unknown[]; then: (a: (v: unknown) => unknown, b?: (e: unknown) => unknown) => Promise<unknown> }
  const mk = (text: string, binds: unknown[] = []): Frag => ({
    __text: text,
    __binds: binds,
    then: (a, b) => Promise.resolve().then(() => respond(text, binds)).then(a, b),
  })
  const render = (strings: readonly string[], binds: unknown[]) =>
    strings.reduce((acc, s, i) => {
      const b = i < binds.length ? binds[i] : undefined
      const t = b && typeof b === 'object' && '__text' in (b as object) ? (b as Frag).__text : (i < binds.length ? '?' : '')
      return acc + s + t
    }, '')
  const flat = (binds: unknown[]): unknown[] => binds.flatMap(b =>
    b && typeof b === 'object' && '__text' in (b as object) ? flat((b as Frag).__binds) : [b])
  const tag: any = jest.fn((strings: unknown, ...binds: unknown[]) => {
    if (typeof strings === 'string') return mk(strings)            // identifier: sql('ge')
    if (!(Array.isArray(strings) && 'raw' in strings)) return mk('', [strings]) // sql(ids)
    return mk(render(strings as string[], binds), flat(binds))
  })
  tag.json = jest.fn((x: unknown) => x)
  return { sql: tag }
})
jest.mock('next-auth', () => ({ getServerSession: jest.fn(() => Promise.resolve(null)) }))
jest.mock('@/lib/genre-config-db', () => ({
  loadGenreTargets: jest.fn(async () => [{ bucket: 'puzzle', enabled: true, available: 2, active: true }]),
}))

import { sql } from '@/lib/db'
import { POST as assignCron } from '@/app/api/cron/assign-evaluators/route'
import { selectPendingGames } from '@/lib/reassign-core'
import { selectStaleGames } from '@/lib/rescue-core'
import { DEFAULT_RESCUE_CONFIG } from '@/lib/rescue-config'

const sqlMock = sql as unknown as jest.Mock
const texts = () => sqlMock.mock.results.map(r => (r.value as { __text: string }).__text)
const outer = (needle: string) => texts().filter(t => t.includes(needle))

beforeEach(() => {
  sqlMock.mockClear()
  respond = () => []
})

function expectFrontRowsWithPairOs(text: string) {
  expect(text).toContain('NOT ge.pair_back')
  expect(text).toMatch(/CASE WHEN ge\.pair_eval_id IS NOT NULL[\s\S]*THEN 'pair'[\s\S]*ELSE gi\.os END AS os/)
}

describe('candidate queries take the front row and tag a live pair', () => {
  it('cron assign-evaluators', async () => {
    respond = (t) => {
      if (t.includes('FROM evaluator_roster')) return [{ name: 'A', game_platform: 'ios', weight: 100 }]
      if (t.includes('initial_evaluator IS NULL')) return [{ id: 1, game_id: 'g1', os: 'pair' }]
      return []
    }
    process.env.WEBHOOK_SECRET = 's'
    const res = await assignCron(new NextRequest('http://x/api/cron/assign-evaluators', {
      method: 'POST', headers: { 'x-webhook-secret': 's' }, body: JSON.stringify({ category: 'puzzle', dryRun: true }),
    }))
    const json = await res.json()
    expect(res.status).toBe(200)
    // an ios specialist takes the pair
    expect(json.per_evaluator).toEqual({ A: 1 })
    const [cand] = outer('initial_evaluator IS NULL')
    expectFrontRowsWithPairOs(cand)
  })

  it('reassign / handover selectPendingGames', async () => {
    await selectPendingGames({ category: 'puzzle', from: 'A' })
    const [cand] = outer('initial_evaluator =')
    expectFrontRowsWithPairOs(cand)
  })

  it('rescue selectStaleGames', async () => {
    await selectStaleGames({ category: 'puzzle', from: 'A', config: DEFAULT_RESCUE_CONFIG })
    const [cand] = outer('initial_evaluator =')
    expectFrontRowsWithPairOs(cand)
  })
})

describe('cron assign writes history with both store ids', () => {
  it('a pair counts as 1 and logs the twin game id', async () => {
    respond = (t, binds) => {
      if (t.includes('FROM evaluator_roster')) return [{ name: 'A', game_platform: 'all', weight: 100 }]
      if (t.includes('initial_evaluator IS NULL')) return [{ id: 1, game_id: 'a1', os: 'pair' }, { id: 2, game_id: 'solo', os: 'ios' }]
      if (t.includes('UPDATE game_evaluations')) {
        const ids = binds.find(b => Array.isArray(b)) as number[]
        return ids.map(id => ({ id }))
      }
      if (t.includes('pair_eval_id') && t.includes('twin_game_id')) return [{ game_id: 'a1', twin_game_id: 'i1' }]
      return []
    }
    process.env.WEBHOOK_SECRET = 's'
    const res = await assignCron(new NextRequest('http://x/api/cron/assign-evaluators', {
      method: 'POST', headers: { 'x-webhook-secret': 's' }, body: JSON.stringify({ category: 'puzzle' }),
    }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.assigned).toBe(2)
    const insert = sqlMock.mock.results
      .map(r => r.value as { __text: string; __binds: unknown[] })
      .find(f => f.__text.includes('INSERT INTO assignment_history'))!
    expect(insert).toBeDefined()
    // game_count 2 (one pair + one single), game_ids carries both stores of the pair
    expect(insert.__binds).toContain(2)
    const ids = insert.__binds.find(b => Array.isArray(b)) as string[]
    expect([...ids].sort()).toEqual(['a1', 'i1', 'solo'])
  })
})
