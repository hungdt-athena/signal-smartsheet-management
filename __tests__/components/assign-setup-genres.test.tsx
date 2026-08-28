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

describe('AssignSetup genre toggles', () => {
  it('shows the genre state the server reports', async () => {
    mockFetch()
    render(<AssignSetup />)
    await waitFor(() => expect(screen.getByRole('button', { name: /puzzle/i })).toHaveTextContent('7 available'))
    expect(screen.getByRole('button', { name: /arcade/i })).toHaveTextContent(/off/i)
  })

  it('turns a genre on through the admin-only endpoint', async () => {
    const calls = mockFetch()
    render(<AssignSetup />)
    await waitFor(() => screen.getByRole('button', { name: /arcade/i }))
    fireEvent.click(screen.getByRole('button', { name: /arcade/i }))
    await waitFor(() => {
      const put = calls.find(c => c.url === '/api/genre-config' && c.init?.method === 'PUT')
      expect(put).toBeDefined()
      expect(JSON.parse(put!.init!.body as string)).toEqual({ bucket: 'arcade', enabled: true })
    })
  })

  it('hides the switch behind a disabled chip when the server says the user may not edit', async () => {
    mockFetch(false)
    render(<AssignSetup />)
    await waitFor(() => expect(screen.getByRole('button', { name: /puzzle/i })).toBeDisabled())
  })
})
