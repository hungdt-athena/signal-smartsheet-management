/**
 * @jest-environment node
 */
import { POST, GET } from '@/app/api/stats/route'
import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'

jest.mock('@/lib/db', () => ({
  sql: jest.fn().mockResolvedValue([])
}))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

process.env.WEBHOOK_SECRET = 'test-secret'

describe('POST /api/stats', () => {
  it('returns 401 without secret', async () => {
    const req = new NextRequest('http://localhost/api/stats', {
      method: 'POST',
      body: JSON.stringify({ stat_date: '2026-03-19', games_pulled: 45 }),
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('upserts global row with valid payload', async () => {
    const { sql } = require('@/lib/db')
    const req = new NextRequest('http://localhost/api/stats', {
      method: 'POST',
      headers: { 'x-webhook-secret': 'test-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ stat_date: '2026-03-19', games_pulled: 45 }),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(sql).toHaveBeenCalled()
  })
})

describe('GET /api/stats', () => {
  it('returns 401 without manager session', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue(null)
    const req = new NextRequest('http://localhost/api/stats')
    const res = await GET(req)
    expect(res.status).toBe(401)
  })
})
