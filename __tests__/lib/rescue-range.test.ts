import { parseAssignedRange, rangeKey } from '@/lib/rescue-range'

describe('lib/rescue-range parseAssignedRange', () => {
  it('returns no range when neither end is given', () => {
    expect(parseAssignedRange(undefined, undefined)).toEqual({ ok: true, range: null })
    expect(parseAssignedRange('', null)).toEqual({ ok: true, range: null })
  })

  it('accepts a closed range, to exclusive', () => {
    expect(parseAssignedRange('2026-10-06', '2026-10-13')).toEqual({
      ok: true, range: { from: '2026-10-06', to: '2026-10-13' },
    })
  })

  it('accepts a range open on one side', () => {
    expect(parseAssignedRange('2026-10-06', null)).toEqual({ ok: true, range: { from: '2026-10-06', to: null } })
    expect(parseAssignedRange(null, '2026-10-13')).toEqual({ ok: true, range: { from: null, to: '2026-10-13' } })
  })

  it('rejects a malformed day instead of widening to the whole backlog', () => {
    expect(parseAssignedRange('06/10/2026', '2026-10-13').ok).toBe(false)
    expect(parseAssignedRange('2026-02-31', '2026-03-05').ok).toBe(false)
    expect(parseAssignedRange('2026-10-06', 'soon').ok).toBe(false)
  })

  it('rejects an empty or inverted range', () => {
    expect(parseAssignedRange('2026-10-13', '2026-10-13').ok).toBe(false)
    expect(parseAssignedRange('2026-10-13', '2026-10-06').ok).toBe(false)
  })

  it('rangeKey is empty for none and stable for a range', () => {
    expect(rangeKey(null)).toBe('')
    expect(rangeKey({ from: '2026-10-06', to: null })).toBe('2026-10-06|')
  })
})
