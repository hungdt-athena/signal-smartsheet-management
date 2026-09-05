/**
 * @jest-environment node
 */
jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { loadHiddenEvaluatorKeys } from '@/lib/people-config-db'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

function mockDb({ hidden = [] as string[], inactive = [] as string[] } = {}) {
  sqlMock.mockImplementation((strings: string[]) => {
    const text = strings.join(' ')
    if (text.includes('dashboard_users')) return Promise.resolve(inactive.map(key => ({ key })))
    return Promise.resolve([{ value: JSON.stringify({ hiddenInFilters: hidden }) }])
  })
}

describe('loadHiddenEvaluatorKeys', () => {
  beforeEach(() => sqlMock.mockReset())

  it('unions the Config toggles with every deactivated user', async () => {
    mockDb({ hidden: ['thudt'], inactive: ['oldguy'] })
    expect((await loadHiddenEvaluatorKeys()).sort()).toEqual(['oldguy', 'shortcut', 'thudt'])
  })

  it('dedupes someone who is both deactivated and toggled off', async () => {
    mockDb({ hidden: ['oldguy'], inactive: ['oldguy'] })
    expect(await loadHiddenEvaluatorKeys()).toEqual(['oldguy', 'shortcut'])
  })

  it('always hides the system labels, even with nothing configured', async () => {
    mockDb()
    expect(await loadHiddenEvaluatorKeys()).toEqual(['shortcut'])
  })

  it('still hides the system labels when the database is unreachable', async () => {
    sqlMock.mockRejectedValue(new Error('connection refused'))
    expect(await loadHiddenEvaluatorKeys()).toEqual(['shortcut'])
  })
})
