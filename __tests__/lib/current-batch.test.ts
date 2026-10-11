/**
 * @jest-environment node
 */
jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
import { getCurrentBatch, pickCurrentBatch } from '@/lib/current-batch'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

describe('pickCurrentBatch', () => {
  it('uses the global value', () => {
    expect(pickCurrentBatch([{ key: 'current_batch', value: 'W2 Oct, 2026' }])).toBe('W2 Oct, 2026')
  })

  it('lets the global row win over legacy per-category rows, whatever their order', () => {
    expect(pickCurrentBatch([
      { key: 'current_batch:puzzle', value: 'W1 Oct, 2026' },
      { key: 'current_batch', value: 'W2 Oct, 2026' },
    ])).toBe('W2 Oct, 2026')
  })

  it('treats an empty global row as "none set" and does NOT fall back to legacy rows', () => {
    // A manager who clears the batch before migration 045 has run must get "none".
    expect(pickCurrentBatch([
      { key: 'current_batch:puzzle', value: 'W2 Oct, 2026' },
      { key: 'current_batch', value: null },
    ])).toBeNull()
    expect(pickCurrentBatch([
      { key: 'current_batch:puzzle', value: 'W2 Oct, 2026' },
      { key: 'current_batch', value: '' },
    ])).toBeNull()
  })

  it('falls back to the newest legacy value when there is no global row', () => {
    expect(pickCurrentBatch([
      { key: 'current_batch:arcade', value: 'W1 Oct, 2026' },
      { key: 'current_batch:puzzle', value: 'W2 Oct, 2026' },
    ])).toBe('W2 Oct, 2026')
  })

  it('compares legacy values by week order, not as strings', () => {
    // As strings "W4 Sep" > "W1 Oct" ('4' > '1'); by week order October is newer.
    expect(pickCurrentBatch([
      { key: 'current_batch:arcade', value: 'W4 Sep, 2026' },
      { key: 'current_batch:puzzle', value: 'W1 Oct, 2026' },
    ])).toBe('W1 Oct, 2026')
    expect(pickCurrentBatch([
      { key: 'current_batch:arcade', value: 'W4 Dec, 2026' },
      { key: 'current_batch:puzzle', value: 'W1 Jan, 2027' },
    ])).toBe('W1 Jan, 2027')
  })

  it('ignores blank legacy values and unrelated keys', () => {
    expect(pickCurrentBatch([
      { key: 'current_batch:simulation', value: null },
      { key: 'current_batch:arcade', value: '' },
      { key: 'something_else', value: 'W9 Oct, 2026' },
    ])).toBeNull()
  })

  it('trims every value, and a whitespace-only value counts as empty', () => {
    expect(pickCurrentBatch([{ key: 'current_batch', value: '  W2 Oct, 2026\n' }])).toBe('W2 Oct, 2026')
    // A blank global row is "none", not a batch called "   " and not a fallback to legacy rows.
    expect(pickCurrentBatch([
      { key: 'current_batch:puzzle', value: 'W2 Oct, 2026' },
      { key: 'current_batch', value: '   ' },
    ])).toBeNull()
    // Legacy rows: trimmed, and blank ones are ignored.
    expect(pickCurrentBatch([
      { key: 'current_batch:arcade', value: ' \t ' },
      { key: 'current_batch:puzzle', value: ' W1 Oct, 2026 ' },
    ])).toBe('W1 Oct, 2026')
    expect(pickCurrentBatch([{ key: 'current_batch:arcade', value: '  ' }])).toBeNull()
  })

  // Legacy rows were free text; only a value that is a real batch label may stand in for
  // the global row, the same check migration 045 applies when it folds them.
  it.each([
    ['foo'], ['W5 Oct, 2026'], ['W0 Oct, 2026'], ['W150 Oct, 2026'], ['W1 Mayday, 2026'],
    ['w2 oct, 2026'], ['W2  Oct, 2026'], ['W2 Oct,2026'], ['W2 Oct, 20266'], ['W2 Xyz, 2026'],
    ['W2' + ' '.repeat(60) + 'Oct, 2026'], ['W2\u00a0Oct, 2026'], ['W2\nOct, 2026'],
  ])('ignores the odd legacy value %j', value => {
    expect(pickCurrentBatch([{ key: 'current_batch:puzzle', value }])).toBeNull()
  })

  it('an odd legacy value never beats a valid older one', () => {
    expect(pickCurrentBatch([
      { key: 'current_batch:arcade', value: 'W4 Dec, 2030 and more' },
      { key: 'current_batch:puzzle', value: 'W5 Dec, 2030' },
      { key: 'current_batch:simulation', value: ' W1 Oct, 2026 ' },
    ])).toBe('W1 Oct, 2026')
  })

  it('still returns the global row as trimmed text, whatever it says (only the validated route or the migration writes it)', () => {
    expect(pickCurrentBatch([{ key: 'current_batch', value: ' W5 Oct, 2026 ' }])).toBe('W5 Oct, 2026')
    expect(pickCurrentBatch([{ key: 'current_batch', value: 'Sprint 7' }])).toBe('Sprint 7')
  })

  it('returns null when nothing is set', () => {
    expect(pickCurrentBatch([])).toBeNull()
  })
})

describe('getCurrentBatch', () => {
  beforeEach(() => sqlMock.mockReset())

  it('reads app_config in ONE query and returns the picked value', async () => {
    sqlMock.mockResolvedValue([
      { key: 'current_batch:puzzle', value: 'W1 Oct, 2026' },
      { key: 'current_batch', value: 'W2 Oct, 2026' },
    ])
    expect(await getCurrentBatch()).toBe('W2 Oct, 2026')
    expect(sqlMock).toHaveBeenCalledTimes(1)
    const text = (sqlMock.mock.calls[0][0] as string[]).join(' ')
    expect(text).toContain('app_config')
    expect(text).toContain("'current_batch'")
    expect(text).toContain("LIKE 'current_batch:%'")
  })
})
