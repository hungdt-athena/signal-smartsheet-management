class NoopObserver {
  observe() { /* jsdom */ }
  disconnect() { /* jsdom */ }
  unobserve() { /* jsdom */ }
}
global.IntersectionObserver = NoopObserver as unknown as typeof IntersectionObserver

jest.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 1, role: 'admin', name: 'HungDT', email: 'hungdt@athena.studio' } }, status: 'authenticated' }),
}))

jest.mock('next/navigation', () => {
  const React = jest.requireActual('react')
  const listeners = new Set<() => void>()
  const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
  const read = () => window.location.search
  const router = { replace: (url: string) => { window.history.replaceState(null, '', url); listeners.forEach(l => l()) } }
  return {
    useSearchParams: () => {
      const qs = React.useSyncExternalStore(subscribe, read, read)
      return React.useMemo(() => new URLSearchParams(qs), [qs])
    },
    useRouter: () => router,
    usePathname: () => window.location.pathname,
  }
})

jest.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ conclusion: [], final_conclusion: [] }) }))
jest.mock('@/components/EvalDetailPanel', () => ({ __esModule: true, default: () => <div data-testid="eval-panel" />, weekBatches: () => [] }))

import { render, screen, waitFor } from '@testing-library/react'
import VideosPage from '@/app/(manager)/youtube/page'

const IOS = { os: 'ios', game_id: '111', eval_id: 1, app_link: null, is_active: true, dead: false }
const AND = { os: 'android', game_id: 'com.x.y', eval_id: 2, app_link: null, is_active: true, dead: false }
const base = {
  category_group: 'puzzle', genre_1: 'Puzzle', genre_2: null, initial_evaluator: 'KhangNA', final_evaluator: null,
  initial_note: 'n', initial_conclusion: 'List_Idea', final_conclusion: 'Insight', drive_link: null,
  record_confirmed_at: '2026-11-02T00:00:00Z', record_5min_assignee: 'Mai', record_5min_drive: null,
  record_20min_assignee: null, record_20min_drive: null, record_bucket: '5min', publisher_name: 'P', batch: 'W4 Oct',
  icon_url: 'https://x/i.png',
}
// record_code is the pair's code (the API COALESCEs the twin's), so the front row shows it.
const PAIR = { ...base, id: 1, game_id: '111', title: 'Pair Game', os: 'ios', app_link: null, record_code: 'AB12CD', stores: [IOS, AND] }
const SOLO = { ...base, id: 3, game_id: '222', title: 'Solo Game', os: 'android', app_link: null, record_code: 'ZZ99YY',
  stores: [{ ...AND, game_id: '222', eval_id: 3 }] }
const LEGACY = { ...base, id: 4, game_id: '333', title: 'Legacy Game', os: 'ios', app_link: null, record_code: 'LG00LG' }

beforeEach(() => {
  window.history.replaceState(null, '', '/youtube?tab=record_video&batch=all')
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input)
    let body: unknown = {}
    if (url.startsWith('/api/evaluations?')) body = { data: [PAIR, SOLO, LEGACY], available_batches: ['W4 Oct'], current_batch: 'W4 Oct', default_batch: 'W4 Oct' }
    else if (url.startsWith('/api/evaluations/record-games')) body = []
    else if (url.startsWith('/api/team/recorders')) body = ['Mai']
    else if (url.startsWith('/api/sheets/ytb-uploaded')) body = []
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
  }) as unknown as typeof fetch
})

const rowOf = (t: string) => screen.getByText(t).closest('tr') as HTMLElement

describe('Record tab: pairs', () => {
  it('shows a linked pair as one row with both store marks and the pair code', async () => {
    render(<VideosPage />)
    await waitFor(() => screen.getByText('Pair Game'))
    expect(screen.getAllByText('Pair Game')).toHaveLength(1)
    const pair = rowOf('Pair Game')
    expect(pair.querySelectorAll('.game-icon-plat')).toHaveLength(2)
    expect(pair.querySelector('[aria-label="iOS"]')).not.toBeNull()
    expect(pair.querySelector('[aria-label="Android"]')).not.toBeNull()
    expect(pair.textContent).toContain('AB12CD')
  })

  it('keeps one mark for a single-store row and for a row without stores', async () => {
    render(<VideosPage />)
    await waitFor(() => screen.getByText('Solo Game'))
    const solo = rowOf('Solo Game')
    expect(solo.querySelectorAll('.game-icon-plat')).toHaveLength(1)
    expect(solo.querySelector('[aria-label="Android"]')).not.toBeNull()
    const legacy = rowOf('Legacy Game')
    expect(legacy.querySelectorAll('.game-icon-plat')).toHaveLength(1)
    expect(legacy.querySelector('[aria-label="iOS"]')).not.toBeNull()
  })

  it('has no Stores column', async () => {
    render(<VideosPage />)
    await waitFor(() => screen.getByText('Pair Game'))
    const heads = Array.from(document.querySelectorAll('thead th')).map(th => th.textContent?.trim())
    expect(heads).not.toContain('Stores')
  })
})
