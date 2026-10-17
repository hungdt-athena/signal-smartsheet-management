import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

class NoopObserver {
  observe() { /* never intersects in jsdom */ }
  disconnect() { /* nothing */ }
  unobserve() { /* nothing */ }
}
global.IntersectionObserver = NoopObserver as unknown as typeof IntersectionObserver

let mockRole = 'admin'
// next-auth refetches the session on window focus; when that fails `data` is null. These
// let a test play that blip: 'authenticated' + user, or any other status with no data.
let mockStatus: 'authenticated' | 'loading' | 'unauthenticated' = 'authenticated'
jest.mock('next-auth/react', () => ({
  useSession: () => ({
    data: mockStatus === 'authenticated'
      ? { user: { id: 1, role: mockRole, name: 'HungDT', email: 'hungdt@athena.studio' } }
      : null,
    status: mockStatus,
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
jest.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ conclusion: [], final_conclusion: ['Good'] }) }))
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
import { toast } from '@/lib/toast'

beforeEach(() => { window.history.replaceState(null, '', '/evaluations?cat=short_list') })

const row = (over: Record<string, unknown>) => ({
  id: 1, game_id: 'g1', title: 'Alpha', icon_url: null, os: 'ios', app_link: null,
  genre_1: null, genre_2: null, initial_evaluator: 'HungDT', initial_note: null, final_note: null,
  game_alike: null, initial_conclusion: 'List_Idea', final_conclusion: null,
  batch: 'W1 Oct, 2026', drive_link: null, publisher_name: null, assigned_date: null,
  evaluate_date: null, category_group: 'puzzle', tags: null, ...over,
})
const ROWS = [row({ id: 1, game_id: 'g1', title: 'Alpha' }), row({ id: 2, game_id: 'g2', title: 'Beta', final_conclusion: 'Good' })]
// What the rows endpoint returns right now; a test can shrink it to simulate a reload.
let rowsNow: ReturnType<typeof row>[] = ROWS
// Whether POST /api/evaluations/current-batch succeeds.
let currentBatchOk = true
// When set, POST /api/evaluations/current-batch waits until the test answers it, so two saves
// can be in flight at once and settle in any order.
let holdCurrentBatch = false
let pendingPosts: ((ok: boolean) => void)[] = []
beforeEach(() => {
  rowsNow = ROWS; currentBatchOk = true; mockRole = 'admin'; mockStatus = 'authenticated'
  holdCurrentBatch = false; pendingPosts = []
})

function stubFetch() {
  const calls: { url: string; init?: RequestInit }[] = []
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    let body: unknown = {}
    if (url.startsWith('/api/evaluations/facets')) {
      body = { available_months: [], available_conclusions: ['List_Idea'], available_evaluators: ['PhuongNT1'], available_batches: ['W1 Oct, 2026', 'W4 Sep, 2026'], current_batch: 'W2 Oct, 2026', default_batch: 'W1 Oct, 2026' }
    } else if (url.startsWith('/api/evaluations/current-batch') && init?.method !== 'POST') {
      // the picker also READS the batch's start day; that is not a save
      body = { current_batch: 'W2 Oct, 2026', starts_at: '2026-10-06T11:28' }
    } else if (url.startsWith('/api/evaluations/current-batch')) {
      if (holdCurrentBatch) {
        return new Promise<Response>(r => { pendingPosts.push(ok => r({ ok, json: () => Promise.resolve({}) } as Response)) })
      }
      return Promise.resolve({ ok: currentBatchOk, json: () => Promise.resolve({}) } as Response)
    } else if (url.startsWith('/api/evaluations/batch-move')) {
      body = { moved: 2 }
    } else if (url.startsWith('/api/evaluations?')) {
      body = { data: rowsNow, total: rowsNow.length, applied_month: null }
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
  }) as unknown as typeof fetch
  return calls
}
const rowsCalls = (calls: { url: string }[]) => calls.filter(c => c.url.startsWith('/api/evaluations?'))

