#!/usr/bin/env node
// Backfill the gameplay brief (initial_gameplay / initial_game_over / initial_level_complete)
// from the P-IV tab of the "pj202 - reports raw data" sheet (core_rules, game_over,
// level_complete), and create the P-IV games that never reached this database.
//
// A game is only filled when ALL THREE parts are in the sheet: a half-filled brief would leave
// the game blocked on its next Save (it stops being legacy once Gameplay is set). Games that
// cannot be filled are listed in the `backfill_remaining` tab with the reason and what to do.
//
// Existing rows (UPDATE): only when the three DB parts are empty and the game is List_Idea.
//   initial_note, updated_by, updated_at and evaluate_date are never touched.
// Existing rows that are NOT List_Idea (Bypass, Playtest & Bypass, ...) (`--convert`): the sheet says the
//   game is Priority IV, so the row is re-labelled the same way an INSERT would be: List_Idea ->
//   Priority IV (final VinhTD), initial_evaluator pj202-backfill, batch/dates of the report week,
//   record_bucket 'none', and final_note "previous <conclusion> by <evaluator>". initial_note is kept.
//   The previous values of every touched column are saved to a JSON file for undo.
// Missing games (INSERT, `--create-missing`): the game must exist in game_info (all 563 do).
//   initial_evaluator pj202-backfill (a system label, excluded from every report),
//   List_Idea -> Priority IV (final evaluator VinhTD), batch = the report's week,
//   evaluate/assign dates inside that week, record_bucket 'none' so Record ignores them.
//   Undo: DELETE FROM game_evaluations WHERE initial_evaluator = 'pj202-backfill'.
//
// Usage:
//   node scripts/backfill-gameplay-from-report.mjs                    # dry run, rewrites the remaining tab
//   node scripts/backfill-gameplay-from-report.mjs --create-missing   # INSERT the missing games
//   node scripts/backfill-gameplay-from-report.mjs --apply            # UPDATE the existing games
//   node scripts/backfill-gameplay-from-report.mjs --convert          # re-label the non-List_Idea games
import fs from 'node:fs'
import { google } from 'googleapis'
import postgres from 'postgres'

const apply = process.argv.includes('--apply')
const create = process.argv.includes('--create-missing')
const convert = process.argv.includes('--convert')
const SHEET_ID = '1tODTnBXPt28Mi3grEyWnzcMOlMn0-ed2MeW3WBvYj78'
const TAB_REMAINING = 'backfill_remaining'
const BACKFILL_EVALUATOR = 'pj202-backfill'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

if (fs.existsSync('.env.local')) {
  for (const l of fs.readFileSync('.env.local', 'utf8').split('\n')) {
    const m = l.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}
const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET)
auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
const sheets = google.sheets({ version: 'v4', auth })
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', connect_timeout: 30 })

const t = (v) => (v ?? '').toString().trim()

// The team's week rule: a week belongs to the month of its LAST day (Sunday), and W1 is the
// first such week. Returns the Monday of that week as a UTC Date plus the batch label.
function weekOf(reportId) {
  const [y, m, w] = reportId.match(/^(\d{4})-(\d{2})-W(\d)/).slice(1).map(Number)
  const mondays = []
  for (let d = new Date(Date.UTC(y, m - 1, 1) - 6 * 864e5); mondays.length < 6; d = new Date(d.getTime() + 864e5)) {
    if (d.getUTCDay() !== 1) continue
    const sunday = new Date(d.getTime() + 6 * 864e5)
    if (sunday.getUTCMonth() === m - 1 && sunday.getUTCFullYear() === y) mondays.push(d)
    if (sunday.getUTCMonth() > m - 1 || sunday.getUTCFullYear() > y) break
  }
  const monday = mondays[w - 1]
  if (!monday) throw new Error(`no week ${w} in ${y}-${m}`)
  return { monday, label: `W${w} ${MONTHS[m - 1]}, ${y}` }
}
const ymd = (d) => d.toISOString().slice(0, 10)
const at = (monday, plusDays) => `${ymd(new Date(monday.getTime() + plusDays * 864e5))}T12:00:00+07:00`

const compose = (gp, go, lc) => `Gameplay: ${gp}\nGame over: ${go}\nLevel complete: ${lc}`

