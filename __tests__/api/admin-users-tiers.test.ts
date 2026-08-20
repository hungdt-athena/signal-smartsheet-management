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

import { POST, PUT } from '@/app/api/admin/users/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

function req(method: string, body: unknown) {
  return new NextRequest('http://localhost/api/admin/users', {
    method, body: JSON.stringify(body),
  } as never)
}

describe('/api/admin/users tiers', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => {
    sqlMock.mockReset()
    sqlMock.mockImplementation(() => Promise.resolve([]))
  })

  const asModerator = () =>
    sessionMock.mockResolvedValue({ user: { role: 'moderator', email: 'mod@athena.studio' } })

  it('lets a moderator invite an evaluator', async () => {
    asModerator()
    expect((await POST(req('POST', { email: 'new@athena.studio', role: 'evaluator' }))).status).toBe(200)
  })

  it('stops a moderator inviting an admin', async () => {
    asModerator()
    const res = await POST(req('POST', { email: 'new@athena.studio', role: 'admin' }))
    expect(res.status).toBe(403)
    expect(sqlMock).not.toHaveBeenCalled()
  })

  it('stops a moderator changing a role', async () => {
    asModerator()
    const res = await PUT(req('PUT', { id: 3, role: 'admin' }))
    expect(res.status).toBe(403)
    expect(sqlMock).not.toHaveBeenCalled()
  })

  it('lets a moderator rename a user', async () => {
    asModerator()
    sqlMock.mockImplementation(() => Promise.resolve([{ email: 'x@athena.studio', role: 'evaluator' }]))
    expect((await PUT(req('PUT', { id: 3, name: 'X' }))).status).toBe(200)
  })

  it('lets an admin change a role, and accepts moderator as a value', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', email: 'hungdt@athena.studio' } })
    sqlMock.mockImplementation(() => Promise.resolve([{ email: 'x@athena.studio', role: 'evaluator' }]))
    expect((await PUT(req('PUT', { id: 3, role: 'moderator' }))).status).toBe(200)
  })

  it('refuses an evaluator outright', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', email: 'mitt@athena.studio' } })
    expect((await POST(req('POST', { email: 'new@athena.studio', role: 'evaluator' }))).status).toBe(403)
  })
})
