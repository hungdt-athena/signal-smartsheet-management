/**
 * @jest-environment node
 */
import { NextRequest, NextResponse } from 'next/server'

jest.mock('@/lib/auth-guard', () => ({ requireAuth: jest.fn(async () => null) }))
jest.mock('@/lib/file-codes', () => ({
  ensureDemoCode: jest.fn(),
  ensureRecordCode: jest.fn(),
}))

import { POST } from '@/app/api/evaluations/demo-code/route'
import { requireAuth } from '@/lib/auth-guard'
import { ensureDemoCode } from '@/lib/file-codes'

const ensure = ensureDemoCode as jest.Mock
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/evaluations/demo-code', {
  method: 'POST', body: JSON.stringify(body),
} as never))

describe('POST /api/evaluations/demo-code', () => {
  beforeEach(() => { ensure.mockReset(); (requireAuth as jest.Mock).mockResolvedValue(null) })

  it('401 without a session', async () => {
    ;(requireAuth as jest.Mock).mockResolvedValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const res = await post({ gameId: 'g-1' })
    expect(res.status).toBe(401)
    expect(ensure).not.toHaveBeenCalled()
  })

  it('returns the code for a valid game, uncached', async () => {
    ensure.mockResolvedValue('ABC234')
    const res = await post({ gameId: 'g-1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ code: 'ABC234' })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(ensure).toHaveBeenCalledWith('g-1')
  })

  it('returns null for an unknown game', async () => {
    ensure.mockResolvedValue(null)
    const res = await post({ gameId: 'nope' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ code: null })
  })

  it('400 without a string gameId', async () => {
    for (const body of [{}, { gameId: 5 }, { gameId: '' }]) {
      const res = await post(body)
      expect(res.status).toBe(400)
    }
    expect(ensure).not.toHaveBeenCalled()
  })
})