async function open(role = 'admin') {
  mockRole = role
  const calls = stubFetch()
  const view = render(<EvaluationsPage />)
  await screen.findByText('Alpha')
  return Object.assign(calls, { view })
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

  async function selectAll() {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByLabelText('Select all shown'))
    expect(screen.getByText('2 selected')).toBeInTheDocument()
  }

  // Every control that changes what the table lists must drop the selection, so a move
  // can never cover a game the manager can no longer see.
  it.each([
    ['category', () => fireEvent.click(screen.getByRole('button', { name: 'Arcade' }))],
    ['evaluator', () => fireEvent.change(screen.getByLabelText('All evaluators'), { target: { value: 'PhuongNT1' } })],
    ['batch', () => fireEvent.change(screen.getByLabelText('All batches'), { target: { value: 'W4 Sep, 2026' } })],
    // The bar's multi-select is Final conclusions; the cards are shortcuts into the same filter.
    ['final conclusion (menu)', () => fireEvent.change(screen.getByLabelText('Final conclusions'), { target: { value: 'Good' } })],
    // Final conclusion is filtered from the stat cards now, not a select.
    ['final conclusion (card)', () => fireEvent.click(screen.getByRole('button', { name: /^Not set/ }))],
    ['date range', () => {
      fireEvent.click(screen.getByRole('button', { name: /Evaluated/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Last 30 days' }))
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    }],
  ])('changing the %s filter drops the selection, so hidden games can never be moved', async (_name, change) => {
    await selectAll()
    change()
    await waitFor(() => expect(screen.queryByText(/^\d+ selected$/)).toBeNull())
  })

  it('sorting is not a filter: it keeps the selection', async () => {
    await selectAll()
    fireEvent.click(screen.getByTitle(/Sorted newest first/))
    expect(screen.getByText('2 selected')).toBeInTheDocument()
  })

  it('moves only the rows still on screen when a reload removes a selected one', async () => {
    const calls = await open()
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByLabelText('Select all shown'))
    expect(screen.getByText('2 selected')).toBeInTheDocument()

    // Beta disappears from the next load (e.g. someone else moved it). Sorting is not a
    // filter, so the selection survives the reload, but only Alpha is still listed.
    rowsNow = [ROWS[0]]
    fireEvent.click(screen.getByTitle(/Sorted newest first/))
    await waitFor(() => expect(screen.queryByText('Beta')).toBeNull())
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Move to batch'), { target: { value: 'W2 Oct, 2026' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Move 1 game' })) })

    const move = calls.find(c => c.url === '/api/evaluations/batch-move')!
    expect(JSON.parse(String(move.init?.body))).toEqual({ ids: [1], batch: 'W2 Oct, 2026' })
  })

  it('offers every batch that has games as a move target, not only the nearby weeks, newest first', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByLabelText('Select all shown'))
    const select = screen.getByLabelText('Move to batch')
    const options = within(select).getAllByRole('option').map(o => (o as HTMLOptionElement).value).filter(Boolean)
    // W4 Sep is not in this or next month's weeks; it is offered because games sit in it.
    expect(options).toEqual(['W3 Oct, 2026', 'W2 Oct, 2026', 'W1 Oct, 2026', 'W4 Sep, 2026'])
  })

  it('moves the selected games, leaves select mode and reloads the rows and the batch list', async () => {
    const calls = await open()
    const before = rowsCalls(calls).length
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByLabelText('Select all shown'))
    fireEvent.change(screen.getByLabelText('Move to batch'), { target: { value: 'W2 Oct, 2026' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('1 of them already has a final conclusion and will move too')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Move 2 games' })) })

    const move = calls.find(c => c.url === '/api/evaluations/batch-move')!
    expect(JSON.parse(String(move.init?.body))).toEqual({ ids: [1, 2], batch: 'W2 Oct, 2026' })
    await waitFor(() => expect(rowsCalls(calls).length).toBeGreaterThan(before))
    await waitFor(() => expect(checkboxes()).toHaveLength(0))
  })

  // --- fix wave ---------------------------------------------------------------------------

  it('shows no bar when a reload leaves none of the selected games on screen', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByLabelText('Select all shown'))
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    rowsNow = []
    fireEvent.click(screen.getByTitle(/Sorted newest first/))
    await waitFor(() => expect(screen.queryByText('Alpha')).toBeNull())
    expect(screen.queryByText(/\d+ selected$/)).toBeNull()
    expect(screen.queryByRole('region', { name: 'Move games to another batch' })).toBeNull()
  })

  it('drops select mode when the role stops being a manager, and does not bring it back', async () => {
    const calls = await open()
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByLabelText('Select Alpha'))
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    mockRole = 'evaluator'
    calls.view.rerender(<EvaluationsPage />)
    expect(checkboxes()).toHaveLength(0)
    expect(screen.queryByText('1 selected')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Select' })).toBeNull()

    mockRole = 'admin'
    calls.view.rerender(<EvaluationsPage />)
    expect(checkboxes()).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Select' })).toBeInTheDocument()
    expect(screen.queryByText('1 selected')).toBeNull()
  })

  describe('a session that blinks out is not a role drop', () => {
    it.each([['loading'], ['unauthenticated']] as const)(
      'keeps select mode and the selection when the session is briefly %s with no data', async status => {
        const calls = await open()
        fireEvent.click(screen.getByRole('button', { name: 'Select' }))
        fireEvent.click(screen.getByLabelText('Select all shown'))
        expect(screen.getByText('2 selected')).toBeInTheDocument()

        mockStatus = status
        calls.view.rerender(<EvaluationsPage />)
        // Nothing is shown to a viewer whose role is unknown...
        expect(screen.queryByRole('button', { name: 'Select' })).toBeNull()
        expect(checkboxes()).toHaveLength(0)

        // ...but the state survives and comes back with the session.
        mockStatus = 'authenticated'
        calls.view.rerender(<EvaluationsPage />)
        expect(screen.getByText('2 selected')).toBeInTheDocument()
        expect(checkboxes()).toHaveLength(3)
      })

    it('still resets when an authenticated session shows a non-manager role', async () => {
      const calls = await open()
      fireEvent.click(screen.getByRole('button', { name: 'Select' }))
      fireEvent.click(screen.getByLabelText('Select Alpha'))
      mockRole = 'evaluator'
      calls.view.rerender(<EvaluationsPage />)
      mockRole = 'admin'
      calls.view.rerender(<EvaluationsPage />)
      expect(screen.queryByText('1 selected')).toBeNull()
      expect(checkboxes()).toHaveLength(0)
    })
  })

  describe('current batch picker', () => {
    const post = (calls: { url: string; init?: RequestInit }[]) => calls.filter(c => c.url === '/api/evaluations/current-batch' && c.init?.method === 'POST')
    // The picker lives in a popover off the header: open it the first time it is needed.
    const openPopover = () => {
      if (!screen.queryByLabelText('Not set')) fireEvent.click(screen.getByRole('button', { name: /Current batch/ }))
    }
    const picker = () => { openPopover(); return screen.getByLabelText('Not set') as HTMLSelectElement }
    const ALERT = "Couldn't save the batch. Try again."
    // A failed save is reported as a toast (the Toaster itself is mounted in the root layout).
    let toastError: jest.SpyInstance
    let toastSuccess: jest.SpyInstance
    beforeEach(() => {
      toastError = jest.spyOn(toast, 'error').mockImplementation(() => 0)
      toastSuccess = jest.spyOn(toast, 'success').mockImplementation(() => 0)
    })
    afterEach(() => { toastError.mockRestore(); toastSuccess.mockRestore() })

    it('shows the moment the batch starts and saves a changed time with the batch', async () => {
      const calls = await open()
      const at = () => { openPopover(); return screen.getByLabelText('Starts at') as HTMLInputElement }
      await waitFor(() => expect(at().value).toBe('2026-10-06T11:28'))
      await act(async () => { fireEvent.change(at(), { target: { value: '2026-10-07T09:00' } }) })
      const sent = post(calls)
      expect(sent).toHaveLength(1)
      expect(JSON.parse(String(sent[0].init?.body))).toEqual({ batch: 'W2 Oct, 2026', starts_at: '2026-10-07T09:00' })
    })

    it('puts the old value back and says so when the save fails', async () => {
      const calls = await open()
      await waitFor(() => expect(picker().value).toBe('W2 Oct, 2026'))
      currentBatchOk = false
      await act(async () => { fireEvent.change(picker(), { target: { value: 'W3 Oct, 2026' } }) })
      expect(post(calls)).toHaveLength(1)
      await waitFor(() => expect(picker().value).toBe('W2 Oct, 2026'))
      expect(toastError).toHaveBeenCalledTimes(1)
      expect(toastError).toHaveBeenCalledWith(ALERT)
    })

    it('says so when the next change succeeds', async () => {
      const calls = await open()
      await waitFor(() => expect(picker().value).toBe('W2 Oct, 2026'))
      currentBatchOk = false
      await act(async () => { fireEvent.change(picker(), { target: { value: 'W3 Oct, 2026' } }) })
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(ALERT))
      currentBatchOk = true
      await act(async () => { fireEvent.change(picker(), { target: { value: 'W3 Oct, 2026' } }) })
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Current batch set to W3 Oct, 2026'))
      expect(toastError).toHaveBeenCalledTimes(1)
      expect(picker().value).toBe('W3 Oct, 2026')
      expect(post(calls)).toHaveLength(2)
    })

    describe('two quick changes', () => {
      const change = (v: string) => act(async () => { fireEvent.change(picker(), { target: { value: v } }) })
      const answer = (i: number, ok: boolean) => act(async () => { pendingPosts[i](ok) })

      it('first save fails after the second succeeded: the picker keeps the second pick, no message', async () => {
        await open()
        await waitFor(() => expect(picker().value).toBe('W2 Oct, 2026'))
        holdCurrentBatch = true
        await change('W3 Oct, 2026')
        await change('')
        expect(pendingPosts).toHaveLength(2)
        await answer(1, true)
        await answer(0, false)
        expect(picker().value).toBe('')
        expect(toastError).not.toHaveBeenCalled()
      })

      it('second save fails after the first succeeded: the picker goes back to the first pick, with the message', async () => {
        await open()
        await waitFor(() => expect(picker().value).toBe('W2 Oct, 2026'))
        holdCurrentBatch = true
        await change('W3 Oct, 2026')
        await change('')
        await answer(0, true)
        await answer(1, false)
        expect(picker().value).toBe('W3 Oct, 2026')
        expect(toastError).toHaveBeenCalledWith(ALERT)
      })

      it('a single failed save still goes back to the value the server confirmed on load', async () => {
        await open()
        await waitFor(() => expect(picker().value).toBe('W2 Oct, 2026'))
        holdCurrentBatch = true
        await change('W3 Oct, 2026')
        await answer(0, false)
        expect(picker().value).toBe('W2 Oct, 2026')
        expect(toastError).toHaveBeenCalledWith(ALERT)
      })
    })

    it('shows no message when the save works', async () => {
      await open()
      await waitFor(() => expect(picker().value).toBe('W2 Oct, 2026'))
      await act(async () => { fireEvent.change(picker(), { target: { value: 'W3 Oct, 2026' } }) })
      expect(picker().value).toBe('W3 Oct, 2026')
      expect(toastError).not.toHaveBeenCalled()
    })
  })

  describe('what the bar is told about the selected games', () => {
    const OLD = '2020-01-01T00:00:00Z'

    it('disables Move when every selected game is already in the chosen batch', async () => {
      await open()
      fireEvent.click(screen.getByRole('button', { name: 'Select' }))
      fireEvent.click(screen.getByLabelText('Select Alpha'))
      fireEvent.change(screen.getByLabelText('Move to batch'), { target: { value: 'W1 Oct, 2026' } })
      expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled()
      expect(screen.getByText('They are already in this batch.')).toBeInTheDocument()
    })

    it('warns about the Report window for a game evaluated long ago that moves to a newer batch', async () => {
      rowsNow = [row({ id: 1, game_id: 'g1', title: 'Alpha', batch: 'W1 Oct, 2026', evaluate_date: OLD })]
      await open()
      fireEvent.click(screen.getByRole('button', { name: 'Select' }))
      fireEvent.click(screen.getByLabelText('Select Alpha'))
      fireEvent.change(screen.getByLabelText('Move to batch'), { target: { value: 'W3 Oct, 2026' } })
      fireEvent.click(screen.getByRole('button', { name: 'Move' }))
      expect(screen.getByRole('dialog')).toHaveTextContent('1 of them was evaluated more than 8 days ago.')
    })
  })
})
