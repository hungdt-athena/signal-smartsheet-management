// jsdom has no IntersectionObserver; the table's infinite-scroll sentinel wants one.
class NoopObserver {
  observe() { /* the sentinel never intersects in jsdom */ }
  disconnect() { /* nothing to tear down */ }
  unobserve() { /* nothing to tear down */ }
}
global.IntersectionObserver = NoopObserver as unknown as typeof IntersectionObserver


jest.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 1, role: 'admin', name: 'HungDT', email: 'hungdt@athena.studio' } }, status: 'authenticated' }),
}))

// The page keeps its view and filters in the URL (lib/use-url-state). This stand-in for
// next/navigation keeps the query string in jsdom's location, so changing a filter
// re-renders the page the way the real router does.
jest.mock('next/navigation', () => {
  const React = jest.requireActual('react')
  const listeners = new Set<() => void>()
  const subscribe = (l: () => void) => { listeners.add(l); window.addEventListener('test:urlchange', l); return () => { listeners.delete(l); window.removeEventListener('test:urlchange', l) } }
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

jest.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ conclusion: [], final_conclusion: [] }),
}))

// Children that do their own fetching or need a DOM the table does not give them.
// The stand-in keeps the props it was last given, so a test can play the panel's onSaved.
const mockPanelProps: { current: Record<string, unknown> | null } = { current: null }
jest.mock('@/components/EvalDetailPanel', () => ({
  __esModule: true,
  default: (p: Record<string, unknown>) => { mockPanelProps.current = p; return <div data-testid="eval-panel" /> },
  weekBatches: () => [],
}))
jest.mock('@/components/QuickStatsModal', () => ({ QuickStatsModal: () => null }))
jest.mock('@/components/weekly-feedback/WeeklyFeedbackTab', () => ({ WeeklyFeedbackTab: () => null }))
jest.mock('@/components/TaggingTab', () => ({ TaggingTab: () => null }))

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import EvaluationsPage from '@/app/(manager)/evaluations/page'

const IOS = { os: 'ios', game_id: '111', eval_id: 1, app_link: 'https://apps.apple.com/app/id111', is_active: true, dead: false }
const AND = { os: 'android', game_id: 'com.x.y', eval_id: 2, app_link: 'https://play.google.com/store/apps/details?id=com.x.y', is_active: true, dead: false }

const base = {
  category_group: 'puzzle', genre_1: 'Puzzle', genre_2: null, initial_evaluator: 'KhangNA', final_evaluator: null,
  assigned_date: '2026-11-02', evaluate_date: null, initial_note: 'note', initial_conclusion: 'List_Idea',
  final_conclusion: null, final_note: null, game_alike: null, drive_link: null, imported_at: '2026-11-02',
  icon_url: 'https://x/i.png', release_date: '2026-10-05', publisher_name: 'Very Long Publisher Name Studio',
  tags: null, batch: 'W4 Oct',
}
const PAIR = { ...base, id: 1, game_id: '111', title: 'Pair Game', os: 'ios', app_link: IOS.app_link, stores: [IOS, AND] }
const SOLO = { ...base, id: 3, game_id: '222', title: 'Solo Game', os: 'android', app_link: 'https://play.google.com/store/apps/details?id=solo',
  stores: [{ ...AND, game_id: '222', eval_id: 3, app_link: 'https://play.google.com/store/apps/details?id=solo' }] }
const LEGACY = { ...base, id: 4, game_id: '333', title: 'Legacy Game', os: 'ios', app_link: 'https://apps.apple.com/app/id333' }

function stubFetch(rows: unknown[]) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.startsWith('/api/evaluations/facets')
      ? { available_months: [{ year: 2026, month: 10 }], available_conclusions: ['List_Idea'], available_evaluators: ['KhangNA'], available_batches: ['W4 Oct'], default_batch: 'W4 Oct' }
      : { data: rows, total: 7, stats: { total: 7, evaluated: 0, pending: 7 }, applied_month: { year: 2026, month: 10 } }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
  }) as unknown as typeof fetch
}

const rowOf = (t: string) => screen.getByText(t).closest('tr') as HTMLElement
const colIndex = (name: string) => Array.from(document.querySelectorAll('thead th')).findIndex(th => th.textContent?.trim() === name)

