/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ authOptions: {} }))
jest.mock('@/lib/shortlist-export/games', () => ({
  ...jest.requireActual('@/lib/shortlist-export/games'),
  listExportLabels: jest.fn(), loadExportGames: jest.fn(),
}))
jest.mock('@/lib/shortlist-export/google', () => ({ getExportAuth: jest.fn(() => ({ sa: true })) }))
jest.mock('@/lib/shortlist-export/slides-export', () => ({ exportSlides: jest.fn() }))
jest.mock('@/lib/shortlist-export/gsheet', () => ({ createExportSheet: jest.fn() }))

import { GET, POST } from '@/app/api/shortlist-export/route'
import { getServerSession } from 'next-auth'
import { listExportLabels, loadExportGames } from '@/lib/shortlist-export/games'
import { getExportAuth } from '@/lib/shortlist-export/google'
import { exportSlides } from '@/lib/shortlist-export/slides-export'
import { createExportSheet } from '@/lib/shortlist-export/gsheet'
import type { ExportGame } from '@/lib/shortlist-export/types'

const session = getServerSession as unknown as jest.Mock
const labels = listExportLabels as jest.Mock
const load = loadExportGames as jest.Mock
const slides = exportSlides as jest.Mock
const sheet = createExportSheet as jest.Mock
const auth = getExportAuth as jest.Mock

const LABELS = ['W4 Oct, 2026', 'W3 Oct, 2026', 'W2 Oct, 2026', 'W1 Oct, 2026']
const game = (id: string, conclusion: ExportGame['conclusion']): ExportGame => ({
  gameId: id, title: id, publisher: null, platform: 'android', storeUrl: 'https://play.google.com/x', iconUrl: null,
  releaseDate: null, conclusion, batch: 'W3 Oct, 2026', youtubeUrl: null,
})

const get = (qs = '') => GET(new NextRequest(`http://localhost/api/shortlist-export${qs}`))
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/shortlist-export', { method: 'POST', body: JSON.stringify(body) }))

const realSkip = process.env.SKIP_AUTH
beforeEach(() => {
  jest.clearAllMocks()
  process.env.SKIP_AUTH = 'false'
  session.mockResolvedValue({ user: { name: 'NhiLV', role: 'moderator' } })
  labels.mockResolvedValue(LABELS)
  load.mockResolvedValue([game('i1', 'Insight'), game('p1', 'Priority IV'), game('p2', 'Priority IV')])
})
afterAll(() => { process.env.SKIP_AUTH = realSkip })

it('blocks an evaluator', async () => {
  session.mockResolvedValue({ user: { name: 'PhuongNT1', role: 'evaluator' } })
  expect((await get()).status).toBe(403)
  expect((await post({ pick: 'W3 Oct, 2026', types: ['insight'], format: 'xlsx' })).status).toBe(403)
})

it('allows a moderator and lists the labels', async () => {
  const res = await get()
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ labels: LABELS, counts: null })
})

it('returns counts for a valid pick', async () => {
  const res = await get('?pick=' + encodeURIComponent('month:2026-10'))
  expect(await res.json()).toEqual({ labels: LABELS, counts: { insight: 1, priorityIV: 2 } })
  expect(load).toHaveBeenCalledWith(['W1 Oct, 2026', 'W2 Oct, 2026', 'W3 Oct, 2026', 'W4 Oct, 2026'], ['insight', 'priority_iv'])
})

it('rejects a pick outside the batches table without querying games or Google', async () => {
  const res = await post({ pick: 'W3 Feb, 2026', types: ['insight'], format: 'slides' })
  expect(res.status).toBe(400)
  expect((await res.json()).error).toBe('Pick a batch or month from W2 Jul 2026 on')
  expect(load).not.toHaveBeenCalled()
  expect(auth).not.toHaveBeenCalled()
  expect((await get('?pick=' + encodeURIComponent('W3 Feb, 2026'))).status).toBe(400)
})

it.each([
  [{ pick: 'W3 Oct, 2026', types: [], format: 'xlsx' }],
  [{ pick: 'W3 Oct, 2026', types: ['insight'], format: 'pdf' }],
  [{ pick: 'W3 Oct, 2026', types: ['other'], format: 'xlsx' }],
])('rejects a bad body %#', async body => {
  expect((await post(body)).status).toBe(400)
})

it('streams an xlsx with the export file name', async () => {
  const res = await post({ pick: 'W3 Oct, 2026', types: ['insight', 'priority_iv'], format: 'xlsx' })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  expect(res.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''Oct%202026%20W3%20Report.xlsx")
  expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0)
  expect(auth).not.toHaveBeenCalled()
})

it('returns the Slides link and warnings', async () => {
  slides.mockResolvedValue({ fileId: 'd1', url: 'https://docs.google.com/presentation/d/d1/edit', warnings: ['Icon not loaded: p1'] })
  const res = await post({ pick: 'W3 Oct, 2026', types: ['priority_iv'], format: 'slides' })
  expect(await res.json()).toEqual({ url: 'https://docs.google.com/presentation/d/d1/edit', warnings: ['Icon not loaded: p1'] })
  expect(slides.mock.calls[0][1]).toBe('Oct 2026 W3 Report (Priority IV)')
  expect(slides.mock.calls[0][3]).toMatchObject({ kind: 'week', labels: ['W3 Oct, 2026'] })
})

it('returns the Sheets link', async () => {
  sheet.mockResolvedValue({ fileId: 's1', url: 'https://docs.google.com/spreadsheets/d/s1/edit' })
  const res = await post({ pick: 'W3 Oct, 2026', types: ['insight', 'priority_iv'], format: 'sheets' })
  expect(await res.json()).toEqual({ url: 'https://docs.google.com/spreadsheets/d/s1/edit', warnings: [] })
  expect(sheet.mock.calls[0][2].map((t: any) => t.name)).toEqual(['Priority IV', 'Insight'])
})

it('refuses an empty period', async () => {
  load.mockResolvedValue([])
  const res = await post({ pick: 'W3 Oct, 2026', types: ['insight'], format: 'slides' })
  expect(res.status).toBe(400)
  expect((await res.json()).error).toBe('No games in this period')
  expect(auth).not.toHaveBeenCalled()
})

it('passes a Google failure through as 500', async () => {
  slides.mockRejectedValue(new Error('The caller does not have permission'))
  const res = await post({ pick: 'W3 Oct, 2026', types: ['insight'], format: 'slides' })
  expect(res.status).toBe(500)
  expect((await res.json()).error).toBe('The caller does not have permission')
})
