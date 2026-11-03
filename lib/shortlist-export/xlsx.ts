// Sheet tabs -> an .xlsx file. Server only (exceljs).

import ExcelJS from 'exceljs'
import { LINK_COLUMNS, type SheetTab } from './table'

export async function buildXlsx(tabs: SheetTab[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  for (const tab of tabs) {
    const ws = wb.addWorksheet(tab.name, { views: [{ state: 'frozen', ySplit: 1 }] })
    ws.addRow(tab.header)
    ws.getRow(1).font = { bold: true }
    for (const row of tab.rows) {
      const r = ws.addRow(row.map((v, i) =>
        (LINK_COLUMNS as readonly number[]).includes(i) && v ? { text: v, hyperlink: v } : v || null))
      for (const i of LINK_COLUMNS) {
        if (row[i]) r.getCell(i + 1).font = { color: { argb: 'FF1155CC' }, underline: true }
      }
    }
    ws.columns.forEach((c, i) => { c.width = [22, 36, 28, 50, 50][i] ?? 20 })
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}
