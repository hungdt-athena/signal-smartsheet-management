/**
 * @jest-environment node
 */
jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
import { getCurrentBatches, onlyCurrentBatch } from '@/lib/current-batch'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

// The "current batch" is the one fact the missing-demo prompt hangs on. Today it is stored
// per category (`current_batch:<category>`); it is about to become one global value.
// Everything that needs it goes through getCurrentBatches(), so that switch is a change
// to this one function and its tests -- not to the query, the route or the panel.

describe('getCurrentBatches', () => {
  beforeEach(() => sqlMock.mockReset())

  it('maps each category to its own current batch', async () => {
    sqlMock.mockResolvedValue([
      { key: 'current_batch:puzzle', value: 'W2 Oct, 2026' },
      { key: 'current_batch:arcade', value: 'W1 Oct, 2026' },
    ])
    expect(await getCurrentBatches()).toEqual({
      puzzle: 'W2 Oct, 2026',
      arcade: 'W1 Oct, 2026',
    })
  })

  it('leaves out a category whose batch is blank or was cleared', async () => {
    sqlMock.mockResolvedValue([
      { key: 'current_batch:puzzle', value: 'W2 Oct, 2026' },
      { key: 'current_batch:arcade', value: null },
      { key: 'current_batch:simulation', value: '' },
    ])
    expect(await getCurrentBatches()).toEqual({ puzzle: 'W2 Oct, 2026' })
  })

  it('returns an empty map when no batch is set anywhere', async () => {
    sqlMock.mockResolvedValue([])
    expect(await getCurrentBatches()).toEqual({})
  })
})

describe('onlyCurrentBatch', () => {
  const rows = [
    { id: 1, category_group: 'puzzle', batch: 'W2 Oct, 2026' },
    { id: 2, category_group: 'puzzle', batch: 'W1 Oct, 2026' }, // last week's puzzle batch
    { id: 3, category_group: 'arcade', batch: 'W1 Oct, 2026' },
    { id: 4, category_group: 'arcade', batch: 'W2 Oct, 2026' }, // the OTHER category's batch
    { id: 5, category_group: 'puzzle', batch: null },
    { id: 6, category_group: 'simulation', batch: 'W2 Oct, 2026' }, // no batch set for simulation
  ]

  it('keeps a row only when its batch is the current one for ITS OWN category', () => {
    const kept = onlyCurrentBatch(rows, { puzzle: 'W2 Oct, 2026', arcade: 'W1 Oct, 2026' })
    expect(kept.map(r => r.id)).toEqual([1, 3])
  })

  it('keeps every category once they share a batch (the global case)', () => {
    const kept = onlyCurrentBatch(rows, {
      puzzle: 'W2 Oct, 2026', arcade: 'W2 Oct, 2026', simulation: 'W2 Oct, 2026',
    })
    expect(kept.map(r => r.id)).toEqual([1, 4, 6])
  })

  it('keeps nothing when no batch is set', () => {
    expect(onlyCurrentBatch(rows, {})).toEqual([])
  })
})
