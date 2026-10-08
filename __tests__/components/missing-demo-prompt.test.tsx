import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MissingDemoPrompt } from '@/components/MissingDemoPrompt'

type Item = {
  id: number; game_id: string; title: string; icon_url: string | null
  category: string; genre: string | null; batch: string; evaluate_date: string | null
}

const item = (over: Partial<Item>): Item => ({
  id: 1, game_id: 'g1', title: 'Game One', icon_url: null,
  category: 'puzzle', genre: 'Casual', batch: 'W2 Oct, 2026',
  evaluate_date: '2026-10-07T10:00:00Z', ...over,
})

const A = item({ id: 1, title: 'Color Queue Shooter' })
const B = item({ id: 2, title: 'ArcFlush', genre: 'Puzzle' })
const C = item({ id: 3, title: 'Stack Tower Rush', category: 'arcade', batch: 'W1 Oct, 2026' })

let patches: { id: number; drive_link: string | null }[] = []
let patchOk = true

function mockFetch(items: Item[] | 'fail') {
  patches = []
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).startsWith('/api/evaluations/missing-demo')) {
      if (items === 'fail') return { ok: false, json: async () => ({}) } as Response
      return { ok: true, json: async () => ({ items }) } as Response
    }
    if (String(url) === '/api/evaluations' && init?.method === 'PATCH') {
      patches.push(JSON.parse(String(init.body)))
      return { ok: patchOk, json: async () => ({}) } as Response
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as jest.Mock
}

async function open(items: Item[] | 'fail') {
  mockFetch(items)
  render(<MissingDemoPrompt />)
  if (items !== 'fail' && items.length) await screen.findByRole('dialog')
  else await waitFor(() => expect(global.fetch).toHaveBeenCalled())
}

const rowOf = (title: string) => screen.getByText(title).closest('[data-row]') as HTMLElement

beforeEach(() => { patchOk = true })

describe('MissingDemoPrompt', () => {
  it('shows nothing when no game is missing a demo link', async () => {
    await open([])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows nothing when the request fails (never nags with a broken list)', async () => {
    await open('fail')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('titles the panel with the count and groups the games by batch', async () => {
    await open([A, B, C])
    expect(screen.getByRole('dialog')).toHaveTextContent('3 List Idea games still need a demo link')
    const sections = screen.getAllByTestId('batch-section')
    expect(sections).toHaveLength(2)
    expect(sections[0]).toHaveTextContent('W2 Oct, 2026')
    expect(within(sections[0]).getByText('Color Queue Shooter')).toBeInTheDocument()
    expect(within(sections[1]).getByText('Stack Tower Rush')).toBeInTheDocument()
  })

  it('uses the singular for one game', async () => {
    await open([A])
    expect(screen.getByRole('dialog')).toHaveTextContent('1 List Idea game still needs a demo link')
  })

  // Current batch is about to become one global value: every category then shares a label.
  // The panel must not care -- one section, and each row still says which category it is.
  it('puts games from different categories into ONE section when they share a batch', async () => {
    await open([A, item({ id: 9, title: 'Stack Tower Rush', category: 'arcade', batch: 'W2 Oct, 2026' })])
    const sections = screen.getAllByTestId('batch-section')
    expect(sections).toHaveLength(1)
    expect(rowOf('Color Queue Shooter')).toHaveTextContent(/puzzle/i)
    expect(rowOf('Stack Tower Rush')).toHaveTextContent(/arcade/i)
  })

  it('keeps Save disabled until a link is typed', async () => {
    await open([A])
    const row = rowOf('Color Queue Shooter')
    const save = within(row).getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    fireEvent.change(within(row).getByPlaceholderText(/demo video link/i), { target: { value: 'x' } })
    expect(save).toBeEnabled()
  })

  it('saves the link with PATCH and removes the row, accepting any text', async () => {
    await open([A, B])
    const row = rowOf('Color Queue Shooter')
    fireEvent.change(within(row).getByPlaceholderText(/demo video link/i), { target: { value: '  drive.google.com/abc  ' } })
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByText('Color Queue Shooter')).toBeNull())
    expect(patches).toEqual([{ id: 1, drive_link: 'drive.google.com/abc' }])
    expect(screen.getByRole('dialog')).toHaveTextContent('1 List Idea game still needs a demo link')
  })

  it('keeps the row and says so when the save fails', async () => {
    patchOk = false
    await open([A, B])
    const row = rowOf('Color Queue Shooter')
    fireEvent.change(within(row).getByPlaceholderText(/demo video link/i), { target: { value: 'https://x' } })
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(within(rowOf('Color Queue Shooter')).getByText(/couldn.t save/i)).toBeInTheDocument())
    expect(screen.getByText('Color Queue Shooter')).toBeInTheDocument()
  })

  it('is closed only by "Remind me later": no Esc, no backdrop click, no X', async () => {
    await open([A])
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    fireEvent.click(screen.getByTestId('prompt-backdrop'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /close|✕/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Remind me later' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the done state after the last game is saved, then closes itself after 2s', async () => {
    jest.useFakeTimers()
    try {
      mockFetch([A])
      render(<MissingDemoPrompt />)
      await screen.findByRole('dialog')
      const row = rowOf('Color Queue Shooter')
      fireEvent.change(within(row).getByPlaceholderText(/demo video link/i), { target: { value: 'https://x' } })
      fireEvent.click(within(row).getByRole('button', { name: 'Save' }))
      await screen.findByText('All demo links are in')
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      act(() => { jest.advanceTimersByTime(1999) })
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      act(() => { jest.advanceTimersByTime(2) })
      expect(screen.queryByRole('dialog')).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  it('asks the server once per mount: opening the app, not a timer, is what shows it', async () => {
    jest.useFakeTimers()
    try {
      mockFetch([A])
      render(<MissingDemoPrompt />)
      await screen.findByRole('dialog')
      act(() => { jest.advanceTimersByTime(3 * 3600 * 1000) })
      const listCalls = (global.fetch as jest.Mock).mock.calls.filter(c => String(c[0]).includes('missing-demo'))
      expect(listCalls).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })
})
