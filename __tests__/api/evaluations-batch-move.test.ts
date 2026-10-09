/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ authOptions: {} }))

import { POST, MAX_MOVE } from '@/app/api/evaluations/batch-move/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

let calls: { text: string; binds: unknown[] }[] = []

/** `updated` = the rows the UPDATE ... RETURNING id hands back. */
function db(updated: { id: number }[] = []) {
  calls = []
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    calls.push({ text: Array.isArray(strings) ? (strings as string[]).join(' ') : '', binds })
    return Promise.resolve(updated)
  })
}

const post = (body: unknown) =>
  POST(new NextRequest('http://localhost/api/evaluations/batch-move', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  } as never))

describe('POST /api/evaluations/batch-move', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeEach(() => {
    process.env.SKIP_AUTH = 'false'
    sessionMock.mockResolvedValue({ user: { name: 'HungDT', role: 'admin' } })
  })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  it('is refused when not signed in, and for an evaluator', async () => {
    db()
    sessionMock.mockResolvedValue(null)
    expect((await post({ ids: [1], batch: 'W2 Oct, 2026' })).status).toBe(401)
    sessionMock.mockResolvedValue({ user: { name: 'PhuongNT1', role: 'evaluator' } })
    expect((await post({ ids: [1], batch: 'W2 Oct, 2026' })).status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('lets a moderator through', async () => {
    db([{ id: 1 }])
    sessionMock.mockResolvedValue({ user: { name: 'Mod', role: 'moderator' } })
    expect((await post({ ids: [1], batch: 'W2 Oct, 2026' })).status).toBe(200)
  })

  it.each([
    ['empty ids', { ids: [], batch: 'W2 Oct, 2026' }],
    ['ids missing', { batch: 'W2 Oct, 2026' }],
    ['ids not an array', { ids: 5, batch: 'W2 Oct, 2026' }],
    ['string id', { ids: ['1'], batch: 'W2 Oct, 2026' }],
    ['float id', { ids: [1.5], batch: 'W2 Oct, 2026' }],
    ['negative id', { ids: [-3], batch: 'W2 Oct, 2026' }],
    ['zero id', { ids: [0], batch: 'W2 Oct, 2026' }],
    ['blank batch', { ids: [1], batch: '   ' }],
    ['missing batch', { ids: [1] }],
    ['non-string batch', { ids: [1], batch: 7 }],
  ])('400 for %s, and never touches the database', async (_name, body) => {
    db()
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(typeof (await res.json()).error).toBe('string')
    expect(calls).toHaveLength(0)
  })

  it('400 for a body that is not JSON', async () => {
    db()
    expect((await post('not json')).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('accepts exactly MAX_MOVE ids and refuses one more', async () => {
    expect(MAX_MOVE).toBe(500)
    db([])
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
    expect((await post({ ids: ids(500), batch: 'W2 Oct, 2026' })).status).toBe(200)
    expect((await post({ ids: ids(501), batch: 'W2 Oct, 2026' })).status).toBe(400)
  })

  it('collapses duplicate ids before updating', async () => {
    db([{ id: 1 }, { id: 2 }])
    await post({ ids: [1, 2, 2, 1], batch: 'W2 Oct, 2026' })
    expect(calls[0].binds).toContainEqual([1, 2])
  })

  it('moves a game that already has a final conclusion: the UPDATE has no conclusion filter', async () => {
    db([{ id: 1 }])
    await post({ ids: [1], batch: 'W2 Oct, 2026' })
    const { text } = calls[0]
    expect(text).toMatch(/UPDATE game_evaluations/)
    expect(text).not.toMatch(/final_conclusion|initial_conclusion/)
  })

  it('updates only the listed ids, stamps who did it, and trims the batch', async () => {
    db([{ id: 4 }, { id: 9 }])
    await post({ ids: [4, 9], batch: '  W3 Oct, 2026 ' })
    const { text, binds } = calls[0]
    expect(text).toMatch(/WHERE id = ANY\(/)
    expect(text).toMatch(/updated_by/)
    expect(binds).toContain('W3 Oct, 2026')
    expect(binds).toContain('HungDT')
    expect(binds).toContainEqual([4, 9])
  })

  it('returns how many rows actually changed; ids that do not exist are not an error', async () => {
    db([{ id: 4 }])
    const res = await post({ ids: [4, 9999], batch: 'W3 Oct, 2026' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ moved: 1 })
  })
})
