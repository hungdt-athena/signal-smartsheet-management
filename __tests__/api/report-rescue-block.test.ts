/**
 * @jest-environment node
 */
// The Report used to call a game stale at 8 days while Rescue called it stale at 14,
// so the two screens pointed at different games with the same word. The payload now
// carries the Rescue scan itself. These tests pin the three things that must hold.
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: Object.assign(jest.fn(), { unsafe: jest.fn(() => '') }) }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn(() => Promise.resolve(null)) }))
jest.mock('@/lib/auth-guard', () => ({ requireRole: jest.fn(() => Promise.resolve(null)) }))
jest.mock('@/lib/report-config-db', () => ({
  loadReportConfig: jest.fn(() => Promise.resolve({
    config: { excluded: [], weights: { Volume: 40, Consistency: 15, Signal: 15, Survival: 15, Recording: 15 }, credibility: false },
    updatedAt: '2026-08-07T00:00:00Z',
  })),
}))

import { getServerSession } from 'next-auth'
import { GET } from '@/app/api/report/route'
import { sql } from '@/lib/db'
import { clearBatchSpanCache } from '@/lib/report-batches'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

function setupSql(opts: { rescueConfig?: Record<string, unknown> } = {}) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    // loadRescueConfig()
    if (q.includes('FROM app_config')) {
      return Promise.resolve(opts.rescueConfig ? [{ value: JSON.stringify(opts.rescueConfig) }] : [])
    }
    // scanRoster() - the final SELECT of the roster scan, distinct from the plain
    // roster lookup by the extra columns it pulls off evaluator_roster.
    if (q.includes('r.game_platform')) return Promise.resolve([])
    return Promise.resolve([])
  })
}

function getReport(opts: { role: string; self?: string; rescueConfig?: Record<string, unknown>; view?: string }) {
  sessionMock.mockResolvedValue({ user: { role: opts.role, name: opts.self || 'Boss' } })
  setupSql({ rescueConfig: opts.rescueConfig })
  const view = opts.view || 'batch'
  return GET(new NextRequest(`http://localhost/api/report?view=${view}`)).then((res) => res.json())
}

beforeEach(() => {
  clearBatchSpanCache()
})

describe('report payload: rescue block', () => {
  it('is present for a manager and reports the configured threshold', async () => {
    const body = await getReport({ role: 'admin', rescueConfig: { staleDays: 11 } })
    expect(body.staleDays).toBe(11)
    expect(body.rescue).not.toBeNull()
    expect(Array.isArray(body.rescue.sources)).toBe(true)
  })

  it('is absent for an evaluator, who still gets the threshold and their own count', async () => {
    const body = await getReport({ role: 'evaluator', self: 'phuongnt1' })
    expect(body.rescue).toBeNull()
    expect(body.staleDays).toBe(14)
    expect(typeof body.selfStale).toBe('number')
  })

  it('survives a batch window, where pipeline is null', async () => {
    const body = await getReport({ role: 'admin', view: 'batch' })
    expect(body.pipeline).toBeNull()
    expect(body.rescue).not.toBeNull()
    expect(body.stock).toBeDefined()
  })
})
