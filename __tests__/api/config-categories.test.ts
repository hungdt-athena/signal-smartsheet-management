/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { GET, POST } from '@/app/api/config/categories/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

function req(url: string, init?: RequestInit) {
  return new NextRequest(`http://localhost${url}`, init as never)
}

describe('/api/config/categories', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => sqlMock.mockReset())

  it('GET groups active genres by bucket', async () => {
    sqlMock.mockResolvedValueOnce([
      { genre: 'puzzle', category_group: 'puzzle' },
      { genre: 'word', category_group: 'puzzle' },
      { genre: 'arcade', category_group: 'arcade' },
    ])
    const res = await GET(req('/api/config/categories'))
    const json = await res.json()
    expect(json.puzzle).toEqual(['puzzle', 'word'])
    expect(json.arcade).toEqual(['arcade'])
    expect(json.simulation).toEqual([])
  })

  it('GET?check returns exists=true when game_info has the genre', async () => {
    sqlMock.mockResolvedValueOnce([{ one: 1 }])
    const res = await GET(req('/api/config/categories?check=Puzzle'))
    expect(await res.json()).toEqual({ exists: true })
  })

  it('GET?check returns exists=false for an unknown genre', async () => {
    sqlMock.mockResolvedValueOnce([])
    const res = await GET(req('/api/config/categories?check=zzz'))
    expect(await res.json()).toEqual({ exists: false })
  })

  it('POST rejects an invalid bucket', async () => {
    const res = await POST(req('/api/config/categories', {
      method: 'POST',
      body: JSON.stringify({ genre: 'foo', category_group: 'rpg' }),
    }))
    expect(res.status).toBe(400)
  })

  it('POST inserts a mapping', async () => {
    sqlMock.mockResolvedValueOnce([])
    const res = await POST(req('/api/config/categories', {
      method: 'POST',
      body: JSON.stringify({ genre: 'Roguelike', category_group: 'arcade' }),
    }))
    expect(await res.json()).toEqual({ ok: true })
    expect(sqlMock).toHaveBeenCalled()
  })
})