describe('Evaluate tab: pairs', () => {
  beforeEach(() => { window.history.replaceState(null, '', '/evaluations') })

  it('has a Stores column right after Game, 2 icons for a pair, no mark on the game icon', async () => {
    stubFetch([PAIR, SOLO, LEGACY])
    render(<EvaluationsPage />)
    await waitFor(() => expect(screen.getByText('Pair Game')).toBeTruthy())
    expect(colIndex('Stores')).toBe(colIndex('Game') + 1)
    const idx = colIndex('Stores')
    expect(rowOf('Pair Game').children[idx].querySelectorAll('.store-ico').length).toBe(2)
    expect(rowOf('Solo Game').children[idx].querySelectorAll('.store-ico').length).toBe(1)
    // no `stores` on the row: falls back to its own store
    expect(rowOf('Legacy Game').children[idx].querySelectorAll('.store-ico').length).toBe(1)
    expect(document.querySelector('.game-icon-plat')).toBeNull()
    // the count is the API total
    expect(screen.getByText(/7 games/)).toBeTruthy()
  })

  it('a save in the panel that marks iOS link dead shows on the row at once, without refetching the list', async () => {
    stubFetch([PAIR, SOLO])
    render(<EvaluationsPage />)
    await waitFor(() => expect(screen.getByText('Pair Game')).toBeTruthy())
    fireEvent.click(screen.getByText('Pair Game'))
    await waitFor(() => expect(screen.getByTestId('eval-panel')).toBeTruthy())
    const listCalls = () => (global.fetch as jest.Mock).mock.calls.filter(([u]) => String(u).startsWith('/api/evaluations?')).length
    const before = listCalls()
    const idx = colIndex('Stores')
    expect(rowOf('Pair Game').children[idx].querySelector('.store-ico.dead')).toBeNull()
    const onSaved = mockPanelProps.current!.onSaved as (fresh: unknown, stores: unknown) => void
    // the front row may have changed after the switch: the row still matches by the pair's ids
    act(() => { onSaved({ ...PAIR, id: 2, game_id: 'com.x.y' }, [{ ...IOS, dead: true }, AND]) })
    const dead = rowOf('Pair Game').children[idx].querySelectorAll('.store-ico.dead')
    expect(dead).toHaveLength(1)
    expect(dead[0].getAttribute('title')).toContain('iOS')
    expect(rowOf('Solo Game').children[idx].querySelector('.store-ico.dead')).toBeNull()
    expect(listCalls()).toBe(before)
  })
})

describe('Short List tab: pairs and compact game cell', () => {
  beforeEach(() => { window.history.replaceState(null, '', '/evaluations?cat=short_list') })

  it('drops the Link column, shows Stores as links, and a 3-line game cell', async () => {
    stubFetch([PAIR, LEGACY])
    render(<EvaluationsPage />)
    await waitFor(() => expect(screen.getByText('Pair Game')).toBeTruthy())
    expect(colIndex('Link')).toBe(-1)
    expect(colIndex('Stores')).toBe(colIndex('Game') + 1)
    const tr = rowOf('Pair Game')
    const links = tr.children[colIndex('Stores')].querySelectorAll('a.store-ico')
    expect(links.length).toBe(2)
    expect(links[0].getAttribute('href')).toBe(IOS.app_link)
    expect(document.querySelector('.game-icon-plat')).toBeNull()

    const slg = tr.querySelector('.slg') as HTMLElement
    expect(slg).toBeTruthy()
    const text = slg.querySelector('.slg-text') as HTMLElement
    expect(text.children.length).toBe(3)
    expect(text.children[0].className).toContain('slg-title')
    const chips = text.children[1] as HTMLElement
    expect(chips.className).toContain('slg-chips')
    expect(within(chips).getByText('W4 Oct')).toBeTruthy()
    expect(within(chips).getByText('KhangNA')).toBeTruthy()
    const meta = text.children[2] as HTMLElement
    expect(meta.className).toContain('slg-meta')
    expect(meta.querySelector('.slg-pub')?.textContent).toBe('Very Long Publisher Name Studio')
    expect(meta.querySelector('.slg-date')?.textContent).toBe('· 05/10/26')
    // the copy button is inside .slg (absolutely positioned by .slg .cell-copy)
    expect(slg.querySelector('.cell-copy')).toBeTruthy()
    // legacy row without stores still gets one icon
    expect(rowOf('Legacy Game').children[colIndex('Stores')].querySelectorAll('.store-ico').length).toBe(1)
  })
})
