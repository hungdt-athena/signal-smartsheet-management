import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

// What the search box on the Evaluate tab owes the user:
//
//   1. A search finds a game that exists, wherever it is. It used to filter only the
//      rows already on screen -- one page of one month -- so a game assigned in August
//      was simply not findable in September, which read as "search is broken".
//   2. It does not hammer the database on the way there. Under three characters no
//      trigram index can serve the query (measured: 673ms for '%me%' against 209ms for
//      '%mer%'), so short terms keep filtering the loaded rows for free and only a real
//      term goes to the server -- once, after the typing stops.
//   3. Clearing it puts the view back exactly as it was. The filters are never mutated,
//      only overridden while a search is live, so there is no state to restore wrongly.

class NoopObserver {
  observe() { /* the sentinel never intersects in jsdom */ }
  disconnect() { /* nothing to tear down */ }
  unobserve() { /* nothing to tear down */ }
}
global.IntersectionObserver = NoopObserver as unknown as typeof IntersectionObserver

jest.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { id: 1, role: 'admin', name: 'HungDT', email: 'hungdt@athena.studio' } },
    status: 'authenticated',
  }),
}))

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
}))

jest.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ conclusion: [], final_conclusion: [] }),
}))

jest.mock('@/components/EvalDetailPanel', () => ({
  __esModule: true,
  default: () => <div data-testid="eval-panel" />,
  weekBatches: () => [],
}))
jest.mock('@/components/QuickStatsModal', () => ({ QuickStatsModal: () => null }))
jest.mock('@/components/weekly-feedback/WeeklyFeedbackTab', () => ({ WeeklyFeedbackTab: () => null }))
jest.mock('@/components/TaggingTab', () => ({ TaggingTab: () => null }))

import EvaluationsPage from '@/app/(manager)/evaluations/page'

const APPLIED_MONTH = { year: 2026, month: 9 }

interface Row { id: number; game_id: string; title: string }

function stubFetch(
  rowsFor?: (url: string) => Row[],
  extra?: Record<string, unknown>,
  statsFor?: (url: string) => { total: number; evaluated: number; pending: number },
) {
  const calls: string[] = []
  const fn = jest.fn((input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    const body = url.startsWith('/api/evaluations/facets')
      ? {
        available_months: [APPLIED_MONTH],
        available_conclusions: ['List_Idea'],
        available_evaluators: ['HungDT', 'KhangNA'],
      }
      : {
        data: rowsFor ? rowsFor(url) : [],
        total: rowsFor ? rowsFor(url).length : 0,
        stats: statsFor ? statsFor(url) : { total: 0, evaluated: 0, pending: 0 },
        applied_month: APPLIED_MONTH,
        ...extra,
      }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
  })
  global.fetch = fn as unknown as typeof fetch
  return calls
}

const rowCalls = (calls: string[]) => calls.filter(u => u.startsWith('/api/evaluations?'))
const facetCalls = (calls: string[]) => calls.filter(u => u.startsWith('/api/evaluations/facets'))

const box = () => screen.getByPlaceholderText('Search games...')

/** The filter row's text, which is where the date pill lives. Read as a whole because
 *  the pill splits its label across text nodes, and the page subtitle mentions the
 *  month too. */
const filterRow = () => document.querySelector('.filter-row')?.textContent || ''

/** Type a term and let the debounce elapse. */
async function typeSearch(term: string) {
  fireEvent.change(box(), { target: { value: term } })
  await act(async () => { jest.advanceTimersByTime(500) })
}

/** Mount and wait for the first rows request to settle -- including the month=auto
 *  the server resolves in its response, which the picker only shows once applied. */
async function open(calls: string[]) {
  render(<EvaluationsPage />)
  await waitFor(() => expect(rowCalls(calls).length).toBe(1))
  await act(async () => { jest.advanceTimersByTime(500) })
  // The response carries the month=auto the server resolved; the picker showing it is
  // what tells us the first load has actually landed and not just been issued.
  await waitFor(() => expect(filterRow()).toContain('Sep 2026'))
}

