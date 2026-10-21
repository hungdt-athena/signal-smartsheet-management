/**
 * @jest-environment node
 */
jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('@/lib/session', () => ({ getSession: jest.fn() }))
jest.mock('@/lib/ytb-cache', () => ({ getYtbUploaded: jest.fn() }))
jest.mock('@/lib/current-batch', () => ({ getCurrentBatch: jest.fn() }))
jest.mock('@/lib/report-batches', () => ({ loadBatchSpans: jest.fn() }))

import { GET } from '@/app/api/record/my-queue/route'
import { sql } from '@/lib/db'
import { getSession } from '@/lib/session'
import { getYtbUploaded } from '@/lib/ytb-cache'
import { getCurrentBatch } from '@/lib/current-batch'
import { loadBatchSpans } from '@/lib/report-batches'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getSession as unknown as jest.Mock
const sheetMock = getYtbUploaded as unknown as jest.Mock
const currentMock = getCurrentBatch as unknown as jest.Mock
const spansMock = loadBatchSpans as unknown as jest.Mock
const span = (batch: string) => ({ batch, from: '', to: '', fromAt: '', toAt: null })

const game = (over: Record<string, unknown>) => ({
  id: 1, game_id: 'g1', batch: 'W2 Oct, 2026', category_group: 'puzzle', title: 'Alpha',
  record_bucket: '5min', final_conclusion: 'Insight',
  record_5min_assignee: 'KietCD', record_20min_assignee: null,
  youtube_link: null, uploaded_local: null, since: '2026-10-01', confirmed: true, ...over,
})
const upload = (title: string) => ({ gameTitle: title, youtubeId: 'yt_' + title, duration: '5mins', time: '2026-10-05 10:00:00', pic: 'KietCD' })

describe('GET /api/record/my-queue', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'false' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => {
    sessionMock.mockResolvedValue({ user: { name: 'kietcd', role: 'evaluator' } })
    sheetMock.mockResolvedValue([])
    currentMock.mockResolvedValue('W2 Oct, 2026')
    spansMock.mockResolvedValue([span('W2 Oct, 2026'), span('W1 Oct, 2026'), span('W4 Sep, 2026')])
  })

  it('counts my confirmed games that have no upload, in the current and the previous batch', async () => {
    sqlMock.mockResolvedValue([
      game({ id: 1, title: 'Alpha' }),
      game({ id: 2, title: 'Beta', batch: 'W1 Oct, 2026' }),
    ])
    const body = await (await GET()).json()
    expect(body.count).toBe(2)
    expect(body.games.map((g: { title: string }) => g.title)).toEqual(['Alpha', 'Beta'])
  })

  it('skips older batches and games with no batch', async () => {
    sqlMock.mockResolvedValue([
      game({ id: 1, title: 'Old', batch: 'W4 Sep, 2026' }),
      game({ id: 2, title: 'Unlabelled', batch: null }),
      game({ id: 3, title: 'Now' }),
    ])
    expect((await (await GET()).json()).count).toBe(1)
  })

  it('has no previous batch when the current one is not in the batches table', async () => {
    currentMock.mockResolvedValue('W3 Oct, 2026')
    sqlMock.mockResolvedValue([
      game({ id: 1, batch: 'W3 Oct, 2026' }),
      game({ id: 2, batch: 'W2 Oct, 2026' }),
    ])
    expect((await (await GET()).json()).count).toBe(1)
  })

  it('is empty when no batch is current', async () => {
    currentMock.mockResolvedValue(null)
    sqlMock.mockResolvedValue([game({})])
    expect((await (await GET()).json()).count).toBe(0)
  })

  it('leaves out drafts, uploaded games and other recorders', async () => {
    sheetMock.mockResolvedValue([upload('Beta')])
    sqlMock.mockResolvedValue([
      game({ id: 1, title: 'Alpha' }),
      game({ id: 2, title: 'Beta' }),                                  // uploaded
      game({ id: 3, title: 'Gamma', confirmed: false }),               // draft
      game({ id: 4, title: 'Delta', record_5min_assignee: 'HuyDD' }),  // someone else's
    ])
    expect((await (await GET()).json()).count).toBe(1)
  })

  it('reads the assignee of the bucket the game sits in', async () => {
    sqlMock.mockResolvedValue([
      game({ id: 1, record_bucket: '20min', record_5min_assignee: 'HuyDD', record_20min_assignee: 'KietCD' }),
    ])
    expect((await (await GET()).json()).count).toBe(1)
  })

  it('answers 500, not a count, when the sheet cannot be read', async () => {
    sheetMock.mockRejectedValue(new Error('quota'))
    sqlMock.mockResolvedValue([game({})])
    const res = await GET()
    expect(res.status).toBe(500)
  })

  it('is 0 for a session with no name', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin' } })
    expect((await (await GET()).json()).count).toBe(0)
  })
})
