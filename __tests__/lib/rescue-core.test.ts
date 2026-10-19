/**
 * @jest-environment node
 */
jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { scanRoster, selectStaleGames } from '@/lib/rescue-core'
import { sql } from '@/lib/db'
import { DEFAULT_RESCUE_CONFIG } from '@/lib/rescue-config'

const sqlMock = sql as unknown as jest.Mock

// postgres.js evaluates a nested `sql` fragment before the outer query, so every fragment
// and the outer query all land in mock.calls: [strings, ...values].
function sqlText() {
  return sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? (c[0] as string[]).join(' ') : '')).join('\n')
}
function sqlValues() {
  return sqlMock.mock.calls.flatMap(c => c.slice(1))
}

beforeEach(() => {
  sqlMock.mockReset()
  sqlMock.mockImplementation(() => Promise.resolve([]))
})

describe('lib/rescue-core range', () => {
  it('scanRoster adds no assigned_date bounds without a range, and staleAll is still selected', async () => {
    await scanRoster({ category: 'puzzle', config: DEFAULT_RESCUE_CONFIG })
    expect(sqlText()).not.toMatch(/assigned_date >=/)
    expect(sqlText()).not.toMatch(/assigned_date </)
    expect(sqlText()).toContain('stale_all')
  })

  it('scanRoster bounds stale and movable by from inclusive and to exclusive', async () => {
    await scanRoster({ category: 'puzzle', config: DEFAULT_RESCUE_CONFIG, range: { from: '2026-10-06', to: '2026-10-13' } })
    expect(sqlText()).toMatch(/assigned_date >= /)
    expect(sqlText()).toMatch(/assigned_date < /)
    expect(sqlValues()).toEqual(expect.arrayContaining(['2026-10-06', '2026-10-13']))
  })

  it('an open-ended range adds only the bound it has', async () => {
    await scanRoster({ category: 'puzzle', config: DEFAULT_RESCUE_CONFIG, range: { from: '2026-10-06', to: null } })
    expect(sqlText()).toMatch(/assigned_date >= /)
    expect(sqlText()).not.toMatch(/assigned_date < /)
  })

  it('maps stale_all, and falls back to stale when the column is absent', async () => {
    sqlMock.mockImplementation((strings: unknown) =>
      Promise.resolve(Array.isArray(strings) && (strings as string[]).join(' ').includes('FROM evaluator_roster')
        ? [{ name: 'A', game_platform: null, weight: null, today_available: true, pending: 9, stale: 2, stale_all: 7, movable: 2, evaluated_recent: 1 }]
        : []))
    const [row] = await scanRoster({ category: 'puzzle', config: DEFAULT_RESCUE_CONFIG, range: { from: '2026-10-06', to: '2026-10-13' } })
    expect(row).toMatchObject({ stale: 2, staleAll: 7, movable: 2 })
  })

  it('selectStaleGames applies the same bounds', async () => {
    await selectStaleGames({ category: 'puzzle', from: 'A', config: DEFAULT_RESCUE_CONFIG, range: { from: '2026-10-06', to: '2026-10-13' } })
    expect(sqlText()).toMatch(/assigned_date >= /)
    expect(sqlText()).toMatch(/assigned_date < /)
  })
})
