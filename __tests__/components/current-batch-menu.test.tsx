import { fireEvent, render, screen } from '@testing-library/react'

// The picker portals its panel; a plain select stands in for it.
jest.mock('@/components/ui/BatchPicker', () => ({
  BatchPicker: ({ value, onChange, batches, ariaLabel }: {
    value: string; onChange: (v: string) => void; batches: string[]; ariaLabel?: string
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">Not set</option>
      {batches.map(b => <option key={b} value={b}>{b}</option>)}
    </select>
  ),
}))

import { CurrentBatchMenu } from '@/components/CurrentBatchMenu'

const OPTIONS = ['W4 Nov, 2026', 'W1 Dec, 2026']

function setup(over: Partial<Parameters<typeof CurrentBatchMenu>[0]> = {}) {
  const onChange = jest.fn()
  const onStartChange = jest.fn()
  render(<CurrentBatchMenu value="W4 Nov, 2026" options={OPTIONS} startsAt="2026-11-20T11:47"
    onChange={onChange} onStartChange={onStartChange} {...over} />)
  fireEvent.click(screen.getByRole('button', { name: /Current batch/ }))
  return { onChange, onStartChange }
}
const picker = () => screen.getByLabelText('Current batch') as HTMLSelectElement

describe('CurrentBatchMenu: a global setting changes only on confirm', () => {
  it('picking another batch asks first and saves nothing yet', () => {
    const { onChange } = setup()
    fireEvent.change(picker(), { target: { value: 'W1 Dec, 2026' } })
    expect(onChange).not.toHaveBeenCalled()
    const box = screen.getByRole('alertdialog')
    expect(box).toHaveTextContent('W4 Nov, 2026')
    expect(box).toHaveTextContent('W1 Dec, 2026')
    expect(box).toHaveTextContent('all categories')
  })

  it('Change batch saves the picked one', () => {
    const { onChange } = setup()
    fireEvent.change(picker(), { target: { value: 'W1 Dec, 2026' } })
    fireEvent.click(screen.getByRole('button', { name: 'Change batch' }))
    expect(onChange).toHaveBeenCalledWith('W1 Dec, 2026')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('Cancel keeps the current batch and puts the picker back', () => {
    const { onChange } = setup()
    fireEvent.change(picker(), { target: { value: 'W1 Dec, 2026' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(picker().value).toBe('W4 Nov, 2026')
  })

  it('clearing the batch also asks, and says it clears', () => {
    const { onChange } = setup()
    fireEvent.change(picker(), { target: { value: '' } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Clear batch' }))
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('picking the batch already set asks nothing', () => {
    const { onChange } = setup()
    fireEvent.change(picker(), { target: { value: 'W4 Nov, 2026' } })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('closing the popover drops an unconfirmed pick', () => {
    const { onChange } = setup()
    fireEvent.change(picker(), { target: { value: 'W1 Dec, 2026' } })
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: /Current batch/ }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(picker().value).toBe('W4 Nov, 2026')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('the start time saves on Save, not on every keystroke', () => {
    const { onStartChange } = setup()
    const input = screen.getByLabelText('Starts at') as HTMLInputElement
    expect(screen.queryByRole('button', { name: 'Save start' })).toBeNull()
    fireEvent.change(input, { target: { value: '2026-11-20T12:00' } })
    expect(onStartChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save start' }))
    expect(onStartChange).toHaveBeenCalledWith('2026-11-20T12:00')
  })
})
