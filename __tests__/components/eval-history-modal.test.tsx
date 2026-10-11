import { fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'fs'
import path from 'path'
import { EvalHistoryModal } from '@/components/EvalHistoryModal'
import type { HistoryEvent } from '@/lib/evaluation-history'

const EVENTS: HistoryEvent[] = [
  {
    key: 'log-2', at: '2026-10-11T07:32:00.000Z', who: 'Alice', type: 'save', verb: 'changed the verdict',
    changes: [{ kind: 'initial', from: 'Bypass', to: 'List_Idea' }, { kind: 'final', from: null, to: 'Priority IV' }],
    time: '12m', seconds: 720, note: 'From Short List',
  },
  {
    key: 'asg-1', at: '2026-10-10T02:00:00.000Z', who: 'Auto-assign', type: 'assign', verb: 'reassigned',
    changes: [{ kind: 'person', from: 'Bob', to: 'Alice' }], time: null, seconds: null, note: null,
  },
]
const noop = () => {}
const view = (over: Partial<React.ComponentProps<typeof EvalHistoryModal>> = {}) =>
  render(<EvalHistoryModal events={EVENTS} logReady error={false} onClose={noop} onRetry={noop} {...over} />)

describe('EvalHistoryModal', () => {
  it('groups events by Vietnam day and writes each as who, verb, change, time and panel time', () => {
    view()
    const rows = screen.getAllByTestId('history-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Alice changed the verdict')
    expect(rows[0].textContent).toContain('14:32') // 07:32 UTC = 14:32 VN
    expect(rows[0].textContent).toContain('12m')
    expect(rows[0].textContent).toContain('From Short List')
    expect(rows[1].textContent).toContain('Auto-assign reassigned')
    expect(rows[1].textContent).toContain('Bob')
    expect(rows[1].querySelector('.hx-dur')).toBeNull() // no panel time on a hand-over
    // two different days -> two day headings
    expect(document.querySelectorAll('.hx-day')).toHaveLength(2)
  })
  it('shows the verdict as a coloured badge and the final conclusion on its own labelled line', () => {
    view()
    const row = screen.getAllByTestId('history-row')[0]
    const badges = Array.from(row.querySelectorAll('.badge')).map(b => [b.textContent, b.className])
    expect(badges).toEqual([
      ['Bypass', 'badge error'],
      ['List Idea', 'badge success'],
      ['Priority IV', 'badge neutral'], // final conclusions carry no colour meaning here
    ])
    expect(row.querySelector('.lbl')?.textContent).toBe('Final')
  })
  it('shows the batch on its own labelled line, with an arrow when it moved from something', () => {
    const ev = (changes: HistoryEvent['changes']): HistoryEvent => ({ ...EVENTS[0], changes })
    const { rerender } = view({ events: [ev([{ kind: 'batch', from: 'W1 Oct, 2026', to: 'W2 Oct, 2026' }])] })
    let row = screen.getAllByTestId('history-row')[0]
    expect(row.querySelector('.lbl')?.textContent).toBe('Batch')
    expect(Array.from(row.querySelectorAll('.badge')).map(b => [b.textContent, b.className])).toEqual([
      ['W1 Oct, 2026', 'badge neutral'],
      ['W2 Oct, 2026', 'badge neutral'],
    ])
    expect(row.querySelectorAll('.hx-chg svg')).toHaveLength(1) // the arrow
    // batch text is shown as is, not run through the conclusion prettifier
    rerender(<EvalHistoryModal events={[ev([{ kind: 'batch', from: null, to: 'W2_Oct' }])]} logReady error={false} onClose={noop} onRetry={noop} />)
    row = screen.getAllByTestId('history-row')[0]
    expect(Array.from(row.querySelectorAll('.badge')).map(b => b.textContent)).toEqual(['W2_Oct'])
    expect(row.querySelectorAll('.hx-chg svg')).toHaveLength(0)
    // cleared batch shows a dash
    rerender(<EvalHistoryModal events={[ev([{ kind: 'batch', from: 'W1 Oct, 2026', to: null }])]} logReady error={false} onClose={noop} onRetry={noop} />)
    row = screen.getAllByTestId('history-row')[0]
    expect(Array.from(row.querySelectorAll('.badge')).map(b => b.textContent)).toEqual(['W1 Oct, 2026', '—'])
  })
  it('summarises events, panel time and people under the title', () => {
    view()
    const sum = document.querySelector('.hx-sum')!
    expect(sum.textContent).toBe('2 events12m panel time1 person')
  })
  it('shows loading, empty, not-logged-yet and error states', () => {
    const { rerender } = view({ events: null })
    expect(screen.getByRole('status').textContent).toContain('Loading…')
    expect(document.querySelector('.hx-sum')).toBeNull()
    rerender(<EvalHistoryModal events={[]} logReady error={false} onClose={noop} onRetry={noop} />)
    expect(screen.getByText('No history yet.')).toBeTruthy()
    rerender(<EvalHistoryModal events={[]} logReady={false} error={false} onClose={noop} onRetry={noop} />)
    expect(screen.getByText('Saves are not logged yet.')).toBeTruthy()
    rerender(<EvalHistoryModal events={null} logReady error onClose={noop} onRetry={noop} />)
    expect(screen.getByText('Could not load the history')).toBeTruthy()
  })
  it('offers Try again on an error', () => {
    const onRetry = jest.fn()
    view({ events: null, error: true, onRetry })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
  it('closes on the backdrop and the ✕, not on a click inside', () => {
    const onClose = jest.fn()
    view({ onClose })
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
  it('Try again fetches the same game again', () => {
    expect(src).toMatch(/onRetry=\{\(\) => openHistory\(history\.gameId\)\}/)
  })
  it('Esc closes the modal first, and arrows do not change game while it is open', () => {
    const onKey = src.slice(src.indexOf('const onKey = '), src.indexOf("window.addEventListener('keydown', onKey)"))
    expect(onKey.indexOf('if (history)')).toBeGreaterThan(-1)
    expect(onKey.indexOf('if (history)')).toBeLessThan(onKey.indexOf("'ArrowLeft'"))
  })
})
