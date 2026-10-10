/**
 * @jest-environment node
 */
jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
import { commitAssignment } from '@/lib/reassign-core'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

describe('commitAssignment', () => {
  it('only counts games the UPDATE actually moved (still unjudged)', async () => {
    const texts: string[] = []
    sqlMock.mockReset()
    sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
      if (!(Array.isArray(strings) && 'raw' in strings)) return { __ids: strings } // sql(ids): a plain array, no .raw
      texts.push((strings as string[]).join(' '))
      const ids = (binds.find(b => (b as { __ids?: number[] })?.__ids) as { __ids: number[] }).__ids
      return Promise.resolve(ids.filter(id => id !== 2).map(id => ({ id }))) // game 2 was judged meanwhile
    })
    const res = await commitAssignment(new Map([[1, 'A'], [2, 'A'], [3, 'B']]), new Map([[1, 'g1'], [2, 'g2'], [3, 'g3']]))
    expect(texts.every(t => /initial_conclusion IS NULL/.test(t) && /RETURNING id/.test(t))).toBe(true)
    expect(Array.from(res.movedIds).sort()).toEqual([1, 3])
    expect(res.byEvaluator.get('A')).toEqual(['g1'])
    expect(res.byEvaluator.get('B')).toEqual(['g3'])
  })
})
