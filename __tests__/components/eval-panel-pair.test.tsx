// The panel for a linked pair (spec 6.4, artboards 2 and 3): one form for both stores, a store
// switcher in Game Info, a red per-store "link dead" switch, and a save that sends the
// switches first (POST /api/evaluations/store-dead) and the form after, to the live row.

jest.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ conclusion: [], final_conclusion: [] }),
}))
// jsdom has no canvas; the QR is not what these tests look at.
jest.mock('qrcode', () => ({ __esModule: true, default: { toDataURL: () => Promise.resolve('data:image/png;base64,QR') } }))

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import EvalDetailPanel from '@/components/EvalDetailPanel'

const shots = (n: number, p: string) => Array.from({ length: n }, (_, i) => `https://img/${p}${i}.png`)

type Store = {
  os: 'ios' | 'android'; game_id: string; eval_id: number; app_link: string; is_active: boolean; dead: boolean
  title: string; icon_url: string | null; release_date: string | null; publisher_name: string | null; publisher_link: string | null
  screenshot_urls: string[]; description: string | null; subtitle: string | null; content_rating: string | null
  demo_code: string | null; record_code: string | null; conclusion: string | null
}

const IOS: Store = {
  os: 'ios', game_id: '6822015244', eval_id: 10, app_link: 'https://apps.apple.com/app/id6822015244', is_active: true, dead: false,
  title: 'Factory Match Jam', icon_url: null, release_date: '2026-11-05', publisher_name: 'Funbit iOS Ltd', publisher_link: null,
  screenshot_urls: shots(6, 'i'), description: 'iOS description', subtitle: null, content_rating: '4+',
  demo_code: null, record_code: null, conclusion: 'Bypass',
}
const AND: Store = {
  os: 'android', game_id: 'com.funbit.factory.match.jam', eval_id: 20, app_link: 'https://play.google.com/store/apps/details?id=com.funbit.factory.match.jam', is_active: true, dead: false,
  title: 'Factory Match Jam', icon_url: null, release_date: '2026-10-02', publisher_name: 'Funbit Android Co', publisher_link: null,
  screenshot_urls: shots(24, 'a'), description: 'Android description', subtitle: null, content_rating: 'Everyone',
  demo_code: null, record_code: null, conclusion: 'Bypass',
}

// The front row of the pair: Android here (data.id 20), the shared evaluation fields.
function row(front: Store, over: Record<string, unknown> = {}) {
  return {
    id: front.eval_id, game_id: front.game_id, category_group: 'puzzle', genre_1: 'Puzzle', genre_2: null,
    initial_evaluator: 'HungDT', final_evaluator: null, assigned_date: '2026-11-01', evaluate_date: '2026-11-02T03:00:00Z',
    initial_note: 'a note long enough', initial_gameplay: '', initial_game_over: '', initial_level_complete: '',
    initial_self_note: 'a note long enough', final_note: null, game_alike: [], initial_conclusion: front.conclusion,
    final_conclusion: null, batch: null, current_batch: 'W3 Nov, 2026', record_assignee: null, record_assign_date: null,
    record_5min_assignee: null, record_5min_date: null, record_5min_drive: null, record_5min_drive_date: null,
    record_20min_assignee: null, record_20min_date: null, record_20min_drive: null, record_20min_drive_date: null,
    record_confirmed_at: null, final_conclusion_date: null, drive_link: null, drive_date: null, youtube_link: null,
    record_bucket: null, record_5min_confirmed_at: null, record_20min_confirmed_at: null, youtube_5min_link: null,
    youtube_20min_link: null, youtube_5min_uploaded_local: null, youtube_20min_uploaded_local: null,
    imported_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z', updated_by: 'HungDT',
    title: front.title, os: front.os, app_link: front.app_link, icon_url: null, release_date: front.release_date,
    screenshot_urls: front.screenshot_urls, manual_screenshot_urls: null, categories: ['Puzzle'],
    description: front.description, subtitle: null, content_rating: front.content_rating,
    publisher_name: front.publisher_name, publisher_link: null, demo_code: null, record_code: null,
    ...over,
  }
}

