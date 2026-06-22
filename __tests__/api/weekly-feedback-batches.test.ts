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
    // Route now calls sql twice: first the batches query, then the evaluators
    // query. Branch on SQL text so each call gets the right rows.
    sqlMock.mockImplementation((strings: string[]) => {
      const text = strings.join(' ')
      if (text.includes('GROUP BY batch')) {
        return Promise.resolve([{ batch: 'W2 Jun, 2026' }, { batch: 'W1 Jun, 2026' }])
      }
      return Promise.resolve([{ name: 'Alice' }, { name: 'Bob' }])
    })
    const res = await GET()
    expect(await res.json()).toEqual({
      batches: ['W2 Jun, 2026', 'W1 Jun, 2026'],
      evaluators: ['Alice', 'Bob'],
    })
    // Batches query must NOT use SELECT DISTINCT: combined with the aggregate
    // ORDER BY it is a Postgres 42P10 error ("ORDER BY expressions must appear
    // in select list"). GROUP BY is what dedupes the labels.
    const batchesCall = sqlMock.mock.calls.find(c => (c[0] as string[]).join(' ').includes('GROUP BY batch'))!
    const batchesText = (batchesCall[0] as string[]).join(' ')
    expect(batchesText).toContain('GROUP BY batch')
    expect(batchesText).not.toContain('DISTINCT')
  })

  it('returns the distinct evaluator names', async () => {
    sqlMock.mockReset()
    sqlMock.mockImplementation((strings: string[]) => {
      const text = strings.join(' ')
      if (text.includes('GROUP BY batch')) {
        return Promise.resolve([{ batch: 'W2 Jun, 2026' }])
      }
      return Promise.resolve([{ name: 'Alice' }, { name: 'Bob' }])
    })
    const res = await GET()
    const body = await res.json()
    expect(body.evaluators).toEqual(['Alice', 'Bob'])
    // Evaluator query unions both evaluator columns.
    const evalCall = sqlMock.mock.calls.find(c => (c[0] as string[]).join(' ').includes('initial_evaluator'))!
    const evalText = (evalCall[0] as string[]).join(' ')
    expect(evalText).toContain('UNION')
    expect(evalText).toContain('final_evaluator')
  })
})
