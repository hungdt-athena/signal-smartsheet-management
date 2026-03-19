/**
 * @jest-environment node
 */
import { POST } from '@/app/api/logs/route'
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({
  sql: jest.fn().mockResolvedValue([{ id: 1 }])
}))

const validSecret = 'test-secret'
process.env.WEBHOOK_SECRET = validSecret

function makeRequest(body: object, secret?: string) {
  return new NextRequest('http://localhost/api/logs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'x-webhook-secret': secret } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe('POST /api/logs', () => {
  it('returns 401 without secret', async () => {
    const res = await POST(makeRequest({ workflow_name: 'test', status: 'success' }))
    expect(res.status).toBe(401)
  })

  it('returns 401 with wrong secret', async () => {
    const res = await POST(makeRequest({ workflow_name: 'test', status: 'success' }, 'wrong'))
    expect(res.status).toBe(401)
  })

  it('returns 400 with missing required fields', async () => {
    const res = await POST(makeRequest({ workflow_name: 'test' }, validSecret))
    expect(res.status).toBe(400)
  })

  it('returns 200 with valid payload', async () => {
    const res = await POST(makeRequest({
      workflow_name: 'import_daily_game',
      status: 'success',
      triggered_by: 'test@example.com',
      summary: { total: 10 }
    }, validSecret))
    expect(res.status).toBe(200)
  })
})