type Call = { url: string; method: string; body: Record<string, unknown> | null }

function mockApi(opts: { stores: Store[] | null; front: Store; over?: Record<string, unknown> }) {
  const calls: Call[] = []
  const json = (v: unknown, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 400, json: async () => v })
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (url === '/api/evaluations/store-dead') return json({ data: { id: 1 } })
    if (url === '/api/evaluations' && method === 'PATCH') return json({ data: { id: 1 } })
    const m = url.match(/^\/api\/evaluations\/([^/?]+)(\?.*)?$/)
    if (m && method === 'GET') {
      const gid = decodeURIComponent(m[1])
      return json({
        data: row(opts.front, opts.over),
        pair: opts.stores ? { selected_game_id: gid, stores: opts.stores } : null,
      })
    }
    if (url.startsWith('/api/playtest-tags')) return json({ pending: [], existing: [] })
    if (url.startsWith('/api/trends/options')) return json({ values: [], subValues: [] })
    return json([])
  }) as unknown as typeof fetch
  return calls
}

const panel = (gameId: string) => render(
  <EvalDetailPanel initialGameId={gameId} gameList={[]} role="admin" userName="HungDT" logContext="evaluate" />,
)

const writes = (calls: Call[]) => calls.filter(c => c.method !== 'GET' && !c.url.startsWith('/api/playtest-tags'))

async function editSelfNote() {
  fireEvent.change(screen.getByPlaceholderText('Why this conclusion, what stood out'), { target: { value: 'a different note, long enough' } })
}

async function clickSave() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
}

const realFetch = global.fetch
afterEach(() => { global.fetch = realFetch })

describe('EvalDetailPanel, a single-store game', () => {
  it('has no store switcher and keeps the old Dead link switch', async () => {
    mockApi({ stores: null, front: AND })
    panel(AND.game_id)
    await screen.findByText('Funbit Android Co')
    expect(document.querySelector('.store-tabs')).toBeNull()
    expect(screen.getByRole('switch', { name: 'Dead link' })).toBeTruthy()
    expect(screen.queryByRole('switch', { name: /link dead/ })).toBeNull()
    expect(screen.getByText('StoreKit (24)')).toBeTruthy()
    expect(document.querySelector('.shared-hint')).toBeNull()
  })
})

