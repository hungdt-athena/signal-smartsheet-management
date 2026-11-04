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
  getConfigValues: jest.fn(async () => ['List_Idea', 'Link_dead', 'Bypass', 'Pass']),
}))
jest.mock('@/lib/file-codes', () => ({
  ensureDemoCode: jest.fn(async () => 'ABC234'),
  ensureRecordCode: jest.fn(async () => 'XYZ234'),
}))

import { PATCH } from '@/app/api/evaluations/route'
import { sql } from '@/lib/db'
import { ensureDemoCode } from '@/lib/file-codes'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const ensure = ensureDemoCode as jest.Mock

const patchReq = (body: unknown) =>
  new NextRequest('http://localhost/api/evaluations', { method: 'PATCH', body: JSON.stringify(body) } as never)

function routeSql() {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const text = (strings as string[]).join(' ')
    if (/SELECT\s+initial_conclusion\b[^]*FROM game_evaluations/.test(text)) {
      return Promise.resolve([{ initial_conclusion: null, initial_note: null, initial_gameplay: null }])
    }
    return Promise.resolve([{ id: 1, game_id: 'g-42' }])
  })
}

describe('PATCH /api/evaluations: demo code on List_Idea', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => {
    ensure.mockClear()
    ensure.mockImplementation(async () => 'ABC234')
    routeSql()
    ;(getServerSession as jest.Mock).mockResolvedValue({ user: { role: 'admin', name: 'VinhTD' } })
  })

  const NOTE = 'Core loop is fine, meta is thin'

  it('ensures a demo code for the saved game when the conclusion is List_Idea', async () => {
    const res = await PATCH(patchReq({ id: 1, initial_conclusion: 'List_Idea', initial_note: NOTE }))
    expect(res.status).toBe(200)
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(ensure).toHaveBeenCalledWith('g-42')
  })

  it('does not for another conclusion', async () => {
    await PATCH(patchReq({ id: 1, initial_conclusion: 'Pass', initial_note: NOTE }))
    expect(ensure).not.toHaveBeenCalled()
  })

  it('does not when the conclusion is not in the request', async () => {
    await PATCH(patchReq({ id: 1, final_note: 'admin says hi' }))
    expect(ensure).not.toHaveBeenCalled()
  })

  it('a throwing helper never fails the save', async () => {
    ensure.mockRejectedValueOnce(new Error('boom'))
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const res = await PATCH(patchReq({ id: 1, initial_conclusion: 'List_Idea', initial_note: NOTE }))
    expect(res.status).toBe(200)
    expect((await res.json()).data.id).toBe(1)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
