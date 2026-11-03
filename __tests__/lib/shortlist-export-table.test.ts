/**
 * @jest-environment node
 */
import ExcelJS from 'exceljs'
import { buildTabs } from '@/lib/shortlist-export/table'
import { buildXlsx } from '@/lib/shortlist-export/xlsx'
import type { ExportGame } from '@/lib/shortlist-export/types'

function game(over: Partial<ExportGame> = {}): ExportGame {
  return {
    gameId: 'g1', title: 'Game 1', publisher: 'Pub', platform: 'android',
    storeUrl: 'https://play.google.com/store/apps/details?id=g1', iconUrl: null,
    releaseDate: null, conclusion: 'Insight', batch: 'W3 Oct, 2026', youtubeUrl: null,
    ...over,
  }
}

describe('buildTabs', () => {
  it('orders tabs Priority IV then Insight', () => {
    expect(buildTabs([], ['insight', 'priority_iv']).map(t => t.name)).toEqual(['Priority IV', 'Insight'])
    expect(buildTabs([], ['insight']).map(t => t.name)).toEqual(['Insight'])
  })

  it('puts the store link in the column of its platform', () => {
    const [tab] = buildTabs([
      game(),
      game({ gameId: 'g2', platform: 'ios', storeUrl: 'https://apps.apple.com/app/id2' }),
      game({ gameId: 'g3', platform: null, publisher: null }),
    ], ['insight'])
    expect(tab.header).toEqual(['id', 'title', 'publisher', 'android', 'ios'])
    expect(tab.rows[0]).toEqual(['g1', 'Game 1', 'Pub', 'https://play.google.com/store/apps/details?id=g1', ''])
    expect(tab.rows[1]).toEqual(['g2', 'Game 1', 'Pub', '', 'https://apps.apple.com/app/id2'])
    expect(tab.rows[2]).toEqual(['g3', 'Game 1', '', '', ''])
  })

  it('keeps every game in its own tab, in input order', () => {
    const tabs = buildTabs([
      game({ gameId: 'a', conclusion: 'Priority IV' }),
      game({ gameId: 'b' }),
      game({ gameId: 'c', conclusion: 'Priority IV' }),
    ], ['insight', 'priority_iv'])
    expect(tabs[0].rows.map(r => r[0])).toEqual(['a', 'c'])
    expect(tabs[1].rows.map(r => r[0])).toEqual(['b'])
  })
})

describe('buildXlsx', () => {
  it('writes a workbook with hyperlinks', async () => {
    const tabs = buildTabs([game(), game({ gameId: 'p', conclusion: 'Priority IV', platform: 'ios', storeUrl: 'https://apps.apple.com/x' })],
      ['insight', 'priority_iv'])
    const buf = await buildXlsx(tabs)
    expect(buf.length).toBeGreaterThan(0)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
    expect(wb.worksheets.map(w => w.name)).toEqual(['Priority IV', 'Insight'])
    const ins = wb.getWorksheet('Insight')!
    expect(ins.getRow(1).font?.bold ?? ins.getCell('A1').font?.bold).toBe(true)
    expect(ins.views[0].state).toBe('frozen')
    expect(ins.autoFilter).toBeTruthy()
    expect((ins.getCell('A1').fill as any)?.fgColor?.argb).toBeTruthy()
    const url = 'https://play.google.com/store/apps/details?id=g1'
    expect(ins.getCell('D2').value).toEqual({ text: url, hyperlink: url })
    expect(ins.getCell('E2').value).toBeFalsy()
    expect(wb.getWorksheet('Priority IV')!.getCell('E2').value).toEqual({ text: 'https://apps.apple.com/x', hyperlink: 'https://apps.apple.com/x' })
  })
})
