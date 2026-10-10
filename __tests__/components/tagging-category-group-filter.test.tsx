import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TaggingTab } from '@/components/TaggingTab'

jest.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { role: 'admin', name: 'VinhTD' } } }),
}))
jest.mock('@/components/EvalDetailPanel', () => ({
  __esModule: true,
  default: () => <div data-testid="eval-panel" />,
}))

const QUEUE = [{
  id: 1, game_id: 'g1', title: 'Farm Game', publisher_name: 'Pub', icon_url: null,
  initial_evaluator: 'Mitt', field_value: 'Farm Life', sub_value_id: null,
  sub_value_name: null, tagged_by_name: 'Mitt', tagged_at: '2026-10-04T00:00:00.000Z',
  their_sub_value_id: null, their_sub_value_name: null, conflict: false,
  game_category_group: 'arcade',
}]

// Block Puzzle is puzzle-only, Farm Life arcade-only, Food Hunt both.
const CATEGORY_GROUPS = {
  'Block Puzzle': ['puzzle'], 'Farm Life': ['arcade'], 'Food Hunt': ['arcade', 'puzzle'],
}

const CATALOG = [
  { value: 'Block Puzzle', total: 730, last30: 12, lastTaggedAt: null, hasInstruction: false, categoryGroups: ['puzzle'] },
  { value: 'Farm Life', total: 3, last30: 3, lastTaggedAt: null, hasInstruction: false, categoryGroups: ['arcade'] },
  { value: 'Food Hunt', total: 9, last30: 1, lastTaggedAt: null, hasInstruction: false, categoryGroups: ['arcade', 'puzzle'] },
]

let hits: string[] = []

function stubFetch() {
  hits = []
  global.fetch = jest.fn(async (url: string) => {
    const u = String(url)
    hits.push(u)
    if (u.startsWith('/api/playtest-tags/pending')) {
      return { ok: true, json: async () => ({ tags: QUEUE, total: 1 }) } as Response
    }
    if (u.startsWith('/api/playtest-tags/history')) {
      return { ok: true, json: async () => ({ rows: [], total: 0, taggers: [] }) } as Response
    }
    if (u.startsWith('/api/trends/options')) {
      return {
        ok: true,
        json: async () => ({
          values: Object.keys(CATEGORY_GROUPS), categoryGroups: CATEGORY_GROUPS, subValues: [],
        }),
      } as Response
    }
    if (u.startsWith('/api/trends/catalog')) {
      return { ok: true, json: async () => ({ trends: CATALOG }) } as Response
    }
    return { ok: true, json: async () => ({}) } as Response
  }) as unknown as typeof fetch
}

const last = (prefix: string) => hits.filter(u => u.startsWith(prefix)).pop() ?? ''
const groupBar = () => screen.getByRole('group', { name: 'Category group' })

// One filter, three views: the category group is picked once at the top of the tab and
// every view reads it, so switching to History or Trends does not drop it.
describe('Tagging > Category group filter', () => {
  beforeEach(stubFetch)

  it('starts on All and offers the three category groups', async () => {
    render(<TaggingTab />)
    await waitFor(() => expect(screen.getByText('Farm Game')).toBeInTheDocument())
    const bar = within(groupBar())
    expect(bar.getByRole('button', { name: 'All', pressed: true })).toBeInTheDocument()
    for (const g of ['puzzle', 'arcade', 'simulation']) {
      expect(bar.getByRole('button', { name: g })).toBeInTheDocument()
    }
    // All is the absence of a filter, not a category group called "all".
    expect(last('/api/playtest-tags/pending')).not.toContain('category_group=')
  })

  it('re-reads Pending from the first row when the category group changes', async () => {
    render(<TaggingTab />)
    await waitFor(() => expect(screen.getByText('Farm Game')).toBeInTheDocument())
    fireEvent.click(within(groupBar()).getByRole('button', { name: 'arcade' }))
    await waitFor(() => expect(last('/api/playtest-tags/pending')).toContain('category_group=arcade'))
    expect(last('/api/playtest-tags/pending')).toContain('offset=0')
  })

  it('carries the category group into History and back to All', async () => {
    render(<TaggingTab />)
    await waitFor(() => expect(screen.getByText('Farm Game')).toBeInTheDocument())
    fireEvent.click(within(groupBar()).getByRole('button', { name: 'simulation' }))
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    await waitFor(() => expect(last('/api/playtest-tags/history')).toContain('category_group=simulation'))
    expect(last('/api/playtest-tags/history')).toContain('page=1')

    fireEvent.click(within(groupBar()).getByRole('button', { name: 'All' }))
    await waitFor(() => expect(last('/api/playtest-tags/history')).not.toContain('category_group='))
  })

  it('narrows the Trends listing to trends defined for that group', async () => {
    render(<TaggingTab />)
    await waitFor(() => expect(screen.getByText('Farm Game')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Trends' }))
    await waitFor(() => expect(screen.getByText('Block Puzzle')).toBeInTheDocument())
    expect(screen.getByText('Farm Life')).toBeInTheDocument()

    fireEvent.click(within(groupBar()).getByRole('button', { name: 'arcade' }))
    await waitFor(() => expect(screen.queryByText('Block Puzzle')).not.toBeInTheDocument())
    expect(screen.getByText('Farm Life')).toBeInTheDocument()
    // Defined for both genres, so it stays under either.
    expect(screen.getByText('Food Hunt')).toBeInTheDocument()
    // No catalog request per genre: the list is local, like search and sort.
    expect(hits.filter(u => u.startsWith('/api/trends/catalog'))).toHaveLength(1)
  })

  // The row's own game decides what the picker opens on, whatever the filter
  // says: an admin on "All" still edits an arcade game's tag among arcade trends.
  it('opens a row\'s trend picker on that game\'s category group', async () => {
    render(<TaggingTab />)
    await waitFor(() => expect(screen.getByText('Farm Game')).toBeInTheDocument())
    await waitFor(() => expect(hits.some(u => u.startsWith('/api/trends/options'))).toBe(true))
    fireEvent.click(screen.getByTitle('Change the trend value'))
    const listed = Array.from(document.querySelectorAll('ul li button')).map(b => b.firstChild?.textContent)
    // Farm Life is the row's own tag, which the picker never offers back; Block
    // Puzzle is puzzle-only and stays out.
    expect(listed).toEqual(['Food Hunt'])
  })
})

// Ticks are kept by id, so a filter change that swaps the rows must clear them:
// otherwise Confirm would act on rows the admin can no longer see.
describe('Tagging > Category group filter and the selection', () => {
  beforeEach(stubFetch)

  it('drops ticked rows when the category group changes', async () => {
    render(<TaggingTab />)
    await waitFor(() => expect(screen.getByText('Farm Game')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('Select Farm Life on Farm Game'))
    expect(screen.getByRole('button', { name: 'Confirm 1 tag' })).toBeInTheDocument()

    fireEvent.click(within(groupBar()).getByRole('button', { name: 'puzzle' }))
    await waitFor(() => expect(last('/api/playtest-tags/pending')).toContain('category_group=puzzle'))
    expect(screen.queryByRole('button', { name: /^Confirm \d+ tag/ })).not.toBeInTheDocument()
  })
})
