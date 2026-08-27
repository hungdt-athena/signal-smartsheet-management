import {
  buildMatrix, dayRange, shadeScale, shiftWindow, type HistoryRow,
} from '@/lib/assign-history-matrix'

const h = (o: Partial<HistoryRow> & { id: number; run_date: string; evaluator_name: string }): HistoryRow => ({
  run_at: `${o.run_date}T09:00:00Z`, category_group: 'puzzle', action: 'assign',
  from_evaluator: null, game_count: 1, created_by: 'cron', ...o,
})

describe('dayRange', () => {
  it('ra ngày liên tục, cũ trước mới sau, gồm cả hai đầu', () => {
    expect(dayRange('2026-08-24', '2026-08-27')).toEqual([
      '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27',
    ])
  })
  it('vượt biên tháng vẫn đúng', () => {
    expect(dayRange('2026-07-31', '2026-08-01')).toEqual(['2026-07-31', '2026-08-01'])
  })
  it('from sau to thì rỗng', () => {
    expect(dayRange('2026-08-27', '2026-08-24')).toEqual([])
  })
})

describe('buildMatrix', () => {
  const window = { from: '2026-08-24', to: '2026-08-26' }

  it('ngày không có data vẫn ra cột, ô bằng 0', () => {
    const m = buildMatrix({
      ...window, rosterNames: ['Ann'],
      rows: [h({ id: 1, run_date: '2026-08-24', evaluator_name: 'Ann', game_count: 4 })],
    })
    expect(m.days).toEqual(['2026-08-24', '2026-08-25', '2026-08-26'])
    expect(m.rows[0].cells.map(c => c.assign)).toEqual([4, 0, 0])
    expect(m.dayTotals.map(t => t.assign)).toEqual([4, 0, 0])
  })

  it('reassign và handover KHÔNG bị cộng vào số assign', () => {
    const m = buildMatrix({
      ...window, rosterNames: ['Ann'],
      rows: [
        h({ id: 1, run_date: '2026-08-25', evaluator_name: 'Ann', action: 'assign', game_count: 2 }),
        h({ id: 2, run_date: '2026-08-25', evaluator_name: 'Ann', action: 'reassign', game_count: 5, from_evaluator: 'Bob' }),
        h({ id: 3, run_date: '2026-08-25', evaluator_name: 'Ann', action: 'handover', game_count: 7 }),
      ],
    })
    const cell = m.rows[0].cells[1]
    expect(cell.assign).toBe(2)
    expect(cell.reassign).toBe(5)
    expect(cell.handover).toBe(7)
    expect(cell.rows).toHaveLength(3)
    expect(m.rows[0].total.assign).toBe(2)
    expect(m.grandTotal.assign).toBe(2)
  })

  it('người trong roster mà 0 history vẫn ra một dòng toàn 0', () => {
    const m = buildMatrix({ ...window, rosterNames: ['Ann', 'Zed'], rows: [] })
    expect(m.rows.map(r => r.name)).toEqual(['Ann', 'Zed'])
    expect(m.rows[1].cells.every(c => c.assign === 0)).toBe(true)
    expect(m.rows[1].inRoster).toBe(true)
  })

  it('người đã rời roster nhưng còn history vẫn hiện, inRoster = false, xếp sau', () => {
    const m = buildMatrix({
      ...window, rosterNames: ['Ann'],
      rows: [h({ id: 1, run_date: '2026-08-24', evaluator_name: 'OldGuy', game_count: 3 })],
    })
    expect(m.rows.map(r => r.name)).toEqual(['Ann', 'OldGuy'])
    expect(m.rows[1].inRoster).toBe(false)
    expect(m.rows[1].total.assign).toBe(3)
  })

  it('dòng ngoài cửa sổ bị bỏ, không làm lệch tổng', () => {
    const m = buildMatrix({
      ...window, rosterNames: ['Ann'],
      rows: [
        h({ id: 1, run_date: '2026-08-20', evaluator_name: 'Ann', game_count: 9 }),
        h({ id: 2, run_date: '2026-08-26', evaluator_name: 'Ann', game_count: 4 }),
      ],
    })
    expect(m.grandTotal.assign).toBe(4)
    expect(m.rows[0].total.assign).toBe(4)
  })

  it('run_date có phần giờ vẫn khớp đúng cột', () => {
    const m = buildMatrix({
      ...window, rosterNames: ['Ann'],
      rows: [h({ id: 1, run_date: '2026-08-25T00:00:00.000Z', evaluator_name: 'Ann', game_count: 2 })],
    })
    expect(m.rows[0].cells[1].assign).toBe(2)
  })
})

describe('shadeScale', () => {
  it('0 luôn ra bậc 0, số lớn nhất ra bậc 4', () => {
    const shade = shadeScale([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(shade(0)).toBe(0)
    expect(shade(8)).toBe(4)
    expect(shade(1)).toBe(1)
  })
  it('không có số dương nào thì mọi thứ là bậc 0', () => {
    const shade = shadeScale([0, 0])
    expect(shade(0)).toBe(0)
    expect(shade(5)).toBe(0)
  })
})

describe('shiftWindow', () => {
  it('lùi cửa sổ về trước đúng số ngày', () => {
    expect(shiftWindow('2026-08-14', '2026-08-27', -14)).toEqual({ from: '2026-07-31', to: '2026-08-13' })
  })
  it('tiến cửa sổ về sau đúng số ngày', () => {
    expect(shiftWindow('2026-07-31', '2026-08-13', 14)).toEqual({ from: '2026-08-14', to: '2026-08-27' })
  })
})
