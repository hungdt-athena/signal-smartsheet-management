// Sheet tabs -> a Google Sheet in the export folder.

import { google } from 'googleapis'
import { EXPORT_FOLDER_ID, trashFile, type ExportAuth } from './google'
import { LINK_COLUMNS, type SheetTab } from './table'

const quote = (s: string) => s.replace(/"/g, '""')
const hyperlink = (url: string) => `=HYPERLINK("${quote(url)}","${quote(url)}")`
// Values go in as USER_ENTERED (so the HYPERLINK formulas work), which would also turn an
// iOS id into a number and read "=Fun Game" as a formula. A leading ' keeps the cell text;
// Sheets does not show it.
const asText = (v: string) => (/^[\d=+\-@]/.test(v) ? `'${v}` : v)

// id, title, publisher, android, ios -- wide enough for a bundle id and a full title.
const COLUMN_PX = [260, 280, 200, 320, 320]
const HEADER_BG = { red: 0.85, green: 0.92, blue: 0.83 }

/** The requests that fill a new spreadsheet. `format` needs the sheet ids the add step returns. */
export function sheetRequests(tabs: SheetTab[]) {
  return {
    addSheets: tabs.map(t => ({ addSheet: { properties: { title: t.name, gridProperties: { columnCount: t.header.length, rowCount: Math.max(t.rows.length + 1, 2) } } } })),
    values: tabs.map(t => ({
      range: `'${t.name}'!A1`,
      values: [
        [...t.header] as string[],
        ...t.rows.map(r => r.map((v, i) => ((LINK_COLUMNS as readonly number[]).includes(i) ? (v ? hyperlink(v) : '') : asText(v)))),
      ],
    })),
    format: (sheetIds: Record<string, number>) => tabs.flatMap(t => [
      {
        repeatCell: {
          range: { sheetId: sheetIds[t.name], startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: HEADER_BG } },
          fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
        },
      },
      // Long store links stay inside their own column instead of running over the next one.
      {
        repeatCell: {
          range: { sheetId: sheetIds[t.name], startRowIndex: 1, endRowIndex: t.rows.length + 1, startColumnIndex: 0, endColumnIndex: 5 },
          cell: { userEnteredFormat: { wrapStrategy: 'CLIP', verticalAlignment: 'MIDDLE' } },
          fields: 'userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment',
        },
      },
      ...COLUMN_PX.map((pixelSize, i) => ({
        updateDimensionProperties: {
          range: { sheetId: sheetIds[t.name], dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
          properties: { pixelSize },
          fields: 'pixelSize',
        },
      })),
      { setBasicFilter: { filter: { range: { sheetId: sheetIds[t.name], startRowIndex: 0, endRowIndex: t.rows.length + 1, startColumnIndex: 0, endColumnIndex: 5 } } } },
      {
        updateSheetProperties: {
          properties: { sheetId: sheetIds[t.name], gridProperties: { frozenRowCount: 1 } },
          fields: 'gridProperties.frozenRowCount',
        },
      },
    ]),
  }
}

export async function createExportSheet(auth: ExportAuth, name: string, tabs: SheetTab[]): Promise<{ fileId: string; url: string }> {
  const drive = google.drive({ version: 'v3', auth })
  const sheets = google.sheets({ version: 'v4', auth })
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [EXPORT_FOLDER_ID] },
    supportsAllDrives: true,
    fields: 'id',
  })
  const fileId = created.data.id!
  try {
    const req = sheetRequests(tabs)
    const added = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: fileId,
      // The new file starts with "Sheet1" (sheetId 0); drop it once the tabs exist.
      requestBody: { requests: [...req.addSheets, { deleteSheet: { sheetId: 0 } }] },
    })
    const ids: Record<string, number> = {}
    for (const r of added.data.replies ?? []) {
      const p = r.addSheet?.properties
      if (p?.title != null && p.sheetId != null) ids[p.title] = p.sheetId
    }
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: fileId,
      requestBody: { valueInputOption: 'USER_ENTERED', data: req.values },
    })
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: fileId, requestBody: { requests: req.format(ids) } })
    return { fileId, url: `https://docs.google.com/spreadsheets/d/${fileId}/edit` }
  } catch (e) {
    await trashFile(auth, fileId)
    throw e
  }
}
