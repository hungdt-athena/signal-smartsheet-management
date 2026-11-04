/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('@/lib/auth-guard', () => ({ requireManager: jest.fn(async () => null) }))
jest.mock('@/lib/session', () => ({ getSession: jest.fn(async () => ({ user: { name: 'VinhTD', role: 'moderator' } })) }))
jest.mock('@/lib/file-codes', () => ({
  ensureDemoCode: jest.fn(),
  ensureRecordCode: jest.fn(async () => 'XYZ234'),
}))

import { POST } from '@/app/api/evaluations/confirm-records/route'
import { sql } from '@/lib/db'
import { ensureRecordCode } from '@/lib/file-codes'

const sqlMock = sql as unknown as jest.Mock
const ensure = ensureRecordCode as jest.Mock

function routeSql(rows: unknown[]) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings) || !('raw' in (strings as object))) return { list: strings }
    const text = (strings as string[]).join(' ')
    if (!/^\s*(WITH|UPDATE|SELECT|INSERT)\b/.test(text)) return { frag: true }
    return Promise.resolve(Object.assign([...rows], { count: 2 }))
  })
}
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/evaluations/confirm-records', {
  method: 'POST', body: JSON.stringify(body),
} as never))

describe('POST confirm-records: record code', () => {
  beforeEach(() => { ensure.mockClear(); ensure.mockImplementation(async () => 'XYZ234') })

  it('ensures a record code once per distinct confirmed game', async () => {
    routeSql([{ confirmed: 3, game_ids: ['g-1', 'g-2'] }])
    const res = await post({ ids: [1, 2, 3] })
    expect(await res.json()).toEqual({ confirmed: 3 })
    expect(ensure).toHaveBeenCalledTimes(2)
    expect(ensure).toHaveBeenCalledWith('g-1')
    expect(ensure).toHaveBeenCalledWith('g-2')
  })

  it('does nothing on unset (reset to draft)', async () => {
    routeSql([])
    await post({ ids: [1, 2], unset: true })
    expect(ensure).not.toHaveBeenCalled()
  })

  it('nothing confirmed, no codes', async () => {
    routeSql([{ confirmed: 0, game_ids: null }])
    const res = await post({ ids: [1] })
    expect(res.status).toBe(200)
    expect(ensure).not.toHaveBeenCalled()
  })

  it('a throwing helper never fails the confirm', async () => {
    ensure.mockRejectedValue(new Error('boom'))
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    routeSql([{ confirmed: 2, game_ids: ['g-1', 'g-2'] }])
    const res = await post({ ids: [1, 2] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ confirmed: 2 })
    expect(ensure).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })
})
