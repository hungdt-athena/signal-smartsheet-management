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

import { GET } from '@/app/api/playtest-tags/pending/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

let calls: { text: string; binds: unknown[] }[] = []

function routeSql() {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    calls.push({ text: (strings as string[]).join(' '), binds })
    return Promise.resolve([])
  })
}

const get = () => GET(new NextRequest('http://localhost/api/playtest-tags/pending') as never)

/** The scoping fragment reaches sql() as a nested template, so it is recorded as
 *  a call of its own rather than as part of the query it is spliced into. */
const scopeFilters = () => calls.filter(c => /tagged_by =/.test(c.text))

// The queue is readable by everyone, but an evaluator only ever sees what they
// proposed themselves -- the own-only rule the Evaluate and Short List tabs
// follow. The scope comes from the session, never from a query parameter, so
// there is nothing here for a client to widen.
describe('GET /api/playtest-tags/pending', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { calls = []; routeSql() })

  it('401s when nobody is signed in', async () => {
    sessionMock.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('gives an admin the whole queue', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', email: 'vinhtd@athena.studio' } })
    expect((await get()).status).toBe(200)
    expect(scopeFilters()).toHaveLength(0)
  })

  // Both the rows and the count: a "3 of 40" counted against the whole team's
  // queue would page an evaluator through rows they are never shown.
  it('scopes an evaluator to their own tags, rows and count alike', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', email: 'mitt@athena.studio' } })
    expect((await get()).status).toBe(200)
    const filters = scopeFilters()
    expect(filters).toHaveLength(2)
    for (const f of filters) expect(f.binds).toEqual(['mitt@athena.studio'])
  })

  // Failing open here would hand one evaluator the whole team's queue.
  it('matches nothing when a non-admin session carries no email', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator' } })
    expect((await get()).status).toBe(200)
    const filters = scopeFilters()
    expect(filters).toHaveLength(2)
    for (const f of filters) expect(f.binds).toEqual(['(no email)'])
  })
})
