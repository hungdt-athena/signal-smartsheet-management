// One-off (THROWAWAY): import per-member weekly feedback from the legacy Google
// Sheet into the weekly_feedback_import STAGING table. Review + approve happens
// in the app's Weekly Feedback > Import tab; approving copies into weekly_feedback.
// Delete this script + the staging table once the sync is done.
//
// Each sheet tab is auto-resolved to the canonical evaluator string from
// game_evaluations via a case/space-insensitive match, so no manual mapping is
// needed for tabs that match. config/evaluator-map.json is OPTIONAL and only
// used to override tabs the dry-run reports under unresolvedTab / ambiguousTab.
//
// Run (dry run first — review the report's `resolved` map before writing):
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

// Convenience: load .env.local (KEY=VALUE) when run outside Next, so DATABASE_URL
// (and optionally SPREADSHEET_ID / GOOGLE_APPLICATION_CREDENTIALS) come from there.
// Anything already in the environment (inline / exported) wins.
try {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* no .env.local — rely on real env */ }

const DRY = process.argv.includes('--dry-run')
const SPREADSHEET_ID = process.env.SPREADSHEET_ID
const MAP_PATH = process.env.EVALUATOR_MAP || './config/evaluator-map.json'
if (!SPREADSHEET_ID) { console.error('SPREADSHEET_ID is required'); process.exit(1) }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1) }

// Optional explicit overrides (tab -> exact DB evaluator string). The script
// auto-resolves each tab to the canonical evaluator by normalized match against
// the real evaluator list, so this file is only needed for tabs that don't
// auto-resolve (or that collide). A missing file is fine.
let overrideMap: Record<string, string> = {}
try { overrideMap = JSON.parse(readFileSync(MAP_PATH, 'utf8')) } catch { /* no overrides */ }

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' })

// Case/space-insensitive key so a tab like "HuyDD" matches a stored "Huy DD".
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

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

// The canonical evaluator strings the app uses everywhere else come from
// game_evaluations (same source as the Weekly Feedback manager picker). Build a
// normalized-key -> canonical-string index so a tab resolves to the EXACT stored
// string regardless of case/spacing. Keys that map to two different canonical
// strings are flagged as collisions (must be disambiguated via the override map).
async function loadEvaluatorIndex() {
  const rows = await sql<{ name: string }[]>`
    SELECT DISTINCT name FROM (
      SELECT initial_evaluator AS name FROM game_evaluations WHERE initial_evaluator IS NOT NULL
      UNION
      SELECT final_evaluator   AS name FROM game_evaluations WHERE final_evaluator   IS NOT NULL
    ) e`
  const index = new Map<string, string>()
  const collisions = new Set<string>()
  for (const { name } of rows) {
    const k = norm(name)
    if (index.has(k) && index.get(k) !== name) collisions.add(k)
    else if (!index.has(k)) index.set(k, name)
  }
  return { index, collisions }
}

// Walk a feedback Tiptap doc; upgrade each hyperlinked text node that matches a
// DB game into a gameMention node, leaving non-matches as plain links.
async function upgradeFeedbackLinks(doc: any): Promise<{ doc: any; mentions: number }> {
  let mentions = 0
  async function maybeMention(child: any) {
    if (child?.type !== 'text' || !Array.isArray(child.marks)) return null
    const link = child.marks.find((m: any) => m?.type === 'link')?.attrs?.href
    if (!link) return null
    const parsed = parseStoreLink(link)
    if (!parsed) return null
    const rows = await sql`
      SELECT game_id, title, app_link, icon_url FROM game_info
      WHERE (game_id = ${parsed.storeId} OR app_link ILIKE ${'%' + parsed.storeId + '%'}) AND is_active = true
      LIMIT 1`
    if (!rows[0]) return null
    return { type: 'gameMention', attrs: { gameId: rows[0].game_id, title: rows[0].title, href: rows[0].app_link, icon: rows[0].icon_url } }
  }
  async function walk(node: any): Promise<any> {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node.content)) {
      const out: any[] = []
      for (const child of node.content) {
        const mention = await maybeMention(child)
        if (mention) { out.push(mention); mentions++; continue }
        out.push(await walk(child))
      }
      return { ...node, content: out }
    }
    return node
  }
  return { doc: await walk(doc), mentions }
}

