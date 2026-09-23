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

// Single dispatcher for every test's fetch mock: routes a request to the facets
// response, the newest-days probe (limit=100), or a page of list rows, by URL
// shape alone -- the same three requests the component actually makes.
function mockApi(opts: {
  probe?: unknown[]
  facets?: string[]
  facetsReject?: boolean
  pages?: Record<string, unknown[]>
  list?: unknown[] // shorthand for pages: { '1': list } when there is only one page
} = {}) {
  return jest.fn(async (url: string) => {
    const u = new URL(String(url), 'http://x')
    if (u.pathname.endsWith('/facets')) {
      if (opts.facetsReject) throw new Error('network error')
      return { ok: true, json: async () => ({ available_conclusions: opts.facets || [] }) } as Response
    }
    const isProbe = u.searchParams.get('limit') === '100'
    if (isProbe) return { ok: true, json: async () => ({ data: opts.probe || [] }) } as Response
    const page = u.searchParams.get('page') || '1'
    const pages = opts.pages || (opts.list ? { '1': opts.list } : {})
    return { ok: true, json: async () => ({ data: pages[page] || [] }) } as Response
  })
}

beforeEach(() => {
  installObserver('noop')
})

describe('ReviewTable', () => {
  it('defaults to the newest 3 days with rows, puzzle, every real conclusion', async () => {
    const probeRows = [
      row({ id: 1, evaluate_date: '2026-09-22T09:00:00Z', updated_at: '2026-09-22T09:00:00Z' }),
      row({ id: 2, evaluate_date: '2026-09-22T08:00:00Z', updated_at: '2026-09-22T08:00:00Z' }),
      row({ id: 3, evaluate_date: '2026-09-20T09:00:00Z', updated_at: '2026-09-20T09:00:00Z' }),
      // A gap day (09-19) with nothing, then an older day that must NOT be pulled
      // in once 3 distinct days (22, 20, 18) are already found.
      row({ id: 4, evaluate_date: '2026-09-18T09:00:00Z', updated_at: '2026-09-18T09:00:00Z' }),
      row({ id: 5, evaluate_date: '2026-09-10T09:00:00Z', updated_at: '2026-09-10T09:00:00Z' }),
    ]
    const fetchMock = mockApi({ probe: probeRows, list: [probeRows[0], probeRows[1], probeRows[2]] })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)

    await waitFor(() => expect(screen.getAllByText('Merge Puzzle').length).toBeGreaterThan(0))
    const calls = parseCalls(fetchMock)
    const probeCall = calls.find(c => c.limit === '100')!
    expect(probeCall.category).toBe('puzzle')
    // The default is All, which travels as an exclusion, not as a value: see
    // ALL_CONCLUSIONS. Link_dead and Stale_release are housekeeping and are what
    // "every real conclusion" leaves out.
    expect(probeCall.exclude_conclusions).toBe('Link_dead,Stale_release')
    expect(probeCall.conclusion).toBeUndefined()
    expect(probeCall.evaluator).toBe('NhiLV')

    const listCall = calls.find(c => c.limit === '20')!
    expect(listCall.category).toBe('puzzle')
    expect(listCall.exclude_conclusions).toBe('Link_dead,Stale_release')
    expect(listCall.conclusion).toBeUndefined()
    expect(listCall.with_screenshots).toBe('1')
    expect(listCall.date_basis).toBe('evaluated')
    expect(listCall.page).toBe('1')
    // This table pages with a sentinel and never prints a count, so it opts out of
    // the page-1 count(*) -- which runs over the same filtered set as the rows.
    expect(listCall.stats).toBe('0')
    expect(probeCall.stats).toBe('0')
    // Newest 3 distinct days present: 09-22, 09-20, 09-18 -- the gap and the
    // older 09-10 row must not shift the window.
    expect(listCall.from).toBe('2026-09-18')
    expect(listCall.to).toBe('2026-09-22')

    // The conclusion-options facets request also fired, scoped the same way.
    const facetsCall = fetchMock.mock.calls.find(([u]) => new URL(String(u), 'http://x').pathname.endsWith('/facets'))!
    const facetsParams = new URL(String(facetsCall[0]), 'http://x').searchParams
    expect(facetsParams.get('category')).toBe('puzzle')
    expect(facetsParams.get('evaluator')).toBe('NhiLV')
  })

  it('refetches from page 1 when a filter changes', async () => {
    const fetchMock = mockApi({ list: [row()] })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())
    fetchMock.mockClear()

    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'arcade' } })

    // Changing category also re-fetches the conclusion facets (they're scoped by
    // category), so wait for the list refetch specifically rather than any count.
    await waitFor(() => {
      const calls = parseCalls(fetchMock)
      expect(calls.some(c => c.category === 'arcade' && c.page === '1' && c.limit === '20')).toBe(true)
    })
  })

  it('appends page 2 from the sentinel rather than replacing page 1', async () => {
    installObserver('firing')
    const page1 = Array.from({ length: 20 }, (_, i) => row({ id: i + 1, title: `Game ${i + 1}` }))
    const page2 = [row({ id: 21, title: 'Game 21' })]
    const fetchMock = mockApi({ pages: { '1': page1, '2': page2 } })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)

    await waitFor(() => expect(screen.getByText('Game 1')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('Game 21')).toBeInTheDocument())
    // Page 1's rows are still there -- page 2 was appended, not swapped in.
    expect(screen.getByText('Game 1')).toBeInTheDocument()
    expect(screen.getAllByText(/^Game \d+$/).length).toBe(21)
  })

  it('renders a game with no screenshots without an empty strip', async () => {
    const fetchMock = mockApi({ list: [row({ screenshot_urls: null, manual_screenshot_urls: null })] })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    expect(document.querySelector('.rp-review-shots')).toBeNull()
  })

  it('falls back to manual screenshots when the StoreKit array is empty', async () => {
    const fetchMock = mockApi({
      list: [row({ screenshot_urls: [], manual_screenshot_urls: ['https://cdn.example/manual1.png'] })],
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(document.querySelector('.rp-review-shots')).not.toBeNull())
    const img = document.querySelector('.rp-review-shot') as HTMLImageElement
    expect(img.src).toBe('https://cdn.example/manual1.png')
  })

  it('opens the shared lightbox with the whole strip on a screenshot click', async () => {
    const fetchMock = mockApi({ list: [row()] })
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

  // The wide form is now the only form. This asserts the CONTROL is gone, which is
  // observable in jsdom; it asserts NOTHING about painted width, which is not --
  // jsdom loads no stylesheet. A test named for the paint is how a version of the
  // old Expand rule that gained exactly zero content width (a +60px border-box spent
  // entirely on 60px of its own padding) passed through seven reviews. Whether the
  // block is actually wider than the cards above it is a browser check.
  it('has no Expand/Collapse control: the wide form is the only form', async () => {
    const fetchMock = mockApi({ list: [row()] })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    expect(screen.queryByRole('button', { name: /expand|collapse/i })).toBeNull()
  })

  // ---- the page's own period owns this table's dates ----

  it('opens on the page period and never pays for the newest-days probe', async () => {
    const fetchMock = mockApi({ list: [row()] })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false}
      windowFrom="2026-09-01" windowTo="2026-09-30" />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    const calls = parseCalls(fetchMock)
    // The probe is the limit=100 request. With real bounds in hand there is nothing
    // to resolve, so it must not be sent at all -- that is a whole round trip to a
    // database on another continent, on every Individual tab open.
    expect(calls.find(c => c.limit === '100')).toBeUndefined()

    const listCall = calls.find(c => c.limit === '20')!
    expect(listCall.from).toBe('2026-09-01')
    expect(listCall.to).toBe('2026-09-30')

    expect((screen.getByLabelText('From date') as HTMLInputElement).value).toBe('2026-09-01')
    expect((screen.getByLabelText('To date') as HTMLInputElement).value).toBe('2026-09-30')
  })

  it('bounds both pickers to the page period, so neither can be pushed outside it', async () => {
    const fetchMock = mockApi({ list: [row()] })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false}
      windowFrom="2026-09-01" windowTo="2026-09-30" />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    const fromBox = screen.getByLabelText('From date') as HTMLInputElement
    const toBox = screen.getByLabelText('To date') as HTMLInputElement
    expect(fromBox.min).toBe('2026-09-01')
    expect(toBox.max).toBe('2026-09-30')

    // min/max are advisory in several browsers once a date is TYPED rather than
    // picked, so the value is clamped in the handler too -- this is that clamp.
    fireEvent.change(fromBox, { target: { value: '2026-08-11' } })
    await waitFor(() => expect((screen.getByLabelText('From date') as HTMLInputElement).value).toBe('2026-09-01'))
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-12-25' } })
    await waitFor(() => expect((screen.getByLabelText('To date') as HTMLInputElement).value).toBe('2026-09-30'))

    const listCalls = parseCalls(fetchMock).filter(c => c.limit === '20')
    for (const c of listCalls) {
      expect(c.from! >= '2026-09-01').toBe(true)
      expect(c.to! <= '2026-09-30').toBe(true)
    }
  })

  it('puts the page period back when a date box is cleared, instead of going all-time', async () => {
    const fetchMock = mockApi({ list: [row()] })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false}
      windowFrom="2026-09-01" windowTo="2026-09-30" />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-09-20' } })
    await waitFor(() => expect((screen.getByLabelText('From date') as HTMLInputElement).value).toBe('2026-09-20'))

    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '' } })
    await waitFor(() => expect((screen.getByLabelText('From date') as HTMLInputElement).value).toBe('2026-09-01'))
    expect((screen.getByLabelText('To date') as HTMLInputElement).value).toBe('2026-09-30')

    // And the query went with it: no request ever loses its bounds.
    const last = parseCalls(fetchMock).filter(c => c.limit === '20').pop()!
    expect(last.from).toBe('2026-09-01')
    expect(last.to).toBe('2026-09-30')
  })

  it('follows the page period when the reader changes it upstairs', async () => {
    const fetchMock = mockApi({ list: [row()] })
    global.fetch = fetchMock as unknown as typeof fetch

    const { rerender } = render(<ReviewTable evaluator="NhiLV" canSeeTeam={false}
      windowFrom="2026-09-01" windowTo="2026-09-30" />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    rerender(<ReviewTable evaluator="NhiLV" canSeeTeam={false}
      windowFrom="2026-08-01" windowTo="2026-08-31" />)
    await waitFor(() => expect((screen.getByLabelText('From date') as HTMLInputElement).value).toBe('2026-08-01'))

    const last = parseCalls(fetchMock).filter(c => c.limit === '20').pop()!
    expect(last.from).toBe('2026-08-01')
    expect(last.to).toBe('2026-08-31')
  })

  // ---- the row itself ----

  it('carries the whole call on one side of the row: title, publisher, platform, release, tags, verdict', async () => {
    const fetchMock = mockApi({
      list: [row({
        initial_evaluator: 'NhiLV',
        tags: [{ field_value: 'Merge', sub_value_name: 'Board', pending: false }],
      })],
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const { container } = render(<ReviewTable evaluator="NhiLV" canSeeTeam={true} />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    const main = container.querySelector('.rp-review-main') as HTMLElement
    expect(within(main).getByText('Merge Puzzle')).toBeInTheDocument()
    expect(within(main).getByText('Acme Studio')).toBeInTheDocument()
    expect(within(main).getByText('IOS')).toBeInTheDocument()
    // Both dates say WHICH date they are. Two bare dd/mm/yy on the same row -- one
    // the store's, one the team's -- is a guess the reader should not have to make.
    expect(within(main).getByText(/^Release: 01\/08\/26$/)).toBeInTheDocument()
    expect(within(main).getByText('Merge')).toBeInTheDocument()
    // The verdict moved OUT of its own column and onto this side of the row, next
    // to the game it is a verdict on -- conclusion, when, and by whom.
    expect(within(main).getByText('List Idea')).toBeInTheDocument()
    expect(within(main).getByText(/^Evaluated: 22\/09\/26$/)).toBeInTheDocument()
    expect(within(main).getByText('NhiLV')).toBeInTheDocument()
    // and all four of those facts are badges, not loose grey words
    expect(within(main).getAllByText(/^(IOS|Release: .*|Evaluated: .*|NhiLV)$/)
      .every(n => n.className.includes('rp-review-badge'))).toBe(true)
    // Two grid cells only: the call, and the screenshots that back it.
    const cells = container.querySelector('.rp-review-row')!.children
    expect(cells.length).toBe(2)
    expect(cells[1].className).toContain('rp-review-shots')
  })

  // ---- what belongs in the conclusion dropdown ----

  it('keeps housekeeping out of the conclusion dropdown, however the facets answer', async () => {
    // Link_dead ("the store page went away") and Stale_release ("the build aged
    // out") are not calls anybody made. The Report's own `judged` predicate excludes
    // both, so every KPI on the tabs above this table already counts them out -- and
    // a block titled "check the calls themselves" that opens on one shows an empty
    // table under a person who did plenty of work. Live values, not just the
    // canonical defaults: the facets endpoint is where they actually came from.
    const fetchMock = mockApi({
      facets: ['List_Idea', 'Link_dead', 'Stale_release', 'Bypass'],
      list: [row()],
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    const select = screen.getByLabelText('Initial conclusion') as HTMLSelectElement
    await waitFor(() => {
      expect(Array.from(select.options).map(o => o.value)).toContain('Bypass')
    })
    const values = Array.from(select.options).map(o => o.value)
    expect(values).not.toContain('Link_dead')
    expect(values).not.toContain('Stale_release')
  })

  it('opens on All, and narrows to one value when the reader picks one', async () => {
    const fetchMock = mockApi({
      facets: ['List_Idea', 'Stale_release', 'Bypass'],
      list: [row()],
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    const select = screen.getByLabelText('Initial conclusion') as HTMLSelectElement
    expect(select.value).toBe('__all__')
    expect(within(select).getByText('All')).toBeInTheDocument()
    await waitFor(() => expect(Array.from(select.options).map(o => o.value)).toContain('Bypass'))

    fireEvent.change(select, { target: { value: 'Bypass' } })
    await waitFor(() => {
      const last = parseCalls(fetchMock).filter(c => c.limit === '20').pop()!
      expect(last.conclusion).toBe('Bypass')
    })
    expect(parseCalls(fetchMock).filter(c => c.limit === '20').pop()!.exclude_conclusions).toBeUndefined()
  })

  it('says "judged" rather than printing the All sentinel in the empty sentence', async () => {
    const fetchMock = mockApi({ facets: ['List_Idea', 'Bypass'] })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(document.querySelector('.rp-review-empty')).not.toBeNull())
    fireEvent.change(screen.getByLabelText('Initial conclusion'), { target: { value: '__all__' } })

    await waitFor(() => {
      const text = document.querySelector('.rp-review-empty')!.textContent!
      expect(text).toMatch(/no Puzzle games judged/)
    })
    expect(document.querySelector('.rp-review-empty')!.textContent).not.toMatch(/__all__/)
  })

  it('does not fetch page 1 twice when the facets response lands after it', async () => {
    // The default selection is All, and the obvious way to express All -- the list
    // of every other value -- is derived from the option list, which arrives in its
    // OWN request. That would change fetchPage's identity the moment facets resolved
    // and re-run the page-1 effect: a second full page request, with screenshots, on
    // every single tab open. Expressing All as a constant exclusion is what keeps
    // this at one.
    const fetchMock = mockApi({ facets: ['List_Idea', 'Bypass'], list: [row()] })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())
    await waitFor(() => {
      const select = screen.getByLabelText('Initial conclusion') as HTMLSelectElement
      expect(Array.from(select.options).map(o => o.value)).toContain('Bypass')
    })

    const pageOnes = parseCalls(fetchMock).filter(c => c.limit === '20' && c.page === '1')
    expect(pageOnes.length).toBe(1)
  })

  it('colours the conclusion pill by what the conclusion means', async () => {
    const fetchMock = mockApi({
      list: [
        row({ id: 1, title: 'A', initial_conclusion: 'List_Idea' }),
        row({ id: 2, title: 'B', initial_conclusion: 'Bypass' }),
        // The bypass rule is `/bypass/i`, the same line the server draws with
        // `NOT ILIKE '%bypass%'` -- so these two land red, not amber or green.
        row({ id: 3, title: 'C', initial_conclusion: 'Playtest & Bypass' }),
        row({ id: 4, title: 'D', initial_conclusion: 'M_ByPass' }),
        row({ id: 5, title: 'E', initial_conclusion: 'Need deeper testing' }),
        row({ id: 6, title: 'F', initial_conclusion: 'Priority IV: Idea' }),
        row({ id: 7, title: 'G', initial_conclusion: null }),
      ],
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const { container } = render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(screen.getByText('A')).toBeInTheDocument())

    const tone = (i: number) =>
      (container.querySelectorAll('.rp-review-verdict .pill')[i] as HTMLElement).className
    expect(tone(0)).toContain('rp-tone-good')  // List Idea - kept
    expect(tone(1)).toContain('rp-tone-bad')   // Bypass - dropped
    expect(tone(2)).toContain('rp-tone-bad')   // Playtest & Bypass - dropped
    expect(tone(3)).toContain('rp-tone-bad')   // M_ByPass - dropped
    expect(tone(4)).toContain('rp-tone-hold')  // Need deeper testing - not decided
    expect(tone(5)).toContain('rp-tone-good')  // a Priority - kept
    expect(tone(6)).toContain('rp-tone-none')  // no call at all
  })

  // ---- scrolling ----

  it('never intercepts the wheel, so scrolling stays on the compositor thread', async () => {
    // REGRESSION GUARD, and the reason is specific. A non-passive `wheel` listener
    // takes scrolling off the compositor thread for that element: every frame then
    // waits on JS. With a mouse wheel that is invisible; with a trackpad -- a stream
    // of small fractional deltas plus momentum -- it stutters and then stops dead,
    // while dragging the scrollbar stays smooth. This block had such a handler, to
    // make the page finish scrolling the table into view before the list moved, and
    // that behaviour is not worth the cost. If one comes back, this goes red.
    const content = document.createElement('div')
    content.className = 'content'
    document.body.appendChild(content)
    global.fetch = mockApi({ list: [row()] }) as unknown as typeof fetch
    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />, { container: content })
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    const box = content.querySelector('.rp-review-rows') as HTMLElement
    for (const deltaY of [120, -120, 3, -3]) {
      const ev = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })
      box.dispatchEvent(ev)
      expect(ev.defaultPrevented).toBe(false)
    }
    content.remove()
  })

  it('leaves the tag line out entirely when a game has no tags', async () => {
    const fetchMock = mockApi({ list: [row({ tags: [] })] })
    global.fetch = fetchMock as unknown as typeof fetch

    const { container } = render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    const meta = container.querySelector('.rp-review-meta') as HTMLElement
    // Platform badge and release date only -- no empty chip row, and no lone em dash
    // standing in for tags nobody asked about.
    expect(meta.children.length).toBe(2)
  })

  it('renders a sentence naming the filters when the result is empty, instead of a blank area', async () => {
    const fetchMock = mockApi()
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)

    await waitFor(() => expect(document.querySelector('.rp-review-rows')).toBeNull())
    const empty = document.querySelector('.rp-review-empty')
    expect(empty).not.toBeNull()
    expect(empty!.textContent).toMatch(/puzzle/i)
    // On the default (All) there is no conclusion to name, so the sentence says what
    // the filter really is -- judged at all -- and never the sentinel.
    expect(empty!.textContent).toMatch(/no Puzzle games judged/)
    expect(empty!.textContent).not.toMatch(/__all__/)
    expect(empty!.textContent).toMatch(/You/)
  })

  it('names the chosen conclusion in the empty sentence, prettily, once one is picked', async () => {
    const fetchMock = mockApi()
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(document.querySelector('.rp-review-empty')).not.toBeNull())
    fireEvent.change(screen.getByLabelText('Initial conclusion'), { target: { value: 'List_Idea' } })

    // Pretty label, not the raw stored/transmitted value -- see prettyConclusion.
    await waitFor(() => expect(document.querySelector('.rp-review-empty')!.textContent).toMatch(/List Idea/))
    expect(document.querySelector('.rp-review-empty')!.textContent).not.toMatch(/List_Idea/)
  })

  it('names the evaluator (not "You") in the empty sentence when the viewer can see the team', async () => {
    const fetchMock = mockApi()
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="QuangVN" canSeeTeam={true} />)

    await waitFor(() => expect(document.querySelector('.rp-review-empty')).not.toBeNull())
    expect(document.querySelector('.rp-review-empty')!.textContent).toMatch(/QuangVN/)
  })

  it('renders a row with every optional field missing without NaN, Infinity or undefined on screen', async () => {
    const fetchMock = mockApi({
      list: [row({
        title: null, icon_url: null, publisher_name: null, release_date: null,
        os: null, app_link: null, initial_conclusion: null,
        evaluate_date: null, updated_at: null,
        screenshot_urls: null, manual_screenshot_urls: null,
      })],
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
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2) // platform, conclusion
    expect(screen.getByText(/^Release: —$/)).toBeInTheDocument()
    expect(screen.getByText(/^Evaluated: —$/)).toBeInTheDocument()
  })

  it('offers the real, admin-editable conclusion list, not a hardcoded shortlist', async () => {
    // A deliberately small, deliberately unhardcoded set: 'Good' was never one of
    // this component's old 3 static options, so its option existing proves the
    // dropdown is driven by the fetched facets response, not a static array --
    // and 'Skip' being ABSENT from the live list proves it isn't just unioning in
    // every possible value regardless of what the server actually returned.
    const fetchMock = mockApi({ facets: ['Good', 'List_Idea'], list: [row()] })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    const select = screen.getByLabelText('Initial conclusion') as HTMLSelectElement
    await waitFor(() => {
      const values = Array.from(select.options).map(o => o.value)
      expect(values).toEqual(expect.arrayContaining(['Good', 'List_Idea']))
    })
    const values = Array.from(select.options).map(o => o.value)
    expect(values).not.toContain('Skip')
    // Pretty label in the option text, raw value preserved on the option itself
    // (the value is what gets sent back to the server; only the label changes).
    const goodOption = Array.from(select.options).find(o => o.value === 'List_Idea')!
    expect(goodOption.textContent).toBe('List Idea')
  })

  it('keeps the full canonical conclusion list when the facets fetch fails, instead of collapsing to just the current selection', async () => {
    const fetchMock = mockApi({ facetsReject: true, list: [row()] })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    // Give the (failing) facets fetch a turn to resolve and, if the bug were
    // still present, narrow the dropdown down to just ['List_Idea'].
    const select = screen.getByLabelText('Initial conclusion') as HTMLSelectElement
    await waitFor(() => {
      const values = Array.from(select.options).map(o => o.value)
      // A manager who hits a transient network error must still be able to
      // change the filter -- the canonical floor, not a single option.
      expect(values).toContain('Bypass')
      expect(values).toContain('Skip')
      expect(values).toContain('Playtest & Bypass')
    })
  })

  it('keeps the full canonical conclusion list when the facets fetch resolves empty', async () => {
    const fetchMock = mockApi({ facets: [], list: [row()] })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    const select = screen.getByLabelText('Initial conclusion') as HTMLSelectElement
    await waitFor(() => {
      const values = Array.from(select.options).map(o => o.value)
      expect(values).toContain('Bypass')
      expect(values).toContain('Skip')
      expect(values).toContain('Playtest & Bypass')
    })
  })

  it('shows the pretty conclusion label on the row pill, never the raw stored value', async () => {
    const fetchMock = mockApi({ list: [row({ initial_conclusion: 'List_Idea' })] })
    global.fetch = fetchMock as unknown as typeof fetch

    const { container } = render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    const pill = container.querySelector('.rp-review-verdict .pill')
    expect(pill).not.toBeNull()
    expect(pill!.textContent).toBe('List Idea')
    // The raw underscored value must not leak into any rendered TEXT (the <option
    // value="List_Idea"> attribute is fine -- that's the value sent back to the
    // server, not text a reader sees).
    expect(container.textContent).not.toMatch(/List_Idea/)
  })
  // ---- The newest-days probe is BOUNDED ----------------------------------------
  // Without from/to the route's rangeFilter is empty, and the probe becomes two
  // unbounded all-time queries over the evaluator's whole history: the rows query,
  // ordered by an expression no index serves, plus the page-1 count(*) stats
  // aggregate (meta=0 suppresses only the facet block). The app and the database are
  // on different continents, so that is paid in full on every Individual tab open.

  it('bounds the newest-days probe to a recent window instead of asking all-time', async () => {
    const fetchMock = mockApi({ probe: [row()], list: [row()] })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    const probes = parseCalls(fetchMock).filter(c => c.limit === '100')
    expect(probes).toHaveLength(1)
    expect(probes[0].from).toBeDefined()
    expect(probes[0].to).toBeDefined()
    // ~90 days wide, and ending no earlier than today: a bound the route will
    // actually turn into a range predicate.
    const days = (Date.parse(probes[0].to) - Date.parse(probes[0].from)) / 86400000
    expect(days).toBeGreaterThanOrEqual(90)
    expect(days).toBeLessThanOrEqual(92)
    expect(Date.parse(probes[0].to)).toBeGreaterThanOrEqual(Date.now())
  })

  it('falls back to one unbounded probe only when the bounded one comes back empty', async () => {
    // The bounded probe answers empty (a person with no work in a quarter); the
    // unbounded retry then finds their real newest days.
    const old = row({ id: 9, evaluate_date: '2025-01-05T09:00:00Z', updated_at: '2025-01-05T09:00:00Z' })
    const fetchMock = jest.fn(async (url: string) => {
      const u = new URL(String(url), 'http://x')
      if (u.pathname.endsWith('/facets')) return { ok: true, json: async () => ({ available_conclusions: [] }) } as Response
      if (u.searchParams.get('limit') === '100') {
        const bounded = u.searchParams.has('from')
        return { ok: true, json: async () => ({ data: bounded ? [] : [old] }) } as Response
      }
      return { ok: true, json: async () => ({ data: [old] }) } as Response
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    const probes = parseCalls(fetchMock).filter(c => c.limit === '100')
    expect(probes).toHaveLength(2)
    expect(probes[0].from).toBeDefined()
    expect(probes[1].from).toBeUndefined()
    // and the resolved window is the one the unbounded probe found
    const listCall = parseCalls(fetchMock).find(c => c.limit === '20')!
    expect(listCall.from).toBe('2025-01-05')
  })

  // A FAILED bounded probe (network error) must not be read the same as a bounded
  // probe that genuinely answered "no rows here": that pair is what licenses the
  // one-extra-round-trip unbounded retry, and a failure escalating into it means a
  // network hiccup on the cheap bounded probe reaches the expensive unbounded query.
  it('does not escalate to the unbounded probe when the bounded one FAILS, only when it genuinely answers empty', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      const u = new URL(String(url), 'http://x')
      if (u.pathname.endsWith('/facets')) return { ok: true, json: async () => ({ available_conclusions: [] }) } as Response
      if (u.searchParams.get('limit') === '100') throw new Error('network error')
      return { ok: true, json: async () => ({ data: [row()] }) } as Response
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => {
      const calls = parseCalls(fetchMock)
      expect(calls.some(c => c.limit === '20')).toBe(true)
    })

    const probes = parseCalls(fetchMock).filter(c => c.limit === '100')
    expect(probes).toHaveLength(1)
  })

  // ---- Filters that own the window --------------------------------------------

  it('re-resolves the newest-days window when the category changes', async () => {
    const puzzleDay = row({ id: 1, evaluate_date: '2026-09-22T09:00:00Z', updated_at: '2026-09-22T09:00:00Z' })
    const arcadeDay = row({ id: 2, title: 'Arcade Run', evaluate_date: '2026-08-04T09:00:00Z', updated_at: '2026-08-04T09:00:00Z' })
    const fetchMock = jest.fn(async (url: string) => {
      const u = new URL(String(url), 'http://x')
      if (u.pathname.endsWith('/facets')) return { ok: true, json: async () => ({ available_conclusions: [] }) } as Response
      const arcade = u.searchParams.get('category') === 'arcade'
      const hit = arcade ? arcadeDay : puzzleDay
      return { ok: true, json: async () => ({ data: [hit] }) } as Response
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'arcade' } })
    await waitFor(() => expect(screen.getByText('Arcade Run')).toBeInTheDocument())

    const arcadeProbe = parseCalls(fetchMock).find(c => c.limit === '100' && c.category === 'arcade')
    expect(arcadeProbe).toBeDefined()
    // and the rows request for arcade uses the window that probe found, not the
    // puzzle one -- an evaluator with no arcade work in the puzzle days would
    // otherwise open an empty table and read it as broken.
    const arcadeList = parseCalls(fetchMock).filter(c => c.limit === '20' && c.category === 'arcade')
    expect(arcadeList.length).toBeGreaterThan(0)
    arcadeList.forEach(c => expect(c.from).toBe('2026-08-04'))
  })

  it('clears both date boxes when either one is cleared, instead of going silently all-time', async () => {
    const fetchMock = mockApi({ probe: [row()], list: [row()] })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    const fromBox = screen.getByLabelText('From date') as HTMLInputElement
    const toBox = screen.getByLabelText('To date') as HTMLInputElement
    expect(fromBox.value).not.toBe('')
    expect(toBox.value).not.toBe('')

    fireEvent.change(fromBox, { target: { value: '' } })
    await waitFor(() => expect(toBox.value).toBe(''))
    expect(fromBox.value).toBe('')
    // the request really is all-time now, and the toolbar says so
    await waitFor(() => {
      const last = parseCalls(fetchMock).filter(c => c.limit === '20').pop()!
      expect(last.from).toBeUndefined()
      expect(last.to).toBeUndefined()
    })
  })

  it('never stores a reversed date pair, so the empty sentence cannot read backwards', async () => {
    const fetchMock = mockApi({ probe: [row()], list: [] })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(document.querySelector('.rp-review-empty')).not.toBeNull())

    const fromBox = screen.getByLabelText('From date') as HTMLInputElement
    const toBox = screen.getByLabelText('To date') as HTMLInputElement
    fireEvent.change(toBox, { target: { value: '2026-09-18' } })
    fireEvent.change(fromBox, { target: { value: '2026-09-22' } })

    await waitFor(() => expect(toBox.value).toBe('2026-09-22'))
    expect(Date.parse(fromBox.value)).toBeLessThanOrEqual(Date.parse(toBox.value))
    await waitFor(() => expect(document.querySelector('.rp-review-empty')).not.toBeNull())
    const sentence = document.querySelector('.rp-review-empty')!.textContent || ''
    expect(sentence).not.toMatch(/between 22\/09\/26 and 18\/09\/26/)
    // both ends collapsed onto the one day the reader last touched
    expect(sentence).toMatch(/on 22\/09\/26/)
  })

  // ---- Switching person --------------------------------------------------------

  it('drops the previous person rows the moment the name changes', async () => {
    const alpha = row({ id: 1, title: 'Alpha Game' })
    const beta = row({ id: 2, title: 'Beta Game' })
    const fetchMock = jest.fn(async (url: string) => {
      const u = new URL(String(url), 'http://x')
      if (u.pathname.endsWith('/facets')) return { ok: true, json: async () => ({ available_conclusions: [] }) } as Response
      const who = u.searchParams.get('evaluator')
      const hit = who === 'Beta' ? beta : alpha
      return { ok: true, json: async () => ({ data: [hit] }) } as Response
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const { rerender } = render(<ReviewTable evaluator="Alpha" canSeeTeam />)
    await waitFor(() => expect(screen.getByText('Alpha Game')).toBeInTheDocument())

    rerender(<ReviewTable evaluator="Beta" canSeeTeam />)
    // Synchronously, in the same commit the new name paints in: an admin clicking
    // through the name chips must never see one person's games under another's.
    expect(screen.queryByText('Alpha Game')).toBeNull()
    await waitFor(() => expect(screen.getByText('Beta Game')).toBeInTheDocument())
  })

  // The bug above is fixed by resetting `rows` on the render that changes `evaluator`.
  // That is not the whole story: the OUTGOING person's page-1 request can still be
  // in flight when the switch happens (it awaited the newest-days probe before this
  // reset ran), and the render-phase reset used to leave `fetchSeqRef` untouched --
  // so that stale response's `seq` still equalled `fetchSeqRef.current` (no NEW
  // fetch had bumped it yet, because the new person's own fetchPage does not fire
  // until ITS probe resolves) and would repopulate `rows` with the outgoing
  // person's games under the new name. This test switches WHILE that request is
  // still pending, which the existing test above does not: it waits for the first
  // fetch to settle before switching.
  it('drops a stale in-flight response from the OUTGOING person, even when it lands before the new person\'s own probe resolves', async () => {
    const alphaRow = row({ id: 1, title: 'Alpha Game' })
    const betaRow = row({ id: 2, title: 'Beta Game' })

    function deferred() {
      let resolve!: (v: unknown) => void
      const promise = new Promise((res) => { resolve = res })
      return { promise, resolve }
    }
    const alphaList = deferred()
    const betaProbe = deferred()

    const fetchMock = jest.fn(async (url: string) => {
      const u = new URL(String(url), 'http://x')
      if (u.pathname.endsWith('/facets')) return { ok: true, json: async () => ({ available_conclusions: [] }) } as Response
      const who = u.searchParams.get('evaluator')
      const isProbe = u.searchParams.get('limit') === '100'
      if (isProbe) {
        if (who === 'Alpha') return { ok: true, json: async () => ({ data: [alphaRow] }) } as Response
        // Beta's probe hangs until the test resolves it: this is the exact window
        // during which Beta's own fetchPage has NOT yet been called, and so has
        // not yet bumped fetchSeqRef past Alpha's in-flight request.
        await betaProbe.promise
        return { ok: true, json: async () => ({ data: [betaRow] }) } as Response
      }
      if (who === 'Alpha') {
        await alphaList.promise
        return { ok: true, json: async () => ({ data: [alphaRow] }) } as Response
      }
      return { ok: true, json: async () => ({ data: [betaRow] }) } as Response
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const { rerender } = render(<ReviewTable evaluator="Alpha" canSeeTeam />)
    // Confirm Alpha's page-1 request has genuinely been issued (and is hanging).
    await waitFor(() => {
      const calls = parseCalls(fetchMock)
      expect(calls.some(c => c.limit === '20' && c.evaluator === 'Alpha')).toBe(true)
    })

    rerender(<ReviewTable evaluator="Beta" canSeeTeam />)
    // Beta's probe is still pending -- Beta's own fetchPage has not run yet.

    // Now let the outgoing Alpha response land.
    alphaList.resolve(undefined)
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    // It must not have repopulated the table with Alpha's game under Beta's name.
    expect(screen.queryByText('Alpha Game')).toBeNull()

    // Only once Beta's own probe resolves does Beta's row show.
    betaProbe.resolve(undefined)
    await waitFor(() => expect(screen.getByText('Beta Game')).toBeInTheDocument())
    expect(screen.queryByText('Alpha Game')).toBeNull()
  })

  // ---- A failed append must not retry forever ----------------------------------

  it('stops and rolls the page back when appending a page fails, instead of retrying forever', async () => {
    let listCalls = 0
    const fetchMock = jest.fn(async (url: string) => {
      const u = new URL(String(url), 'http://x')
      if (u.pathname.endsWith('/facets')) return { ok: true, json: async () => ({ available_conclusions: [] }) } as Response
      if (u.searchParams.get('limit') === '100') return { ok: true, json: async () => ({ data: [row()] }) } as Response
      listCalls++
      const page = u.searchParams.get('page')
      if (page === '1') {
        return { ok: true, json: async () => ({ data: Array.from({ length: 20 }, (_, i) => row({ id: i + 1 })) }) } as Response
      }
      throw new Error('network error')
    })
    global.fetch = fetchMock as unknown as typeof fetch
    installObserver('firing')

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(document.querySelectorAll('.rp-review-row').length).toBe(20))

    // The sentinel is still intersecting. Let every pending microtask and re-render
    // settle: with hasMore left true after the failure the observer would re-fire on
    // each one and the list request count would keep climbing.
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2))
    const settled = listCalls
    await new Promise(r => setTimeout(r, 50))
    expect(listCalls).toBe(settled)
    // and it never skipped past the page that failed
    const pages = parseCalls(fetchMock).filter(c => c.limit === '20').map(c => c.page)
    expect(pages).toEqual(['1', '2'])
    installObserver('noop')
  })

  // ---- The screenshot strip is not mouse-only ----------------------------------

  it('opens the lightbox from the keyboard, not only on a mouse click', async () => {
    const fetchMock = mockApi({ probe: [row()], list: [row()] })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ReviewTable evaluator="NhiLV" canSeeTeam={false} />)
    await waitFor(() => expect(screen.getByText('Merge Puzzle')).toBeInTheDocument())

    const shot = document.querySelectorAll('.rp-review-shot')[0] as HTMLElement
    expect(shot.getAttribute('role')).toBe('button')
    expect(shot.tabIndex).toBe(0)
    fireEvent.keyDown(shot, { key: 'Enter' })
    expect(document.querySelectorAll('.lightbox-backdrop img').length).toBe(2)
  })
})
