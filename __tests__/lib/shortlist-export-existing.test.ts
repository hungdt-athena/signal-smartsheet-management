/**
 * @jest-environment node
 */
const filesList = jest.fn()
jest.mock('googleapis', () => ({
  google: { drive: () => ({ files: { list: filesList } }), auth: { GoogleAuth: jest.fn() } },
}))

import { exportKey, findExport, EXPORT_FOLDER_ID } from '@/lib/shortlist-export/google'
import type { ExportScope } from '@/lib/shortlist-export/types'

const WEEK: ExportScope = { kind: 'week', labels: ["W3 Oct, 2026"], monthKey: '2026-10', weekTag: 'W3' }
const MONTH: ExportScope = { kind: 'month', labels: ['W1 Oct, 2026'], monthKey: '2026-10', weekTag: null }

beforeEach(() => filesList.mockReset())

it('keys an export by period and games', () => {
  expect(exportKey(WEEK, ['insight', 'priority_iv'])).toBe('W3 Oct, 2026|insight,priority_iv')
  expect(exportKey(MONTH, ['priority_iv'])).toBe('month:2026-10|priority_iv')
})

it('finds the newest file of that key and format in the export folder', async () => {
  filesList.mockResolvedValue({ data: { files: [{ id: 'd2', createdTime: '2026-11-03T10:12:00Z' }] } })
  const out = await findExport({} as any, WEEK, ['insight', 'priority_iv'], 'slides', "Oct 2026 W3 Report")
  expect(out).toEqual({ url: 'https://docs.google.com/presentation/d/d2/edit', createdTime: '2026-11-03T10:12:00Z' })
  const q = filesList.mock.calls[0][0]
  expect(q.q).toContain(`'${EXPORT_FOLDER_ID}' in parents`)
  expect(q.q).toContain("mimeType = 'application/vnd.google-apps.presentation'")
  expect(q.q).toContain("appProperties has { key='slExport' and value='W3 Oct, 2026|insight,priority_iv' }")
  expect(q.q).toContain("name = 'Oct 2026 W3 Report'")
  expect(q.q).toContain('trashed = false')
  expect(q).toMatchObject({ supportsAllDrives: true, includeItemsFromAllDrives: true, orderBy: 'createdTime desc', pageSize: 1 })
})

it('returns null when nothing was exported and for xlsx', async () => {
  filesList.mockResolvedValue({ data: { files: [] } })
  expect(await findExport({} as any, WEEK, ['insight'], 'sheets', 'x')).toBeNull()
  expect(await findExport({} as any, WEEK, ['insight'], 'xlsx', 'x')).toBeNull()
  expect(filesList).toHaveBeenCalledTimes(1)
})

it("escapes a quote in the file name", async () => {
  filesList.mockResolvedValue({ data: { files: [] } })
  await findExport({} as any, WEEK, ['insight'], 'sheets', "Bob's Report")
  expect(filesList.mock.calls[0][0].q).toContain("name = 'Bob\\'s Report'")
})
