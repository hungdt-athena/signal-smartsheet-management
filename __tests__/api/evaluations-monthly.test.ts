/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { GET } from '@/app/api/evaluations/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

const BREAKDOWN = [
  { batch: 'W1 Oct, 2026', final_conclusion: 'Insight', category_group: 'puzzle', n: 9 },
  { batch: 'W1 Oct, 2026', final_conclusion: '(none)', category_group: 'puzzle', n: 48 },
]
const OCT = ['W1 Oct, 2026', 'W2 Oct, 2026', 'W3 Oct, 2026', 'W4 Oct, 2026']

// Same approach as evaluations.test.ts: answer by looking at the SQL text.
function setupSql() {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('GROUP BY 1, 2, 3')) return Promise.resolve(BREAKDOWN)
    if (q.includes('count(*)')) return Promise.resolve([{ total: 57, evaluated: 57 }])
    return Promise.resolve([])
  })
}
const templateTexts = () => sqlMock.mock.calls.filter(c => Array.isArray(c[0])).map(c => (c[0] as string[]).join(' '))
// sql(array) is the IN-list helper: called with a plain array, not a template.
const inLists = () => sqlMock.mock.calls.filter(c => Array.isArray(c[0]) && !(c[0] as { raw?: unknown }).raw).map(c => c[0] as string[])
const get = (qs: string) => GET(new NextRequest(`http://localhost/api/evaluations?${qs}`))

describe('GET /api/evaluations: Monthly view params', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(setupSql)

  it('category=all drops the category predicate; a named category keeps it', async () => {
    await get('category=all&limit=10&meta=0')
    expect(templateTexts().some(q => q.includes('ge.category_group ='))).toBe(false)
    setupSql()
    await get('category=puzzle&limit=10&meta=0')
    expect(templateTexts().some(q => q.includes('ge.category_group ='))).toBe(true)
  })

  it('batch_month filters to the four batch labels of that month', async () => {
    await get('category=all&batch_month=2026-10&limit=10')
    expect(inLists()).toContainEqual(OCT)
  })

  it('a malformed batch_month filters nothing', async () => {
    await get("category=all&batch_month=2026-1'; DROP&limit=10")
    expect(inLists()).not.toContainEqual(OCT)
    expect(templateTexts().some(q => q.includes('ge.batch IN'))).toBe(false)
  })

  it('an explicit batch is still filtered by equality when a month is given too', async () => {
    await get('category=all&batch_month=2026-10&batch=W2%20Oct%2C%202026&limit=10')
    expect(templateTexts().some(q => q.includes('ge.batch ='))).toBe(true)
  })

  it('breakdown=1 returns the per batch / final conclusion / category counts', async () => {
    const res = await get('category=all&batch_month=2026-10&breakdown=1&limit=10')
    expect((await res.json()).breakdown).toEqual(BREAKDOWN)
  })

  it('leaves the breakdown out unless asked, and does not scope it by final conclusion or batch', async () => {
    const plain = await (await get('category=puzzle&limit=10')).json()
    expect(plain.breakdown).toBeUndefined()

    setupSql()
    await get('category=puzzle&final_conclusions=Insight&batch=W1%20Oct%2C%202026&breakdown=1&limit=10')
    const breakdownCall = sqlMock.mock.calls.find(c => Array.isArray(c[0]) && (c[0] as string[]).join(' ').includes('GROUP BY 1, 2, 3'))
    expect(breakdownCall).toBeDefined()
    // Counts for the cards must not shrink to the selected card: the SQL text has no
    // final-conclusion or batch predicate of its own.
    const text = (breakdownCall as unknown as [string[]])[0].join(' ')
    expect(text).not.toContain('final_conclusion IN')
    expect(text).not.toContain('ge.batch =')
  })
})