// The slides were parsed by section heading, so a part the author wrote under the wrong heading
// lands in the wrong cell. Two shapes are recoverable without guessing, and only into a blank cell:
//   1. the game-over / level-complete sentence is the tail of core_rules ("The game ends when ...")
//   2. the level-complete sentence is glued to the end of game_over ("... The level is complete ...")
// A sentence is moved (removed from where it was found), never copied. Anything looser than these
// patterns (e.g. "The first player to reach 15 points is the winner") stays for a human to decide.
const GO_LINE = /^(the )?game (ends|is over)\b/i
const LC_SENTENCE = /\b(the )?(level|game|stage) is (complete|completed|cleared)\b/i
function rescue(r) {
  const moved = []
  if (r.game_over && !r.level_complete) {
    const m = r.game_over.match(/^(.*?[.!])\s+((?:the )?(?:level|game|stage) is (?:complete|completed|cleared)\b.*)$/is)
    if (m && GO_LINE.test(m[1].trim())) { r.game_over = m[1].trim(); r.level_complete = m[2].trim(); moved.push('LC<-game_over') }
  }
  const lines = r.core_rules.split('\n')
  const last = lines.length > 1 ? lines[lines.length - 1].trim() : ''
  if (last && !r.game_over && GO_LINE.test(last)) {
    r.game_over = last; lines.pop(); moved.push('GO<-core_rules')
  }
  const tail = lines.length > 1 ? lines[lines.length - 1].trim() : ''
  if (tail && !r.level_complete && LC_SENTENCE.test(tail)) {
    r.level_complete = tail; lines.pop(); moved.push('LC<-core_rules')
  }
  r.core_rules = lines.join('\n').trim()
  r.rescued = moved
  return r
}

const HOW = {
  SHEET_BLANK: 'Fill the blank cell(s) in tab P-IV (col I = game_over, col J = level_complete), then re-run the script',
  NEEDS_REVIEW: 'The parser flagged the row (reason in data_notes, usually the release date on the slide). The three brief parts are not affected: if they read right, clear needs_review (col M) in tab P-IV and re-run',
  DUPLICATE_KEY: 'Delete the wrong duplicate row in tab P-IV, re-run',
  ALREADY_FILLED_IN_DB: 'Nothing to do if the DB text is right; otherwise clear the DB parts first',
}

