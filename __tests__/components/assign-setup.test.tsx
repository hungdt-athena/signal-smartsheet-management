import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { AssignSetup } from '@/components/AssignSetup'

jest.mock('@/hooks/useCategoryMappings', () => ({
  useCategoryMappings: () => ({ data: { puzzle: ['puzzle'], arcade: ['arcade'], simulation: ['simulation'] } }),
}))

const GENRES = [
  { bucket: 'puzzle', enabled: true, available: 7, active: true },
  { bucket: 'arcade', enabled: false, available: 0, active: false },
  { bucket: 'simulation', enabled: false, available: 0, active: false },
]

const PREVIEW = {
  total: 100,
  incoming: 90,
  waiting: 10,
  blocked: 3,
  windows: { puzzle: 7, arcade: 30, simulation: 30 },
  genres: [
    { bucket: 'puzzle', status: 'ready', enabled: true, available: 2,
      incoming: 90, waiting: 10, pool: 100, assigned: 100, unmatched: 0,
      os: { ios: 0, android: 100, other: 0 },
      crew: [{ name: 'NhiLV', platform: 'all', weight: 100 }, { name: 'MyTL', platform: 'all', weight: 100 }],
      perEvaluator: [{ name: 'NhiLV', count: 50 }, { name: 'MyTL', count: 50 }] },
    { bucket: 'arcade', status: 'off', enabled: false, available: 0,
      incoming: 3, waiting: 0, pool: 3, assigned: 0, unmatched: 0,
      os: { ios: 0, android: 3, other: 0 }, crew: [], perEvaluator: [] },
    { bucket: 'simulation', status: 'off', enabled: false, available: 0,
      incoming: 0, waiting: 0, pool: 0, assigned: 0, unmatched: 0,
      os: { ios: 0, android: 0, other: 0 }, crew: [], perEvaluator: [] },
  ],
}

function mockFetch(canEdit = true, preview: unknown = PREVIEW) {
  const calls: { url: string; init?: RequestInit }[] = []
  global.fetch = jest.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const body = url.startsWith('/api/assign-setup/preview')
      ? preview
      : url.startsWith('/api/genre-config')
        ? { genres: GENRES, canEdit }
        : { initial: [], final: [] }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
  }) as unknown as typeof fetch
  return calls
}

const sw = (genre: string) => screen.getByRole('switch', { name: new RegExp(genre, 'i') })

describe('AssignSetup genre toggles', () => {
  it('shows the genre state the server reports', async () => {
    mockFetch()
    render(<AssignSetup />)
    await waitFor(() => expect(screen.getByRole('row', { name: /puzzle/i })).toHaveTextContent('7 evaluators'))
    expect(sw('arcade')).toHaveAttribute('aria-checked', 'false')
  })

  it('turns a genre on through the admin-only endpoint', async () => {
    const calls = mockFetch()
    render(<AssignSetup />)
    await waitFor(() => sw('arcade'))
    fireEvent.click(sw('arcade'))
    await waitFor(() => {
      const put = calls.find(c => c.url === '/api/genre-config' && c.init?.method === 'PUT')
      expect(put).toBeDefined()
      expect(JSON.parse(put!.init!.body as string)).toEqual({ bucket: 'arcade', enabled: true })
    })
  })

  it('hides the switch behind a disabled chip when the server says the user may not edit', async () => {
    mockFetch(false)
    render(<AssignSetup />)
    await waitFor(() => expect(sw('puzzle')).toBeDisabled())
  })
})

