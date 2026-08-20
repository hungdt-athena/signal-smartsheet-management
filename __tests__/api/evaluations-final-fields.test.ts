/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => {
  const fn = jest.fn() as jest.Mock & { json: jest.Mock; begin: jest.Mock }
  fn.json = jest.fn((v: unknown) => v)
  fn.begin = jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(fn)))
  return { sql: fn }
})
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ authOptions: {} }))
jest.mock('@/lib/config', () => ({
  getConfigValues: jest.fn(async () => ['Priority IV', 'Insight', 'Bypass']),
}))

import { PATCH } from '@/app/api/evaluations/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock & { begin: jest.Mock }
const sessionMock = getServerSession as unknown as jest.Mock

function patchReq(body: unknown) {
  return new NextRequest('http://localhost/api/evaluations', {
    method: 'PATCH', body: JSON.stringify(body),
  } as never)
}

let calls: { text: string; binds: unknown[] }[] = []
function routeSql(rows: unknown[] = [{ id: 1 }]) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    calls.push({ text: (strings as string[]).join(' '), binds })
    return Promise.resolve(rows)
  })
  sqlMock.begin = jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(sqlMock)))
}

/** The UPDATE statement's binds, where the final-field values would land. */
function updateBinds() {
  return calls.filter(c => /UPDATE game_evaluations/.test(c.text)).flatMap(c => c.binds)
}

describe('/api/evaluations PATCH — final fields are admin-only', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { calls = [] })

  it('refuses a final conclusion from a moderator', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'moderator', name: 'Mitt' } })
    routeSql()
    const res = await PATCH(patchReq({ id: 1, final_conclusion: 'Insight' }))
    expect(res.status).toBe(403)
    expect(updateBinds()).toHaveLength(0)
  })

  it('refuses a final note from a moderator', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'moderator', name: 'Mitt' } })
    routeSql()
    const res = await PATCH(patchReq({ id: 1, final_note: 'nice' }))
    expect(res.status).toBe(403)
    expect(updateBinds()).toHaveLength(0)
  })

  it('lets a moderator edit game alike', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'moderator', name: 'Mitt' } })
    routeSql()
    const res = await PATCH(patchReq({ id: 1, game_alike: [{ title: 'Balatro' }] }))
    expect(res.status).toBe(200)
    // game_alike is stored as jsonb, so the value reaches the bind list wrapped
    // by sql.json (mocked to identity here) rather than as a bare string.
    expect(calls.some(c => /UPDATE game_evaluations/.test(c.text))).toBe(true)
  })

  it('lets an admin set the final conclusion', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD' } })
    routeSql()
    const res = await PATCH(patchReq({ id: 1, final_conclusion: 'Insight' }))
    expect(res.status).toBe(200)
    expect(updateBinds()).toContain('Insight')
  })
})
