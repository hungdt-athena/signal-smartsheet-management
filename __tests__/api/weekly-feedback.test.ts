/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: Object.assign(jest.fn(), { json: (v: unknown) => v }) }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ authOptions: {} }))

import { GET, PUT } from '@/app/api/weekly-feedback/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

function getReq(qs: string) {
  return GET(new NextRequest(`http://localhost/api/weekly-feedback?${qs}`))
}
function putReq(body: unknown) {
  return PUT(new NextRequest('http://localhost/api/weekly-feedback', {
    method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }))
}

describe('/api/weekly-feedback', () => {
  const realSkip = process.env.SKIP_AUTH
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { sqlMock.mockReset(); sessionMock.mockReset() })

  it('GET list forces evaluator to the session user for a non-manager', async () => {
    process.env.SKIP_AUTH = ''
    sessionMock.mockResolvedValue({ user: { name: 'Alice', role: 'evaluator' } })
    sqlMock.mockResolvedValue([])
    await getReq('evaluator=Bob') // attempts to read Bob's
    const text = (sqlMock.mock.calls[0][0] as string[]).join(' ')
    expect(text).toContain('lower(evaluator)')
    // bound param is Alice, not Bob — assert on the interpolated value directly
    // (sqlMock is called as sql`...${v}...` so calls[0] is [stringsArray, ...values])
    const boundValues = sqlMock.mock.calls[0].slice(1)
    expect(boundValues).toContain('Alice')
    expect(boundValues).not.toContain('Bob')
  })

  it('PUT blocks writing to another evaluator (403)', async () => {
    process.env.SKIP_AUTH = ''
    sessionMock.mockResolvedValue({ user: { name: 'Alice', role: 'admin' } })
    const res = await putReq({ batch: 'W1 Jun, 2026', evaluator: 'Bob', feedback: {}, game_alike: [] })
    expect(res.status).toBe(403)
  })

  it('PUT upserts for the session user', async () => {
    process.env.SKIP_AUTH = ''
    sessionMock.mockResolvedValue({ user: { name: 'Alice', role: 'evaluator' } })
    sqlMock.mockResolvedValue([{ batch: 'W1 Jun, 2026', evaluator: 'Alice', feedback: {}, game_alike: [], updated_at: 'now' }])
    const res = await putReq({ batch: 'W1 Jun, 2026', feedback: { type: 'doc' }, game_alike: [] })
    expect(res.status).toBe(200)
    const text = (sqlMock.mock.calls[0][0] as string[]).join(' ')
    expect(text).toContain('ON CONFLICT')
  })

  it('PUT rejects a missing batch (400)', async () => {
    process.env.SKIP_AUTH = ''
    sessionMock.mockResolvedValue({ user: { name: 'Alice', role: 'evaluator' } })
    const res = await putReq({ feedback: {}, game_alike: [] })
    expect(res.status).toBe(400)
  })
})
