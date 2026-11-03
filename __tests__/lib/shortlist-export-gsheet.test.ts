/**
 * @jest-environment node
 */
const filesCreate = jest.fn()
const filesUpdate = jest.fn()
const sheetsBatchUpdate = jest.fn()
const valuesBatchUpdate = jest.fn()

jest.mock('googleapis', () => ({
  google: {
    drive: () => ({ files: { create: filesCreate, update: filesUpdate } }),
    sheets: () => ({ spreadsheets: { batchUpdate: sheetsBatchUpdate, values: { batchUpdate: valuesBatchUpdate } } }),
    auth: { GoogleAuth: jest.fn() },
  },
}))

import { sheetRequests, createExportSheet } from '@/lib/shortlist-export/gsheet'
import { EXPORT_FOLDER_ID } from '@/lib/shortlist-export/google'
import type { SheetTab } from '@/lib/shortlist-export/table'

const HEADER: SheetTab['header'] = ['id', 'title', 'publisher', 'android', 'ios']
const TABS: SheetTab[] = [
  { name: 'Priority IV', header: HEADER, rows: [['p1', 'P', 'Pub', '', 'https://apps.apple.com/a"b']] },
  { name: 'Insight', header: HEADER, rows: [['i1', 'I', '', 'https://play.google.com/x', '']] },
]

describe('sheetRequests', () => {
  it('adds one sheet per tab, in order', () => {
    const r = sheetRequests(TABS)
    expect(r.addSheets.map((a: any) => a.addSheet.properties.title)).toEqual(['Priority IV', 'Insight'])
  })

  it('writes header first and links as HYPERLINK formulas', () => {
    const r = sheetRequests(TABS)
    expect(r.values[0].range).toBe("'Priority IV'!A1")
    expect(r.values[0].values[0]).toEqual(HEADER)
    expect(r.values[0].values[1]).toEqual(['p1', 'P', 'Pub', '', '=HYPERLINK("https://apps.apple.com/a""b","https://apps.apple.com/a""b")'])
    expect(r.values[1].values[1][3]).toBe('=HYPERLINK("https://play.google.com/x","https://play.google.com/x")')
    expect(r.values[1].values[1][4]).toBe('')
  })

  it('keeps numeric ids and formula-looking text as text', () => {
    const r = sheetRequests([{ name: 'Insight', header: HEADER, rows: [
      ['6812649735', '=Fun Game', '+Plus Studio', '', 'https://apps.apple.com/x'],
      ['com.a.b', '2048 Merge', '-Minus', 'https://play.google.com/y', ''],
    ] }])
    expect(r.values[0].values[1].slice(0, 3)).toEqual(["'6812649735", "'=Fun Game", "'+Plus Studio"])
    expect(r.values[0].values[2].slice(0, 3)).toEqual(['com.a.b', "'2048 Merge", "'-Minus"])
    expect(r.values[0].values[1][4]).toMatch(/^=HYPERLINK\(/)
    expect(r.values[0].values[0]).toEqual(HEADER)
  })

  it('bolds and freezes the header of every tab', () => {
    const fmt = sheetRequests(TABS).format({ 'Priority IV': 11, Insight: 22 })
    const bold = fmt.filter((f: any) => f.repeatCell)
    const frozen = fmt.filter((f: any) => f.updateSheetProperties)
    expect(bold.map((f: any) => f.repeatCell.range.sheetId)).toEqual([11, 22])
    expect((bold[0] as any).repeatCell.cell.userEnteredFormat.textFormat.bold).toBe(true)
    expect(frozen.map((f: any) => f.updateSheetProperties.properties.gridProperties.frozenRowCount)).toEqual([1, 1])
  })
})

describe('createExportSheet', () => {
  beforeEach(() => { jest.resetAllMocks() })

  it('creates the sheet in the export folder and returns the link', async () => {
    filesCreate.mockResolvedValue({ data: { id: 'f1' } })
    sheetsBatchUpdate
      .mockResolvedValueOnce({ data: { replies: [{ addSheet: { properties: { sheetId: 11, title: 'Priority IV' } } }, { addSheet: { properties: { sheetId: 22, title: 'Insight' } } }, {}] } })
      .mockResolvedValueOnce({ data: {} })
    valuesBatchUpdate.mockResolvedValue({ data: {} })
    const out = await createExportSheet({} as any, 'Oct 2026 W3 Report', TABS)
    expect(out).toEqual({ fileId: 'f1', url: 'https://docs.google.com/spreadsheets/d/f1/edit' })
    expect(filesCreate.mock.calls[0][0]).toMatchObject({
      requestBody: { name: 'Oct 2026 W3 Report', mimeType: 'application/vnd.google-apps.spreadsheet', parents: [EXPORT_FOLDER_ID] },
      supportsAllDrives: true,
    })
    expect(valuesBatchUpdate.mock.calls[0][0].requestBody.valueInputOption).toBe('USER_ENTERED')
  })

  it('trashes the file when filling fails', async () => {
    filesCreate.mockResolvedValue({ data: { id: 'f1' } })
    filesUpdate.mockResolvedValue({ data: {} })
    const boom = new Error('quota')
    sheetsBatchUpdate.mockRejectedValue(boom)
    await expect(createExportSheet({} as any, 'x', TABS)).rejects.toBe(boom)
    expect(filesUpdate).toHaveBeenCalledWith({ fileId: 'f1', requestBody: { trashed: true }, supportsAllDrives: true })
  })
})
