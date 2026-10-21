/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('@/lib/auth-guard', () => ({ requireManager: jest.fn(async () => null) }))
jest.mock('@/lib/ytb-cache', () => ({ getYtbUploaded: jest.fn() }))

import { POST } from '@/app/api/evaluations/reconcile-recorders/route'
import { sql } from '@/lib/db'
import { getYtbUploaded } from '@/lib/ytb-cache'

const sqlMock = sql as unknown as jest.Mock
const text = (c: unknown[]) => (Array.isArray(c[0]) ? (c[0] as string[]).join('?') : '')

const row = (id: number, title: string, batch: string, since: string | null) => ({
  id, game_id: `g${id}`, batch, category_group: 'puzzle', title,
  record_bucket: null, final_conclusion: 'Priority IV',
  record_5min_assignee: null, record_20min_assignee: 'KietCD',
  youtube_link: null, uploaded_local: null, since,
})

// W3 Oct 2026: the auto-sync for batch W3 Oct gave "Car Loop Puzzle" the upload of
// "Car Loop" (W1 Oct), because W1 Oct's games were not part of the match.
describe('POST /api/evaluations/reconcile-recorders: batch scope', () => {
  beforeEach(() => {
    sqlMock.mockReset()
    sqlMock.mockImplementation((...args: unknown[]) => {
      const q = text(args)
      if (q.includes('FROM dashboard_users')) return Promise.resolve([{ name: 'KietCD' }])
      if (q.includes('FROM game_evaluations ge')) return Promise.resolve([
        row(1, 'Car Loop', 'W1 Oct, 2026', '2026-10-02'),
        row(2, 'Car Loop Puzzle', 'W3 Oct, 2026', null),
      ])
      return Promise.resolve(Object.assign([], { count: 1 }))
    })
    ;(getYtbUploaded as jest.Mock).mockResolvedValue([
      { gameTitle: 'Car Loop', youtubeId: 'carloop0001', duration: '20', time: '2026-10-07 09:02:02', pic: 'KietCD' },
    ])
  })

  const run = (batch: string) => POST(new NextRequest('http://localhost/api/evaluations/reconcile-recorders', {
    method: 'POST', body: JSON.stringify({ mode: 'dry', batch }),
  })).then(r => r.json())

  it('a game outside the batch still owns its upload', async () => {
    const out = await run('W3 Oct, 2026')
    expect(out.link_changes).toEqual([])
  })

  it('the owner itself gets the link when its batch is synced', async () => {
    const out = await run('W1 Oct, 2026')
    expect(out.link_changes.map((c: { id: number }) => c.id)).toEqual([1])
  })
})
