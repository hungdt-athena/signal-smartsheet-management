import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

class NoopObserver { observe() {} disconnect() {} unobserve() {} }
global.IntersectionObserver = NoopObserver as unknown as typeof IntersectionObserver

jest.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { id: 1, role: 'admin', name: 'HungDT', email: 'hungdt@athena.studio' } },
    status: 'authenticated',
  }),
}))
// The page keeps its view and filters in the URL (lib/use-url-state). This stand-in for
// next/navigation keeps the query string in jsdom's location, so changing a filter
// re-renders the page the way the real router does.
jest.mock('next/navigation', () => {
  const React = jest.requireActual('react')
  const listeners = new Set<() => void>()
  const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
  const read = () => window.location.search
  const router = {
    replace: (url: string) => { window.history.replaceState(null, '', url); listeners.forEach(l => l()) },
  }
  return {
    useSearchParams: () => {
      const qs = React.useSyncExternalStore(subscribe, read, read)
      return React.useMemo(() => new URLSearchParams(qs), [qs])
    },
    useRouter: () => router,
    usePathname: () => window.location.pathname,
  }
})
jest.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ conclusion: [], final_conclusion: ['Insight', 'Priority IV', 'Bypass'] }) }))
jest.mock('@/components/EvalDetailPanel', () => ({
  __esModule: true,
  default: () => <div data-testid="eval-panel" />,
  weekBatches: () => ['W3 Oct, 2026', 'W2 Oct, 2026'],
}))
jest.mock('@/components/StyledSelect', () => ({
  StyledSelect: ({ value, onChange, options, placeholder }: {
    value: string; onChange: (v: string) => void
    options: { value: string; label: string }[]; placeholder?: string
  }) => (
    <select aria-label={placeholder ?? 'select'} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}))
jest.mock('@/components/TrendTagCell', () => ({ TrendTagCell: () => null }))
jest.mock('@/components/QuickStatsModal', () => ({ QuickStatsModal: () => null }))
jest.mock('@/components/weekly-feedback/WeeklyFeedbackTab', () => ({ WeeklyFeedbackTab: () => null }))
jest.mock('@/components/TaggingTab', () => ({ TaggingTab: () => null }))

import EvaluationsPage from '@/app/(manager)/evaluations/page'

beforeEach(() => { window.history.replaceState(null, '', '/evaluations?cat=short_list') })

const row = (over: Record<string, unknown>) => ({
  id: 1, game_id: 'g1', title: 'Alpha', icon_url: null, os: 'ios', app_link: null,
  genre_1: null, genre_2: null, initial_evaluator: 'HungDT', initial_note: null, final_note: null,
  game_alike: null, initial_conclusion: 'List_Idea', final_conclusion: null,
  batch: 'W2 Oct, 2026', drive_link: null, publisher_name: null, assigned_date: null,
  evaluate_date: null, category_group: 'puzzle', tags: null, ...over,
})
const BREAKDOWN = [
  { batch: 'W1 Oct, 2026', final_conclusion: 'Insight', category_group: 'puzzle', n: 3 },
  { batch: 'W1 Oct, 2026', final_conclusion: 'Priority IV', category_group: 'arcade', n: 1 },
  { batch: 'W2 Oct, 2026', final_conclusion: 'Insight', category_group: 'puzzle', n: 2 },
  { batch: 'W2 Oct, 2026', final_conclusion: '(none)', category_group: 'puzzle', n: 40 },
]

function stubFetch() {
  const urls: string[] = []
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    let body: unknown = {}
    if (url.startsWith('/api/evaluations/facets')) {
      body = { available_months: [], available_conclusions: ['List_Idea'], available_evaluators: [], available_batches: ['W1 Oct, 2026', 'W2 Oct, 2026', 'W4 Sep, 2026'], current_batch: 'W2 Oct, 2026', default_batch: 'W2 Oct, 2026' }
    } else if (url.startsWith('/api/evaluations/current-batch')) {
      body = { current_batch: 'W2 Oct, 2026', starts_at: '2026-10-06T11:28' }
    } else if (url.startsWith('/api/evaluations?')) {
      body = { data: [row({})], total: 1, applied_month: null, breakdown: BREAKDOWN }
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
  }) as unknown as typeof fetch
  return urls
}
const rowsUrls = (urls: string[]) => urls.filter(u => u.startsWith('/api/evaluations?')).map(u => new URLSearchParams(u.split('?')[1]))
const lastRows = (urls: string[]) => rowsUrls(urls).slice(-1)[0]
const view = (name: string | RegExp) => screen.getByRole('button', { name })
// A stat card, not the filter menu that may show the same word.
const card = (name: RegExp) => within(document.querySelector('.sl-stats') as HTMLElement).getByRole('button', { name })

