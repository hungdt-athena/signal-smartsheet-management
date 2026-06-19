/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/team/initial/weight/route'

const realFetch = global.fetch

function req(body: unknown) {
  return new NextRequest('http://localhost/api/team/initial/weight', {
    method: 'POST', body: JSON.stringify(body),
  } as never)
}

describe('POST /api/team/initial/weight', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true'; process.env.WEBHOOK_TEAM_INITIAL_WEIGHT = 'http://hook' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip; global.fetch = realFetch })

  it('rejects a weight outside 30/50/70/100', async () => {
    const r = await POST(req({ row_number: 2, weight: 60 }))
    expect(r.status).toBe(400)
  })

  it('forwards a valid weight to the webhook', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as never
    const r = await POST(req({ row_number: 2, weight: 70 }))
    expect(await r.json()).toEqual({ ok: true })
    expect(global.fetch).toHaveBeenCalledWith('http://hook', expect.objectContaining({ method: 'POST' }))
  })

  it('returns 502 when the webhook fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as never
    const r = await POST(req({ row_number: 2, weight: 70 }))
    expect(r.status).toBe(502)
  })
})