describe('AssignSetup next-run panel', () => {
  it('shows what the run would hand out, and where the pool came from', async () => {
    mockFetch()
    render(<AssignSetup />)
    await waitFor(() => expect(document.querySelector('.pp-n')).toHaveTextContent('100'))
    expect(screen.getByText(/90 new to push/i)).toBeInTheDocument()
    expect(screen.getByText(/10 still waiting/i)).toBeInTheDocument()
    // A genre that will not run says why instead of showing a zero.
    expect(screen.getAllByText(/turned off/i)).toHaveLength(2)
    expect(screen.getByText(/3 held back by a genre that will not run/i)).toBeInTheDocument()
  })

  it('names each genre\'s push window, flagging the one that is not the default', async () => {
    mockFetch()
    render(<AssignSetup />)
    await waitFor(() => expect(screen.getByText('7d')).toBeInTheDocument())
    // 7 is not the 30-day default, so it is emphasised; 30 is not.
    expect(screen.getByText('7d')).toHaveClass('set')
    expect(screen.getAllByText('30d')[0]).not.toHaveClass('set')
  })

  it('breakdown opens a modal with a tab per genre and the crew behind the total', async () => {
    mockFetch()
    render(<AssignSetup />)
    await waitFor(() => screen.getByRole('button', { name: /^breakdown/i }))
    fireEvent.click(screen.getByRole('button', { name: /^breakdown/i }))

    expect(screen.getByRole('dialog', { name: /next run breakdown/i })).toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(screen.getByRole('tab', { name: /puzzle/i })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('NhiLV')).toBeInTheDocument()
    expect(screen.getByText('MyTL')).toBeInTheDocument()
    expect(screen.getByText(/100 in the pool/i)).toBeInTheDocument()
    // The window is the lever behind every number in here, so the modal says
    // both the length and what it is counted from.
    expect(screen.getByText(/last 7 days/i)).toBeInTheDocument()
    expect(screen.getByText(/release date/i)).toBeInTheDocument()
  })

  it('the modal links to the setting that changes the numbers', async () => {
    mockFetch()
    render(<AssignSetup />)
    await waitFor(() => screen.getByRole('button', { name: /^breakdown/i }))
    fireEvent.click(screen.getByRole('button', { name: /^breakdown/i }))
    expect(screen.getByRole('link', { name: /push window/i }))
      .toHaveAttribute('href', '/config?highlight=push-window')
  })

  it('Escape closes the modal, but backs out of the confirmation first', async () => {
    mockFetch()
    render(<AssignSetup />)
    await waitFor(() => screen.getByRole('button', { name: /^breakdown/i }))
    fireEvent.click(screen.getByRole('button', { name: /^breakdown/i }))

    fireEvent.click(screen.getByRole('button', { name: /push & assign now/i }))
    fireEvent.keyDown(window, { key: 'Escape' })
    // One keypress must not dismiss the warning AND the modal, leaving the
    // operator unsure whether the run went ahead.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: /next run breakdown/i })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: /next run breakdown/i })).not.toBeInTheDocument()
  })

  it('unticking an evaluator re-splits their share onto the rest', async () => {
    mockFetch()
    render(<AssignSetup />)
    await waitFor(() => screen.getByRole('button', { name: /^breakdown/i }))
    fireEvent.click(screen.getByRole('button', { name: /^breakdown/i }))

    fireEvent.click(screen.getByRole('checkbox', { name: /include MyTL in Puzzle/i }))
    // 100 games, two equal weights, one dropped: the other takes all of them.
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /puzzle/i })).toHaveTextContent('100'))
    expect(screen.getByText(/changes this run only/i)).toBeInTheDocument()
    const nhi = screen.getByText('NhiLV').closest('li')!
    expect(nhi).toHaveTextContent('100')
  })

  it('running asks first, then posts the per-genre exclusions', async () => {
    const calls = mockFetch()
    render(<AssignSetup />)
    await waitFor(() => screen.getByRole('button', { name: /^breakdown/i }))
    fireEvent.click(screen.getByRole('button', { name: /^breakdown/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /include MyTL in Puzzle/i }))

    // A run hands games to real people, so it costs a second, deliberate click.
    fireEvent.click(screen.getByRole('button', { name: /push & assign now/i }))
    expect(calls.some(c => c.url === '/api/assign-setup/run')).toBe(false)
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /yes, run it/i }))
    await waitFor(() => expect(calls.some(c => c.url === '/api/assign-setup/run')).toBe(true))
    const run = calls.find(c => c.url === '/api/assign-setup/run')!
    // Off for Puzzle says nothing about the other genres.
    expect(JSON.parse(run.init!.body as string)).toEqual({
      genres: ['puzzle'],
      exclude: { puzzle: ['MyTL'] },
    })
  })

  it('cancelling the confirmation runs nothing', async () => {
    const calls = mockFetch()
    render(<AssignSetup />)
    await waitFor(() => screen.getByRole('button', { name: /^breakdown/i }))
    fireEvent.click(screen.getByRole('button', { name: /^breakdown/i }))
    fireEvent.click(screen.getByRole('button', { name: /push & assign now/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(calls.some(c => c.url === '/api/assign-setup/run')).toBe(false)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('a non-admin sees the numbers but gets no run button', async () => {
    mockFetch(false)
    render(<AssignSetup />)
    await waitFor(() => screen.getByRole('button', { name: /^breakdown/i }))
    fireEvent.click(screen.getByRole('button', { name: /^breakdown/i }))
    expect(screen.queryByRole('button', { name: /push & assign now/i })).not.toBeInTheDocument()
    expect(screen.getByText(/only an admin can run this/i)).toBeInTheDocument()
  })

  it('a 200 of the wrong shape costs the panel, not the tab', async () => {
    // The endpoint is the least important thing on this screen; an unreadable
    // reply used to crash the whole roster on `genres.map`.
    mockFetch(true, { initial: [], final: [] })
    render(<AssignSetup />)
    // The rest of the tab loads normally...
    await waitFor(() =>
      expect(screen.getByRole('row', { name: /puzzle/i })).toHaveTextContent('7 evaluators'))
    expect(screen.getByText('Initial Evaluator')).toBeInTheDocument()
    // ...and the panel degrades on its own.
    await waitFor(() => expect(screen.getByText(/not available/i)).toBeInTheDocument())
  })

  it('an evaluator gets no panel and no request for one', async () => {
    const calls = mockFetch()
    render(<AssignSetup isEvaluator userName="NhiLV" />)
    await waitFor(() => expect(screen.getByText('Initial Evaluator')).toBeInTheDocument())
    expect(calls.some(c => c.url.startsWith('/api/assign-setup/preview'))).toBe(false)
    expect(screen.queryByText(/next run/i)).not.toBeInTheDocument()
  })
})

describe('AssignSetup roster height', () => {
  // The roster is the page's content, not a widget on it: capping the Initial list
  // at ten rows put a second scrollbar inside a page that already scrolls, and hid
  // the people at the bottom behind it.
  it('lets both rosters run to their full height', async () => {
    mockFetch()
    render(<AssignSetup />)
    await waitFor(() => expect(screen.getByText('Initial Evaluator')).toBeInTheDocument())
    const wraps = Array.from(document.querySelectorAll('.roster-tbl'))
    expect(wraps).toHaveLength(2)
    for (const w of wraps) expect(w.className).not.toContain('roster-scroll')
  })
})
