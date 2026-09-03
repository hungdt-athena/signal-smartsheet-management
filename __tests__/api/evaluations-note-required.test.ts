/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => {
  const fn = jest.fn() as jest.Mock & { json: jest.Mock; begin: jest.Mock }
  fn.json = jest.fn((v: unknown) => v)
  fn.begin = jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(fn)))
  return { sql: fn }
})
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ authOptions: {} }))
jest.mock('@/lib/config', () => ({
  getConfigValues: jest.fn(async () => ['List_Idea', 'Link_dead', 'Bypass']),
}))

import { PATCH } from '@/app/api/evaluations/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock & { begin: jest.Mock }
const sessionMock = getServerSession as unknown as jest.Mock

function patchReq(body: unknown) {
  return new NextRequest('http://localhost/api/evaluations', {
    method: 'PATCH', body: JSON.stringify(body),
  } as never)
}

let calls: { text: string; binds: unknown[] }[] = []

/** Answers the row-state SELECT with `row`; everything else with one dummy row. */
function routeSql(row: { initial_conclusion: string | null }) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const text = (strings as string[]).join(' ')
    calls.push({ text, binds })
    if (/SELECT\s+initial_conclusion FROM game_evaluations/.test(text)) return Promise.resolve([row])
    return Promise.resolve([{ id: 1 }])
  })
  sqlMock.begin = jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(sqlMock)))
}

const updated = () => calls.some(c => /UPDATE game_evaluations/.test(c.text))

describe('/api/evaluations PATCH — initial note is required', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => {
    calls = []
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD' } })
  })

  it('rejects a short note', async () => {
    routeSql({ initial_conclusion: 'List_Idea' })
    const res = await PATCH(patchReq({ id: 1, initial_note: 'meh' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/at least 10/)
    expect(updated()).toBe(false)
  })

  it('rejects a first evaluation that leaves the note empty', async () => {
    routeSql({ initial_conclusion: null })
    const res = await PATCH(patchReq({ id: 1, initial_conclusion: 'List_Idea', initial_note: '' }))
    expect(res.status).toBe(400)
    expect(updated()).toBe(false)
  })

  it('rejects a short note written onto an already-evaluated game', async () => {
    routeSql({ initial_conclusion: 'List_Idea' })
    const res = await PATCH(patchReq({ id: 1, initial_note: 'bad' }))
    expect(res.status).toBe(400)
    expect(updated()).toBe(false)
  })

  it('accepts a first evaluation with a real note', async () => {
    routeSql({ initial_conclusion: null })
    const res = await PATCH(patchReq({ id: 1, initial_conclusion: 'List_Idea', initial_note: 'Core loop is fine, meta is thin' }))
    expect(res.status).toBe(200)
    expect(updated()).toBe(true)
  })

  it('blocks a legacy row whose short note is resent untouched', async () => {
    routeSql({ initial_conclusion: 'List_Idea' })
    const res = await PATCH(patchReq({ id: 1, initial_note: 'ok', drive_link: 'https://x' }))
    expect(res.status).toBe(400)
    expect(updated()).toBe(false)
  })

  it('exempts Link_dead', async () => {
    routeSql({ initial_conclusion: null })
    const res = await PATCH(patchReq({ id: 1, initial_conclusion: 'Link_dead', initial_note: '' }))
    expect(res.status).toBe(200)
    expect(updated()).toBe(true)
  })

  it('leaves a manager-only write alone when no note is sent', async () => {
    routeSql({ initial_conclusion: null })
    const res = await PATCH(patchReq({ id: 1, final_note: 'admin says hi' }))
    expect(res.status).toBe(200)
    expect(calls.some(c => /SELECT\s+initial_conclusion FROM game_evaluations/.test(c.text))).toBe(false)
  })
})
