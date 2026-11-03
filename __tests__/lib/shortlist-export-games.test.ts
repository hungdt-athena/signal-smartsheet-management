/**
 * @jest-environment node
 */
jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { sql } from '@/lib/db'
import { loadExportGames, listExportLabels, countExportGames } from '@/lib/shortlist-export/games'

const sqlMock = sql as unknown as jest.Mock
let queries: { text: string; binds: unknown[] }[] = []

function db(rows: Record<string, unknown>[]) {
  queries = []
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    const text = Array.isArray(strings) ? (strings as string[]).join(' ') : ''
    queries.push({ text, binds })
    return Promise.resolve(rows)
  })
}

function row(over: Record<string, unknown> = {}) {
  return {
    game_id: 'g1', title: 'Game 1', developer_name: 'Pub', os: 'Android',
    app_link: 'https://play.google.com/store/apps/details?id=g1', icon_url: 'https://img/1.png',
    initial_release: '2026-09-25', final_conclusion: 'Insight', batch: 'W3 Oct, 2026',
    evaluate_date: '2026-10-15T03:00:00Z',
    youtube_5min_link: 'https://youtu.be/a', youtube_20min_link: 'https://youtu.be/b',
    ...over,
  }
}

describe('loadExportGames', () => {
  it('dedupes over both conclusions whatever the Games choice, then filters', async () => {
    // newest row of g1 is Priority IV: an Insight-only export must leave g1 out, the same
    // way "Both" lists it once under Priority IV -- so the dialog count matches the file
    db([row({ game_id: 'g1', final_conclusion: 'Priority IV' }), row({ game_id: 'g2' })])
    const out = await loadExportGames(['W3 Oct, 2026'], ['insight'])
    expect(out.map(g => g.gameId)).toEqual(['g2'])
    expect(queries).toHaveLength(1)
    const { text, binds } = queries[0]
    expect(binds).toContainEqual(['Insight', 'Priority IV'])
    expect(binds).toContainEqual(['W3 Oct, 2026'])
    expect(text).toContain('DISTINCT ON (ge.game_id)')
    expect(text).toContain('ORDER BY ge.game_id, ge.evaluate_date DESC')
  })

  it('dedupes by game_id keeping the latest evaluation', async () => {
    db([])
    await loadExportGames(['W3 Oct, 2026'], ['insight', 'priority_iv'])
    const { text, binds } = queries[0]
    expect(binds).toContainEqual(['Insight', 'Priority IV'])
    expect(text).toMatch(/DISTINCT ON \(ge\.game_id\)[\s\S]*ORDER BY ge\.game_id, ge\.evaluate_date DESC/)
  })

  it('does not query for no labels or no types', async () => {
    db([])
    expect(await loadExportGames([], ['insight'])).toEqual([])
    expect(await loadExportGames(['W3 Oct, 2026'], [])).toEqual([])
    expect(queries).toHaveLength(0)
  })

  it('maps rows', async () => {
    db([
      row({ developer_name: null }),
      row({ game_id: 'g2', final_conclusion: 'Priority IV', os: 'iOS' }),
      row({ game_id: 'g3', os: 'web', youtube_5min_link: '', app_link: '', icon_url: '  ', initial_release: null }),
    ])
    const out = await loadExportGames(['W3 Oct, 2026'], ['insight', 'priority_iv'])
    expect(out[0]).toEqual({
      gameId: 'g1', title: 'Game 1', publisher: null, platform: 'android',
      storeUrl: 'https://play.google.com/store/apps/details?id=g1', iconUrl: 'https://img/1.png',
      releaseDate: '2026-09-25', conclusion: 'Insight', batch: 'W3 Oct, 2026', youtubeUrl: 'https://youtu.be/a',
    })
    expect(out[1]).toMatchObject({ platform: 'ios', youtubeUrl: 'https://youtu.be/b', conclusion: 'Priority IV' })
    expect(out[2]).toMatchObject({ platform: null, youtubeUrl: null, storeUrl: null, iconUrl: null, releaseDate: null })
  })

  it('orders by batch then evaluate time', async () => {
    db([
      row({ game_id: 'a', batch: 'W2 Oct, 2026', evaluate_date: '2026-10-08T00:00:00Z' }),
      row({ game_id: 'b', batch: 'W1 Oct, 2026', evaluate_date: '2026-10-02T00:00:00Z' }),
      row({ game_id: 'c', batch: 'W1 Oct, 2026', evaluate_date: '2026-10-01T00:00:00Z' }),
      row({ game_id: 'd', batch: 'W2 Oct, 2026', evaluate_date: '2026-10-07T00:00:00Z' }),
    ])
    const out = await loadExportGames(['W1 Oct, 2026', 'W2 Oct, 2026'], ['insight'])
    expect(out.map(g => g.gameId)).toEqual(['c', 'b', 'd', 'a'])
  })
})

describe('listExportLabels', () => {
  it('reads labels from batches, newest first', async () => {
    db([{ label: 'W1 Nov, 2026' }, { label: 'W4 Oct, 2026' }])
    expect(await listExportLabels()).toEqual(['W1 Nov, 2026', 'W4 Oct, 2026'])
    expect(queries[0].text).toMatch(/FROM batches[\s\S]*ORDER BY starts_at DESC/)
  })
})

describe('countExportGames', () => {
  it('counts per conclusion', () => {
    const g = (conclusion: 'Insight' | 'Priority IV') => ({ conclusion }) as never
    expect(countExportGames([g('Insight'), g('Priority IV'), g('Priority IV')])).toEqual({ insight: 1, priorityIV: 2 })
  })
})
