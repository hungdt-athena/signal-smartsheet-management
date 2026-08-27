import { fireEvent, render, screen, within } from '@testing-library/react'
import { AssignHistoryMatrix } from '@/components/AssignHistoryMatrix'
import { buildMatrix, type HistoryRow } from '@/lib/assign-history-matrix'

const h = (o: Partial<HistoryRow> & { id: number; run_date: string; evaluator_name: string }): HistoryRow => ({
  run_at: `${o.run_date}T09:00:00Z`, category_group: 'puzzle', action: 'assign',
  from_evaluator: null, game_count: 1, created_by: 'cron', ...o,
})

// Ann is assigned 4 on the 24th, then receives 2 from Zed on the 26th.
// Moe is on the roster and did nothing at all.
const matrix = buildMatrix({
  from: '2026-08-24', to: '2026-08-26', rosterNames: ['Ann', 'Zed', 'Moe'],
  rows: [
    h({ id: 1, run_date: '2026-08-24', evaluator_name: 'Ann', game_count: 4 }),
    h({ id: 2, run_date: '2026-08-26', evaluator_name: 'Ann', action: 'reassign', game_count: 2, from_evaluator: 'Zed', created_by: 'KhangNA' }),
  ],
})

describe('AssignHistoryMatrix', () => {
  it('draws a column for every day in the window, including the empty one', () => {
    render(<AssignHistoryMatrix matrix={matrix} />)
    expect(screen.getByRole('columnheader', { name: /24/ })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /25/ })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /26/ })).toBeInTheDocument()
  })

  it('keeps a row for a rostered person with no activity', () => {
    render(<AssignHistoryMatrix matrix={matrix} />)
    expect(screen.getByText('Moe')).toBeInTheDocument()
    expect(screen.getByTestId('cell-Moe-2026-08-24')).toHaveTextContent('·')
  })

  it('a reassign lands as a gain on the receiver and a loss on the giver, same day', () => {
    render(<AssignHistoryMatrix matrix={matrix} />)
    expect(screen.getByTestId('cell-Ann-2026-08-26')).toHaveTextContent('2')
    expect(screen.getByTestId('cell-Zed-2026-08-26')).toHaveTextContent('-2')
    expect(screen.getByTestId('cell-Zed-2026-08-26').className).toContain('hm-neg')
  })

  it('the total column nets the move out: Ann 6, Zed -2', () => {
    render(<AssignHistoryMatrix matrix={matrix} />)
    expect(screen.getByTestId('total-Ann')).toHaveTextContent('6')
    expect(screen.getByTestId('total-Zed')).toHaveTextContent('-2')
  })

  it('clicking a cell opens the run detail', () => {
    render(<AssignHistoryMatrix matrix={matrix} />)
    fireEvent.click(screen.getByTestId('cell-Ann-2026-08-24').querySelector('button')!)
    const pop = screen.getByRole('dialog')
    expect(pop).toHaveTextContent(/assign/i)
    expect(pop).toHaveTextContent('puzzle')
    expect(pop).toHaveTextContent('Assigned')
  })

  it('clicking a total opens the assign vs reassign breakdown', () => {
    render(<AssignHistoryMatrix matrix={matrix} />)
    fireEvent.click(screen.getByTestId('total-Ann').querySelector('button')!)
    const pop = screen.getByRole('dialog')
    expect(pop).toHaveTextContent('Assigned')
    expect(pop).toHaveTextContent('Received')
    expect(pop).toHaveTextContent('Net')
  })

  it("the giver's popover shows the games leaving, with a destination", () => {
    render(<AssignHistoryMatrix matrix={matrix} />)
    fireEvent.click(screen.getByTestId('total-Zed').querySelector('button')!)
    const pop = screen.getByRole('dialog')
    expect(pop).toHaveTextContent('Given away')
    expect(pop).toHaveTextContent('-2')
    expect(pop).toHaveTextContent('→ Ann')
  })

  it('the run time is rendered in UTC+7, not the raw UTC string', () => {
    const m = buildMatrix({
      from: '2026-08-24', to: '2026-08-24', rosterNames: ['Ann'],
      rows: [h({ id: 1, run_date: '2026-08-24', evaluator_name: 'Ann', run_at: '2026-08-24T05:00:00.000Z', game_count: 3 })],
    })
    render(<AssignHistoryMatrix matrix={m} />)
    fireEvent.click(screen.getByTestId('cell-Ann-2026-08-24').querySelector('button')!)
    expect(within(screen.getByRole('dialog')).getByText('12:00')).toBeInTheDocument()
  })

  it('shows an empty state when the window holds nothing', () => {
    const empty = buildMatrix({ from: '2026-08-24', to: '2026-08-26', rosterNames: [], rows: [] })
    render(<AssignHistoryMatrix matrix={empty} />)
    expect(screen.getByText('No history in this window')).toBeInTheDocument()
  })
})
