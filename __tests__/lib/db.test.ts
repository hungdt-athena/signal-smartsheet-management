import { sql } from '@/lib/db'

jest.mock('postgres', () => {
  const mockSql = jest.fn()
  mockSql.mockResolvedValue([{ id: 1 }])
  return jest.fn(() => mockSql)
})

describe('db', () => {
  it('exports a sql function', () => {
    expect(typeof sql).toBe('function')
  })
})
