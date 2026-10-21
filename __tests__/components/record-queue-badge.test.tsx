import { render, screen, fireEvent, waitFor } from '@testing-library/react'

jest.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { name: 'MyTL' } } }) }))
jest.mock('next/navigation', () => ({ usePathname: () => '/youtube' }))

import { RecordQueueBadge } from '@/components/RecordQueueBadge'

const games = [
  { id: 1, title: 'Alpha', bucket: '5min', batch: 'W2 Oct, 2026', category_group: 'puzzle' },
  { id: 2, title: 'Beta', bucket: '20min', batch: 'W1 Oct, 2026', category_group: 'arcade' },
]

beforeEach(() => {
  window.localStorage.clear()
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ count: games.length, games }) })) as unknown as typeof fetch
})

describe('RecordQueueBadge', () => {
  it('shows the count and lists the games on click', async () => {
    render(<RecordQueueBadge />)
    const badge = await screen.findByRole('button', { name: '2 to record' })
    expect(badge.textContent).toBe('2')
    fireEvent.click(badge)
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Beta')).toBeTruthy()
  })

  it('Mark all as recorded hides the badge, remembers it, and can be undone', async () => {
    const { unmount } = render(<RecordQueueBadge />)
    fireEvent.click(await screen.findByRole('button', { name: '2 to record' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark all as recorded' }))
    expect(screen.queryByRole('button', { name: '2 to record' })).toBeNull()
    expect(JSON.parse(window.localStorage.getItem('record-badge-hidden:mytl') || '[]').sort()).toEqual([1, 2])

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await screen.findByRole('button', { name: '2 to record' })
    expect(window.localStorage.getItem('record-badge-hidden:mytl')).toBe('[]')

    // Undo leaves the list open. Hidden games stay hidden after a reload.
    fireEvent.click(screen.getByRole('button', { name: 'Mark all as recorded' }))
    unmount()
    render(<RecordQueueBadge />)
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('button', { name: /to record/ })).toBeNull()
  })

  it('renders nothing when there is nothing to record', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ count: 0, games: [] }) })) as unknown as typeof fetch
    const { container } = render(<RecordQueueBadge />)
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })
})