describe('searching on the Evaluate tab', () => {
  beforeEach(() => { jest.useFakeTimers() })
  afterEach(() => { jest.useRealTimers() })

  it('does not go to the server for a term no index can serve', async () => {
    const calls = stubFetch()
    await open(calls)
    await typeSearch('me')
    expect(rowCalls(calls).length).toBe(1)
  })

  it('sends one request per search, not one per keystroke', async () => {
    const calls = stubFetch()
    await open(calls)

    fireEvent.change(box(), { target: { value: 'mer' } })
    fireEvent.change(box(), { target: { value: 'merg' } })
    fireEvent.change(box(), { target: { value: 'merge' } })
    await act(async () => { jest.advanceTimersByTime(500) })

    await waitFor(() => expect(rowCalls(calls).length).toBe(2))
    expect(rowCalls(calls)[1]).toContain('q=merge')
  })

  it('searches all time, ignoring the month the picker is on', async () => {
    const calls = stubFetch()
    await open(calls)
    await typeSearch('merge')

    await waitFor(() => expect(rowCalls(calls).length).toBe(2))
    const url = rowCalls(calls)[1]
    expect(url).not.toContain('from=')
    expect(url).not.toContain('to=')
    expect(url).not.toContain('month=')
  })

  it('finds a game by its store id', async () => {
    const calls = stubFetch(url => url.includes('q=6762543798')
      ? [{ id: 1, game_id: '6762543798', title: 'Merge Whale' }]
      : [])
    await open(calls)
    await typeSearch('6762543798')

    await waitFor(() => expect(rowCalls(calls)[1]).toContain('q=6762543798'))
    expect(await screen.findByText('Merge Whale')).toBeTruthy()
  })

  it('leaves the dropdown facets alone: a search is not a filter change', async () => {
    const calls = stubFetch()
    await open(calls)
    const before = facetCalls(calls).length
    await typeSearch('merge')
    await waitFor(() => expect(rowCalls(calls).length).toBe(2))
    expect(facetCalls(calls).length).toBe(before)
  })

  it('puts the original month back when the search is cleared', async () => {
    const calls = stubFetch()
    await open(calls)
    await typeSearch('merge')
    await waitFor(() => expect(rowCalls(calls).length).toBe(2))

    await typeSearch('')
    await waitFor(() => expect(rowCalls(calls).length).toBe(3))
    const url = rowCalls(calls)[2]
    expect(url).not.toContain('q=')
    expect(url).toContain('from=2026-09-01')
    expect(url).toContain('to=2026-09-30')
  })

  it('says the result count is a floor when the server capped it', async () => {
    const calls = stubFetch(
      url => url.includes('q=merge') ? [{ id: 1, game_id: 'g1', title: 'Merge Whale' }] : [],
      { total: 501, total_capped: true },
    )
    await open(calls)
    await typeSearch('merge')
    await waitFor(() => expect(rowCalls(calls).length).toBe(2))
    expect(await screen.findByText(/500\+ results/)).toBeTruthy()
  })
})

describe('what the filter row says while searching', () => {
  beforeEach(() => { jest.useFakeTimers() })
  afterEach(() => { jest.useRealTimers() })

  it('shows the date filter as all-time, and puts the month back afterwards', async () => {
    const calls = stubFetch()
    await open(calls)

    await typeSearch('merge')
    await waitFor(() => expect(rowCalls(calls).length).toBe(2))
    expect(filterRow()).toContain('All time')
    expect(filterRow()).not.toContain('Sep 2026')

    await typeSearch('')
    await waitFor(() => expect(filterRow()).toContain('Sep 2026'))
  })
})

