/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

import { GET } from '@/app/api/trends/options/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

describe('/api/trends/options', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  it('names the category groups each trend is defined for, so the picker can filter by the game\'s group', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } })
    sqlMock.mockReset()
    sqlMock.mockImplementation((strings: unknown) => {
      const text = Array.isArray(strings) ? (strings as string[]).join(' ') : ''
      if (/custom_field_definitions/.test(text)) {
        // A value may be defined under more than one category group: Signal Sense
        // (where the column is called `genre`) clones Puzzle's definitions into the
        // others with identical text.
        return Promise.resolve([
          { field_value: 'Block Puzzle', genre: 'puzzle' },
          { field_value: 'Farm Life', genre: 'arcade' },
          { field_value: 'Food Hunt', genre: 'arcade' },
          { field_value: 'Food Hunt', genre: 'puzzle' },
        ])
      }
      if (/sub_value_definitions/.test(text)) return Promise.resolve([{ id: 1, name: 'Theme' }])
      return Promise.resolve([])
    })

    const res = await GET(new NextRequest('http://localhost/api/trends/options'))
    expect(res.status).toBe(200)
    const body = await res.json()
    // `values` stays a flat, de-duplicated list: the admin review queue reads it
    // as-is and must not see a value twice because it has two category groups.
    expect(body.values).toEqual(['Block Puzzle', 'Farm Life', 'Food Hunt'])
    expect(body.categoryGroups).toEqual({
      'Block Puzzle': ['puzzle'],
      'Farm Life': ['arcade'],
      'Food Hunt': ['arcade', 'puzzle'],
    })
    expect(body.subValues).toEqual([{ id: 1, name: 'Theme' }])
  })
})