describe('Short List / Monthly views', () => {
  it('Short List: cards count final conclusions of the selected batch and filter on click', async () => {
    const urls = stubFetch()
    render(<EvaluationsPage />)
    await screen.findByText('Alpha')
    // Default batch is the current one (W2): 2 Insight, 40 not set, nothing else.
    await waitFor(() => expect(card(/^Not set/)).toHaveTextContent('40'))
    expect(card(/^Insight/)).toHaveTextContent('2')
    expect(card(/^All/)).toHaveTextContent('42')

    fireEvent.click(card(/^Insight/))
    await waitFor(() => expect(lastRows(urls).get('final_conclusions')).toBe('Insight'))
    fireEvent.click(card(/^Insight/)) // a second click clears it
    await waitFor(() => expect(lastRows(urls).get('final_conclusions')).toBeNull())
  })

  it('shows when the current batch starts on the header button, and offers it in the popover', async () => {
    stubFetch()
    render(<EvaluationsPage />)
    await screen.findByText('Alpha')
    const btn = await screen.findByRole('button', { name: /Current batch.*W2 Oct, 2026.*from 6 Oct, 11:28/ })
    fireEvent.click(btn)
    expect((screen.getByLabelText('Starts at') as HTMLInputElement).value).toBe('2026-10-06T11:28')
  })

  it('Batch view: the final-conclusion filter reads All, and names every call plus Not set and Other', async () => {
    const urls = stubFetch()
    render(<EvaluationsPage />)
    await screen.findByText('Alpha')
    expect(screen.getByRole('button', { name: 'Batch' })).toHaveAttribute('aria-pressed', 'true')

    const select = screen.getByLabelText('Final conclusions') as HTMLSelectElement
    expect(select.value).toBe('all')
    expect(Array.from(select.options).map(o => o.textContent).filter(x => x && x !== 'Final conclusions')).toEqual(
      ['All final conclusions', 'Not set', 'Insight', 'Priority IV', 'Bypass', 'Other (all except Insight, Priority IV)'])

    fireEvent.change(select, { target: { value: 'Priority IV' } })
    await waitFor(() => expect(lastRows(urls).get('final_conclusions')).toBe('Priority IV'))
    fireEvent.change(select, { target: { value: 'all' } })
    await waitFor(() => expect(lastRows(urls).get('final_conclusions')).toBeNull())
  })

  it('Monthly: lists Insight + Priority IV of every category for one month, by batch label, not by date', async () => {
    const urls = stubFetch()
    render(<EvaluationsPage />)
    await screen.findByText('Alpha')
    fireEvent.click(view('Monthly'))

    await waitFor(() => expect(lastRows(urls).get('batch_month')).toBe('2026-10'))
    const q = lastRows(urls)
    expect(q.get('category')).toBe('all')
    expect(q.get('final_conclusions')).toBe('Insight,Priority IV')
    expect(q.get('breakdown')).toBe('1')
    expect(q.get('batch')).toBeNull()
    // The date filter is back (all time by default): no from/to unless someone sets one.
    expect(q.get('date_basis')).toBe('evaluated')
    expect(q.get('from')).toBeNull()

    // One page, one title: Monthly is a view of Short List, not a page of its own.
    expect(screen.getByRole('heading', { name: 'Short List' })).toBeInTheDocument()
    // The view is in the URL, so a reload or a shared link opens Monthly again.
    expect(window.location.search).toContain('view=monthly')
    // Month card: 5 games (3+2 Insight, 1 Priority IV -> 6 actually), W1 has 4.
    await waitFor(() => expect(view(/^W1/)).toHaveTextContent('4'))
    expect(view(/^Oct 2026/)).toHaveTextContent('6')
    expect(view(/^W3/)).toHaveTextContent('0')

    fireEvent.click(view(/^W1/))
    await waitFor(() => expect(lastRows(urls).get('batch')).toBe('W1 Oct, 2026'))
    expect(lastRows(urls).get('batch_month')).toBe('2026-10')
    fireEvent.click(view(/^W1/)) // click again: back to the whole month
    await waitFor(() => expect(lastRows(urls).get('batch')).toBeNull())
  })

  it('Monthly: the final-conclusion filter reads All, offers only Insight and Priority IV, and the cards follow it', async () => {
    const urls = stubFetch()
    render(<EvaluationsPage />)
    await screen.findByText('Alpha')
    fireEvent.click(view('Monthly'))
    await waitFor(() => expect(lastRows(urls).get('batch_month')).toBe('2026-10'))

    const select = screen.getByLabelText('Final conclusions') as HTMLSelectElement
    expect(select.value).toBe('all')
    expect(Array.from(select.options).map(o => o.textContent).filter(x => x && x !== 'Final conclusions')).toEqual(['All final conclusions', 'Insight', 'Priority IV'])
    expect(lastRows(urls).get('final_conclusions')).toBe('Insight,Priority IV')

    fireEvent.change(select, { target: { value: 'Insight' } })
    await waitFor(() => expect(lastRows(urls).get('final_conclusions')).toBe('Insight'))
    await waitFor(() => expect(view(/^W1/)).toHaveTextContent('3'))
    expect(view(/^W1/)).not.toHaveTextContent('Priority IV')

    fireEvent.change(select, { target: { value: 'all' } })
    await waitFor(() => expect(lastRows(urls).get('final_conclusions')).toBe('Insight,Priority IV'))
  })

  it('going back to Short List puts the old scope back', async () => {
    const urls = stubFetch()
    render(<EvaluationsPage />)
    await screen.findByText('Alpha')
    await waitFor(() => expect(lastRows(urls).get('batch')).toBe('W2 Oct, 2026'))
    fireEvent.click(view('Monthly'))
    await waitFor(() => expect(lastRows(urls).get('category')).toBe('all'))
    fireEvent.click(view('Batch'))
    await waitFor(() => expect(lastRows(urls).get('category')).toBe('puzzle'))
    const q = lastRows(urls)
    expect(q.get('batch')).toBe('W2 Oct, 2026')
    expect(q.get('conclusions')).toBe('List_Idea')
    expect(q.get('final_conclusions')).toBeNull()
    expect(q.get('batch_month')).toBeNull()
  })
})
