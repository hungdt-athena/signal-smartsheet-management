import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ReviewTable } from '@/components/report/ReviewTable'

// The Individual tab's review table: one evaluator's judged games, one per row,
// with screenshots -- so a wrong call is obvious without leaving the Report for
// the Evaluations screen. It owns its own filters (defaulting to the newest 3
// days that actually have rows, not the last 3 calendar days) and pages through
// GET /api/evaluations with the repo's existing sentinel idiom.

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    game_id: 'g1',
    title: 'Merge Puzzle',
    icon_url: 'https://cdn.example/icon1.png',
    publisher_name: 'Acme Studio',
    release_date: '2026-08-01',
    os: 'ios',
    app_link: 'https://apps.apple.com/g1',
    initial_conclusion: 'List_Idea',
    evaluate_date: '2026-09-22T10:00:00.000Z',
    updated_at: '2026-09-22T10:00:00.000Z',
    screenshot_urls: ['https://cdn.example/s1.png', 'https://cdn.example/s2.png'],
    manual_screenshot_urls: null,
    ...overrides,
  }
}

// jsdom has no IntersectionObserver. Two stand-ins: one that never intersects
// (so the sentinel effect can be observed without paging), one that fires as
// soon as it is observed (the shape scrolling the real sentinel into view has).
class NoopObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}
class FiringObserver {
  cb: (e: { isIntersecting: boolean }[]) => void
  constructor(cb: (e: { isIntersecting: boolean }[]) => void) { this.cb = cb }
  observe() { this.cb([{ isIntersecting: true }]) }
  disconnect() {}
  unobserve() {}
}

function installObserver(kind: 'noop' | 'firing') {
  global.IntersectionObserver = (kind === 'noop' ? NoopObserver : FiringObserver) as unknown as typeof IntersectionObserver
}

function parseCalls(mock: jest.Mock) {
  return mock.mock.calls.map(([url]) => {
    const u = new URL(String(url), 'http://x')
    return Object.fromEntries(u.searchParams.entries())
  })
}

beforeEach(() => {
  installObserver('noop')
})

