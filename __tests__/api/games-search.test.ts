/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { GET } from '@/app/api/games/search/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

function get(qs: string) {
  return GET(new NextRequest(`http://localhost/api/games/search?${qs}`))
}

describe('GET /api/games/search', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { sqlMock.mockReset() })

  it('returns [] when neither q nor link given', async () => {
    const res = await get('')
    expect(await res.json()).toEqual({ results: [] })
    expect(sqlMock).not.toHaveBeenCalled()
  })

  it('searches by name when q is provided', async () => {
    sqlMock.mockResolvedValue([{ game_id: '1', title: 'Color Pop', app_link: 'x', icon_url: null }])
    const res = await get('q=color')
    expect(await res.json()).toEqual({
      results: [{ game_id: '1', title: 'Color Pop', app_link: 'x', icon_url: null }],
    })
    const text = (sqlMock.mock.calls[0][0] as string[]).join(' ')
    expect(text).toContain('ILIKE')
    // Verify the actual bound wildcard value was interpolated
    expect(sqlMock.mock.calls[0]).toContain('%color%')
  })

  it('matches by store id when link is provided', async () => {
    sqlMock.mockResolvedValue([{ game_id: '6757068097', title: 'X', app_link: 'l', icon_url: null }])
    const res = await get('link=' + encodeURIComponent('https://apps.apple.com/us/app/x/id6757068097'))
    const body = await res.json()
    expect(body.results[0].game_id).toBe('6757068097')
    // Verify sql was called and the parsed store id was bound as a parameter
    expect(sqlMock).toHaveBeenCalledTimes(1)
    expect(sqlMock.mock.calls[0]).toContain('6757068097')
  })

  it('returns [] for an unparseable link', async () => {
    const res = await get('link=' + encodeURIComponent('https://example.com/nope'))
    expect(await res.json()).toEqual({ results: [] })
    expect(sqlMock).not.toHaveBeenCalled()
  })
})
