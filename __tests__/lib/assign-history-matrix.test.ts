import {
  buildMatrix, dayRange, shadeScale, shiftWindow, type HistoryRow,
} from '@/lib/assign-history-matrix'

const h = (o: Partial<HistoryRow> & { id: number; run_date: string; evaluator_name: string }): HistoryRow => ({
  run_at: `${o.run_date}T09:00:00Z`, category_group: 'puzzle', action: 'assign',
  from_evaluator: null, game_count: 1, created_by: 'cron', ...o,
})

describe('dayRange', () => {
  it('yields consecutive days, oldest first, both ends included', () => {
    expect(dayRange('2026-08-24', '2026-08-27')).toEqual([
      '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27',
    ])
  })
  it('crosses a month boundary', () => {
    expect(dayRange('2026-07-31', '2026-08-01')).toEqual(['2026-07-31', '2026-08-01'])
  })
  it('is empty when from is after to', () => {
    expect(dayRange('2026-08-27', '2026-08-24')).toEqual([])
  })
})

describe('buildMatrix', () => {
  const window = { from: '2026-08-24', to: '2026-08-26' }

  it('keeps a column for a day with no data, and zeroes its cells', () => {
    const m = buildMatrix({
      ...window, rosterNames: ['Ann'],
      rows: [h({ id: 1, run_date: '2026-08-24', evaluator_name: 'Ann', game_count: 4 })],
    })
    expect(m.days).toEqual(['2026-08-24', '2026-08-25', '2026-08-26'])
    expect(m.rows[0].cells.map(c => c.net)).toEqual([4, 0, 0])
    expect(m.dayTotals.map(t => t.net)).toEqual([4, 0, 0])
  })

  it('a reassign credits the receiver and debits the giver, both on the move date', () => {
    const m = buildMatrix({
      ...window, rosterNames: ['Ann', 'Bob'],
      rows: [
        // Bob was assigned 10 games on the 24th...
        h({ id: 1, run_date: '2026-08-24', evaluator_name: 'Bob', game_count: 10 }),
        // ...and handed 4 of them to Ann on the 26th.
        h({ id: 2, run_date: '2026-08-26', evaluator_name: 'Ann', action: 'reassign', game_count: 4, from_evaluator: 'Bob' }),
      ],
    })
    const bob = m.rows.find(r => r.name === 'Bob')!
    const ann = m.rows.find(r => r.name === 'Ann')!

    // The debit lands on the 26th, not back on the 24th where the assign was.
    expect(bob.cells.map(c => c.net)).toEqual([10, 0, -4])
    expect(ann.cells.map(c => c.net)).toEqual([0, 0, 4])
    expect(bob.total.net).toBe(6)
    expect(ann.total.net).toBe(4)
    expect(bob.total.reassignOut).toBe(4)
    expect(ann.total.reassignIn).toBe(4)
  })

  it('a move nets out inside its own day column and in the grand total', () => {
    const m = buildMatrix({
      ...window, rosterNames: ['Ann', 'Bob'],
      rows: [
        h({ id: 1, run_date: '2026-08-24', evaluator_name: 'Bob', game_count: 10 }),
        h({ id: 2, run_date: '2026-08-26', evaluator_name: 'Ann', action: 'reassign', game_count: 4, from_evaluator: 'Bob' }),
      ],
    })
    expect(m.dayTotals.map(t => t.net)).toEqual([10, 0, 0])
    expect(m.grandTotal.net).toBe(10)
    expect(m.grandTotal.assign).toBe(10)
    expect(m.grandTotal.reassignIn).toBe(4)
    expect(m.grandTotal.reassignOut).toBe(4)
  })

  it('both sides of a move are listed in the cell, with a direction', () => {
    const m = buildMatrix({
      ...window, rosterNames: ['Ann', 'Bob'],
      rows: [h({ id: 2, run_date: '2026-08-25', evaluator_name: 'Ann', action: 'reassign', game_count: 4, from_evaluator: 'Bob' })],
    })
    const ann = m.rows.find(r => r.name === 'Ann')!
    const bob = m.rows.find(r => r.name === 'Bob')!
    expect(ann.cells[1].entries).toEqual([{ row: expect.objectContaining({ id: 2 }), dir: 'in' }])
    expect(bob.cells[1].entries).toEqual([{ row: expect.objectContaining({ id: 2 }), dir: 'out' }])
  })

  it('a handover moves games the same way a reassign does', () => {
    const m = buildMatrix({
      ...window, rosterNames: ['Ann', 'Bob'],
      rows: [h({ id: 1, run_date: '2026-08-25', evaluator_name: 'Ann', action: 'handover', game_count: 7, from_evaluator: 'Bob' })],
    })
    expect(m.rows.find(r => r.name === 'Ann')!.total.handoverIn).toBe(7)
    expect(m.rows.find(r => r.name === 'Bob')!.total.handoverOut).toBe(7)
    expect(m.rows.find(r => r.name === 'Bob')!.total.net).toBe(-7)
  })

  it('rows run busiest first, ties broken by name', () => {
    const m = buildMatrix({
      ...window, rosterNames: ['Ann', 'Bob', 'Cid', 'Dee'],
      rows: [
        h({ id: 1, run_date: '2026-08-24', evaluator_name: 'Cid', game_count: 9 }),
        h({ id: 2, run_date: '2026-08-24', evaluator_name: 'Ann', game_count: 3 }),
      ],
    })
    expect(m.rows.map(r => r.name)).toEqual(['Cid', 'Ann', 'Bob', 'Dee'])
  })

  it('a person on the roster with no history still gets a row', () => {
    const m = buildMatrix({ ...window, rosterNames: ['Ann', 'Zed'], rows: [] })
    expect(m.rows.map(r => r.name)).toEqual(['Ann', 'Zed'])
    expect(m.rows[1].cells.every(c => c.net === 0)).toBe(true)
    expect(m.rows[1].inRoster).toBe(true)
  })

  it('someone who left the roster but has history is still shown, flagged', () => {
    const m = buildMatrix({
      ...window, rosterNames: ['Ann'],
      rows: [h({ id: 1, run_date: '2026-08-24', evaluator_name: 'OldGuy', game_count: 3 })],
    })
    expect(m.rows.map(r => r.name)).toEqual(['OldGuy', 'Ann'])
    expect(m.rows[0].inRoster).toBe(false)
    expect(m.rows[0].total.net).toBe(3)
  })

  it('rows outside the window are dropped and never skew a total', () => {
    const m = buildMatrix({
      ...window, rosterNames: ['Ann'],
      rows: [
        h({ id: 1, run_date: '2026-08-20', evaluator_name: 'Ann', game_count: 9 }),
        h({ id: 2, run_date: '2026-08-26', evaluator_name: 'Ann', game_count: 4 }),
      ],
    })
    expect(m.grandTotal.net).toBe(4)
    expect(m.rows[0].total.net).toBe(4)
  })

  it('a run_date carrying a time part still lands in the right column', () => {
    const m = buildMatrix({
      ...window, rosterNames: ['Ann'],
      rows: [h({ id: 1, run_date: '2026-08-25T00:00:00.000Z', evaluator_name: 'Ann', game_count: 2 })],
    })
    expect(m.rows[0].cells[1].net).toBe(2)
  })
})

describe('shadeScale', () => {
  it('puts 0 at level 0 and the largest value at level 4', () => {
    const shade = shadeScale([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(shade(0)).toBe(0)
    expect(shade(8)).toBe(4)
    expect(shade(1)).toBe(1)
  })
  it('flattens to level 0 when nothing is positive', () => {
    const shade = shadeScale([0, 0])
    expect(shade(0)).toBe(0)
    expect(shade(5)).toBe(0)
  })
  it('treats a negative net as level 0', () => {
    expect(shadeScale([1, 2, 3])(-4)).toBe(0)
  })
})

describe('shiftWindow', () => {
  it('steps the window backwards by whole days', () => {
    expect(shiftWindow('2026-08-14', '2026-08-27', -14)).toEqual({ from: '2026-07-31', to: '2026-08-13' })
  })
  it('steps the window forwards by whole days', () => {
    expect(shiftWindow('2026-07-31', '2026-08-13', 14)).toEqual({ from: '2026-08-14', to: '2026-08-27' })
  })
})
