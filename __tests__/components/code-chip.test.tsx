import { render, screen, fireEvent, act } from '@testing-library/react'
import { CodeChip } from '@/components/CodeChip'

const setClipboard = (v: unknown) =>
  Object.defineProperty(navigator, 'clipboard', { value: v, configurable: true })

afterEach(() => { jest.useRealTimers(); setClipboard(undefined) })

describe('CodeChip', () => {
  it('renders nothing for null', () => {
    const { container } = render(<CodeChip code={null} />)
    expect(container.textContent).toBe('')
  })

  it('shows the code', () => {
    render(<CodeChip code="K7M2QX" />)
    expect(screen.getByText('K7M2QX')).toBeTruthy()
  })

  it('click copies the code, shows Copied, then goes back after 1.5s', async () => {
    jest.useFakeTimers()
    const writeText = jest.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })
    render(<CodeChip code="K7M2QX" />)
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    expect(writeText).toHaveBeenCalledWith('K7M2QX')
    expect(screen.getByText('Copied')).toBeTruthy()
    act(() => { jest.advanceTimersByTime(1500) })
    expect(screen.queryByText('Copied')).toBeNull()
    expect(screen.getByText('K7M2QX')).toBeTruthy()
  })

  it('does not throw when the clipboard is missing', async () => {
    setClipboard(undefined)
    render(<CodeChip code="K7M2QX" />)
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    expect(screen.getByText('K7M2QX')).toBeTruthy()
  })

  it('does not throw when writeText rejects', async () => {
    setClipboard({ writeText: jest.fn().mockRejectedValue(new Error('denied')) })
    render(<CodeChip code="K7M2QX" />)
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    expect(screen.getByText('K7M2QX')).toBeTruthy()
    expect(screen.queryByText('Copied')).toBeNull()
  })

  it('does not let the click reach a clickable parent', async () => {
    setClipboard({ writeText: jest.fn().mockResolvedValue(undefined) })
    const onRow = jest.fn()
    render(<div onClick={onRow}><CodeChip code="K7M2QX" /></div>)
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    expect(onRow).not.toHaveBeenCalled()
  })
})
