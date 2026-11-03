import { resolveScope, exportFileName } from '@/lib/shortlist-export/scope'

const ALLOWED = ['W1 Nov, 2026', 'W4 Oct, 2026', 'W3 Oct, 2026', 'W2 Oct, 2026', 'W1 Oct, 2026']

describe('resolveScope', () => {
  it('resolves a week', () =>
    expect(resolveScope('W3 Oct, 2026', ALLOWED)).toEqual({ kind: 'week', labels: ['W3 Oct, 2026'], monthKey: '2026-10', weekTag: 'W3' }))

  it('resolves a month to its allowed labels, W1 first', () =>
    expect(resolveScope('month:2026-10', ALLOWED)!.labels).toEqual(['W1 Oct, 2026', 'W2 Oct, 2026', 'W3 Oct, 2026', 'W4 Oct, 2026']))

  it.each(['', 'W5 Oct, 2026', 'W3 Feb, 2026', 'month:2026-13', 'month:2026-02'])('rejects %p', p =>
    expect(resolveScope(p, ALLOWED)).toBeNull())

  it('names files', () => {
    expect(exportFileName(resolveScope('W3 Oct, 2026', ALLOWED)!, ['insight', 'priority_iv'])).toBe('Oct 2026 W3 Report')
    expect(exportFileName(resolveScope('month:2026-10', ALLOWED)!, ['priority_iv'])).toBe('Oct 2026 Monthly Report (Priority IV)')
    expect(exportFileName(resolveScope('W1 Nov, 2026', ALLOWED)!, ['insight'])).toBe('Nov 2026 W1 Report (Insight)')
  })
})
