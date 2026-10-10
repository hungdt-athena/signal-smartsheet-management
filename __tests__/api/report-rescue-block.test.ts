/**
 * @jest-environment node
 */
// The Report used to call a game stale at 8 days while Rescue called it stale at 14,
// so the two screens pointed at different games with the same word. The payload now
// carries the Rescue scan itself. These tests pin what must hold.
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: Object.assign(jest.fn(), { unsafe: jest.fn(() => '') }) }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn(() => Promise.resolve(null)) }))
jest.mock('@/lib/auth-guard', () => ({ requireRole: jest.fn(() => Promise.resolve(null)) }))
jest.mock('@/lib/report-config-db', () => ({
  loadReportConfig: jest.fn(() => Promise.resolve({
    config: { excluded: [], weights: { Volume: 40, Consistency: 20, Signal: 20, Survival: 20 }, credibility: false },
    updatedAt: '2026-08-07T00:00:00Z',
  })),
}))

import { getServerSession } from 'next-auth'
import { GET } from '@/app/api/report/route'
import { sql } from '@/lib/db'
import { clearBatchSpanCache } from '@/lib/report-batches'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

const BUCKETS = ['puzzle', 'arcade', 'simulation']

// Every bucket the roster scan was actually run for, in call order. The scan's
// category is a BIND VALUE, not part of the query text, so it has to be read off the
// template's interpolations - which is exactly the thing the old version of this file
// never looked at, and why it stayed green while `category=all` scanned nothing.
let scannedBuckets: string[] = []

type ScanRow = {
  name: string
  pending: number
  stale: number
  movable: number
  evaluated_recent: number
  game_platform?: string | null
  weight?: number | null
  today_available?: boolean
}

function setupSql(opts: {
  rescueConfig?: Record<string, unknown>
  // roster rows to answer the scan with, per bucket
  scan?: Record<string, ScanRow[]>
} = {}) {
  scannedBuckets = []
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...vals: unknown[]) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    // loadRescueConfig()
    if (q.includes('FROM app_config')) {
      return Promise.resolve(opts.rescueConfig ? [{ value: JSON.stringify(opts.rescueConfig) }] : [])
    }
    // scanRoster() - the final SELECT of the roster scan, distinct from the plain
    // roster lookup by the extra columns it pulls off evaluator_roster.
    if (q.includes('r.game_platform')) {
      const cats = vals.filter((v): v is string => typeof v === 'string' && BUCKETS.includes(v))
      const cat = cats[cats.length - 1] ?? '(none)'
      scannedBuckets.push(cat)
      const rows = opts.scan?.[cat] ?? []
      return Promise.resolve(rows.map((r) => ({
        game_platform: null, weight: null, today_available: true, ...r,
      })))
    }
    return Promise.resolve([])
  })
}

function getReport(opts: {
  role: string
  self?: string
  rescueConfig?: Record<string, unknown>
  view?: string
  category?: string
  scan?: Record<string, ScanRow[]>
}) {
  sessionMock.mockResolvedValue({ user: { role: opts.role, name: opts.self || 'Boss' } })
  setupSql({ rescueConfig: opts.rescueConfig, scan: opts.scan })
  const view = opts.view || 'batch'
  const cat = opts.category ? `&category=${opts.category}` : ''
  return GET(new NextRequest(`http://localhost/api/report?view=${view}${cat}`)).then((res) => res.json())
}

beforeEach(() => {
  clearBatchSpanCache()
})

describe('report payload: rescue block', () => {
  it('is present for a manager and reports the configured threshold', async () => {
    const body = await getReport({ role: 'admin', category: 'puzzle', rescueConfig: { staleDays: 11 } })
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
    const body = await getReport({ role: 'admin', view: 'batch', category: 'puzzle' })
    expect(body.pipeline).toBeNull()
    expect(body.rescue).not.toBeNull()
    expect(body.stock).toBeDefined()
  })

  it('scans the one bucket the Category filter names', async () => {
    await getReport({ role: 'admin', category: 'arcade' })
    expect(scannedBuckets).toEqual(['arcade'])
  })

  // The bug this covers: `category` defaults to 'all' and "All" is a segment on the
  // filter bar, but `category_group` only ever holds a bucket name - so ONE scan for
  // 'all' matched no rows at all, and Overview printed its no-receivers fallback over
  // a team that had receivers in every bucket.
  it('scans every bucket when the filter says All, and merges them per person', async () => {
    const body = await getReport({
      role: 'admin',
      category: 'all',
      scan: {
        // Ann is a SOURCE in puzzle (20 pending, 5 movable) and would read as a
        // RECEIVER in arcade on its own. Source has to win.
        puzzle: [
          { name: 'Ann', pending: 20, stale: 5, movable: 5, evaluated_recent: 2 },
          { name: 'Bob', pending: 2, stale: 0, movable: 0, evaluated_recent: 1 },
        ],
        arcade: [
          { name: 'Ann', pending: 3, stale: 0, movable: 0, evaluated_recent: 4 },
          { name: 'Bob', pending: 4, stale: 0, movable: 0, evaluated_recent: 3 },
        ],
        simulation: [
          { name: 'Bob', pending: 1, stale: 0, movable: 0, evaluated_recent: 1 },
        ],
      },
    })
    expect(scannedBuckets.sort()).toEqual(['arcade', 'puzzle', 'simulation'])

    const sources = body.rescue.sources as Array<{ name: string; stale: number; movable: number }>
    const receivers = body.rescue.receivers as Array<{ name: string; pending: number }>
    // Source in one bucket, receiver in another: source.
    expect(sources.map((s) => s.name)).toEqual(['Ann'])
    expect(receivers.map((r) => r.name)).toEqual(['Bob'])
    // Named once, not once per bucket.
    expect(receivers).toHaveLength(1)
    // And the counts are sums across the three buckets, not one bucket's.
    expect(receivers[0].pending).toBe(7)
    expect(sources[0].stale).toBe(5)
    expect(sources[0].movable).toBe(5)
    expect(body.rescue.movableTotal).toBe(5)
  })
})
