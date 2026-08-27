import { fireEvent, render, screen } from '@testing-library/react'
import { AssignHistoryMatrix } from '@/components/AssignHistoryMatrix'
import { buildMatrix, type HistoryRow } from '@/lib/assign-history-matrix'

const h = (o: Partial<HistoryRow> & { id: number; run_date: string; evaluator_name: string }): HistoryRow => ({
  run_at: `${o.run_date}T09:00:00Z`, category_group: 'puzzle', action: 'assign',
  from_evaluator: null, game_count: 1, created_by: 'cron', ...o,
})

const matrix = buildMatrix({
  from: '2026-08-24', to: '2026-08-26', rosterNames: ['Ann', 'Zed'],
  rows: [
    h({ id: 1, run_date: '2026-08-24', evaluator_name: 'Ann', game_count: 4 }),
    h({ id: 2, run_date: '2026-08-26', evaluator_name: 'Ann', action: 'reassign', game_count: 2, from_evaluator: 'Zed', created_by: 'KhangNA' }),
  ],
})

describe('AssignHistoryMatrix', () => {
  it('vẽ đủ cột cho mọi ngày trong cửa sổ, kể cả ngày trống', () => {
    render(<AssignHistoryMatrix matrix={matrix} />)
    expect(screen.getByRole('columnheader', { name: /24/ })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /25/ })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /26/ })).toBeInTheDocument()
  })

  it('người trong roster mà 0 game vẫn có dòng', () => {
    render(<AssignHistoryMatrix matrix={matrix} />)
    expect(screen.getByText('Zed')).toBeInTheDocument()
  })

  it('ô chỉ có reassign hiện dấu ▲ chứ không hiện 2 như số assign', () => {
    render(<AssignHistoryMatrix matrix={matrix} />)
    const cell = screen.getByTestId('cell-Ann-2026-08-26')
    expect(cell).toHaveTextContent('▲')
    expect(cell).not.toHaveTextContent('2')
  })

  it('bấm một ô có data mở popover chi tiết', () => {
    render(<AssignHistoryMatrix matrix={matrix} />)
    fireEvent.click(screen.getByTestId('cell-Ann-2026-08-24').querySelector('button')!)
    expect(screen.getByRole('dialog')).toHaveTextContent(/assign/i)
    expect(screen.getByRole('dialog')).toHaveTextContent('puzzle')
  })

  it('cửa sổ không có gì thì hiện empty state', () => {
    const empty = buildMatrix({ from: '2026-08-24', to: '2026-08-26', rosterNames: [], rows: [] })
    render(<AssignHistoryMatrix matrix={empty} />)
    expect(screen.getByText('No history in this window')).toBeInTheDocument()
  })
})
