/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
const session = { user: { name: 'KietCD', role: 'evaluator' } }
jest.mock('@/lib/session', () => ({ getSession: jest.fn(async () => session) }))

import { GET } from '@/app/api/evaluations/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock
const texts = () => sqlMock.mock.calls.filter(c => Array.isArray(c[0])).map(c => (c[0] as string[]).join('?'))
// Values bound into the template fragments, flattened.
const values = () => sqlMock.mock.calls.filter(c => Array.isArray(c[0])).flatMap(c => c.slice(1))
const get = (qs: string) => GET(new NextRequest(`http://localhost/api/evaluations?${qs}`))

// Evaluators reach the Record tab now. Their rows there are the games they RECORD,
// whoever evaluated them: the evaluator scope must not also apply, or a recorder of a
// teammate's game would see nothing. And the recorder is always the session name.
describe('GET /api/evaluations: Record view for an evaluator', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'false' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => {
    sqlMock.mockReset()
    sqlMock.mockImplementation(() => Promise.resolve([]))
  })

  it('scopes by recorder, not by initial evaluator', async () => {
    await get('category=all&record_view=1&recorder=KietCD&limit=10&meta=0')
    expect(texts().some(q => q.includes('lower(ge.initial_evaluator) = lower('))).toBe(false)
    expect(texts().some(q => q.includes('ge.record_5min_assignee ='))).toBe(true)
  })

  it('ignores a ?recorder= that is not the signed-in evaluator', async () => {
    await get('category=all&record_view=1&recorder=HuyDD&limit=10&meta=0')
    expect(values()).toContain('KietCD')
    expect(values()).not.toContain('HuyDD')
  })

  it('outside the Record view an evaluator is still scoped to their own evaluations', async () => {
    await get('category=puzzle&limit=10&meta=0')
    expect(texts().some(q => q.includes('lower(ge.initial_evaluator) = lower('))).toBe(true)
  })
})
