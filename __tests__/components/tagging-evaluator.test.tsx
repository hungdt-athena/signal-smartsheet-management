import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TaggingTab } from '@/components/TaggingTab'

// The whole point of this file: the same tab, read by an evaluator.
jest.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { role: 'evaluator', name: 'Mitt' } } }),
}))
jest.mock('@/components/EvalDetailPanel', () => ({
  __esModule: true,
  default: () => <div data-testid="eval-panel" />,
}))

const PENDING = [{
  id: 1, game_id: 'g1', title: 'Balatro Clone', publisher_name: 'Pub',
  icon_url: null, initial_evaluator: 'Mitt', field_value: 'Balatro',
  sub_value_id: null, sub_value_name: null, tagged_by_name: 'Mitt',
  tagged_at: '2026-08-13T00:00:00.000Z', their_sub_value_id: 4,
  their_sub_value_name: 'Roguelike', conflict: true,
}]

// One tag corrected before it was confirmed, one confirmed exactly as proposed.
const HISTORY = [
  {
    id: 1, game_id: 'g1', title: 'Balatro Clone', icon_url: null,
    field_value: 'Merge', sub_value_name: 'Merge Two',
    tagged_by_name: 'Mitt', tagged_at: '2026-08-10T00:00:00.000Z',
    confirmed_by_name: 'VinhTD', confirmed_at: '2026-08-12T00:00:00.000Z',
    status: 'synced', sync_result: 'inserted', removed_at: null,
    removed_by: null, removed_by_name: null, in_signal_sense: true, ours: true,
    original_captured_at: '2026-08-11T00:00:00.000Z',
    original_field_value: 'Idle', original_sub_value_name: null,
    review_note: 'core loop is merge, not idle',
    sub_changed_at: null, sub_changed_from: null, sub_changed_to: null, sub_changed_by: null,
  },
  {
    id: 2, game_id: 'g1', title: 'Balatro Clone', icon_url: null,
    field_value: 'Backpack', sub_value_name: null,
    tagged_by_name: 'Mitt', tagged_at: '2026-08-10T00:00:00.000Z',
    confirmed_by_name: 'VinhTD', confirmed_at: '2026-08-12T00:00:00.000Z',
    status: 'synced', sync_result: 'inserted', removed_at: null,
    removed_by: null, removed_by_name: null, in_signal_sense: true, ours: true,
    original_captured_at: null, original_field_value: null, original_sub_value_name: null,
    review_note: null,
    sub_changed_at: null, sub_changed_from: null, sub_changed_to: null, sub_changed_by: null,
  },
]

let hits: string[] = []

function stubFetch() {
  hits = []
  global.fetch = jest.fn(async (url: string) => {
    const u = String(url)
    hits.push(u)
    if (u.startsWith('/api/playtest-tags/pending')) {
      return { ok: true, json: async () => ({ tags: PENDING, total: 1 }) } as Response
    }
    if (u.startsWith('/api/playtest-tags/history')) {
      return { ok: true, json: async () => ({ rows: HISTORY, total: HISTORY.length }) } as Response
    }
    return { ok: true, json: async () => ({}) } as Response
  }) as unknown as typeof fetch
}

describe('Tagging tab as an evaluator', () => {
  beforeEach(stubFetch)

  it('shows the pending queue with nothing to act on', async () => {
    render(<TaggingTab />)
    await waitFor(() => expect(screen.getByText('Balatro')).toBeInTheDocument())

    // No tick boxes, no confirm, no reject, no overwrite: every write path in
    // this view is admin-only, so none of its controls are rendered at all.
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /Confirm/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
    // The value pickers are plain text, so nothing can be edited either.
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    // And the catalog the pickers would have needed is never fetched.
    expect(hits.some(u => u.startsWith('/api/trends/options'))).toBe(false)
  })

  it('shows what was proposed beside what was confirmed, and the reason', async () => {
    render(<TaggingTab />)
    await waitFor(() => expect(screen.getByText('Balatro')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'History' }))

    await waitFor(() => expect(screen.getByText('Merge')).toBeInTheDocument())
    // The corrected row carries the evaluator's own version on both columns.
    expect(screen.getByText('was Idle')).toBeInTheDocument()
    expect(screen.getByText('was None')).toBeInTheDocument()
    expect(screen.getByText(/core loop is merge, not idle/)).toBeInTheDocument()
    // The row that was confirmed as proposed says nothing about a change.
    expect(screen.queryByText('was Backpack')).not.toBeInTheDocument()

    // Removing a tag from Signal Sense stays admin-only, and the reconcile sweep
    // it depends on is a write, so an evaluator never fires it.
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    expect(hits.some(u => u.includes('/reconcile'))).toBe(false)
  })
})
