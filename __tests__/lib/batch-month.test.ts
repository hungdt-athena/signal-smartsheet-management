import { batchLabelsOfMonth, monthKeyOfBatch, monthKeyLabel } from '@/lib/batch-month'

describe('batch-month', () => {
  it('lists the four batch labels of a month, W1 first', () => {
    expect(batchLabelsOfMonth('2026-10')).toEqual([
      'W1 Oct, 2026', 'W2 Oct, 2026', 'W3 Oct, 2026', 'W4 Oct, 2026',
    ])
  })

  it('returns nothing for a malformed key, so a bad query string never filters', () => {
    for (const bad of ['', '2026-13', '2026-00', 'Oct 2026', '2026-1', "2026-10'; --"]) {
      expect(batchLabelsOfMonth(bad)).toEqual([])
    }
  })

  it('maps a batch label back to its month key', () => {
    expect(monthKeyOfBatch('W3 Oct, 2026')).toBe('2026-10')
    expect(monthKeyOfBatch('W1 Jan, 2027')).toBe('2027-01')
  })

  it('does not map anything that is not a W1-W4 label', () => {
    expect(monthKeyOfBatch(null)).toBeNull()
    expect(monthKeyOfBatch('')).toBeNull()
    expect(monthKeyOfBatch('W5 Oct, 2026')).toBeNull()
    expect(monthKeyOfBatch('Week 3')).toBeNull()
  })

  it('round-trips: every label of a month maps back to that month', () => {
    for (const label of batchLabelsOfMonth('2026-02')) expect(monthKeyOfBatch(label)).toBe('2026-02')
  })

  it('labels a month key for display', () => {
    expect(monthKeyLabel('2026-10')).toBe('Oct 2026')
    expect(monthKeyLabel('nope')).toBe('nope')
  })
})
