import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TaggingTab } from '@/components/TaggingTab'

jest.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { role: 'admin', name: 'VinhTD' } } }),
}))
// The evaluation panel only opens on a game click and drags a large tree of its
// own in with it; the queue is what these tests are about.
jest.mock('@/components/EvalDetailPanel', () => ({
  __esModule: true,
  default: () => <div data-testid="eval-panel" />,
}))

const tag = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 1, game_id: 'g1', title: 'Balatro Clone', publisher_name: 'Pub',
  icon_url: null, initial_evaluator: 'Mitt', field_value: 'Balatro',
  sub_value_id: null, sub_value_name: null, tagged_by_name: 'Mitt',
  tagged_at: '2026-08-13T00:00:00.000Z', their_sub_value_id: null,
  their_sub_value_name: null, conflict: false, ...over,
})

// Three pending tags over two games — enough to tell "confirm the ticked tag"
// apart from "confirm the game" and from "confirm everything".
const QUEUE = [
  tag(),
  tag({ id: 2, field_value: 'Backpack' }),
  tag({ id: 3, game_id: 'g2', title: 'Other Game', field_value: 'Merge' }),
]

let posts: { url: string; body: Record<string, unknown> }[] = []
let pendingReads = 0

function stubFetch(confirmBody: unknown) {
  posts = []
  pendingReads = 0
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.startsWith('/api/playtest-tags/pending')) {
      pendingReads++
      return { ok: true, json: async () => ({ tags: QUEUE, total: QUEUE.length }) } as Response
    }
    if (u.startsWith('/api/trends/options')) {
      return {
        ok: true,
        json: async () => ({ values: ['Balatro', 'Backpack', 'Merge'], subValues: [{ id: 5, name: 'Deckbuilder' }] }),
      } as Response
    }
    posts.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) })
    return { ok: true, json: async () => confirmBody } as Response
  }) as unknown as typeof fetch
}

// The per-tag select boxes, which is one per row — the header's "select every"
// box and the conflict overwrite boxes are labelled differently.
const queueRows = () =>
  screen.getAllByRole('checkbox').filter(c => /^Select .+ on .+/.test(c.getAttribute('aria-label') || ''))

