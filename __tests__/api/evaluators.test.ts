/**
 * @jest-environment node
 */
import { GET } from '@/app/api/evaluators/route'
import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'

jest.mock('@/lib/db', () => ({
  sql: jest.fn().mockResolvedValue([])
}))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

describe('GET /api/evaluators', () => {
  it('returns 401 without manager session', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue(null)
    const res = await GET(new NextRequest('http://localhost/api/evaluators'))
    expect(res.status).toBe(401)
  })

  it('returns 200 for manager', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue({
      user: { role: 'manager', email: 'mgr@test.com' }
    })
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ name: 'Nam', email: 'nam@test.com', is_available: true }]
    })
    process.env.WEBHOOK_GET_EVALUATORS = 'https://n8n.test/webhook/get-evaluators'
    const res = await GET(new NextRequest('http://localhost/api/evaluators'))
    expect(res.status).toBe(200)
  })
})
