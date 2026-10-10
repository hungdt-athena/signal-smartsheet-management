import { isBatchLabel } from '@/lib/weekly-feedback'
import { weekBatches } from '@/components/EvalDetailPanel'

describe('isBatchLabel', () => {
  it('accepts every label weekBatches() can generate, for every month', () => {
    for (let m = 1; m <= 12; m++) {
      for (const label of weekBatches(2026, m)) expect(isBatchLabel(label)).toBe(true)
    }
  })

  it.each([
    '', ' ', 'W0 Oct, 2026', 'W5 Oct, 2026', 'W99999999999 Oct, 2026', 'w2 oct, 2026',
    ' W2 Oct, 2026', 'W2 Oct, 2026 ', 'W2 Oct, 2026\n', 'W2  Oct, 2026', 'W2 October, 2026',
    'W2 Sept, 2026', 'W2 Oct 2026', 'W2 Oct, 26', 'W2 Oct, 20260', 'W2 Foo, 2026',
    '[object Object]', 'x'.repeat(41),
  ])('rejects %j', s => {
    expect(isBatchLabel(s)).toBe(false)
  })
})