describe('Tagging > Pending', () => {
  it('lists one row per tag and confirms only the ticked one', async () => {
    stubFetch({ ok: true, results: [{ id: 2, result: 'inserted' }], skipped: [] })
    render(<TaggingTab />)
    await waitFor(() => expect(screen.getByText(/3 tags · 2 games/)).toBeInTheDocument())
    expect(queueRows()).toHaveLength(3)
    // Every row stands alone: no merged game cell, and the game repeats on both
    // of its tags rather than spanning them.
    expect(screen.getAllByRole('button', { name: 'Balatro Clone' })).toHaveLength(2)
    expect(document.querySelectorAll('td[rowspan]')).toHaveLength(0)
    expect(screen.queryByText('In Signal Sense')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Select Backpack on Balatro Clone'))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm 1 tag' }))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].url).toBe('/api/playtest-tags/confirm')
    // No note was typed, so the map is empty rather than carrying blank strings
    // the routes would have to reject.
    expect(posts[0].body).toEqual({ game_id: 'g1', ids: [2], overwrite: [], notes: {} })

    // The row leaves the table without the queue being read again — the point of
    // the rewrite is that reviewing a tag does not reload the list.
    await waitFor(() => expect(queueRows()).toHaveLength(2))
    expect(pendingReads).toBe(1)
    expect(screen.getByText(/Confirmed 1 tag — 1 inserted/)).toBeInTheDocument()
  })

  it('splits a multi-game selection into one confirm per game', async () => {
    stubFetch({ ok: true, results: [], skipped: [] })
    render(<TaggingTab />)
    await waitFor(() => expect(queueRows()).toHaveLength(3))

    // Header checkbox: everything.
    fireEvent.click(screen.getByLabelText('Select all loaded tags'))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm 3 tags' }))

    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts.map(p => p.body.game_id)).toEqual(['g1', 'g2'])
    expect(posts[0].body.ids).toEqual([1, 2])
    expect(posts[1].body.ids).toEqual([3])
    await waitFor(() => expect(screen.getByText(/Nothing waiting for review/)).toBeInTheDocument())
    expect(pendingReads).toBe(1)
  })

  it('sends a ticked conflict as an overwrite and warns about the ones left alone', async () => {
    const CONFLICT = [
      tag({ id: 1, conflict: true, their_sub_value_id: 5, their_sub_value_name: 'Roguelike', sub_value_id: 6 }),
      tag({ id: 2, field_value: 'Backpack', conflict: true, their_sub_value_id: 7, their_sub_value_name: 'Idle', sub_value_id: 6 }),
    ]
    posts = []
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.startsWith('/api/playtest-tags/pending')) return { ok: true, json: async () => ({ tags: CONFLICT, total: CONFLICT.length }) } as Response
      if (u.startsWith('/api/trends/options')) return { ok: true, json: async () => ({ values: [], subValues: [] }) } as Response
      posts.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) })
      return { ok: true, json: async () => ({ ok: true, results: [], skipped: [] }) } as Response
    }) as unknown as typeof fetch

    render(<TaggingTab />)
    await waitFor(() => expect(queueRows()).toHaveLength(2))

    // Overwrite the first conflict, then select both for confirm.
    const rows = screen.getAllByRole('row')
    const firstConflict = rows.find(r => within(r).queryByText('Roguelike'))!
    fireEvent.click(within(firstConflict).getAllByRole('checkbox')[1])
    fireEvent.click(screen.getByLabelText('Select all loaded tags'))

    expect(screen.getByText(/1 conflict will be rejected unless ticked to overwrite/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm 2 tags' }))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body.ids).toEqual([1, 2])
    expect(posts[0].body.overwrite).toEqual([1])
  })

  // jsdom has no IntersectionObserver: stand one in that fires as soon as the
  // sentinel is observed, which is what scrolling it into view does.
  // The note explains a decision the evaluator did not make, so it has to ride
  // along with the request that makes it and only for the row it was typed on.
  it('carries the per-row note along with the confirm that resolves it', async () => {
    stubFetch({ ok: true, results: [{ id: 1, result: 'inserted' }], skipped: [] })
    render(<TaggingTab />)
    await waitFor(() => expect(queueRows()).toHaveLength(3))

    fireEvent.change(
      screen.getByLabelText('Note to the evaluator about Balatro on Balatro Clone'),
      { target: { value: '  core loop is merge  ' } },
    )
    fireEvent.click(screen.getByLabelText('Select Balatro on Balatro Clone'))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm 1 tag' }))

    await waitFor(() => expect(posts).toHaveLength(1))
    // Trimmed, keyed by row, and carrying nothing for the rows left blank.
    expect(posts[0].body.notes).toEqual({ 1: 'core loop is merge' })
  })

  it('appends the next page when the sentinel comes into view', async () => {
    const reads: string[] = []
    const page2 = [tag({ id: 4, game_id: 'g3', title: 'Third Game', field_value: 'Idle' })]
    global.fetch = jest.fn(async (url: string) => {
      const u = String(url)
      if (u.startsWith('/api/playtest-tags/pending')) {
        reads.push(u)
        const first = u.includes('offset=0')
        return { ok: true, json: async () => ({ tags: first ? QUEUE : page2, total: 4 }) } as Response
      }
      return { ok: true, json: async () => ({ values: [], subValues: [] }) } as Response
    }) as unknown as typeof fetch

    class IO {
      constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {}
      observe() { this.cb([{ isIntersecting: true }]) }
      disconnect() {}
    }
    ;(global as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IO

    render(<TaggingTab />)
    // 3 of 4 loaded, then the sentinel pulls the 4th.
    await waitFor(() => expect(queueRows()).toHaveLength(4))
    // Paged on offset, so a row leaving the queue cannot make a page skip rows.
    expect(reads).toEqual(['/api/playtest-tags/pending?offset=0&limit=50',
                           '/api/playtest-tags/pending?offset=3&limit=50'])
    expect(screen.getByText('All 4 shown')).toBeInTheDocument()
  })

  it('redraws an edited row from the response instead of refetching', async () => {
    stubFetch({ ok: true, results: [], skipped: [] })
    const base = global.fetch
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (init?.method === 'PATCH') {
        posts.push({ url: u, body: JSON.parse(String(init.body ?? '{}')) })
        return {
          ok: true,
          json: async () => ({ ok: true, tag: tag({ id: 1, sub_value_id: 5, sub_value_name: 'Deckbuilder' }) }),
        } as Response
      }
      return (base as unknown as (u: string, i?: RequestInit) => Promise<Response>)(u, init)
    }) as unknown as typeof fetch

    render(<TaggingTab />)
    await waitFor(() => expect(queueRows()).toHaveLength(3))

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: '5' } })
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].url).toBe('/api/playtest-tags/1')
    expect(posts[0].body).toEqual({ sub_value_id: 5 })
    // Still three rows, still one queue read: the row updated in place.
    expect(queueRows()).toHaveLength(3)
    expect(pendingReads).toBe(1)
  })
})