describe('ReviewTable', () => {
  it('defaults to the newest 3 days with rows, puzzle, List_Idea', async () => {
    const probeRows = [
      row({ id: 1, evaluate_date: '2026-09-22T09:00:00Z', updated_at: '2026-09-22T09:00:00Z' }),
      row({ id: 2, evaluate_date: '2026-09-22T08:00:00Z', updated_at: '2026-09-22T08:00:00Z' }),
      row({ id: 3, evaluate_date: '2026-09-20T09:00:00Z', updated_at: '2026-09-20T09:00:00Z' }),
      // A gap day (09-19) with nothing, then an older day that must NOT be pulled
      // in once 3 distinct days (22, 20, 18) are already found.
      row({ id: 4, evaluate_date: '2026-09-18T09:00:00Z', updated_at: '2026-09-18T09:00:00Z' }),
      row({ id: 5, evaluate_date: '2026-09-10T09:00:00Z', updated_at: '2026-09-10T09:00:00Z' }),
    ]
    const fetchMock = jest.fn(async (url: string) => {
      const u = new URL(url, 'http://x')
      const isProbe = u.searchParams.get('limit') === '100'
      return {
        ok: true,
        json: async () => ({ data: isProbe ? probeRows : [probeRows[0], probeRows[1], probeRows[2]] }),
      } as Response
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const calls = parseCalls(fetchMock)
    const probeCall = calls.find(c => c.limit === '100')!
    expect(probeCall.category).toBe('puzzle')
    expect(probeCall.conclusion).toBe('List_Idea')
    expect(probeCall.evaluator).toBe('NhiLV')

    const listCall = calls.find(c => c.limit === '20')!
    expect(listCall.category).toBe('puzzle')
    expect(listCall.conclusion).toBe('List_Idea')
    expect(listCall.with_screenshots).toBe('1')
    expect(listCall.date_basis).toBe('evaluated')
    expect(listCall.page).toBe('1')
    // Newest 3 distinct days present: 09-22, 09-20, 09-18 -- the gap and the
    // older 09-10 row must not shift the window.
    expect(listCall.from).toBe('2026-09-18')
    expect(listCall.to).toBe('2026-09-22')

    await waitFor(() => expect(screen.getAllByText('Merge Puzzle').length).toBeGreaterThan(0))
  })

  it('refetches from page 1 when a filter changes', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      const u = new URL(url, 'http://x')
      const isProbe = u.searchParams.get('limit') === '100'
      return { ok: true, json: async () => ({ data: isProbe ? [] : [row()] }) } as Response
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())
    fetchMock.mockClear()

    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'arcade' } })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const calls = parseCalls(fetchMock)
    expect(calls[0].category).toBe('arcade')
    expect(calls[0].page).toBe('1')
  })

  it('appends page 2 from the sentinel rather than replacing page 1', async () => {
    installObserver('firing')
    const page1 = Array.from({ length: 20 }, (_, i) => row({ id: i + 1, title: `Game ${i + 1}` }))
    const page2 = [row({ id: 21, title: 'Game 21' })]
    const fetchMock = jest.fn(async (url: string) => {
      const u = new URL(url, 'http://x')
      const isProbe = u.searchParams.get('limit') === '100'
      if (isProbe) return { ok: true, json: async () => ({ data: [] }) } as Response
      const page = u.searchParams.get('page')
      return { ok: true, json: async () => ({ data: page === '2' ? page2 : page1 }) } as Response
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)

    await waitFor(() => expect(screen.getByText('Game 1')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('Game 21')).toBeInTheDocument())
    // Page 1's rows are still there -- page 2 was appended, not swapped in.
    expect(screen.getByText('Game 1')).toBeInTheDocument()
    expect(screen.getAllByText(/^Game \d+$/).length).toBe(21)
  })

  it('renders a game with no screenshots without an empty strip', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      const u = new URL(url, 'http://x')
      const isProbe = u.searchParams.get('limit') === '100'
      return {
        ok: true,
        json: async () => ({ data: isProbe ? [] : [row({ screenshot_urls: null, manual_screenshot_urls: null })] }),
      } as Response
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    expect(document.querySelector('.rp-review-shots')).toBeNull()
  })

  it('falls back to manual screenshots when the StoreKit array is empty', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      const u = new URL(url, 'http://x')
      const isProbe = u.searchParams.get('limit') === '100'
      return {
        ok: true,
        json: async () => ({
          data: isProbe ? [] : [row({ screenshot_urls: [], manual_screenshot_urls: ['https://cdn.example/manual1.png'] })],
        }),
      } as Response
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(document.querySelector('.rp-review-shots')).not.toBeNull())
    const img = document.querySelector('.rp-review-shot') as HTMLImageElement
    expect(img.src).toBe('https://cdn.example/manual1.png')
  })

  it('opens the shared lightbox with the whole strip on a screenshot click', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      const u = new URL(url, 'http://x')
      const isProbe = u.searchParams.get('limit') === '100'
      return { ok: true, json: async () => ({ data: isProbe ? [] : [row()] }) } as Response
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    const shots = document.querySelectorAll('.rp-review-shot')
    expect(shots.length).toBe(2)
    fireEvent.click(shots[1])

    const lightboxImgs = document.querySelectorAll('.lightbox-backdrop img')
    // The whole row's strip must be browsable, not just the clicked shot.
    expect(lightboxImgs.length).toBe(2)
    expect((lightboxImgs[1] as HTMLImageElement).src).toBe('https://cdn.example/s2.png')
    expect((lightboxImgs[1] as HTMLImageElement).style.border).toContain('var(--accent)')
  })

  it('expands the table out of the content column and can be toggled back', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      const u = new URL(url, 'http://x')
      const isProbe = u.searchParams.get('limit') === '100'
      return { ok: true, json: async () => ({ data: isProbe ? [] : [row()] }) } as Response
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const { container } = render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    const root = container.querySelector('.rp-review-table') as HTMLElement
    expect(root.className).not.toMatch(/expanded/)

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    expect(root.className).toMatch(/expanded/)

    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
    expect(root.className).not.toMatch(/expanded/)
  })

  it('renders a sentence naming the filters when the result is empty, instead of a blank area', async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ data: [] }) } as Response))
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)

    await waitFor(() => expect(document.querySelector('.rp-review-rows')).toBeNull())
    const empty = document.querySelector('.rp-review-empty')
    expect(empty).not.toBeNull()
    expect(empty!.textContent).toMatch(/puzzle/i)
    expect(empty!.textContent).toMatch(/List_Idea/)
    expect(empty!.textContent).toMatch(/You/)
  })

  it('names the evaluator (not "You") in the empty sentence when the viewer can see the team', async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ data: [] }) } as Response))
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="QuangVN" canSeeTeam={true} />)

    await waitFor(() => expect(document.querySelector('.rp-review-empty')).not.toBeNull())
    expect(document.querySelector('.rp-review-empty')!.textContent).toMatch(/QuangVN/)
  })

  it('renders a row with every optional field missing without NaN, Infinity or undefined on screen', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      const u = new URL(url, 'http://x')
      const isProbe = u.searchParams.get('limit') === '100'
      return {
        ok: true,
        json: async () => ({
          data: isProbe ? [] : [row({
            title: null, icon_url: null, publisher_name: null, release_date: null,
            os: null, app_link: null, initial_conclusion: null,
            evaluate_date: null, updated_at: null,
            screenshot_urls: null, manual_screenshot_urls: null,
          })],
        }),
      } as Response
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const { container } = render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(container.querySelector('.rp-review-row')).not.toBeNull())

    const text = container.textContent || ''
    expect(text).not.toMatch(/NaN/)
    expect(text).not.toMatch(/Infinity/)
    expect(text).not.toMatch(/undefined/)
    expect(document.querySelector('.rp-review-shots')).toBeNull()
    // The specific placeholders that keep those bad strings off screen: a missing
    // title/developer read as words, a missing platform/release/conclusion/judged
    // date read as the codebase's existing "no value" glyph -- not a blank cell.
    expect(screen.getByText('Untitled')).toBeInTheDocument()
    expect(screen.getByText('Unknown developer')).toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3) // platform, release date, conclusion
    expect(screen.getByText(/Judged —/)).toBeInTheDocument()
  })
})
