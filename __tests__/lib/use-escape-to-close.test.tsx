import { fireEvent, render } from '@testing-library/react'
import { useEscapeToClose } from '@/lib/use-escape-to-close'

// Esc on a stacked dialog must close only the top one, and must not reach a
// page-level handler underneath (the evaluation panel closes itself on Esc).
function Dialog({ onClose, enabled = true, children }: { onClose: () => void; enabled?: boolean; children?: React.ReactNode }) {
  useEscapeToClose(onClose, enabled)
  return <div>{children}</div>
}

describe('useEscapeToClose', () => {
  it('closes the dialog on Esc', () => {
    const onClose = jest.fn()
    render(<Dialog onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores other keys', () => {
    const onClose = jest.fn()
    render(<Dialog onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes only the newest of two stacked dialogs', () => {
    const parent = jest.fn()
    const child = jest.fn()
    render(<Dialog onClose={parent}><Dialog onClose={child} /></Dialog>)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(child).toHaveBeenCalledTimes(1)
    expect(parent).not.toHaveBeenCalled()
  })

  it('does nothing while disabled (a save in flight)', () => {
    const onClose = jest.fn()
    render(<Dialog onClose={onClose} enabled={false} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('marks the key handled, so a window handler underneath skips it', () => {
    const seen: boolean[] = []
    const under = (e: KeyboardEvent) => { seen.push(e.defaultPrevented) }
    window.addEventListener('keydown', under)
    render(<Dialog onClose={() => {}} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    window.removeEventListener('keydown', under)
    expect(seen).toEqual([true])
  })
})