async function main() {
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] })
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() as any })
  const res = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    includeGridData: true,
    fields: 'sheets(properties.title,data.rowData.values(formattedValue,hyperlink,textFormatRuns(startIndex,format(bold,link/uri))))',
  })

  const { index, collisions } = await loadEvaluatorIndex()
  const report = { imported: 0, sections: 0, resolved: {} as Record<string, string>, unresolvedTab: [] as string[], ambiguousTab: [] as string[], skippedLabel: [] as string[], matched: 0, manual: 0, feedbackMentions: 0 }

  for (const sheet of res.data.sheets ?? []) {
    const tab = sheet.properties?.title ?? ''
    // Resolve tab -> canonical evaluator: explicit override wins, else normalized
    // auto-match against the real evaluator list. Never guess on a miss.
    const override = overrideMap[tab]
    const explicit = override && !override.startsWith('REPLACE_') ? override : null
    const k = norm(tab)
    if (!explicit && collisions.has(k)) { report.ambiguousTab.push(tab); continue }
    const evaluator = explicit ?? index.get(k) ?? null
    if (!evaluator) { report.unresolvedTab.push(tab); continue }
    report.resolved[tab] = evaluator

    // Column A (week label) AND column B (feedback) are merged cells spanning
    // several rows; the API returns the value only on the top row, blanks below.
    //   • Carry the last valid week label forward → one record per (batch, evaluator).
    //   • A row WITH feedback starts a new SECTION. Rows below it with empty
    //     feedback are continuations: their game-alike links append to that
    //     section. So a week with N feedback blocks yields N sections, each
    //     gathering the games from all the rows its feedback spans.
    const groups = new Map<string, any[]>() // batch -> sections[]
    let currentBatch: string | null = null
    let currentSection: { id: string; feedback: unknown; alikes: any[] } | null = null
    const rows = sheet.data?.[0]?.rowData ?? []
    for (let r = 1; r < rows.length; r++) { // row 0 is the header
      const cells = rows[r]?.values ?? []
      const colA = (cells[0]?.formattedValue ?? '').trim()
      if (colA) {
        if (isValidWeekLabel(colA)) { currentBatch = colA; if (!groups.has(colA)) groups.set(colA, []); currentSection = null }
        else { report.skippedLabel.push(`${tab}: "${colA}"`); currentBatch = null; currentSection = null; continue } // banner/divider
      }
      if (!currentBatch) continue // orphan row with no week label above it

      const fbCell = toRichCell(cells[1])
      const alikeCell = toRichCell(cells[2])
      const hasFb = !!fbCell.text.trim()
      if (!hasFb && !alikeCell.text.trim()) continue // fully blank row

      // New section when this row carries feedback (or it's the batch's first row).
      if (hasFb || !currentSection) {
        const { doc, mentions } = await upgradeFeedbackLinks(parseFeedbackDoc(fbCell))
        report.feedbackMentions += mentions
        currentSection = { id: randomUUID(), feedback: doc, alikes: [] }
        groups.get(currentBatch)!.push(currentSection)
        report.sections++
      }
      const sec = currentSection!

      // Append this row's game-alike blocks. Merge an unnamed (flat) block into a
      // trailing unnamed block so per-row links collapse into one group; named
      // (bold-header) blocks stay separate.
      for (const b of parseAlikeCell(alikeCell)) {
        const games = []
        for (const rg of b.games) {
          const m = await matchGame(rg)
          games.push(m)
          if (m.manual) report.manual++; else report.matched++
        }
        const last = sec.alikes[sec.alikes.length - 1]
        if (!b.name && last && !last.name) last.games.push(...games)
        else sec.alikes.push({ name: b.name, games })
      }
    }

    // One staging record per (batch, evaluator), pending review. Re-running resets
    // to pending so a fresh pull is re-reviewed.
    for (const [batch, sections] of Array.from(groups)) {
      if (!sections.length) continue
      if (!DRY) {
        await sql`
          INSERT INTO weekly_feedback_import (batch, evaluator, sections, status, source_tab, updated_at)
          VALUES (${batch}, ${evaluator}, ${sql.json(sections as any)}, 'pending', ${tab}, NOW())
          ON CONFLICT (batch, evaluator)
          DO UPDATE SET sections = EXCLUDED.sections, status = 'pending', source_tab = EXCLUDED.source_tab, updated_at = NOW()`
      }
      report.imported++
    }
  }

  console.log(`${DRY ? '[DRY RUN] ' : ''}import report (-> weekly_feedback_import staging):`)
  console.log(JSON.stringify(report, null, 2))
  await sql.end()
}

main().catch(e => { console.error(e); process.exit(1) })
