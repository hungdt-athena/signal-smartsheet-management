/**
 * @jest-environment node
 */
jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { twinGameIds } from '@/lib/eval-pairs-db'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

beforeEach(() => {
  sqlMock.mockReset()
})

describe('twinGameIds', () => {
  it('no ids, no query', async () => {
    sqlMock.mockImplementation(() => Promise.resolve([]))
    expect((await twinGameIds([])).size).toBe(0)
    expect(sqlMock).not.toHaveBeenCalled()
  })

  it('one query through pair_eval_id; maps each game id to its twin', async () => {
    sqlMock.mockImplementation(() => Promise.resolve([
      { game_id: 'a1', twin_game_id: 'i1' },
      { game_id: 'a2', twin_game_id: 'i2' },
    ]))
    const m = await twinGameIds(['a1', 'a2', 'solo', 'a1'])
    expect(Array.from(m.entries())).toEqual([['a1', 'i1'], ['a2', 'i2']])
    const outer = sqlMock.mock.calls.filter(c => Array.isArray(c[0]))
    expect(outer).toHaveLength(1)
    const text = (outer[0][0] as string[]).join(' ')
    expect(text).toContain('pair_eval_id')
    // A twin holding its own store result (Link_dead / Stale_release) keeps its own
    // holder, so it did not move with the row and is not returned.
    expect(text).toContain('Link_dead')
    expect(text).toContain('Stale_release')
    // the ids are sent once, deduplicated
    expect(outer[0].slice(1)).toContainEqual(['a1', 'a2', 'solo'])
  })
})
