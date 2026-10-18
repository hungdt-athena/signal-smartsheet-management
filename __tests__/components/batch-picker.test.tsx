import { fireEvent, render, screen, within } from '@testing-library/react'
import { BatchPicker, parseBatchPick, batchPickLabel } from '@/components/ui/BatchPicker'

const BATCHES = ['W1 Oct, 2026', 'W2 Oct, 2026', 'W4 Sep, 2026', 'W3 Dec, 2025', 'Legacy batch']

function open() {
  fireEvent.click(screen.getByRole('button', { name: /^Batch:/ }))
  return screen.getByRole('dialog')
}

describe('BatchPicker', () => {
  it('opens on the current batch: its year, its month, its batches', () => {
    render(<BatchPicker value="" onChange={() => {}} batches={BATCHES} current="W2 Oct, 2026" />)
    const pop = open()
    const batchCol = within(pop).getByRole('group', { name: 'Batch' })
    expect(within(batchCol).getAllByRole('button').map(b => b.textContent)).toEqual(['W1 Oct, 2026', 'W2 Oct, 2026current'])
    // Months of 2026, newest first.
    const monthCol = within(pop).getByRole('group', { name: 'Month' })
    expect(within(monthCol).getAllByRole('button').map(b => b.textContent?.replace('›', ''))).toEqual(['Oct', 'Sep'])
  })

  it('walks year → month → batch and reports the label', () => {
    const onChange = jest.fn()
    render(<BatchPicker value="" onChange={onChange} batches={BATCHES} />)
    const pop = open()
    fireEvent.click(within(pop).getByRole('button', { name: /^2025/ }))
    fireEvent.click(within(pop).getByRole('button', { name: /^Dec/ }))
    fireEvent.click(within(pop).getByRole('button', { name: 'W3 Dec, 2025' }))
    expect(onChange).toHaveBeenCalledWith('W3 Dec, 2025')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers a whole month only when allowed', () => {
    const onChange = jest.fn()
    const { rerender } = render(<BatchPicker value="" onChange={onChange} batches={BATCHES} current="W2 Oct, 2026" />)
    expect(within(open()).queryByText(/^All of/)).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    rerender(<BatchPicker value="" onChange={onChange} batches={BATCHES} current="W2 Oct, 2026" allowMonth />)
    fireEvent.click(within(open()).getByText('All of Oct 2026'))
    expect(onChange).toHaveBeenCalledWith('month:2026-10')
  })

  it('puts labels that are not "Wn Mon, YYYY" under Other', () => {
    const onChange = jest.fn()
    render(<BatchPicker value="" onChange={onChange} batches={BATCHES} />)
    const pop = open()
    fireEvent.click(within(pop).getByRole('button', { name: /^Other/ }))
    fireEvent.click(within(pop).getByRole('button', { name: 'Legacy batch' }))
    expect(onChange).toHaveBeenCalledWith('Legacy batch')
  })

  it('has All batches and Current shortcuts; hides All when not allowed', () => {
    const onChange = jest.fn()
    const { rerender } = render(<BatchPicker value="W1 Oct, 2026" onChange={onChange} batches={BATCHES} current="W2 Oct, 2026" />)
    fireEvent.click(within(open()).getByRole('button', { name: 'All batches' }))
    expect(onChange).toHaveBeenLastCalledWith('')
    rerender(<BatchPicker value="W1 Oct, 2026" onChange={onChange} batches={BATCHES} current="W2 Oct, 2026" allowAll={false} />)
    const pop = open()
    expect(within(pop).queryByRole('button', { name: 'All batches' })).toBeNull()
    fireEvent.click(within(pop).getByRole('button', { name: 'Current · W2 Oct, 2026' }))
    expect(onChange).toHaveBeenLastCalledWith('W2 Oct, 2026')
  })

  it('parses and labels values', () => {
    expect(parseBatchPick('')).toEqual({ batch: null, month: null })
    expect(parseBatchPick('W2 Oct, 2026')).toEqual({ batch: 'W2 Oct, 2026', month: null })
    expect(parseBatchPick('month:2026-10')).toEqual({ batch: null, month: '2026-10' })
    expect(batchPickLabel('month:2026-10')).toBe('All of Oct 2026')
    expect(batchPickLabel('')).toBe('All batches')
  })
})