describe('the stat cards during a search', () => {
  beforeEach(() => { jest.useFakeTimers() })
  afterEach(() => { jest.useRealTimers() })

  it('keeps describing the month, not the search', async () => {
    // The cards above the table are the month's workload -- how much of it is done.
    // A search is a lookup, and its total is capped at 500 anyway, so letting it
    // rewrite those cards would put a made-up number under "Total Games".
    const calls = stubFetch(
      url => url.includes('q=merge') ? [{ id: 1, game_id: 'g1', title: 'Merge Whale' }] : [],
      undefined,
      url => url.includes('q=merge')
        ? { total: 501, evaluated: 400, pending: 101 }
        : { total: 320, evaluated: 200, pending: 120 },
    )
    await open(calls)
    const totalCard = () => document.querySelectorAll('.stat-val')[0]?.textContent
    await waitFor(() => expect(totalCard()).toBe('320'))

    await typeSearch('merge')
    await waitFor(() => expect(rowCalls(calls).length).toBe(2))
    expect(totalCard()).toBe('320')
  })
})

describe('highlighting what matched', () => {
  beforeEach(() => { jest.useFakeTimers() })
  afterEach(() => { jest.useRealTimers() })

  const marks = () => Array.from(document.querySelectorAll('mark')).map(m => m.textContent)
  const rowText = () => document.querySelector('.tbl-row-premium')?.textContent || ''

  it('marks the matched run of the title, keeping its own casing', async () => {
    const calls = stubFetch(url => url.includes('q=merge')
      ? [{ id: 1, game_id: '6762543798', title: 'MERGE Whale' }]
      : [])
    await open(calls)
    await typeSearch('merge')

    await waitFor(() => expect(marks()).toEqual(['MERGE']))
  })

  it('shows the store id, marked, when that is what matched', async () => {
    // The id is not a column, so a search that matched on it would otherwise produce a
    // row with no visible reason for being there.
    const calls = stubFetch(url => url.includes('q=676254')
      ? [{ id: 1, game_id: '6762543798', title: 'Merge Whale' }]
      : [])
    await open(calls)
    await typeSearch('676254')

    await waitFor(() => expect(marks()).toEqual(['676254']))
    expect(rowText()).toContain('6762543798')
  })

  it('leaves the row as it was once the search is cleared', async () => {
    const calls = stubFetch(() => [{ id: 1, game_id: '6762543798', title: 'Merge Whale' }])
    await open(calls)
    await typeSearch('676254')
    await waitFor(() => expect(marks().length).toBe(1))

    await typeSearch('')
    await waitFor(() => expect(marks()).toEqual([]))
    // The id line goes with it: it exists only to explain a search hit.
    expect(rowText()).not.toContain('6762543798')
  })
})

describe('the controls a search overrides', () => {
  beforeEach(() => { jest.useFakeTimers() })
  afterEach(() => { jest.useRealTimers() })

  it('stops the sort button working while a search is live, and gives it back after', async () => {
    // Relevance decides a search's order, so the sort button has nothing to say. It is
    // properly disabled rather than only greyed: a CSS pointer-events rule leaves it
    // clickable by keyboard, and would let it fire a request that changes nothing.
    const calls = stubFetch()
    await open(calls)
    const sortBtn = () => screen.getByRole('button', { name: /first$/i })

    await typeSearch('merge')
    await waitFor(() => expect(rowCalls(calls).length).toBe(2))
    fireEvent.click(sortBtn())
    await act(async () => { jest.advanceTimersByTime(500) })
    expect(rowCalls(calls).length).toBe(2)

    await typeSearch('')
    await waitFor(() => expect(rowCalls(calls).length).toBe(3))
    fireEvent.click(sortBtn())
    await waitFor(() => expect(rowCalls(calls).length).toBe(4))
  })

  it('stops the status segments working too', async () => {
    const calls = stubFetch()
    await open(calls)

    await typeSearch('merge')
    await waitFor(() => expect(rowCalls(calls).length).toBe(2))
    fireEvent.click(screen.getByRole('button', { name: 'Pending' }))
    await act(async () => { jest.advanceTimersByTime(500) })
    expect(rowCalls(calls).length).toBe(2)
  })
})
