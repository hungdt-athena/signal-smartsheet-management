import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { WeeklyFeedbackTab } from '@/components/weekly-feedback/WeeklyFeedbackTab'

jest.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { role: 'admin', name: 'VinhTD' } } }),
}))

// View and filters live in the URL. A stand-in router that writes to jsdom's
// location and re-renders every reader, the way the real one does.
jest.mock('next/navigation', () => {
  const React = jest.requireActual('react')
  const subs = new Set<() => void>()
  const read = () => window.location.search
  const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
  return {
    useSearchParams: () => {
      const qs = React.useSyncExternalStore(subscribe, read, read)
      return React.useMemo(() => new URLSearchParams(qs), [qs])
    },
    useRouter: () => ({ replace: (url: string) => { window.history.replaceState(null, '', url); subs.forEach(f => f()) } }),
    usePathname: () => '/evaluations',
  }
})
beforeEach(() => { window.history.replaceState(null, '', '/evaluations') })

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const RECORDS = [
  { batch: 'W2 Oct, 2026', evaluator: 'HuyDD', updated_at: '2026-10-10T00:00:00Z', sections: [{ id: 's1', feedback: doc('merge loop is strong'), alikes: [] }] },
  { batch: 'W2 Oct, 2026', evaluator: 'Mitt', updated_at: '2026-10-10T00:00:00Z', sections: [{ id: 's2', feedback: doc('idle pacing'), alikes: [] }] },
]

const SEP_RECORD = { batch: 'W4 Sep, 2026', evaluator: 'HuyDD', updated_at: '2026-09-28T00:00:00Z', sections: [{ id: 's3', feedback: doc('older note'), alikes: [] }] }

let hits: string[] = []
let listOk = true
let withSep = false

function stubFetch() {
  hits = []
  global.fetch = jest.fn(async (url: string) => {
    const u = String(url)
    hits.push(u)
    if (u.startsWith('/api/weekly-feedback/batches')) {
      const batches = withSep ? ['W2 Oct, 2026', 'W4 Sep, 2026'] : ['W2 Oct, 2026']
      return { ok: true, json: async () => ({ batches, allBatches: batches, evaluators: ['HuyDD', 'Mitt'] }) } as Response
    }
    if (u.startsWith('/api/weekly-feedback?')) {
      if (!listOk) return { ok: false, json: async () => ({}) } as Response
      const all = withSep ? [...RECORDS, SEP_RECORD] : RECORDS
      const b = new URL(u, 'http://x').searchParams.get('batch')
      return { ok: true, json: async () => ({ records: b ? all.filter(r => r.batch === b) : all }) } as Response
    }
    return { ok: true, json: async () => ({}) } as Response
  }) as unknown as typeof fetch
}

describe('Weekly Feedback', () => {
  beforeEach(() => { listOk = true; withSep = false; stubFetch() })

  it('counts the records and narrows them by search, with Clear filters to undo', async () => {
    render(<WeeklyFeedbackTab />)
    await waitFor(() => expect(screen.getByText('2 records')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Search feedback or games'), { target: { value: 'merge' } })
    // The list narrows at once; the URL follows after the typing pauses.
    expect(screen.getByText('1 of 2 records')).toBeInTheDocument()
    await waitFor(() => expect(window.location.search).toContain('q=merge'))

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(screen.getByText('2 records')).toBeInTheDocument())
    expect(window.location.search).not.toContain('q=')
  })

  it('keeps the batch filter in the URL and sends it to the API', async () => {
    render(<WeeklyFeedbackTab />)
    await waitFor(() => expect(screen.getByText('2 records')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Batch: All batches' }))
    const pop = screen.getByRole('dialog', { name: 'Pick a batch' })
    fireEvent.click(within(within(pop).getByRole('group', { name: 'Batch' })).getByText('W2 Oct, 2026'))
    await waitFor(() => expect(window.location.search).toContain('batch=W2'))
    await waitFor(() => expect(hits.some(u => u.includes('batch=W2'))).toBe(true))
  })

  it('picks a whole month: keeps it in the URL and shows only that month\'s batches', async () => {
    withSep = true
    render(<WeeklyFeedbackTab />)
    await waitFor(() => expect(screen.getByText('3 records')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Batch: All batches' }))
    const pop = screen.getByRole('dialog', { name: 'Pick a batch' })
    fireEvent.click(within(pop).getByText('All of Oct 2026'))
    await waitFor(() => expect(window.location.search).toContain('batch=month%3A2026-10'))
    // A month loads every batch and keeps its own four labels, client-side.
    await waitFor(() => expect(screen.getByText('2 records')).toBeInTheDocument())
    expect(screen.queryByText('W4 Sep, 2026')).not.toBeInTheDocument()
    expect(hits.filter(u => u.startsWith('/api/weekly-feedback?')).every(u => !u.includes('batch='))).toBe(true)
    expect(screen.getByRole('button', { name: 'Batch: All of Oct 2026' })).toBeInTheDocument()
  })

  it('shows a failed load as an error, not as an empty list', async () => {
    listOk = false
    render(<WeeklyFeedbackTab />)
    await waitFor(() => expect(screen.getByText('Could not load the feedback.')).toBeInTheDocument())
    expect(screen.queryByText('No feedback recorded yet.')).not.toBeInTheDocument()
    listOk = true
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByText('2 records')).toBeInTheDocument())
  })

  it('opens the Editor on its batch picker and keeps the view in the URL', async () => {
    render(<WeeklyFeedbackTab />)
    await waitFor(() => expect(screen.getByText('2 records')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Editor' }))
    await waitFor(() => expect(window.location.search).toContain('view=editor'))
    expect(screen.getByRole('button', { name: 'Batch: Select a batch' })).toBeInTheDocument()
  })
})
