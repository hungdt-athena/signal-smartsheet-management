/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: Object.assign(jest.fn(), { json: (v: unknown) => v }) }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ authOptions: {} }))

import { GET, PUT } from '@/app/api/weekly-feedback/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

function getReq(qs: string) {
  return GET(new NextRequest(`http://localhost/api/weekly-feedback?${qs}`))
}
function putReq(body: unknown) {
  return PUT(new NextRequest('http://localhost/api/weekly-feedback', {
    method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }))
}

describe('/api/weekly-feedback', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeEach(() => { process.env.SKIP_AUTH = ''; sqlMock.mockReset(); sessionMock.mockReset() })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  it('GET list forces evaluator to the session user for a non-manager', async () => {
    sessionMock.mockResolvedValue({ user: { name: 'Alice', role: 'evaluator' } })
    sqlMock.mockResolvedValue([])
    await getReq('evaluator=Bob') // attempts to read Bob's
    const text = (sqlMock.mock.calls[0][0] as string[]).join(' ')
    expect(text).toContain('lower(evaluator)')
    // bound param is Alice, not Bob — assert on the interpolated value directly
    // (sqlMock is called as sql`...${v}...` so calls[0] is [stringsArray, ...values])
    const boundValues = sqlMock.mock.calls[0].slice(1)
    expect(boundValues).toContain('Alice')
    expect(boundValues).not.toContain('Bob')
  })

  it('PUT blocks writing to another evaluator (403)', async () => {
    sessionMock.mockResolvedValue({ user: { name: 'Alice', role: 'admin' } })
    const res = await putReq({ batch: 'W1 Jun, 2026', evaluator: 'Bob', feedback: {}, game_alike: [] })
    expect(res.status).toBe(403)
  })

  it('PUT upserts for the session user', async () => {
    sessionMock.mockResolvedValue({ user: { name: 'Alice', role: 'evaluator' } })
    sqlMock.mockResolvedValue([{ batch: 'W1 Jun, 2026', evaluator: 'Alice', feedback: {}, game_alike: [], updated_at: 'now' }])
    const res = await putReq({ batch: 'W1 Jun, 2026', feedback: { type: 'doc' }, game_alike: [] })
    expect(res.status).toBe(200)
    const text = (sqlMock.mock.calls[0][0] as string[]).join(' ')
    expect(text).toContain('ON CONFLICT')
  })

  it('PUT rejects a missing batch (400)', async () => {
    sessionMock.mockResolvedValue({ user: { name: 'Alice', role: 'evaluator' } })
    const res = await putReq({ feedback: {}, game_alike: [] })
    expect(res.status).toBe(400)
  })

  it('PUT sanitizes game_alike: nulls unsafe app_link/icon_url, keeps safe ones', async () => {
    sessionMock.mockResolvedValue({ user: { name: 'Alice', role: 'evaluator' } })
    sqlMock.mockResolvedValue([{ batch: 'W1 Jun, 2026', evaluator: 'Alice', feedback: {}, game_alike: [], updated_at: 'now' }])
    await putReq({
      batch: 'W1 Jun, 2026',
      feedback: { type: 'doc' },
      game_alike: [
        {
          name: 'Section A',
          games: [
            { game_id: '1', title: 'GameOne', app_link: 'javascript:alert(1)', icon_url: 'https://example.com/icon.png' },
            { game_id: '2', title: 'GameTwo', app_link: 'https://apps.apple.com/app/id123', icon_url: 'data:text/html,x' },
          ],
        },
      ],
    })
    // sql is called as a tagged template: calls[0] = [stringsArray, ...values]
    const boundValues = sqlMock.mock.calls[0].slice(1)
    const gameAlikeArg = boundValues.find((v: unknown) => Array.isArray(v)) as Array<{ games: Array<{ app_link: unknown; icon_url: unknown }> }>
    expect(gameAlikeArg).toBeDefined()
    const games = gameAlikeArg[0].games
    // game[0]: unsafe app_link nulled, safe icon_url kept
    expect(games[0].app_link).toBeNull()
    expect(games[0].icon_url).toBe('https://example.com/icon.png')
    // game[1]: safe app_link kept, unsafe icon_url nulled
    expect(games[1].app_link).toBe('https://apps.apple.com/app/id123')
    expect(games[1].icon_url).toBeNull()
  })
})
