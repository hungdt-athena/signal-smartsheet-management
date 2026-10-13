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
    suggested_link: null, suggested_name: null, shared_with: null,
    ...over,
  }
}

/** config rows for getCurrentBatch(); `games` for the missing-demo query. */
function db(config: { key: string; value: string | null }[], games: Record<string, unknown>[],
  /** reject any game query that mentions this table, with Postgres 42P01 (undefined_table) */
  missingTable?: string) {
  gameQueries = []
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: Binds) => {
    const text = Array.isArray(strings) ? (strings as string[]).join(' ') : ''
    if (text.includes('app_config')) return Promise.resolve(config)
    gameQueries.push({ text, binds })
    if (missingTable && text.includes(missingTable)) {
      return Promise.reject(Object.assign(new Error(`relation "${missingTable}" does not exist`), { code: '42P01' }))
    }
    return Promise.resolve(games)
  })
}

const CFG = [{ key: 'current_batch', value: 'W2 Oct, 2026' }]

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

  it('does not query games when no current batch is set', async () => {
    db([{ key: 'current_batch', value: null }], [game({})])
    const res = await GET(req())
    expect(await res.json()).toEqual({ items: [] })
    expect(gameQueries).toHaveLength(0)
  })

  it('asks the database for the one current batch', async () => {
    db(CFG, [])
    await GET(req())
    expect(gameQueries[0].text).toMatch(/ge\.batch\s*=/)
    expect(gameQueries[0].binds).toContain('W2 Oct, 2026')
  })

  it('applies the one batch to every category, with no per-category filtering', async () => {
    db(CFG, [
      game({ id: 1, category_group: 'puzzle' }),
      game({ id: 2, category_group: 'arcade' }),
      game({ id: 3, category_group: 'simulation' }),
    ])
    const body = await (await GET(req())).json()
    expect(body.items.map((i: { id: number }) => i.id)).toEqual([1, 2, 3])
  })

  it('returns the fields the panel renders', async () => {
    db(CFG, [game({ id: 1, title: 'ArcFlush', icon_url: 'https://x/i.png' })])
    const body = await (await GET(req())).json()
    expect(body.items[0]).toEqual({
      id: 1, game_id: 'g1', title: 'ArcFlush', icon_url: 'https://x/i.png',
      category: 'puzzle', genre: 'Casual', batch: 'W2 Oct, 2026',
      evaluate_date: '2026-10-07T10:00:00Z',
      suggested_link: null, suggested_name: null, shared_with: null,
    })
  })

  describe('suggested links (titles shared by different games)', () => {
    it('joins the suggestion table on the evaluation id, and still only asks for rows with no link', async () => {
      db(CFG, [])
      await GET(req())
      const { text } = gameQueries[0]
      expect(text).toMatch(/LEFT JOIN drive_link_suggestions\s+s\s+ON\s+s\.game_evaluation_id\s*=\s*ge\.id/i)
      expect(text).toMatch(/COALESCE\(ge\.drive_link, ''\)\s*=\s*''/)
    })

    it('returns the suggested link, the file it came from, and how many other games share the title', async () => {
      db(CFG, [game({
        id: 7, suggested_link: 'https://drive.google.com/file/d/abc/view',
        suggested_name: 'Nail Box Sort.mp4', shared_with: 2,
      })])
      const body = await (await GET(req())).json()
      expect(body.items[0]).toMatchObject({
        id: 7, suggested_link: 'https://drive.google.com/file/d/abc/view',
        suggested_name: 'Nail Box Sort.mp4', shared_with: 2,
      })
    })

    it('falls back to the plain list when migration 048 is not applied, instead of dropping the prompt', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
      db(CFG, [game({ id: 3 })], 'drive_link_suggestions')
      const res = await GET(req())
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.items.map((i: { id: number }) => i.id)).toEqual([3])
      expect(body.items[0]).toMatchObject({ suggested_link: null, suggested_name: null, shared_with: null })
      // the retry must not mention the missing table, and must keep the same scope
      expect(gameQueries).toHaveLength(2)
      expect(gameQueries[1].text).not.toMatch(/drive_link_suggestions/)
      expect(gameQueries[1].binds).toContain('PhuongNT1')
      spy.mockRestore()
    })

    it('does not swallow other database errors', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
      sqlMock.mockReset()
      sqlMock.mockImplementation((strings: unknown) => {
        const text = Array.isArray(strings) ? (strings as string[]).join(' ') : ''
        if (text.includes('app_config')) return Promise.resolve(CFG)
        return Promise.reject(Object.assign(new Error('boom'), { code: '57014' }))
      })
      const res = await GET(req())
      expect(res.status).toBe(500)
      spy.mockRestore()
    })
  })
})
