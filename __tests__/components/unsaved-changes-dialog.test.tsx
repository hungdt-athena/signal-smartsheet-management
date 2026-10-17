import { fireEvent, render, screen } from '@testing-library/react'
import { UnsavedChangesDialog, type UnsavedChangesDialogProps } from '@/components/UnsavedChangesDialog'

const base: UnsavedChangesDialogProps = {
  action: 'next', fields: ['Initial conclusion', 'Self note'], saving: false, saveBlockedReason: null,
  onSave: jest.fn(), onDiscard: jest.fn(), onStay: jest.fn(),
}
const show = (over: Partial<UnsavedChangesDialogProps> = {}) => {
  const props = { ...base, onSave: jest.fn(), onDiscard: jest.fn(), onStay: jest.fn(), ...over }
  render(<UnsavedChangesDialog {...props} />)
  return props
}

describe('UnsavedChangesDialog', () => {
  it('lists the edited fields and offers save, discard and keep editing', () => {
    const p = show()
    expect(screen.getByRole('alertdialog').textContent).toContain('You have unsaved changes')
    expect(screen.getByText('Initial conclusion')).toBeTruthy()
    expect(screen.getByText('Self note')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save & next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard & next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(p.onSave).toHaveBeenCalledTimes(1)
    expect(p.onDiscard).toHaveBeenCalledTimes(1)
    expect(p.onStay).toHaveBeenCalledTimes(1)
  })
  it('words the buttons for where the user was going', () => {
    show({ action: 'prev' })
    expect(screen.getByRole('button', { name: 'Save & previous' })).toBeTruthy()
  })
  it.each([['jump', 'open'], ['close', 'close']] as const)('says "%s" as "%s"', (action, word) => {
    show({ action })
    expect(screen.getByRole('button', { name: `Discard & ${word}` })).toBeTruthy()
  })
  it('blocks Save with the reason when the note is too short, but still lets the user discard or stay', () => {
    const p = show({ saveBlockedReason: 'Self note needs at least 10 characters.' })
    expect(screen.getByText('Self note needs at least 10 characters.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save & next' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Discard & next' }))
    expect(p.onDiscard).toHaveBeenCalled()
  })
  it('locks every button while saving', () => {
    show({ saving: true })
    for (const name of ['Saving…', 'Discard & next', 'Keep editing']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
  })
  it('a click on the backdrop keeps editing, a click inside does not', () => {
    const p = show()
    fireEvent.click(screen.getByRole('alertdialog'))
    expect(p.onStay).not.toHaveBeenCalled()
    fireEvent.click(document.querySelector('.modal-backdrop')!)
    expect(p.onStay).toHaveBeenCalledTimes(1)
  })
  it('keeps Discard on the left, red, and Save last; focus starts on Save', () => {
    show()
    const foot = document.querySelector('.modal-foot')!
    const names = Array.from(foot.querySelectorAll('button')).map(b => b.textContent)
    expect(names).toEqual(['Discard & next', 'Keep editing', 'Save & next'])
    expect(screen.getByRole('button', { name: 'Discard & next' }).className).toContain('btn-danger')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save & next' }))
    // a prompt that must be answered: no X
    expect(screen.queryByLabelText('Close')).toBeNull()
  })
  it('starts focus on Keep editing when Save is blocked', () => {
    show({ saveBlockedReason: 'Self note needs at least 10 characters.' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep editing' }))
  })
  it('Esc keeps editing', () => {
    const p = show()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(p.onStay).toHaveBeenCalledTimes(1)
  })
  it('ignores Esc while a save runs', () => {
    const p = show({ saving: true })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(p.onStay).not.toHaveBeenCalled()
  })
})
