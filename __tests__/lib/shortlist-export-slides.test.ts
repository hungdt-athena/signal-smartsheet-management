/**
 * @jest-environment node
 */
import fixture from '../fixtures/master-template.json'

const filesCopy = jest.fn()
const filesUpdate = jest.fn()
const presGet = jest.fn()
const presBatch = jest.fn()

jest.mock('googleapis', () => ({
  google: {
    drive: () => ({ files: { copy: filesCopy, update: filesUpdate } }),
    slides: () => ({ presentations: { get: presGet, batchUpdate: presBatch } }),
    auth: { GoogleAuth: jest.fn() },
  },
}))

import { exportSlides } from '@/lib/shortlist-export/slides-export'
import { EXPORT_FOLDER_ID, MASTER_TEMPLATE_ID } from '@/lib/shortlist-export/google'
import type { ExportGame, ExportScope } from '@/lib/shortlist-export/types'

const WEEK: ExportScope = { kind: 'week', labels: ['W3 Oct, 2026'], monthKey: '2026-10', weekTag: 'W3' }
const game = (n: string, over: Partial<ExportGame> = {}): ExportGame => ({
  gameId: n, title: `Game ${n}`, publisher: 'Pub', platform: 'ios', storeUrl: 'https://apps.apple.com/x',
  iconUrl: `https://img.example/${n}.png`, releaseDate: '2026-10-01', conclusion: 'Insight', batch: 'W3 Oct, 2026',
  youtubeUrl: null, ...over,
})

beforeEach(() => {
  jest.resetAllMocks()
  filesCopy.mockResolvedValue({ data: { id: 'deck1' } })
  filesUpdate.mockResolvedValue({ data: {} })
  presGet.mockResolvedValue({ data: fixture })
})

const imageCalls = () => presBatch.mock.calls.filter(c => JSON.stringify(c[0]).includes('replaceImage'))

it('copies the template into the export folder and returns the link', async () => {
  presBatch.mockResolvedValue({ data: {} })
  const out = await exportSlides({} as any, 'Oct 2026 W3 Report', [game('A'), game('B')], WEEK, ['insight'])
  expect(filesCopy).toHaveBeenCalledWith(expect.objectContaining({
    fileId: MASTER_TEMPLATE_ID,
    requestBody: { name: 'Oct 2026 W3 Report', parents: [EXPORT_FOLDER_ID], appProperties: { slExport: 'W3 Oct, 2026|insight' } },
    supportsAllDrives: true,
  }))
  expect(presGet.mock.calls[0][0].presentationId).toBe('deck1')
  expect(out).toEqual({ fileId: 'deck1', url: 'https://docs.google.com/presentation/d/deck1/edit', warnings: [] })
  // structure first, then all images in one call
  expect(presBatch).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(presBatch.mock.calls[0][0])).not.toContain('replaceImage')
  expect(presBatch.mock.calls[1][0].requestBody.requests).toHaveLength(2)
})

it('falls back to one-by-one images and reports the failures', async () => {
  presBatch.mockImplementation(({ requestBody }: any) => {
    const rs = requestBody.requests
    const hasImg = JSON.stringify(rs).includes('replaceImage')
    if (hasImg && rs.length > 1) return Promise.reject(new Error('Invalid requests: provided image was not found'))
    if (hasImg && JSON.stringify(rs).includes('/B.png')) return Promise.reject(new Error('provided image was not found'))
    return Promise.resolve({ data: {} })
  })
  const out = await exportSlides({} as any, 'x', [game('A'), game('B'), game('C')], WEEK, ['insight'])
  expect(out.warnings).toEqual(['Icon not loaded: Game B'])
  expect(imageCalls()).toHaveLength(1 + 3)
  expect(filesUpdate).not.toHaveBeenCalled()
})

it('trashes the copy when the structure batch fails', async () => {
  const boom = new Error('bad request')
  presBatch.mockRejectedValue(boom)
  await expect(exportSlides({} as any, 'x', [game('A')], WEEK, ['insight'])).rejects.toBe(boom)
  expect(filesUpdate).toHaveBeenCalledWith({ fileId: 'deck1', requestBody: { trashed: true }, supportsAllDrives: true })
})

it('passes plan warnings through', async () => {
  presBatch.mockResolvedValue({ data: {} })
  const p4 = Array.from({ length: 41 }, (_, i) => game(`P${i}`, { conclusion: 'Priority IV', iconUrl: null }))
  const out = await exportSlides({} as any, 'x', p4, WEEK, ['priority_iv'])
  expect(out.warnings).toEqual(['More than 40 Top Picks: list packed as small as it goes, check it by hand'])
})

it('drops only the item the error names and resends the rest', async () => {
  let imageBatches = 0
  presBatch.mockImplementation(({ requestBody }: any) => {
    const rs = requestBody.requests
    if (!JSON.stringify(rs).includes('replaceImage')) return Promise.resolve({ data: {} })
    imageBatches++
    const iB = rs.findIndex((r: any) => r.replaceImage?.url?.endsWith('/B.png'))
    if (iB >= 0) return Promise.reject(Object.assign(new Error(`Invalid requests[${iB}].replaceImage: The provided image was not found.`), { code: 400 }))
    return Promise.resolve({ data: {} })
  })
  const out = await exportSlides({} as any, 'x', [game('A'), game('B'), game('C')], WEEK, ['insight'])
  expect(out.warnings).toEqual(['Icon not loaded: Game B'])
  expect(imageBatches).toBe(2)
})

it('stops on a permission error in the image batch and trashes the deck', async () => {
  presBatch.mockImplementation(({ requestBody }: any) =>
    JSON.stringify(requestBody.requests).includes('replaceImage')
      ? Promise.reject(Object.assign(new Error('The caller does not have permission'), { code: 403 }))
      : Promise.resolve({ data: {} }))
  await expect(exportSlides({} as any, 'x', [game('A')], WEEK, ['insight'])).rejects.toThrow('permission')
  expect(filesUpdate).toHaveBeenCalledWith({ fileId: 'deck1', requestBody: { trashed: true }, supportsAllDrives: true })
})
