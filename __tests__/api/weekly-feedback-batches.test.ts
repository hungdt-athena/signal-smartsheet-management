/**
 * @jest-environment node
 */
jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
import { GET } from '@/app/api/weekly-feedback/batches/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

describe('GET /api/weekly-feedback/batches', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  it('returns the distinct batch labels', async () => {
    sqlMock.mockReset()
    sqlMock.mockResolvedValue([{ batch: 'W2 Jun, 2026' }, { batch: 'W1 Jun, 2026' }])
    const res = await GET()
    expect(await res.json()).toEqual({ batches: ['W2 Jun, 2026', 'W1 Jun, 2026'] })
    const text = (sqlMock.mock.calls[0][0] as string[]).join(' ')
    expect(text).toContain('DISTINCT')
  })
})
