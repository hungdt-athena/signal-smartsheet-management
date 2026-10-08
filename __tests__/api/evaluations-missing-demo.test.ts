/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ authOptions: {} }))

import { GET } from '@/app/api/evaluations/missing-demo/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

type Binds = unknown[]
let gameQueries: { text: string; binds: Binds }[] = []

function game(over: Record<string, unknown>) {
  return {
    id: 1, game_id: 'g1', title: 'Game', icon_url: null, genre_1: 'Casual',
    category_group: 'puzzle', batch: 'W2 Oct, 2026', evaluate_date: '2026-10-07T10:00:00Z',
    ...over,
  }
}

/** config rows for getCurrentBatches(); `games` for the missing-demo query. */
function db(config: { key: string; value: string | null }[], games: Record<string, unknown>[]) {
  gameQueries = []
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: Binds) => {
    const text = Array.isArray(strings) ? (strings as string[]).join(' ') : ''
    if (text.includes('app_config')) return Promise.resolve(config)
    gameQueries.push({ text, binds })
    return Promise.resolve(games)
  })
}

const CFG = [
  { key: 'current_batch:puzzle', value: 'W2 Oct, 2026' },
  { key: 'current_batch:arcade', value: 'W1 Oct, 2026' },
]

function req(qs = '') {
  return new NextRequest(`http://localhost/api/evaluations/missing-demo${qs}`)
}

describe('GET /api/evaluations/missing-demo', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeEach(() => {
    process.env.SKIP_AUTH = 'false'
    sessionMock.mockResolvedValue({ user: { name: 'PhuongNT1', role: 'evaluator' } })
  })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  it('rejects a caller who is not signed in', async () => {
    sessionMock.mockResolvedValue(null)
    db(CFG, [])
    const res = await GET(req())
    expect(res.status).toBe(401)
  })

  it('asks only for the signed-in user\'s own List_Idea games with no demo link', async () => {
    db(CFG, [game({})])
    await GET(req())
    expect(gameQueries).toHaveLength(1)
    const { text, binds } = gameQueries[0]
    expect(text).toMatch(/initial_conclusion\s*=\s*'List_Idea'/)
    expect(text).toMatch(/drive_link/)
    expect(text).toMatch(/lower\(ge\.initial_evaluator\)\s*=\s*lower\(/)
    expect(binds).toContain('PhuongNT1')
  })

  it('ignores a crafted ?evaluator= -- it can never reveal someone else\'s games', async () => {
    db(CFG, [])
    await GET(req('?evaluator=HuyDD'))
    expect(gameQueries[0].binds).toContain('PhuongNT1')
    expect(gameQueries[0].binds).not.toContain('HuyDD')
  })

  it('does not query games at all for a user with no name', async () => {
    sessionMock.mockResolvedValue({ user: { name: null, role: 'evaluator' } })
    db(CFG, [game({})])
    const res = await GET(req())
    expect(await res.json()).toEqual({ items: [] })
    expect(gameQueries).toHaveLength(0)
  })

  it('does not query games when no current batch is set anywhere', async () => {
    db([{ key: 'current_batch:puzzle', value: null }], [game({})])
    const res = await GET(req())
    expect(await res.json()).toEqual({ items: [] })
    expect(gameQueries).toHaveLength(0)
  })

  it('keeps only the current batch of each game\'s own category', async () => {
    db(CFG, [
      game({ id: 1, category_group: 'puzzle', batch: 'W2 Oct, 2026' }),
      game({ id: 2, category_group: 'puzzle', batch: 'W1 Oct, 2026' }), // previous puzzle batch
      game({ id: 3, category_group: 'arcade', batch: 'W1 Oct, 2026' }),
      game({ id: 4, category_group: 'arcade', batch: 'W2 Oct, 2026' }), // puzzle's batch, wrong category
      game({ id: 5, category_group: 'simulation', batch: 'W2 Oct, 2026' }), // no batch set
    ])
    const body = await (await GET(req())).json()
    expect(body.items.map((i: { id: number }) => i.id).sort()).toEqual([1, 3])
  })

  it('narrows the SQL to the current batch labels so it does not scan every List_Idea game', async () => {
    db(CFG, [])
    await GET(req())
    const flat = gameQueries[0].binds.flat()
    expect(flat).toEqual(expect.arrayContaining(['W2 Oct, 2026', 'W1 Oct, 2026']))
  })

  it('returns the fields the panel renders, newest batch first', async () => {
    db(CFG, [
      game({ id: 3, category_group: 'arcade', batch: 'W1 Oct, 2026', title: 'Stack Rush' }),
      game({ id: 1, category_group: 'puzzle', batch: 'W2 Oct, 2026', title: 'ArcFlush', icon_url: 'https://x/i.png' }),
    ])
    const body = await (await GET(req())).json()
    expect(body.items.map((i: { id: number }) => i.id)).toEqual([1, 3])
    expect(body.items[0]).toEqual({
      id: 1, game_id: 'g1', title: 'ArcFlush', icon_url: 'https://x/i.png',
      category: 'puzzle', genre: 'Casual', batch: 'W2 Oct, 2026',
      evaluate_date: '2026-10-07T10:00:00Z',
    })
  })
})
