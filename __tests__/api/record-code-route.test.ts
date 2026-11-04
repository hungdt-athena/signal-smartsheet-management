/**
 * @jest-environment node
 */
import { NextRequest, NextResponse } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('@/lib/auth-guard', () => ({ requireAuth: jest.fn(async () => null) }))
jest.mock('@/lib/file-codes', () => ({
  ensureDemoCode: jest.fn(),
  ensureRecordCode: jest.fn(),
}))

import { POST } from '@/app/api/evaluations/record-code/route'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { ensureRecordCode } from '@/lib/file-codes'

const sqlMock = sql as unknown as jest.Mock
const ensure = ensureRecordCode as jest.Mock
let statements: string[]
let confirmedGames: Set<string>

const post = (body: unknown) => POST(new NextRequest('http://localhost/api/evaluations/record-code', {
  method: 'POST', body: JSON.stringify(body),
} as never))

beforeEach(() => {
  ensure.mockReset()
  ;(requireAuth as jest.Mock).mockResolvedValue(null)
  statements = []
  confirmedGames = new Set()
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: string[], ...binds: unknown[]) => {
    const text = strings.join('$')
    statements.push(text)
    const gameId = binds[0] as string
    return Promise.resolve(confirmedGames.has(gameId) ? [{ ok: 1 }] : [])
  })
})

describe('POST /api/evaluations/record-code', () => {
  it('401 without a session', async () => {
    ;(requireAuth as jest.Mock).mockResolvedValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const res = await post({ gameId: 'g-1' })
    expect(res.status).toBe(401)
    expect(ensure).not.toHaveBeenCalled()
    expect(sqlMock).not.toHaveBeenCalled()
  })

  it('400 without a string gameId', async () => {
    for (const body of [{}, { gameId: 5 }, { gameId: '' }]) {
      const res = await post(body)
      expect(res.status).toBe(400)
    }
    expect(ensure).not.toHaveBeenCalled()
  })

  it('returns null and writes nothing when no bucket of the game is Confirmed', async () => {
    const res = await post({ gameId: 'g-draft' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ code: null })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(ensure).not.toHaveBeenCalled()
    expect(statements.some((s) => /UPDATE|INSERT/i.test(s))).toBe(false)
    // The check reads both bucket confirm stamps.
    expect(statements[0]).toMatch(/record_5min_confirmed_at IS NOT NULL/)
    expect(statements[0]).toMatch(/record_20min_confirmed_at IS NOT NULL/)
  })

  it('returns the code when the game has a Confirmed bucket, uncached', async () => {
    confirmedGames.add('g-1')
    ensure.mockResolvedValue('XYZ234')
    const res = await post({ gameId: 'g-1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ code: 'XYZ234' })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(ensure).toHaveBeenCalledWith('g-1')
  })

  it('returns null for an unknown game', async () => {
    const res = await post({ gameId: 'nope' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ code: null })
    expect(ensure).not.toHaveBeenCalled()
  })

  it('returns null when the Confirmed game has no game_info row', async () => {
    confirmedGames.add('g-orphan')
    ensure.mockResolvedValue(null)
    const res = await post({ gameId: 'g-orphan' })
    expect(await res.json()).toEqual({ code: null })
  })

  it('500 when the helper throws', async () => {
    confirmedGames.add('g-1')
    ensure.mockRejectedValue(new Error('boom'))
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post({ gameId: 'g-1' })
    expect(res.status).toBe(500)
  })
})
