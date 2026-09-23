/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

import { GET } from '@/app/api/operations/pending-holders/route'
import { getServerSession } from 'next-auth'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock
function req(url: string) { return new NextRequest(`http://localhost${url}`) }

describe('/api/operations/pending-holders', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => {
    sqlMock.mockReset()
    sessionMock.mockReset()
    sessionMock.mockResolvedValue({ user: { name: 'Admin', role: 'admin' } })
  })

  it('trả người đang ôm game pending của đúng bucket, kèm số lượng', async () => {
    sqlMock.mockResolvedValueOnce([
      { name: 'HuyDD', pending: 1951 },
      { name: 'NhiLV', pending: 200 },
    ])
    const res = await GET(req('/api/operations/pending-holders?category=arcade'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.category).toBe('arcade')
    expect(json.holders).toEqual([
      { name: 'HuyDD', pending: 1951 },
      { name: 'NhiLV', pending: 200 },
    ])
  })

  it('category sai thì 400, không chạm DB', async () => {
    const res = await GET(req('/api/operations/pending-holders?category=bogus'))
    expect(res.status).toBe(400)
    expect(sqlMock).not.toHaveBeenCalled()
  })

  it('evaluator chỉ thấy dòng của chính họ', async () => {
    sessionMock.mockResolvedValue({ user: { name: 'NhiLV', role: 'evaluator' } })
    sqlMock.mockResolvedValueOnce([
      { name: 'HuyDD', pending: 1951 },
      { name: 'NhiLV', pending: 200 },
    ])
    const json = await (await GET(req('/api/operations/pending-holders?category=arcade'))).json()
    expect(json.holders).toEqual([{ name: 'NhiLV', pending: 200 }])
  })
})
