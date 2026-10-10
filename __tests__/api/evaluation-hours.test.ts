/**
 * @jest-environment node
 */
import { NextRequest, NextResponse } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('@/lib/auth-guard', () => ({ requireAdmin: jest.fn(async () => null) }))

import { GET } from '@/app/api/admin/evaluation-hours/route'
import { sql } from '@/lib/db'
import { requireAdmin } from '@/lib/auth-guard'

const sqlMock = sql as unknown as jest.Mock
let calls: { text: string; binds: unknown[] }[] = []
beforeEach(() => {
  calls = []
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    calls.push({ text: (strings as string[]).join('$'), binds })
    return Promise.resolve([])
  })
})
const get = (q: string) => GET(new NextRequest(`http://localhost/api/admin/evaluation-hours?${q}`))

describe('GET /api/admin/evaluation-hours', () => {
  it('rejects bad or missing dates', async () => {
    expect((await get('from=2026-10-01')).status).toBe(400)
    expect((await get('from=2026-10-01&to=10/09/2026')).status).toBe(400)
    expect((await get('from=2026-10-09&to=2026-10-01')).status).toBe(400)
  })
  it('rejects ranges over 92 days', async () => {
    expect((await get('from=2026-01-01&to=2026-10-01')).status).toBe(400)
  })
  it('rejects calendar-impossible dates without calling the database', async () => {
    for (const q of ['from=2026-02-31&to=2026-03-05', 'from=2026-13-01&to=2026-13-02', 'from=2026-00-10&to=2026-00-11']) {
      const res = await get(q)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'from and to must be real dates (YYYY-MM-DD)' })
    }
    expect(calls).toHaveLength(0)
  })
  it('allows exactly 92 calendar days and rejects 93', async () => {
    expect((await get('from=2026-01-01&to=2026-04-02')).status).toBe(200)
    const res = await get('from=2026-01-01&to=2026-04-03')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'range over 92 days' })
  })
  it('returns the admin guard response and does not query when the guard blocks', async () => {
    ;(requireAdmin as jest.Mock).mockResolvedValueOnce(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
    const res = await get('from=2026-10-01&to=2026-10-09')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(calls).toHaveLength(0)
  })
  it('binds the VN dates and the default titles, and excludes NULL view_s', async () => {
    const res = await get('from=2026-10-01&to=2026-10-09')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ from: '2026-10-01', to: '2026-10-09', cap_s: 1800, titles: ['Fulltime', 'Freelancer'] })
    const timeQ = calls.find(c => /make_interval/.test(c.text))!
    expect(timeQ.text).toMatch(/view_s IS NOT NULL/)
    expect(timeQ.binds).toEqual(expect.arrayContaining(['2026-10-01', '2026-10-09', ['Fulltime', 'Freelancer']]))
  })
})
