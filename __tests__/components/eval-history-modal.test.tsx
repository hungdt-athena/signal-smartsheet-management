import { fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'fs'
import path from 'path'
import { EvalHistoryModal } from '@/components/EvalHistoryModal'
import type { HistoryEvent } from '@/lib/evaluation-history'

const EVENTS: HistoryEvent[] = [
  { key: 'log-2', at: '2026-10-11T07:32:00.000Z', who: 'Alice', action: 'Save', detail: 'Bypass → List Idea', time: '12m', note: 'From Short List' },
  { key: 'asg-1', at: '2026-10-10T02:00:00.000Z', who: 'Auto-assign', action: 'Reassign', detail: 'Bob → Alice', time: null, note: null },
]

describe('EvalHistoryModal', () => {
  it('lists each event with VN time, action, person, detail, panel time and note', () => {
    render(<EvalHistoryModal events={EVENTS} logReady error={false} onClose={() => {}} />)
    const rows = screen.getAllByTestId('history-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('11/10/26 - 14:32') // 07:32 UTC = 14:32 VN
    expect(rows[0].textContent).toContain('Save · Alice')
    expect(rows[0].textContent).toContain('Bypass → List Idea')
    expect(rows[0].textContent).toContain('⏱ 12m')
    expect(rows[0].textContent).toContain('From Short List')
    expect(rows[1].textContent).toContain('Reassign · Auto-assign')
    expect(rows[1].textContent).not.toContain('⏱')
  })
  it('shows loading, empty, not-logged-yet and error states', () => {
    const { rerender } = render(<EvalHistoryModal events={null} logReady error={false} onClose={() => {}} />)
    expect(screen.getByText('Loading…')).toBeTruthy()
    rerender(<EvalHistoryModal events={[]} logReady error={false} onClose={() => {}} />)
    expect(screen.getByText('No history yet.')).toBeTruthy()
    rerender(<EvalHistoryModal events={[]} logReady={false} error={false} onClose={() => {}} />)
    expect(screen.getByText('Saves are not logged yet.')).toBeTruthy()
    rerender(<EvalHistoryModal events={null} logReady error onClose={() => {}} />)
    expect(screen.getByText('Could not load the history. Try again.')).toBeTruthy()
  })
  it('closes on the backdrop and the ✕, not on a click inside', () => {
    const onClose = jest.fn()
    render(<EvalHistoryModal events={EVENTS} logReady error={false} onClose={onClose} />)
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Close'))
    fireEvent.click(document.querySelector('.modal-backdrop')!)
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('EvalDetailPanel History wiring', () => {
  const src = readFileSync(path.join(__dirname, '../../components/EvalDetailPanel.tsx'), 'utf8')
  it('fetches only when the button is pressed, and only keeps a reply for the game it was opened on', () => {
    expect(src).toMatch(/onClick=\{\(\) => openHistory\(ev\.game_id\)\}/)
    expect(src).toMatch(/h && h\.gameId === gameId \? \{ \.\.\.h, events: d\.events/)
    expect(src).toMatch(/history && ev && history\.gameId === ev\.game_id && \(/)
  })
  it('Esc closes the modal first, and arrows do not change game while it is open', () => {
    const onKey = src.slice(src.indexOf('const onKey = '), src.indexOf("window.addEventListener('keydown', onKey)"))
    expect(onKey.indexOf('if (history)')).toBeGreaterThan(-1)
    expect(onKey.indexOf('if (history)')).toBeLessThan(onKey.indexOf("'ArrowLeft'"))
  })
})
