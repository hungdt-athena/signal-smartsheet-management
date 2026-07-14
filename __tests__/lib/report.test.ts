/**
 * @jest-environment node
 */
import {
  weekLabel, monthLabel, quarterLabel, periodKey, periodLabel, periodOrder,
  sumComponents, deriveMetrics, groupByEvaluator, groupByPeriod, weeksInRange,
  pctChange, mergeConclusions, emptyComponents, addComponents,
  type RollupRow,
} from '@/lib/report'

function row(over: Partial<RollupRow>): RollupRow {
  return {
    period_week: '2026-06-08', period_month: '2026-06', period_quarter: '2026-Q2',
    category_group: 'puzzle', domain: 'evaluation', evaluator: 'NgocTT', evaluator_key: 'ngoctt',
    games: 0, active_days: 0, turnaround_sum: 0, turnaround_count: 0, priority_count: 0, conclusions: {},
    ...over,
  }
}

describe('period labels', () => {
  it('weekLabel = W{n} Mon YYYY by day-of-month', () => {
    expect(weekLabel('2026-06-01')).toBe('W1 Jun 2026')
    expect(weekLabel('2026-06-08')).toBe('W2 Jun 2026')
    expect(weekLabel('2026-06-29')).toBe('W5 Jun 2026')
    expect(weekLabel('2026-01-15')).toBe('W3 Jan 2026')
  })
  it('monthLabel / quarterLabel', () => {
    expect(monthLabel('2026-06')).toBe('Jun 2026')
    expect(quarterLabel('2026-Q2')).toBe('Q2 2026')
  })
})

describe('periodKey / periodLabel / periodOrder', () => {
  const r = row({})
  it('selects the right key per granularity', () => {
    expect(periodKey(r, 'week')).toBe('2026-06-08')
    expect(periodKey(r, 'month')).toBe('2026-06')
    expect(periodKey(r, 'quarter')).toBe('2026-Q2')
    expect(periodKey(r, 'overall')).toBe('all')
  })
  it('labels overall as Overall', () => {
    expect(periodLabel('all', 'overall')).toBe('Overall')
  })
  it('orders weeks chronologically', () => {
    expect(periodOrder('2026-06-01', 'week')).toBeLessThan(periodOrder('2026-06-08', 'week'))
    expect(periodOrder('2026-01', 'month')).toBeLessThan(periodOrder('2026-02', 'month'))
    expect(periodOrder('2026-Q1', 'quarter')).toBeLessThan(periodOrder('2026-Q2', 'quarter'))
  })
})

describe('component summation', () => {
  it('sums additive fields and merges conclusion maps', () => {
    const c = sumComponents([
      row({ games: 10, active_days: 3, turnaround_sum: 20, turnaround_count: 10, priority_count: 4, conclusions: { 'Priority IV': 4, 'Bypass': 6 } }),
      row({ period_week: '2026-06-15', games: 5, active_days: 2, turnaround_sum: 5, turnaround_count: 5, priority_count: 1, conclusions: { 'Bypass': 5 } }),
    ])
    expect(c.games).toBe(15)
    expect(c.active_days).toBe(5)
    expect(c.turnaround_sum).toBe(25)
    expect(c.turnaround_count).toBe(15)
    expect(c.priority_count).toBe(5)
    expect(c.conclusions).toEqual({ 'Priority IV': 4, 'Bypass': 11 })
  })
  it('addComponents coerces string turnaround_sum from postgres numeric', () => {
    const acc = emptyComponents()
    addComponents(acc, { games: 1, active_days: 1, turnaround_sum: '3.5' as unknown as number, turnaround_count: 1, priority_count: 0, conclusions: {} })
    expect(acc.turnaround_sum).toBe(3.5)
  })
})

describe('deriveMetrics', () => {
  it('computes throughput, turnaround, priorityRate, consistency', () => {
    const c = sumComponents([row({ games: 20, active_days: 4, turnaround_sum: 30, turnaround_count: 20, priority_count: 5 })])
    const m = deriveMetrics(c, 2) // 2 weeks in range → 14 day denom
    expect(m.throughput).toBe(5)          // 20 / 4
    expect(m.turnaround).toBe(1.5)        // 30 / 20
    expect(m.priorityRate).toBe(0.25)     // 5 / 20
    expect(m.consistency).toBeCloseTo(4 / 14)
  })
  it('turnaround null when no dated rows; caps consistency at 1', () => {
    const m = deriveMetrics(sumComponents([row({ games: 3, active_days: 30, turnaround_count: 0 })]), 1)
    expect(m.turnaround).toBeNull()
    expect(m.throughput).toBeCloseTo(0.1)
    expect(m.consistency).toBe(1)
  })
  it('zero games → zero rates, no divide-by-zero', () => {
    const m = deriveMetrics(emptyComponents(), 1)
    expect(m.throughput).toBe(0)
    expect(m.priorityRate).toBe(0)
    expect(m.turnaround).toBeNull()
  })
})

describe('grouping', () => {
  const rows = [
    row({ evaluator: 'NgocTT', evaluator_key: 'ngoctt', games: 10, period_week: '2026-06-08', period_month: '2026-06' }),
    row({ evaluator: 'ngoctt', evaluator_key: 'ngoctt', games: 5, period_week: '2026-06-15', period_month: '2026-06' }),
    row({ evaluator: 'TriTD', evaluator_key: 'tritd', games: 8, period_week: '2026-06-08', period_month: '2026-06' }),
  ]
  it('groupByEvaluator merges casings under the key, keeps first display name', () => {
    const g = groupByEvaluator(rows)
    expect(g.size).toBe(2)
    expect(g.get('ngoctt')!.c.games).toBe(15)
    expect(g.get('ngoctt')!.name).toBe('NgocTT')
  })
  it('groupByPeriod (week) sorts oldest→newest and sums per period', () => {
    const p = groupByPeriod(rows, 'week')
    expect(p.map((x) => x.key)).toEqual(['2026-06-08', '2026-06-15'])
    expect(p[0].c.games).toBe(18) // 10 + 8 in week of 06-08
    expect(p[1].c.games).toBe(5)
  })
  it('groupByPeriod (month) collapses to one bucket', () => {
    const p = groupByPeriod(rows, 'month')
    expect(p).toHaveLength(1)
    expect(p[0].c.games).toBe(23)
    expect(p[0].label).toBe('Jun 2026')
  })
  it('weeksInRange counts distinct weeks', () => {
    expect(weeksInRange(rows)).toBe(2)
  })
})

describe('pctChange', () => {
  it('computes change and guards zero baseline', () => {
    expect(pctChange(15, 10)).toBeCloseTo(0.5)
    expect(pctChange(5, 10)).toBeCloseTo(-0.5)
    expect(pctChange(10, 0)).toBeNull()
  })
})

describe('mergeConclusions', () => {
  it('merges and sorts biggest-first', () => {
    const out = mergeConclusions([
      row({ conclusions: { 'Bypass': 3, 'Priority IV': 1 } }),
      row({ conclusions: { 'Bypass': 2, 'Theme/Art': 6 } }),
    ])
    expect(out).toEqual([
      { name: 'Theme/Art', count: 6 },
      { name: 'Bypass', count: 5 },
      { name: 'Priority IV', count: 1 },
    ])
  })
})
