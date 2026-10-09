import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

class NoopObserver {
  observe() { /* never intersects in jsdom */ }
  disconnect() { /* nothing */ }
  unobserve() { /* nothing */ }
}
global.IntersectionObserver = NoopObserver as unknown as typeof IntersectionObserver

let mockRole = 'admin'
jest.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { id: 1, role: mockRole, name: 'HungDT', email: 'hungdt@athena.studio' } },
    status: 'authenticated',
  }),
}))
jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('cat=short_list'),
}))
jest.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ conclusion: [], final_conclusion: [] }) }))
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
  batch: 'W1 Oct, 2026', drive_link: null, publisher_name: null, assigned_date: null,
  evaluate_date: null, category_group: 'puzzle', tags: null, ...over,
})
const ROWS = [row({ id: 1, game_id: 'g1', title: 'Alpha' }), row({ id: 2, game_id: 'g2', title: 'Beta', final_conclusion: 'Good' })]

function stubFetch() {
  const calls: { url: string; init?: RequestInit }[] = []
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    let body: unknown = {}
    if (url.startsWith('/api/evaluations/facets')) {
      body = { available_months: [], available_conclusions: ['List_Idea'], available_evaluators: [], available_batches: ['W1 Oct, 2026'], current_batch: 'W2 Oct, 2026', default_batch: 'W1 Oct, 2026' }
    } else if (url.startsWith('/api/evaluations/batch-move')) {
      body = { moved: 2 }
    } else if (url.startsWith('/api/evaluations?')) {
      body = { data: ROWS, total: 2, applied_month: null }
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
  }) as unknown as typeof fetch
  return calls
}
const rowsCalls = (calls: { url: string }[]) => calls.filter(c => c.url.startsWith('/api/evaluations?'))

async function open(role = 'admin') {
  mockRole = role
  const calls = stubFetch()
  render(<EvaluationsPage />)
  await screen.findByText('Alpha')
  return calls
}
const checkboxes = () => screen.queryAllByRole('checkbox')

describe('Short List select mode', () => {
  it('shows no Select button to an evaluator', async () => {
    await open('evaluator')
    expect(screen.queryByRole('button', { name: 'Select' })).toBeNull()
  })

  it('hides the checkboxes until Select is pressed, then shows one per game plus select-all', async () => {
    await open()
    expect(checkboxes()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    expect(checkboxes()).toHaveLength(3)
    expect(screen.getByLabelText('Select all shown')).toBeInTheDocument()
  })

  it('Cancel hides the checkboxes and drops the selection', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByLabelText('Select Alpha'))
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0])
    expect(checkboxes()).toHaveLength(0)
    expect(screen.queryByText('1 selected')).toBeNull()
  })

  it('the action bar appears only while something is selected, and select-all selects every shown game', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    expect(screen.queryByText(/selected$/)).toBeNull()
    fireEvent.click(screen.getByLabelText('Select all shown'))
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Select all shown'))
    expect(screen.queryByText(/selected$/)).toBeNull()
  })

  it('clicking a checkbox does not open the game panel, but clicking the row does', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByLabelText('Select Alpha'))
    expect(screen.queryByTestId('eval-panel')).toBeNull()
    fireEvent.click(screen.getByText('Beta'))
    expect(screen.getByTestId('eval-panel')).toBeInTheDocument()
  })

  it('changing a filter drops the selection, so hidden games can never be moved', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByLabelText('Select all shown'))
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'arcade' } })
    await waitFor(() => expect(screen.queryByText(/selected$/)).toBeNull())
  })

  it('moves the selected games, leaves select mode and reloads the rows and the batch list', async () => {
    const calls = await open()
    const before = rowsCalls(calls).length
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByLabelText('Select all shown'))
    fireEvent.change(screen.getByLabelText('Move to batch'), { target: { value: 'W2 Oct, 2026' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('1 of them already has a final conclusion and will move too')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm move' })) })

    const move = calls.find(c => c.url === '/api/evaluations/batch-move')!
    expect(JSON.parse(String(move.init?.body))).toEqual({ ids: [1, 2], batch: 'W2 Oct, 2026' })
    await waitFor(() => expect(rowsCalls(calls).length).toBeGreaterThan(before))
    await waitFor(() => expect(checkboxes()).toHaveLength(0))
  })
})
