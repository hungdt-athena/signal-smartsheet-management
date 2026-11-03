// Sheet tabs -> an .xlsx file. Server only (exceljs).

import ExcelJS from 'exceljs'
import { LINK_COLUMNS, type SheetTab } from './table'

export async function buildXlsx(tabs: SheetTab[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  for (const tab of tabs) {
    const ws = wb.addWorksheet(tab.name, { views: [{ state: 'frozen', ySplit: 1 }] })
    ws.addRow(tab.header)
    ws.getRow(1).font = { bold: true }
    ws.getRow(1).eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EBD4' } } })
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, tab.rows.length + 1), column: tab.header.length } }
    for (const row of tab.rows) {
      const r = ws.addRow(row.map((v, i) =>
        (LINK_COLUMNS as readonly number[]).includes(i) && v ? { text: v, hyperlink: v } : v || null))
      for (const i of LINK_COLUMNS) {
        if (row[i]) r.getCell(i + 1).font = { color: { argb: 'FF1155CC' }, underline: true }
      }
    }
    ws.columns.forEach((c, i) => { c.width = [34, 36, 26, 42, 42][i] ?? 20 })
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}
