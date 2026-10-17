import { fireEvent, render, screen } from '@testing-library/react'
import { TrendTagsDialog } from '@/components/TrendTagsDialog'

// The dialog sits on top of the evaluation panel, which listens on window for Esc and
// ←/→ (and skips a key someone already marked handled). These pin that the dialog
// keeps those keys away from the panel.
const base = {
  gameId: 'g1', value: [], existing: [], options: ['Merge', 'Backpack'],
  subValues: [{ id: 1, name: 'Theme' }], onSave: jest.fn(),
}

function keyOn(target: EventTarget, key: string) {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(e)
  return e
}

describe('TrendTagsDialog', () => {
  it('is a dialog with the title, a Close X, Cancel and Save', () => {
    render(<TrendTagsDialog {...base} onClose={jest.fn()} />)
    expect(screen.getByRole('dialog').textContent).toContain('Trends tags')
    expect(screen.getByLabelText('Close')).toBeTruthy()
    const foot = Array.from(document.querySelectorAll('.modal-foot button')).map(b => b.textContent)
    expect(foot).toEqual(['Cancel', 'Save'])
  })

  it('closes on Esc and marks it handled, so the panel underneath does not close too', () => {
    const onClose = jest.fn()
    render(<TrendTagsDialog {...base} onClose={onClose} />)
    const e = keyOn(document.body, 'Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
  })

  it('swallows the arrows so the panel does not change game behind it', () => {
    render(<TrendTagsDialog {...base} onClose={jest.fn()} />)
    expect(keyOn(document.body, 'ArrowLeft').defaultPrevented).toBe(true)
    expect(keyOn(document.body, 'ArrowRight').defaultPrevented).toBe(true)
  })

  it('leaves Esc typed into the trend search to the search, not the dialog', () => {
    const onClose = jest.fn()
    render(<TrendTagsDialog {...base} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /pick a trend/i }))
    const search = screen.getByPlaceholderText('Search trends')
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByPlaceholderText('Search trends')).toBeNull() // the list closed
  })

  it('removes a row with the labelled X', () => {
    render(<TrendTagsDialog {...base} value={[{ field_value: 'Merge', sub_value_id: null }]} onClose={jest.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove this trend' }))
    expect(screen.queryByText('Merge')).toBeNull()
  })
})
