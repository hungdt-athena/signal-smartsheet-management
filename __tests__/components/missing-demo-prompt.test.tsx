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

// The raw payload, for tests that send something the Item type does not allow.
function mockRaw(payload: unknown) {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => payload }) as Response) as jest.Mock
  render(<MissingDemoPrompt />)
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
    const save = within(row).getByRole('button', { name: /^Save demo link for / })
    expect(save).toBeDisabled()
    fireEvent.change(within(row).getByPlaceholderText(/demo video link/i), { target: { value: 'x' } })
    expect(save).toBeEnabled()
  })

  it('saves the link with PATCH and removes the row, accepting any text', async () => {
    await open([A, B])
    const row = rowOf('Color Queue Shooter')
    fireEvent.change(within(row).getByPlaceholderText(/demo video link/i), { target: { value: '  drive.google.com/abc  ' } })
    fireEvent.click(within(row).getByRole('button', { name: /^Save demo link for / }))
    await waitFor(() => expect(screen.queryByText('Color Queue Shooter')).toBeNull())
    expect(patches).toEqual([{ id: 1, drive_link: 'drive.google.com/abc' }])
    expect(screen.getByRole('dialog')).toHaveTextContent('1 List Idea game still needs a demo link')
  })

  it('keeps the row and says so when the save fails', async () => {
    patchOk = false
    await open([A, B])
    const row = rowOf('Color Queue Shooter')
    fireEvent.change(within(row).getByPlaceholderText(/demo video link/i), { target: { value: 'https://x' } })
    fireEvent.click(within(row).getByRole('button', { name: /^Save demo link for / }))
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
      fireEvent.click(within(row).getByRole('button', { name: /^Save demo link for / }))
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

  // --- fix wave ---------------------------------------------------------------------------

  describe('dates', () => {
    it('shows the day and month in Vietnam time', async () => {
      await open([item({ evaluate_date: '2026-10-07T20:00:00Z' })])
      expect(screen.getByText(/evaluated 08 Oct/)).toBeInTheDocument()
    })

    it.each([
      ['the largest date JS can hold, which overflows once shifted to Vietnam time', '+275760-09-13T00:00:00.000Z'],
      ['a year before 1970', '1969-12-31T00:00:00Z'],
      ['a year after 2100', '2101-01-01T00:00:00Z'],
      ['text that is not a date', 'soon'],
    ])('leaves the date out for %s', async (_n, evaluate_date) => {
      await open([item({ evaluate_date })])
      const meta = rowOf('Game One').querySelector('.mdp-m') as HTMLElement
      expect(meta.textContent).toBe('Puzzle · Casual')
      expect(document.body.textContent).not.toMatch(/NaN|undefined/)
    })
  })

  describe('a malformed list', () => {
    it.each([
      ['items is not an array', { items: 'oops' }],
      ['items is an object', { items: { a: 1 } }],
      ['items is null', { items: null }],
      ['the payload is null', null],
    ])('renders nothing when %s', async (_n, payload) => {
      mockRaw(payload)
      await waitFor(() => expect(global.fetch).toHaveBeenCalled())
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('ignores elements without a numeric id or string category, title or batch, and keeps the rest', async () => {
      mockRaw({ items: [
        A, null, 5, 'x', [],
        { ...B, id: '2' }, { ...B, id: 3, title: undefined }, { ...B, id: 4, title: 7 },
        { ...B, id: 5, category: null }, { ...B, id: 6, batch: undefined }, { ...B, id: Number.NaN },
      ] })
      await screen.findByRole('dialog')
      expect(screen.getByRole('dialog')).toHaveTextContent('1 List Idea game still needs a demo link')
      expect(screen.getByText('Color Queue Shooter')).toBeInTheDocument()
    })

    it('renders nothing when no element is valid', async () => {
      mockRaw({ items: [null, { id: 'x' }, 7] })
      await waitFor(() => expect(global.fetch).toHaveBeenCalled())
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('tolerates a missing genre, icon and date', async () => {
      mockRaw({ items: [{ id: 1, title: 'Bare', category: 'puzzle', batch: 'W2 Oct, 2026' }] })
      await screen.findByRole('dialog')
      expect(rowOf('Bare').querySelector('.mdp-m')!.textContent).toBe('Puzzle')
    })
  })

  describe('saving once', () => {
    it('sends one PATCH however many times Enter is pressed before the answer', async () => {
      await open([A])
      let answer!: (r: Response) => void
      const calls: unknown[] = []
      ;(global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          calls.push(JSON.parse(String(init.body)))
          return new Promise<Response>(res => { answer = res })
        }
        throw new Error(`unexpected fetch ${url}`)
      })
      const input = within(rowOf('Color Queue Shooter')).getByPlaceholderText(/demo video link/i)
      fireEvent.change(input, { target: { value: 'https://x' } })
      // Both presses in ONE batch of updates: state has not caught up, only a ref can stop the second.
      act(() => {
        fireEvent.keyDown(input, { key: 'Enter' })
        fireEvent.keyDown(input, { key: 'Enter' })
      })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(calls).toEqual([{ id: 1, drive_link: 'https://x' }])
      await act(async () => { answer({ ok: true, json: async () => ({}) } as Response) })
    })

    it('can save again after a failed save', async () => {
      patchOk = false
      await open([A])
      const row = rowOf('Color Queue Shooter')
      fireEvent.change(within(row).getByPlaceholderText(/demo video link/i), { target: { value: 'https://x' } })
      fireEvent.click(within(row).getByRole('button', { name: /^Save demo link for / }))
      await waitFor(() => expect(within(rowOf('Color Queue Shooter')).getByText(/couldn.t save/i)).toBeInTheDocument())
      patchOk = true
      fireEvent.click(within(rowOf('Color Queue Shooter')).getByRole('button', { name: /^Save demo link for / }))
      await waitFor(() => expect(screen.queryByText('Color Queue Shooter')).toBeNull())
      expect(patches).toHaveLength(2)
    })
  })

  it('gives every link input and Save button a name that says which game it is for', async () => {
    await open([A, B])
    const row = rowOf('ArcFlush')
    expect(within(row).getByLabelText('Demo link for ArcFlush')).toBeInstanceOf(HTMLInputElement)
    const save = within(row).getByRole('button', { name: 'Save demo link for ArcFlush' })
    expect(save).toHaveTextContent('Save')
    expect(screen.getByLabelText('Demo link for Color Queue Shooter')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save demo link for Color Queue Shooter' })).toBeInTheDocument()
  })
})
