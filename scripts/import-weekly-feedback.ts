// One-off: import per-member weekly feedback from the Google Sheet into
// weekly_feedback. App is the source of truth afterward; delete this script once
// the import is accepted.
//
// Run (dry run first):
//   GOOGLE_APPLICATION_CREDENTIALS=./sa.json \
//   SPREADSHEET_ID=<id> DATABASE_URL=<url> \
//   npx tsx scripts/import-weekly-feedback.ts --dry-run
// Then drop --dry-run to write.
import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { google } from 'googleapis'
import postgres from 'postgres'
import { parseStoreLink } from '../lib/game-link'
import { isValidWeekLabel, parseFeedbackDoc, parseAlikeCell, type RichCell, type TextRun, type RawGame } from '../lib/weekly-feedback-import'

const DRY = process.argv.includes('--dry-run')
const SPREADSHEET_ID = process.env.SPREADSHEET_ID
const MAP_PATH = process.env.EVALUATOR_MAP || './config/evaluator-map.json'
if (!SPREADSHEET_ID) { console.error('SPREADSHEET_ID is required'); process.exit(1) }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1) }

const evaluatorMap: Record<string, string> = JSON.parse(readFileSync(MAP_PATH, 'utf8'))
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' })

// Google CellData → RichCell. Google omits startIndex on the first run; ensure a
// run starting at 0 exists so runAt() covers the whole string.
function toRichCell(cell: any): RichCell {
  const text: string = cell?.formattedValue ?? ''
  const cellLink: string | null = cell?.hyperlink ?? null
  const runs: TextRun[] = (cell?.textFormatRuns ?? []).map((r: any) => ({
    start: r.startIndex ?? 0,
    bold: !!r?.format?.bold,
    link: r?.format?.link?.uri ?? null,
  }))
  if (runs.length && runs[0].start !== 0) runs.unshift({ start: 0, bold: false, link: null })
  return { text, runs, cellLink }
}

async function matchGame(g: RawGame) {
  const parsed = parseStoreLink(g.app_link)
  if (parsed) {
    const rows = await sql`
      SELECT game_id, title, app_link, icon_url FROM game_info
      WHERE (game_id = ${parsed.storeId} OR app_link ILIKE ${'%' + parsed.storeId + '%'}) AND is_active = true
      LIMIT 1`
    if (rows[0]) return { game_id: rows[0].game_id, title: rows[0].title, app_link: rows[0].app_link, icon_url: rows[0].icon_url, manual: false }
  }
  return { game_id: null, title: g.title, app_link: g.app_link, icon_url: null, manual: true }
}

async function main() {
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] })
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() as any })
  const res = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    includeGridData: true,
    fields: 'sheets(properties.title,data.rowData.values(formattedValue,hyperlink,textFormatRuns(startIndex,format(bold,link/uri))))',
  })

  const report = { imported: 0, skippedTab: [] as string[], skippedLabel: [] as string[], matched: 0, manual: 0 }

  for (const sheet of res.data.sheets ?? []) {
    const tab = sheet.properties?.title ?? ''
    const evaluator = evaluatorMap[tab]
    if (!evaluator || evaluator.startsWith('REPLACE_')) { report.skippedTab.push(tab); continue }
    const rows = sheet.data?.[0]?.rowData ?? []
    for (let r = 1; r < rows.length; r++) { // row 0 is the header
      const cells = rows[r]?.values ?? []
      const label = (cells[0]?.formattedValue ?? '').trim()
      if (!label) continue
      if (!isValidWeekLabel(label)) { report.skippedLabel.push(`${tab}: "${label}"`); continue }

      const feedback = parseFeedbackDoc(cells[1]?.formattedValue ?? '')
      const rawBlocks = parseAlikeCell(toRichCell(cells[2]))
      const alikes = []
      for (const b of rawBlocks) {
        const games = []
        for (const rg of b.games) {
          const m = await matchGame(rg)
          games.push(m)
          if (m.manual) report.manual++; else report.matched++
        }
        alikes.push({ name: b.name, games })
      }
      const sections = [{ id: randomUUID(), feedback, alikes }]

      if (!DRY) {
        await sql`
          INSERT INTO weekly_feedback (batch, evaluator, sections, updated_at)
          VALUES (${label}, ${evaluator}, ${sql.json(sections as any)}, NOW())
          ON CONFLICT (batch, evaluator)
          DO UPDATE SET sections = EXCLUDED.sections, updated_at = NOW()`
      }
      report.imported++
    }
  }

  console.log(`${DRY ? '[DRY RUN] ' : ''}import report:`)
  console.log(JSON.stringify(report, null, 2))
  await sql.end()
}

main().catch(e => { console.error(e); process.exit(1) })
