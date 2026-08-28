import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { AssignSetup } from '@/components/AssignSetup'

jest.mock('@/hooks/useCategoryMappings', () => ({
  useCategoryMappings: () => ({ data: { puzzle: ['puzzle'], arcade: ['arcade'], simulation: ['simulation'] } }),
}))

const GENRES = [
  { bucket: 'puzzle', enabled: true, available: 7, active: true },
  { bucket: 'arcade', enabled: false, available: 0, active: false },
  { bucket: 'simulation', enabled: false, available: 0, active: false },
]

function mockFetch(canEdit = true) {
  const calls: { url: string; init?: RequestInit }[] = []
  global.fetch = jest.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const body = url.startsWith('/api/genre-config')
      ? { genres: GENRES, canEdit }
      : { initial: [], final: [] }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
  }) as unknown as typeof fetch
  return calls
}

const sw = (genre: string) => screen.getByRole('switch', { name: new RegExp(genre, 'i') })

describe('AssignSetup genre toggles', () => {
  it('shows the genre state the server reports', async () => {
    mockFetch()
    render(<AssignSetup />)
    await waitFor(() => expect(screen.getByRole('row', { name: /puzzle/i })).toHaveTextContent('7 evaluators'))
    expect(sw('arcade')).toHaveAttribute('aria-checked', 'false')
  })

  it('turns a genre on through the admin-only endpoint', async () => {
    const calls = mockFetch()
    render(<AssignSetup />)
    await waitFor(() => sw('arcade'))
    fireEvent.click(sw('arcade'))
    await waitFor(() => {
      const put = calls.find(c => c.url === '/api/genre-config' && c.init?.method === 'PUT')
      expect(put).toBeDefined()
      expect(JSON.parse(put!.init!.body as string)).toEqual({ bucket: 'arcade', enabled: true })
    })
  })

  it('hides the switch behind a disabled chip when the server says the user may not edit', async () => {
    mockFetch(false)
    render(<AssignSetup />)
    await waitFor(() => expect(sw('puzzle')).toBeDisabled())
  })
})

describe('AssignSetup roster height', () => {
  // The roster is the page's content, not a widget on it: capping the Initial list
  // at ten rows put a second scrollbar inside a page that already scrolls, and hid
  // the people at the bottom behind it.
  it('lets both rosters run to their full height', async () => {
    mockFetch()
    render(<AssignSetup />)
    await waitFor(() => expect(screen.getByText('Initial Evaluator')).toBeInTheDocument())
    const wraps = Array.from(document.querySelectorAll('.roster-tbl'))
    expect(wraps).toHaveLength(2)
    for (const w of wraps) expect(w.className).not.toContain('roster-scroll')
  })
})
