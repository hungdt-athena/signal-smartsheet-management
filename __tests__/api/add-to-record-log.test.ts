/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('@/lib/auth-guard', () => ({ requireManager: jest.fn(async () => null) }))
jest.mock('@/lib/session', () => ({ getSession: jest.fn(async () => ({ user: { name: 'VinhTD', role: 'moderator' } })) }))
jest.mock('@/lib/config', () => ({ getConfigValues: jest.fn(async () => ['List_Idea', 'Bypass', 'Insight', 'Priority IV']) }))

import { POST } from '@/app/api/evaluations/add-to-record/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock
let calls: { text: string; binds: unknown[] }[] = []
beforeEach(() => {
  calls = []
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    calls.push({ text: (strings as string[]).join('$'), binds })
    return Promise.resolve([{ id: 7, game_id: 'g' }])
  })
})
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/evaluations/add-to-record', {
  method: 'POST', body: JSON.stringify(body),
} as never))
const logCall = () => calls.find(c => /INSERT INTO evaluation_log/.test(c.text))

describe('add-to-record logs itself', () => {
  it('override branch: one record_add row, no timing, same statement as the UPDATE', async () => {
    const res = await post({ game_id: 'g', category_group: 'puzzle', bucket: '5min', batch: 'W2 Oct, 2026',
      initial_evaluator: 'Shortcut', initial_conclusion: 'List_Idea', final_conclusion: 'Insight', final_evaluator: 'Shortcut' })
    expect(res.status).toBe(200)
    const c = logCall()!
    expect(c.text).toMatch(/FOR NO KEY UPDATE/)
    expect(c.text).toMatch(/FROM old WHERE ge\.id = old\.id/)
    expect(c.binds).toEqual(expect.arrayContaining(['VinhTD', 'moderator']))
    expect(c.text).toMatch(/'add_to_record',\s+'record_add',/)
    expect(c.text).toMatch(/batch_before, batch_after, bucket_after, owner_after\)/)
    expect(c.text).toMatch(/old\.batch, upd\.batch, \$::text, upd\.initial_evaluator\s+FROM old JOIN upd/)
    expect(c.text).toMatch(/RETURNING ge\.id, ge\.initial_evaluator,/)
    // bucket_after is the bucket param
    expect(c.binds[c.binds.length - 1]).toBe('5min')
    expect(c.text).not.toMatch(/view_s/)
    expect(c.text).not.toMatch(/ELSE (?!ge\.)[a-z_]+\s+END/)
    expect(c.text).not.toMatch(/COALESCE\(\$, (?!ge\.)[a-z_]+\)/)
  })

  it('legacy branch: also logs, auto-fill logic unchanged', async () => {
    await post({ game_id: 'g', category_group: 'puzzle', bucket: '20min' })
    const c = logCall()!
    // the auto-fill test is its own sql`` fragment, so it shows up as a separate call
    expect(calls.some(x => /\(ge\.initial_conclusion IS NULL OR ge\.initial_conclusion ILIKE '%bypass%'\)/.test(x.text))).toBe(true)
    expect(c.text).not.toMatch(/ELSE (?!ge\.)[a-z_]+\s+END/)
    expect(c.text).toMatch(/'add_to_record',\s+'record_add',/)
    expect(c.text).toMatch(/batch_before, batch_after, bucket_after, owner_after\)/)
    expect(c.text).toMatch(/old\.batch, upd\.batch, \$::text, upd\.initial_evaluator\s+FROM old JOIN upd/)
    expect(c.text).toMatch(/RETURNING ge\.id, ge\.initial_evaluator,/)
    expect(c.binds[c.binds.length - 1]).toBe('20min')
    // the verdict CASE (logKindSql) is gone from this route
    expect(calls.some(x => /WHEN NOT .* AND .* THEN 'final'/.test(x.text))).toBe(false)
    expect(c.text).toMatch(/evaluate_date, batch\s+FROM game_evaluations/)
  })
})

describe('add-to-record updates the row by the id from INSERT ... RETURNING', () => {
  it.each([
    ['override', { initial_evaluator: 'Shortcut', initial_conclusion: 'List_Idea' }],
    ['legacy', {}],
  ])('%s branch: old CTE selects WHERE id = the returned id, not (game_id, category_group)', async (_n, extra) => {
    sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
      if (!Array.isArray(strings)) return Promise.resolve([])
      const text = (strings as string[]).join('$')
      calls.push({ text, binds })
      if (/INSERT INTO game_evaluations/.test(text)) return Promise.resolve([{ id: 4242 }])
      return Promise.resolve([{ id: 4242, game_id: 'g' }])
    })
    await post({ game_id: 'g', category_group: 'puzzle', bucket: '5min', ...extra })
    const ins = calls.findIndex(c => /INSERT INTO game_evaluations/.test(c.text))
    expect(calls[ins].text).toMatch(/ON CONFLICT \(game_id, category_group\) DO NOTHING\s+RETURNING id/)
    const upd = calls.find(c => /UPDATE game_evaluations ge/.test(c.text))!
    expect(upd.text).toMatch(/FROM game_evaluations\s+WHERE id = \$\s+FOR NO KEY UPDATE/)
    expect(upd.text).not.toMatch(/category_group = \$\s+FOR NO KEY UPDATE/)
    expect(upd.binds).toContain(4242)
    expect(calls.indexOf(upd)).toBeGreaterThan(ins)
  })

  it('on conflict (no RETURNING row) it looks the id up first, preferring the asked group', async () => {
    sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
      if (!Array.isArray(strings)) return Promise.resolve([])
      const text = (strings as string[]).join('$')
      calls.push({ text, binds })
      if (/INSERT INTO game_evaluations/.test(text)) return Promise.resolve([])
      if (/SELECT id FROM game_evaluations WHERE game_id/.test(text)) return Promise.resolve([{ id: 99 }])
      return Promise.resolve([{ id: 99, game_id: 'g' }])
    })
    await post({ game_id: 'g', category_group: 'puzzle', bucket: '5min' })
    const upd = calls.find(c => /UPDATE game_evaluations ge/.test(c.text))!
    expect(upd.binds).toContain(99)
  })
})
