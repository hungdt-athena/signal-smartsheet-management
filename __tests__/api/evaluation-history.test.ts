/**
 * @jest-environment node
 */
import { NextRequest, NextResponse } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('@/lib/auth-guard', () => ({ requireAuth: jest.fn(async () => null) }))

import { GET } from '@/app/api/evaluations/[gameId]/history/route'
import { sql } from '@/lib/db'
import { requireAuth } from '@/lib/auth-guard'

const sqlMock = sql as unknown as jest.Mock
let calls: { text: string; binds: unknown[] }[] = []
let logRows: unknown = []
let asgRows: unknown = []
beforeEach(() => {
  calls = []
  logRows = []
  asgRows = []
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    const text = (strings as string[]).join('$')
    calls.push({ text, binds })
    const rows = /evaluation_log/.test(text) ? logRows : asgRows
    return rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)
  })
})
const get = (gameId: string) =>
  GET(new NextRequest(`http://localhost/api/evaluations/${encodeURIComponent(gameId)}/history`), { params: { gameId } })

const LOG = {
  id: '5', at: new Date('2026-10-11T07:32:00Z'), actor: 'Alice', owner: 'Alice', source: 'panel', context: 'evaluate',
  kind: 'first', conclusion_before: null, conclusion_after: 'Bypass', final_before: null, final_after: null,
  batch_before: null, batch_after: null, bucket_before: null, bucket_after: null,
  recorder_before: null, recorder_after: null, owner_after: null, changed: true, view_s: 480, confidence: null,
}
const ASG = { id: 9, at: new Date('2026-10-10T02:00:00Z'), action: 'assign', evaluator_name: 'Alice', from_evaluator: null, by: 'cron' }

describe('GET /api/evaluations/[gameId]/history', () => {
  it('returns the guard response when not signed in', async () => {
    ;(requireAuth as jest.Mock).mockResolvedValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    expect((await get('com.foo')).status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('reads both tables by game_id and returns one list, newest first', async () => {
    logRows = [LOG]
    asgRows = [ASG]
    const res = await get('com.foo')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.log_ready).toBe(true)
    expect(body.events.map((e: { key: string }) => e.key)).toEqual(['log-5', 'asg-9'])
    expect(body.events[0]).toMatchObject({
      who: 'Alice', type: 'save', verb: 'evaluated', time: '8m', changes: [{ kind: 'initial', from: null, to: 'Bypass' }],
    })
    expect(body.events[1]).toMatchObject({
      who: 'Auto-assign', type: 'assign', verb: 'assigned to', changes: [{ kind: 'person', from: null, to: 'Alice' }],
    })

    const logCall = calls.find(c => /FROM evaluation_log/.test(c.text))!
    const asgCall = calls.find(c => /FROM assignment_history/.test(c.text))!
    expect(logCall.text).toMatch(/game_id = \$/)
    expect(logCall.binds).toContain('com.foo')
    expect(logCall.text).toMatch(/LIMIT 200/)
    expect(logCall.text).toMatch(/l\.batch_before, l\.batch_after/)
    expect(logCall.text).toMatch(/l\.bucket_before, l\.bucket_after, l\.recorder_before, l\.recorder_after, l\.owner_after/)
    expect(asgCall.text).toMatch(/= ANY\(ah\.game_ids\)/)
    expect(asgCall.binds).toContain('com.foo')
    expect(asgCall.text).toMatch(/LIMIT 100/)
  })

  it('passes a batch change through as a Batch line', async () => {
    logRows = [{ ...LOG, kind: 'revise', changed: false, conclusion_before: 'Bypass', conclusion_after: 'Bypass', batch_before: 'W1 Oct, 2026', batch_after: 'W2 Oct, 2026' }]
    const body = await (await get('com.foo')).json()
    expect(body.events[0]).toMatchObject({ verb: 'changed the batch', changes: [{ kind: 'batch', from: 'W1 Oct, 2026', to: 'W2 Oct, 2026' }] })
  })

  it('still returns the assignment history when migration 045 is missing', async () => {
    logRows = Object.assign(new Error('relation "evaluation_log" does not exist'), { code: '42P01' })
    asgRows = [ASG]
    const res = await get('com.foo')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.log_ready).toBe(false)
    expect(body.events).toHaveLength(1)
  })

  it('500s on any other database error', async () => {
    asgRows = new Error('boom')
    const res = await get('com.foo')
    expect(res.status).toBe(500)
  })
})