try {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'P-IV!A:N' })
  const [head, ...body] = res.data.values
  const rows = body.map((r, i) => rescue({ ...Object.fromEntries(head.map((k, j) => [k, t(r[j])])), sheet_row: i + 2 }))
  const idOf = (r) => r.game_key.replace(/^[a-z]+:/, '')

  const dbRows = await sql`
    SELECT game_id, initial_conclusion, final_conclusion, initial_evaluator,
           coalesce(initial_gameplay,'') AS gp, coalesce(initial_game_over,'') AS go,
           coalesce(initial_level_complete,'') AS lc
    FROM game_evaluations`
  const db = new Map(dbRows.map((r) => [r.game_id, r]))
  const info = new Map((await sql`SELECT game_id, metadata -> 'categories' AS cats FROM game_info WHERE game_id = ANY(${[...new Set(rows.map(idOf))]})`).map((r) => [r.game_id, r.cats]))

  const seen = new Map()
  for (const r of rows) seen.set(idOf(r), (seen.get(idOf(r)) ?? 0) + 1)

  const update = [] // existing rows to fill
  const insert = [] // missing games to create
  const relabel = [] // existing non-List_Idea games to re-label as pj202-backfill / Priority IV
  const remaining = []
  for (const r of rows) {
    const id = idOf(r)
    const d = db.get(id)
    if (d?.initial_evaluator === BACKFILL_EVALUATOR) continue // created by an earlier --create-missing run
    const why = []
    const blank = [['core_rules', r.core_rules], ['game_over', r.game_over], ['level_complete', r.level_complete]]
      .filter(([, v]) => !v).map(([k]) => k)
    if (seen.get(id) > 1) why.push('DUPLICATE_KEY')
    if (r.needs_review) why.push(`NEEDS_REVIEW (${r.data_notes})`)
    if (d && (d.gp || d.go || d.lc)) why.push('ALREADY_FILLED_IN_DB')
    if (blank.length) why.push(`SHEET_BLANK: ${blank.join(', ')}`)
    if (!d && !info.has(id)) why.push('NOT_IN_GAME_INFO')
    if (!why.length) {
      if (!d) insert.push(r)
      else if (d.initial_conclusion === 'List_Idea') update.push(r)
      else relabel.push(r)
      continue
    }
    remaining.push([
      id, r.game_key, r.report_id, r.game_name_raw, d ? 'in DB' : 'not in DB',
      d?.initial_conclusion ?? '', d?.final_conclusion ?? '', d?.initial_evaluator ?? '',
      why.join(' | '),
      why.map((w) => HOW[w.split(/ [(:]/)[0]] ?? w).filter((v, i, a) => a.indexOf(v) === i).join(' ; ') + (d ? '' : ' (the game will then be created)'),
      r.core_rules, r.game_over, r.level_complete, r.sheet_row,
    ])
  }
  const count = {}
  for (const m of remaining) for (const w of m[8].split(' | ')) { const k = w.split(/ [(:]/)[0]; count[k] = (count[k] ?? 0) + 1 }
  console.log(`sheet rows ${rows.length}: UPDATE-ready ${update.length}, INSERT-ready ${insert.length}, RELABEL-ready ${relabel.length}, remaining ${remaining.length}`)
  console.log('remaining by reason (a row can have several):', count)

  if (create) {
    let n = 0
    await sql.begin(async (tx) => {
      for (const r of insert) {
        const id = idOf(r)
        const { monday, label } = weekOf(r.report_id)
        const cats = info.get(id) ?? []
        const note = compose(r.core_rules, r.game_over, r.level_complete)
        const u = await tx`
          INSERT INTO game_evaluations (
            game_id, category_group, initial_evaluator, final_evaluator, assigned_date, first_assigned_date,
            initial_note, initial_conclusion, initial_gameplay, initial_game_over, initial_level_complete,
            youtube_link, genre_1, genre_2, evaluate_date, final_conclusion, final_conclusion_date,
            batch, record_bucket, updated_by, imported_at, updated_at)
          VALUES (
            ${id}, 'puzzle', ${BACKFILL_EVALUATOR}, 'VinhTD', ${ymd(monday)}, ${ymd(monday)},
            ${note}, 'List_Idea', ${r.core_rules}, ${r.game_over}, ${r.level_complete},
            ${r.video_url || null}, ${cats[0] ? String(cats[0]).slice(0, 50) : null}, ${cats[1] ? String(cats[1]).slice(0, 50) : null},
            ${at(monday, 2)}::timestamptz, 'Priority IV', ${at(monday, 3)}::timestamptz,
            ${label}, 'none', ${BACKFILL_EVALUATOR}, ${at(monday, 0)}::timestamptz, ${at(monday, 3)}::timestamptz)
          ON CONFLICT (game_id, category_group) DO NOTHING`
        if (u.count !== 1) throw new Error(`insert ${id}: expected 1 row, got ${u.count}`)
        n++
      }
    })
    console.log(`INSERTED ${n} rows as ${BACKFILL_EVALUATOR}`)
  }

  if (convert) {
    const backup = []
    await sql.begin(async (tx) => {
      for (const r of relabel) {
        const id = idOf(r)
        const d = db.get(id)
        const { monday, label } = weekOf(r.report_id)
        const [prev] = await tx`
          SELECT game_id, category_group, initial_conclusion, initial_evaluator, initial_gameplay, initial_game_over,
                 initial_level_complete, final_conclusion, final_evaluator, final_conclusion_date, final_note,
                 evaluate_date, batch, record_bucket
          FROM game_evaluations WHERE game_id = ${id}`
        const note = `previous ${d.initial_conclusion} by ${d.initial_evaluator}`
        const u = await tx`
          UPDATE game_evaluations SET
            initial_conclusion = 'List_Idea', initial_evaluator = ${BACKFILL_EVALUATOR},
            initial_gameplay = ${r.core_rules}, initial_game_over = ${r.game_over}, initial_level_complete = ${r.level_complete},
            final_conclusion = 'Priority IV', final_evaluator = 'VinhTD', final_conclusion_date = ${at(monday, 3)}::timestamptz,
            final_note = ${note}, evaluate_date = ${at(monday, 2)}::timestamptz, batch = ${label}, record_bucket = 'none'
          WHERE game_id = ${id} AND initial_conclusion = ${d.initial_conclusion}
            AND coalesce(initial_gameplay,'') = '' AND coalesce(initial_game_over,'') = '' AND coalesce(initial_level_complete,'') = ''`
        if (u.count !== 1) throw new Error(`relabel ${id}: expected 1 row, got ${u.count}`)
        backup.push(prev)
      }
    })
    const file = `backfill-relabel-undo-${new Date().toISOString().slice(0, 10)}.json`
    fs.writeFileSync(file, JSON.stringify(backup, null, 2))
    console.log(`RELABELLED ${relabel.length} rows; previous values saved to ${file}`)
  }

  if (apply) {
    await sql.begin(async (tx) => {
      for (const r of update) {
        const u = await tx`
          UPDATE game_evaluations SET initial_gameplay = ${r.core_rules}, initial_game_over = ${r.game_over}, initial_level_complete = ${r.level_complete}
          WHERE game_id = ${idOf(r)} AND coalesce(initial_gameplay,'') = '' AND coalesce(initial_game_over,'') = ''
            AND coalesce(initial_level_complete,'') = '' AND initial_conclusion = 'List_Idea'`
        if (u.count !== 1) throw new Error(`expected 1 row for ${idOf(r)}, got ${u.count}`)
      }
    })
    console.log(`UPDATED ${update.length} rows`)
  }

  // The remaining tab is always rewritten (dry run or not).
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties.title' })
  if (!meta.data.sheets.some((s) => s.properties.title === TAB_REMAINING)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB_REMAINING, gridProperties: { frozenRowCount: 1 } } } }] },
    })
  }
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${TAB_REMAINING}!A:Z` })
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID, range: `${TAB_REMAINING}!A1`, valueInputOption: 'RAW',
    requestBody: { values: [
      ['game_id', 'game_key', 'report_id', 'game_name', 'in_db', 'db_initial_conclusion', 'db_final_conclusion', 'db_initial_evaluator',
       'reason', 'how to resolve', 'sheet_core_rules / db_gameplay', 'sheet_game_over / db_game_over', 'sheet_level_complete / db_level_complete', 'p_iv_row'],
      ...remaining] },
  })
  console.log(`wrote tab ${TAB_REMAINING} (${remaining.length} rows)`)
} finally {
  await sql.end()
}
