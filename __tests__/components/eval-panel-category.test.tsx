import fs from 'node:fs'
import path from 'node:path'
import { fetchEvalByGameId } from '@/components/EvalDetailPanel'

// A game can have a row in two genres, assigned to two people. Every list that
// opens the Evaluate panel is per genre, so the panel must ask for THAT genre's
// row. It used to ask by game_id alone and got whichever row came back first:
// DuyenLP's pending puzzle game opened on HuyDD's arcade evaluation (2026-09-24).

describe('fetchEvalByGameId', () => {
  const realFetch = global.fetch
  afterEach(() => { global.fetch = realFetch })

  function mockFetch() {
    const fn = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { id: 1 } }) })
    global.fetch = fn as unknown as typeof fetch
    return fn
  }

  it('asks for the row of the genre the list is on', async () => {
    const fn = mockFetch()
    await fetchEvalByGameId('6806468468', 'puzzle')
    expect(fn).toHaveBeenCalledWith('/api/evaluations/6806468468?category=puzzle')
  })

  it('asks by game_id alone when there is no genre (the server then prefers your own row)', async () => {
    const fn = mockFetch()
    await fetchEvalByGameId('6806468468')
    expect(fn).toHaveBeenCalledWith('/api/evaluations/6806468468')
  })
})

// Read as text: the panel is 2,000 lines of hooks and child fetches, and what has
// to hold here is only that nothing inside it forgets the genre, and that the
// per-genre screens hand it over.
describe('the genre reaches every panel fetch', () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

  it('passes the category on every fetch inside the panel', () => {
    const src = read('components/EvalDetailPanel.tsx')
    const calls = src.match(/fetchEvalByGameId\([^)]*\)/g) || []
    const inside = calls.filter(c => !c.includes('gameId: string'))
    expect(inside.length).toBeGreaterThanOrEqual(4)
    for (const c of inside) expect(c).toContain('category')
  })

  it.each([
    ['app/(manager)/evaluations/page.tsx', 2],
    ['app/(manager)/youtube/page.tsx', 1],
  ])('%s hands its genre to every panel it opens', (file, count) => {
    const src = read(file)
    const panels = src.split('<EvalDetailPanel').slice(1).map(s => s.slice(0, s.indexOf('/>')))
    expect(panels).toHaveLength(count)
    for (const p of panels) expect(p).toMatch(/\bcategory=\{/)
  })
})
