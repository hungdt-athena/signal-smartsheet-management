/**
 * @jest-environment node
 */
jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { writeAssignmentHistory } from '@/lib/assignment-history'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

// postgres.js tag: strings + values. Find the INSERT and read its values by position.
function inserts() {
  return sqlMock.mock.calls
    .filter(c => Array.isArray(c[0]) && (c[0] as string[]).join(' ').includes('INSERT INTO assignment_history'))
    .map(c => {
      const cols = ['category', 'action', 'name', 'from', 'game_count', 'game_ids', 'created_by']
      return Object.fromEntries(cols.map((k, i) => [k, c[i + 1]]))
    })
}

beforeEach(() => {
  sqlMock.mockReset()
  sqlMock.mockImplementation(() => Promise.resolve([]))
})

describe('writeAssignmentHistory', () => {
  it('a linked pair counts as 1 game and logs both game ids', async () => {
    const rows = await writeAssignmentHistory({
      category: 'puzzle',
      action: 'assign',
      perEvaluator: new Map([['ThuDT', ['a1']]]),
      pairGameIds: new Map([['a1', 'i1']]),
      createdBy: 'cron',
    })
    expect(rows).toBe(1)
    const [ins] = inserts()
    expect(ins.game_count).toBe(1)
    expect(ins.game_ids).toEqual(['a1', 'i1'])
  })

  it('without pairGameIds it logs exactly the ids it was given', async () => {
    await writeAssignmentHistory({
      category: 'puzzle',
      action: 'reassign',
      perEvaluator: new Map([['A', ['g1', 'g2']], ['B', []]]),
      fromEvaluator: 'Z',
    })
    const ins = inserts()
    expect(ins).toHaveLength(1)
    expect(ins[0]).toMatchObject({ name: 'A', game_count: 2, game_ids: ['g1', 'g2'], from: 'Z' })
  })

  it('a twin of a game not in this evaluator\'s list is not logged for them', async () => {
    await writeAssignmentHistory({
      category: 'arcade',
      action: 'handover',
      perEvaluator: new Map([['A', ['g1']], ['B', ['g2']]]),
      pairGameIds: new Map([['g2', 't2']]),
    })
    const ins = inserts()
    expect(ins.find(r => r.name === 'A')).toMatchObject({ game_count: 1, game_ids: ['g1'] })
    expect(ins.find(r => r.name === 'B')).toMatchObject({ game_count: 1, game_ids: ['g2', 't2'] })
  })
})
