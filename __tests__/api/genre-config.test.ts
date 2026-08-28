/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

import { GET, PUT } from '@/app/api/genre-config/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sessionMock = getServerSession as jest.Mock
const sqlMock = sql as unknown as jest.Mock

function setupSql({
  config = '{"puzzle":true,"arcade":false,"simulation":false}' as string | null,
  roster = [{ category_group: 'puzzle', available: '7' }] as Record<string, unknown>[],
}) {
  // A one-key stand-in for app_config: a read after a write must see the write,
  // the way it does in Postgres, or a round-trip assertion proves nothing.
  let stored = config
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...values: unknown[]) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('INSERT INTO app_config')) { stored = values[1] as string; return Promise.resolve([]) }
    if (q.includes('FROM app_config')) return Promise.resolve(stored === null ? [] : [{ value: stored }])
    if (q.includes('FROM evaluator_roster')) return Promise.resolve(roster)
    return Promise.resolve([])
  })
}

const as = (role: string | null) =>
  sessionMock.mockResolvedValue(role ? { user: { role, name: 'X' } } : null)

const put = (body: unknown) =>
  PUT(new NextRequest('http://localhost/api/genre-config', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))

const writes = () => sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? c[0].join(' ') : '')).join('\n')

describe('/api/genre-config', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'false' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => setupSql({}))

  describe('GET', () => {
    it('lets an evaluator read the genre state', async () => {
      as('evaluator')
      const res = await GET()
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.genres).toEqual([
        { bucket: 'puzzle', enabled: true, available: 7, active: true },
        { bucket: 'arcade', enabled: false, available: 0, active: false },
        { bucket: 'simulation', enabled: false, available: 0, active: false },
      ])
    })

    it('tells the client whether it may write, so the UI need not know the rule', async () => {
      as('moderator')
      expect((await (await GET()).json()).canEdit).toBe(false)
      as('admin')
      expect((await (await GET()).json()).canEdit).toBe(true)
    })

    it('rejects an anonymous read with 401', async () => {
      as(null)
      expect((await GET()).status).toBe(401)
    })
  })

  describe('PUT', () => {
    it('lets an admin turn a genre on', async () => {
      as('admin')
      const res = await put({ bucket: 'arcade', enabled: true })
      expect(res.status).toBe(200)
      expect((await res.json()).genres).toContainEqual(
        { bucket: 'arcade', enabled: true, available: 0, active: false },
      )
      expect(writes()).toContain('INSERT INTO app_config')
    })

    it('writes the whole blob, keeping the genres it did not touch', async () => {
      as('admin')
      await put({ bucket: 'simulation', enabled: true })
      const saved = sqlMock.mock.calls.flatMap(c => c.slice(1)).find(a => typeof a === 'string' && a.includes('puzzle'))
      expect(JSON.parse(saved as string)).toEqual({ puzzle: true, arcade: false, simulation: true })
    })

    it('refuses a moderator with 403 and writes nothing', async () => {
      as('moderator')
      expect((await put({ bucket: 'arcade', enabled: true })).status).toBe(403)
      expect(writes()).not.toContain('INSERT INTO app_config')
    })

    it('rejects an unknown genre with 400', async () => {
      as('admin')
      expect((await put({ bucket: 'rpg', enabled: true })).status).toBe(400)
    })

    it('rejects a non-boolean enabled with 400', async () => {
      as('admin')
      expect((await put({ bucket: 'arcade', enabled: 'yes' })).status).toBe(400)
    })
  })
})
