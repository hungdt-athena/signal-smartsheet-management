/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('@/lib/session', () => ({ getSession: jest.fn(async () => ({ user: { name: 'PhuongNT1', role: 'evaluator' } })) }))
jest.mock('@/lib/current-batch', () => ({ getCurrentBatch: jest.fn(async () => 'W2 Oct, 2026') }))

import { GET as missingDemo } from '@/app/api/evaluations/missing-demo/route'
import { GET as evalList } from '@/app/api/evaluations/route'
import { GET as evalOne } from '@/app/api/evaluations/[gameId]/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock
const texts = () => sqlMock.mock.calls.filter(c => Array.isArray(c[0])).map(c => (c[0] as string[]).join('?'))

const base = {
  id: 1, game_id: 'g1', title: 'Game', icon_url: null, genre_1: 'Casual',
  category_group: 'puzzle', batch: 'W2 Oct, 2026', evaluate_date: null,
}

describe('file codes on the read endpoints', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'false' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { sqlMock.mockReset() })

  it('missing-demo items carry demo_code, null (not undefined) when the game has none', async () => {
    sqlMock.mockResolvedValue([{ ...base, demo_code: 'AB3K9Z' }, { ...base, id: 2, game_id: 'g2' }])
    const body = await (await missingDemo(new NextRequest('http://localhost/api/evaluations/missing-demo'))).json()
    expect(body.items[0].demo_code).toBe('AB3K9Z')
    expect(body.items[1].demo_code).toBeNull()
    expect(texts().some(q => q.includes('gi.demo_code'))).toBe(true)
  })

  it('the evaluations list selects both codes from game_info', async () => {
    sqlMock.mockImplementation(() => Promise.resolve([]))
    await evalList(new NextRequest('http://localhost/api/evaluations?category=all&limit=10&meta=0'))
    const q = texts().find(t => t.includes('gi.title')) ?? ''
    expect(q).toContain('gi.demo_code')
    expect(q).toContain('gi.record_code')
  })

  it('the by-gameId read the panel loads selects both codes from game_info', async () => {
    sqlMock.mockImplementation(() => Promise.resolve([{ game_id: 'g1', demo_code: null, record_code: null }]))
    await evalOne(new NextRequest('http://localhost/api/evaluations/g1'), { params: { gameId: 'g1' } })
    const q = texts().find(t => t.includes('SELECT ge.id')) ?? ''
    expect(q).toContain('gi.demo_code')
    expect(q).toContain('gi.record_code')
  })
})
