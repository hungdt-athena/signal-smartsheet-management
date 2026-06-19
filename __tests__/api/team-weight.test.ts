/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/google-sheets', () => ({ updateEvaluatorWeight: jest.fn() }))

import { POST } from '@/app/api/team/initial/weight/route'
import { updateEvaluatorWeight } from '@/lib/google-sheets'

const updateMock = updateEvaluatorWeight as unknown as jest.Mock

function req(body: unknown) {
  return new NextRequest('http://localhost/api/team/initial/weight', {
    method: 'POST', body: JSON.stringify(body),
  } as never)
}

describe('POST /api/team/initial/weight', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => updateMock.mockReset())

  it('rejects a weight outside 30/50/70/100', async () => {
    const r = await POST(req({ row_number: 2, weight: 60 }))
    expect(r.status).toBe(400)
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('rejects a missing row_number', async () => {
    const r = await POST(req({ weight: 70 }))
    expect(r.status).toBe(400)
  })

  it('writes a valid weight to the sheet', async () => {
    updateMock.mockResolvedValue(undefined)
    const r = await POST(req({ row_number: 2, weight: 70 }))
    expect(await r.json()).toEqual({ ok: true })
    expect(updateMock).toHaveBeenCalledWith(2, 70)
  })

  it('returns 502 when the sheet write fails', async () => {
    updateMock.mockRejectedValue(new Error('sheet down'))
    const r = await POST(req({ row_number: 2, weight: 70 }))
    expect(r.status).toBe(502)
  })
})