describe('EvalDetailPanel, a linked pair', () => {
  it('shows two store tabs, the asked-for store first selected; switching changes Game Info, never the form', async () => {
    mockApi({ stores: [IOS, AND], front: AND })
    panel(AND.game_id)
    await screen.findByText('Funbit Android Co')
    const tabs = within(document.querySelector('.store-tabs') as HTMLElement).getAllByRole('button')
    expect(tabs.map(t => t.textContent)).toEqual(['iOS', 'Android'])
    expect(tabs[1].getAttribute('aria-pressed')).toBe('true')
    expect(tabs[0].getAttribute('title')).toContain('6822015244')
    expect(screen.getByText('StoreKit · Android (24)')).toBeTruthy()
    expect(screen.getByText('02/10/26')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Android link dead' })).toBeTruthy()
    // the old switch in Initial Conclusion is gone for a pair
    expect(screen.queryByRole('switch', { name: 'Dead link' })).toBeNull()
    const note = screen.getByPlaceholderText('Why this conclusion, what stood out') as HTMLTextAreaElement
    fireEvent.change(note, { target: { value: 'typed before switching tabs' } })

    fireEvent.click(tabs[0])
    expect(tabs[0].getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('StoreKit · iOS (6)')).toBeTruthy()
    expect(screen.getByText('Funbit iOS Ltd')).toBeTruthy()
    expect(screen.queryByText('Funbit Android Co')).toBeNull()
    expect(screen.getByText('05/11/26')).toBeTruthy()
    expect(screen.getByText('6822015244')).toBeTruthy()
    expect(screen.getByText('Factory Match Jam').closest('a')?.getAttribute('href')).toBe(IOS.app_link)
    expect(screen.getByRole('switch', { name: 'iOS link dead' })).toBeTruthy()
    // the form keeps what was typed
    expect((screen.getByPlaceholderText('Why this conclusion, what stood out') as HTMLTextAreaElement).value).toBe('typed before switching tabs')
  })

  it('a normal pair says Saved to both stores, and the save bar says both stores save together', async () => {
    mockApi({ stores: [IOS, AND], front: AND })
    panel(AND.game_id)
    await screen.findByText('Funbit Android Co')
    expect(document.querySelector('.shared-hint')?.textContent).toBe('Saved to both stores')
    expect(document.querySelector('.pair-note')).toBeNull()
    await editSelfNote()
    expect(document.querySelector('.eval-savebar-note')?.textContent).toContain('saves Android and iOS together')
  })

  it('the link dead switch is red (sw-dead); turning iOS dead and saving posts store-dead for iOS first, then PATCHes the Android row', async () => {
    const calls = mockApi({ stores: [IOS, AND], front: AND })
    panel(AND.game_id)
    await screen.findByText('Funbit Android Co')
    fireEvent.click(within(document.querySelector('.store-tabs') as HTMLElement).getByRole('button', { name: 'iOS' }))
    const sw = screen.getByRole('switch', { name: 'iOS link dead' })
    expect(sw.className).toContain('sw-dead')
    fireEvent.click(sw)
    expect(sw.getAttribute('aria-checked')).toBe('true')
    // the leave guard sees the switch as an unsaved change
    expect(document.querySelector('.eval-savebar-note')?.textContent).toContain('iOS link dead')
    await editSelfNote()
    await clickSave()
    await waitFor(() => expect(writes(calls)).toHaveLength(2))
    const [dead, patch] = writes(calls)
    expect(dead.url).toBe('/api/evaluations/store-dead')
    expect(dead.body).toMatchObject({ id: IOS.eval_id, dead: true })
    expect(patch.url).toBe('/api/evaluations')
    expect(patch.method).toBe('PATCH')
    expect(patch.body).toMatchObject({ id: AND.eval_id })
  })

  it('only the switch changed: store-dead goes out and no form PATCH', async () => {
    const calls = mockApi({ stores: [IOS, AND], front: AND })
    panel(AND.game_id)
    await screen.findByText('Funbit Android Co')
    fireEvent.click(screen.getByRole('switch', { name: 'Android link dead' }))
    await clickSave()
    await waitFor(() => expect(writes(calls)).toHaveLength(1))
    expect(writes(calls)[0]).toMatchObject({ url: '/api/evaluations/store-dead', body: { id: AND.eval_id, dead: true } })
  })

  it('the selected store is dead: red pair note and an Android-only hint', async () => {
    const dIos = { ...IOS, dead: true, conclusion: 'Link_dead' }
    mockApi({ stores: [dIos, AND], front: AND })
    panel(IOS.game_id)
    await screen.findByText('Funbit iOS Ltd')
    const tab = within(document.querySelector('.store-tabs') as HTMLElement).getByRole('button', { name: 'iOS' })
    expect(tab.getAttribute('aria-pressed')).toBe('true')
    expect(tab.className).toContain('dead')
    expect(screen.getByRole('switch', { name: 'iOS link dead' }).getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('.pair-note')?.textContent).toBe(
      'The iOS link is dead, so iOS keeps Link dead. The evaluation on the right is Android only. When the iOS link works again, iOS reopens and takes the pair\'s result.',
    )
    expect(document.querySelector('.pair-note b')?.textContent).toBe('Link dead')
    expect(document.querySelector('.shared-hint')?.textContent).toBe('Android only while the iOS link is dead')
    // the other store is live: no note on its tab
    fireEvent.click(within(document.querySelector('.store-tabs') as HTMLElement).getByRole('button', { name: 'Android' }))
    expect(document.querySelector('.pair-note')).toBeNull()
  })

  it('opened by the back game_id: the form PATCH goes to data.id (the front row)', async () => {
    const calls = mockApi({ stores: [IOS, AND], front: AND })
    panel(IOS.game_id)
    await screen.findByText('Funbit iOS Ltd')
    expect(within(document.querySelector('.store-tabs') as HTMLElement).getByRole('button', { name: 'iOS' }).getAttribute('aria-pressed')).toBe('true')
    await editSelfNote()
    await clickSave()
    await waitFor(() => expect(writes(calls)).toHaveLength(1))
    expect(writes(calls)[0]).toMatchObject({ url: '/api/evaluations', method: 'PATCH', body: { id: AND.eval_id } })
    // the timer belongs to the game the panel was opened on, so panel time still goes out
    expect(typeof writes(calls)[0].body?.view_s).toBe('number')
    // the refetch keeps the same store
    await waitFor(() => expect(calls.filter(c => c.method === 'GET' && c.url === `/api/evaluations/${IOS.game_id}`).length).toBe(2))
  })

  it('turning Android dead while iOS lives: store-dead for Android, then the form PATCH to the iOS row', async () => {
    const calls = mockApi({ stores: [IOS, AND], front: AND })
    panel(AND.game_id)
    await screen.findByText('Funbit Android Co')
    fireEvent.click(screen.getByRole('switch', { name: 'Android link dead' }))
    await editSelfNote()
    await clickSave()
    await waitFor(() => expect(writes(calls)).toHaveLength(2))
    const [dead, patch] = writes(calls)
    expect(dead).toMatchObject({ url: '/api/evaluations/store-dead', body: { id: AND.eval_id, dead: true } })
    expect(patch).toMatchObject({ url: '/api/evaluations', method: 'PATCH', body: { id: IOS.eval_id } })
    // panel time is counted once, on the form save
    expect(dead.body?.view_s).toBeUndefined()
    expect(typeof patch.body?.view_s).toBe('number')
  })

  it('both stores dead after the switches: the form PATCH goes to data.id', async () => {
    const dIos = { ...IOS, dead: true, conclusion: 'Link_dead' }
    const calls = mockApi({ stores: [dIos, AND], front: AND })
    panel(AND.game_id)
    await screen.findByText('Funbit Android Co')
    fireEvent.click(screen.getByRole('switch', { name: 'Android link dead' }))
    await editSelfNote()
    await clickSave()
    await waitFor(() => expect(writes(calls)).toHaveLength(2))
    const [dead, patch] = writes(calls)
    expect(dead).toMatchObject({ url: '/api/evaluations/store-dead', body: { id: AND.eval_id, dead: true } })
    expect(patch).toMatchObject({ url: '/api/evaluations', method: 'PATCH', body: { id: AND.eval_id } })
    // a dead row is never reopened or killed through PATCH
    expect(patch.body).not.toHaveProperty('initial_conclusion')
  })

  it('reopening a dead store goes through store-dead with dead: false', async () => {
    const dIos = { ...IOS, dead: true, conclusion: 'Link_dead' }
    const calls = mockApi({ stores: [dIos, AND], front: AND })
    panel(IOS.game_id)
    await screen.findByText('Funbit iOS Ltd')
    fireEvent.click(screen.getByRole('switch', { name: 'iOS link dead' }))
    await clickSave()
    await waitFor(() => expect(writes(calls)).toHaveLength(1))
    expect(writes(calls)[0]).toMatchObject({ url: '/api/evaluations/store-dead', body: { id: IOS.eval_id, dead: false } })
  })
})
