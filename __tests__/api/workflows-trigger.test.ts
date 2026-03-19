/**
 * @jest-environment node
 */
import { POST } from '@/app/api/workflows/trigger/route'
import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'

jest.mock('@/lib/db', () => ({ sql: jest.fn().mockResolvedValue([{ id: 1 }]) }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

const managerSession = { user: { email: 'mgr@test.com', role: 'manager', id: 1, name: 'Mgr' } }

describe('POST /api/workflows/trigger', () => {
  beforeEach(() => {
    ;(getServerSession as jest.Mock).mockResolvedValue(managerSession)
    global.fetch = jest.fn().mockResolvedValue({ ok: true })
    process.env.WEBHOOK_PULL_IOS = 'https://n8n.test/webhook/pull-ios'
  })

  it('returns 401 without manager session', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue(null)
    const req = new NextRequest('http://localhost/api/workflows/trigger', {
      method: 'POST',
      body: JSON.stringify({ workflow: 'pull_ios' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('returns 400 for unknown workflow', async () => {
    const req = new NextRequest('http://localhost/api/workflows/trigger', {
      method: 'POST',
      body: JSON.stringify({ workflow: 'unknown_workflow' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('inserts running log and returns triggered_at', async () => {
    const req = new NextRequest('http://localhost/api/workflows/trigger', {
      method: 'POST',
      body: JSON.stringify({ workflow: 'pull_ios' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.triggered_at).toBeDefined()
  })
})
