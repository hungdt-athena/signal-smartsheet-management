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

import { GET as pendingGET } from '@/app/api/playtest-tags/pending/route'
import { GET as historyGET } from '@/app/api/playtest-tags/history/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

let calls: { text: string; binds: unknown[] }[] = []

function routeSql() {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    calls.push({ text: (strings as string[]).join(' '), binds })
    return Promise.resolve([])
  })
}

const pending = (qs = '') => pendingGET(new NextRequest(`http://localhost/api/playtest-tags/pending${qs}`) as never)
const history = (qs = '') => historyGET(new NextRequest(`http://localhost/api/playtest-tags/history${qs}`) as never)

/** The category-group predicate reaches sql() as a nested template, so it is recorded as a
 *  call of its own -- bound to the group, and keyed on the game's category_group column. */
const categoryGroupFilters = () => calls.filter(c => /category_group =/.test(c.text) && c.binds.length > 0)

// The Tagging tab's Category group filter. Pending and History narrow by the GAME's category group
// (game_evaluations.category_group), not by anything stamped on the tag row:
// Signal Sense's own genre column on a tag defaults to puzzle and says nothing
// about the game it is on.
describe('Tagging category-group filter', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => {
    calls = []
    routeSql()
    sessionMock.mockResolvedValue({ user: { role: 'admin', email: 'vinhtd@athena.studio' } })
  })

  describe('GET /pending', () => {
    it('applies no category-group predicate when none is asked for', async () => {
      expect((await pending()).status).toBe(200)
      expect(categoryGroupFilters()).toHaveLength(0)
    })

    // Rows and count alike: "3 of 40" counted over every genre would page the
    // reader through rows the filter is hiding.
    it('narrows the rows and the total to one category group', async () => {
      expect((await pending('?category_group=arcade')).status).toBe(200)
      const f = categoryGroupFilters()
      expect(f).toHaveLength(2)
      for (const x of f) expect(x.binds).toEqual(['arcade'])
    })

    it('treats "all" as no filter', async () => {
      expect((await pending('?category_group=all')).status).toBe(200)
      expect(categoryGroupFilters()).toHaveLength(0)
    })

    it('rejects a category group that is not one of the three', async () => {
      const res = await pending('?category_group=strategy')
      expect(res.status).toBe(400)
      expect(calls).toHaveLength(0)
    })

    it('hands each row back with its game\'s category group', async () => {
      await pending()
      const select = calls.find(c => /FROM playtest_tags pt/.test(c.text) && /initial_evaluator/.test(c.text))
      expect(select?.text).toMatch(/category_group/)
    })
  })

  describe('GET /history', () => {
    it('applies no category-group predicate when none is asked for', async () => {
      expect((await history()).status).toBe(200)
      expect(categoryGroupFilters()).toHaveLength(0)
    })

    it('narrows the rows and the total to one category group', async () => {
      expect((await history('?category_group=simulation')).status).toBe(200)
      const f = categoryGroupFilters()
      expect(f).toHaveLength(1)
      expect(f[0].binds).toEqual(['simulation'])
    })

    it('rejects a category group that is not one of the three', async () => {
      const res = await history('?category_group=strategy')
      expect(res.status).toBe(400)
      expect(calls).toHaveLength(0)
    })
  })
})
