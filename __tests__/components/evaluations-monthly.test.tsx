import { fireEvent, render, screen, waitFor } from '@testing-library/react'

class NoopObserver { observe() {} disconnect() {} unobserve() {} }
global.IntersectionObserver = NoopObserver as unknown as typeof IntersectionObserver

jest.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { id: 1, role: 'admin', name: 'HungDT', email: 'hungdt@athena.studio' } },
    status: 'authenticated',
  }),
}))
jest.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('cat=short_list') }))
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

describe('Short List / Monthly views', () => {
  it('Short List: cards count final conclusions of the selected batch and filter on click', async () => {
    const urls = stubFetch()
    render(<EvaluationsPage />)
    await screen.findByText('Alpha')
    // Default batch is the current one (W2): 2 Insight, 40 not set, nothing else.
    await waitFor(() => expect(view(/^Not set/)).toHaveTextContent('40'))
    expect(view(/^Insight/)).toHaveTextContent('2')
    expect(view(/^All/)).toHaveTextContent('42')

    fireEvent.click(view(/^Insight/))
    await waitFor(() => expect(lastRows(urls).get('final_conclusions')).toBe('Insight'))
    fireEvent.click(view(/^Insight/)) // a second click clears it
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

    expect(screen.getByRole('heading', { name: 'Monthly' })).toBeInTheDocument()
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

  it('Monthly: the filter bar offers only Insight and Priority IV, never empty, and the cards follow it', async () => {
    const urls = stubFetch()
    render(<EvaluationsPage />)
    await screen.findByText('Alpha')
    fireEvent.click(view('Monthly'))
    await waitFor(() => expect(lastRows(urls).get('batch_month')).toBe('2026-10'))

    // Both are on by default; the menu holds exactly those two values.
    fireEvent.click(screen.getByRole('button', { name: '2 selected' }))
    const menu = document.querySelector('.ssel-menu') as HTMLElement
    expect(Array.from(menu.querySelectorAll('.ssel-opt')).map(o => o.textContent)).toEqual(['Insight', 'Priority IV'])

    fireEvent.click(menu.querySelectorAll('.ssel-opt')[1]) // untick Priority IV
    await waitFor(() => expect(lastRows(urls).get('final_conclusions')).toBe('Insight'))
    await waitFor(() => expect(view(/^W1/)).toHaveTextContent('3'))
    expect(view(/^W1/)).not.toHaveTextContent('Priority IV')

    // The menu stays open: untick the last one left and it falls back to both.
    fireEvent.click((document.querySelector('.ssel-menu') as HTMLElement).querySelectorAll('.ssel-opt')[0])
    await waitFor(() => expect(lastRows(urls).get('final_conclusions')).toBe('Insight,Priority IV'))
  })

  it('going back to Short List puts the old scope back', async () => {
    const urls = stubFetch()
    render(<EvaluationsPage />)
    await screen.findByText('Alpha')
    await waitFor(() => expect(lastRows(urls).get('batch')).toBe('W2 Oct, 2026'))
    fireEvent.click(view('Monthly'))
    await waitFor(() => expect(lastRows(urls).get('category')).toBe('all'))
    fireEvent.click(view('Short List'))
    await waitFor(() => expect(lastRows(urls).get('category')).toBe('puzzle'))
    const q = lastRows(urls)
    expect(q.get('batch')).toBe('W2 Oct, 2026')
    expect(q.get('conclusions')).toBe('List_Idea')
    expect(q.get('final_conclusions')).toBeNull()
    expect(q.get('batch_month')).toBeNull()
  })
})
