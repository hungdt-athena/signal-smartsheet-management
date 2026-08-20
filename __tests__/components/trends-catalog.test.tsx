import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TrendsCatalog } from '@/components/TrendsCatalog'
import { TaggingTab } from '@/components/TaggingTab'

jest.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } },
  }),
}))
jest.mock('@/components/EvalDetailPanel', () => ({
  __esModule: true,
  default: () => <div data-testid="eval-panel" />,
}))

const TRENDS = [
  { value: 'Sudoku', total: 640, last30: 65, lastTaggedAt: '2026-08-19T21:00:11.735Z', hasInstruction: false },
  { value: 'Block Puzzle', total: 730, last30: 12, lastTaggedAt: '2026-08-19T20:15:08.564Z', hasInstruction: true },
  { value: 'Backpack', total: 0, last30: 0, lastTaggedAt: null, hasInstruction: false },
]

const DETAIL = {
  value: 'Block Puzzle',
  instruction: '## Overview\n\nPlacing **discrete block pieces** on a grid.',
  games: [
    { game_id: 'g1', title: 'Block Match Puzzle', icon_url: null, sub_value_name: 'Merge Two', created_at: '2026-08-19T20:15:08.564Z' },
    { game_id: 'g2', title: 'Box Blast', icon_url: null, sub_value_name: null, created_at: '2026-08-18T20:15:08.564Z' },
  ],
}

let hits: string[] = []

function stubFetch() {
  hits = []
  global.fetch = jest.fn(async (url: string) => {
    const u = String(url)
    hits.push(u)
    if (u.startsWith('/api/trends/catalog')) {
      return { ok: true, json: async () => ({ trends: TRENDS }) } as Response
    }
    if (u.startsWith('/api/trends/detail')) {
      return { ok: true, json: async () => DETAIL } as Response
    }
    return { ok: true, json: async () => ({ tags: [], rows: [], total: 0 }) } as Response
  }) as unknown as typeof fetch
}

const trendRows = () =>
  screen.getAllByRole('row').filter(r => within(r).queryByRole('button'))

describe('Trends catalog', () => {
  beforeEach(stubFetch)

  it('lists the busiest trend of the last 30 days first', async () => {
    render(<TrendsCatalog onOpenGame={jest.fn()} />)
    await waitFor(() => expect(trendRows().length).toBe(3))
    expect(within(trendRows()[0]).getByRole('button')).toHaveTextContent('Sudoku')
    expect(trendRows()[0]).toHaveTextContent('640')
  })

  it('sorts by total games when asked', async () => {
    render(<TrendsCatalog onOpenGame={jest.fn()} />)
    await waitFor(() => expect(trendRows().length).toBe(3))
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'total' } })
    expect(within(trendRows()[0]).getByRole('button')).toHaveTextContent('Block Puzzle')
  })

  it('filters the list by what is typed', async () => {
    render(<TrendsCatalog onOpenGame={jest.fn()} />)
    await waitFor(() => expect(trendRows().length).toBe(3))
    fireEvent.change(screen.getByPlaceholderText('Search trends'), { target: { value: 'back' } })
    await waitFor(() => expect(trendRows().length).toBe(1))
    expect(within(trendRows()[0]).getByRole('button')).toHaveTextContent('Backpack')
  })

  it('opens a trend with its instruction and its recent games', async () => {
    render(<TrendsCatalog onOpenGame={jest.fn()} />)
    await waitFor(() => expect(trendRows().length).toBe(3))
    fireEvent.click(screen.getByRole('button', { name: 'Block Puzzle' }))
    await waitFor(() => expect(screen.getByText('Overview')).toBeInTheDocument())
    expect(hits.some(h => h.includes('/api/trends/detail?value=Block%20Puzzle'))).toBe(true)
    expect(screen.getByText('discrete block pieces')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Block Match Puzzle' })).toBeInTheDocument()
    expect(screen.getByText('Merge Two')).toBeInTheDocument()
  })

  it('hands a clicked game to the evaluation panel with the trend as its list', async () => {
    const onOpenGame = jest.fn()
    render(<TrendsCatalog onOpenGame={onOpenGame} />)
    await waitFor(() => expect(trendRows().length).toBe(3))
    fireEvent.click(screen.getByRole('button', { name: 'Block Puzzle' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Box Blast' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Box Blast' }))
    expect(onOpenGame).toHaveBeenCalledWith('g2', [
      { game_id: 'g1', title: 'Block Match Puzzle' },
      { game_id: 'g2', title: 'Box Blast' },
    ])
  })
})

describe('Tagging tab', () => {
  beforeEach(stubFetch)

  it('offers the trends listing as a third view', async () => {
    render(<TaggingTab />)
    fireEvent.click(screen.getByRole('button', { name: 'Trends' }))
    await waitFor(() => expect(screen.getByPlaceholderText('Search trends')).toBeInTheDocument())
  })

  it('says what the trends view is, not what the queue is', async () => {
    render(<TaggingTab />)
    fireEvent.click(screen.getByRole('button', { name: 'Trends' }))
    await waitFor(() => expect(screen.getByPlaceholderText('Search trends')).toBeInTheDocument())
    expect(screen.getByText(/Every trend you can tag/)).toBeInTheDocument()
  })
})
