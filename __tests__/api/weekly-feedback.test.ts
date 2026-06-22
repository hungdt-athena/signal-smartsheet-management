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

  it('PUT strips unsafe gameMention node href, keeps safe ones', async () => {
    sessionMock.mockResolvedValue({ user: { name: 'Alice', role: 'evaluator' } })
    sqlMock.mockResolvedValue([{ batch: 'W1 Jun, 2026', evaluator: 'Alice', feedback: null, game_alike: null, updated_at: 'now' }])
    await putReq({
      batch: 'W1 Jun, 2026',
      feedback: {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [
            { type: 'gameMention', attrs: { gameId: '1', title: 'Bad Game', href: 'javascript:alert(1)', icon: null } },
            { type: 'gameMention', attrs: { gameId: '2', title: 'Good Game', href: 'https://apps.apple.com/app/id123', icon: null } },
          ],
        }],
      },
      game_alike: null,
    })
    // sql`...` → calls[0] = [stringsArray, batch, evaluator, feedbackDoc, gameAlikeDoc]
    const boundValues = sqlMock.mock.calls[0].slice(1)
    const feedbackDoc = boundValues[2] as { content: Array<{ content: Array<{ attrs: { href: string | null } }> }> }
    const nodes = feedbackDoc.content[0].content
    // unsafe href must be nulled
    expect(nodes[0].attrs.href).toBeNull()
    // safe https href must be kept
    expect(nodes[1].attrs.href).toBe('https://apps.apple.com/app/id123')
  })

  it('PUT strips unsafe link-mark hrefs from the game_alike doc, keeps safe ones', async () => {
    sessionMock.mockResolvedValue({ user: { name: 'Alice', role: 'evaluator' } })
    sqlMock.mockResolvedValue([{ batch: 'W1 Jun, 2026', evaluator: 'Alice', feedback: null, game_alike: null, updated_at: 'now' }])
    // game_alike is now a Tiptap doc (free rich text + inline game links), so it
    // is sanitized exactly like feedback: link marks with unsafe hrefs are dropped.
    await putReq({
      batch: 'W1 Jun, 2026',
      feedback: null,
      game_alike: {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bad', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
            { type: 'text', text: 'good', marks: [{ type: 'link', attrs: { href: 'https://ok.example/app' } }] },
          ],
        }],
      },
    })
    // sql is a tagged template: calls[0] = [stringsArray, batch, evaluator, feedbackDoc, gameAlikeDoc]
    const boundValues = sqlMock.mock.calls[0].slice(1)
    const gameAlikeDoc = boundValues[3] as { content: Array<{ content: Array<{ marks: Array<{ attrs: { href: string } }> }> }> }
    const inline = gameAlikeDoc.content[0].content
    // 'bad' text: javascript: link mark removed
    expect(inline[0].marks).toHaveLength(0)
    // 'good' text: https link mark kept
    expect(inline[1].marks[0].attrs.href).toBe('https://ok.example/app')
  })
})
