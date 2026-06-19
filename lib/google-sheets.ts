import { google } from 'googleapis'

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID!
const YTB_SHEET = 'ytb_uploaded'

// Column order: fileId, time, status, fileName, youtubeId, game title, pic, duration
export const YTB_COLUMNS = ['fileId', 'time', 'status', 'fileName', 'youtubeId', 'gameTitle', 'pic', 'duration'] as const
export type YtbColumn = typeof YTB_COLUMNS[number]

export interface YtbRow {
  row_index: number  // 1-based sheet row (2 = first data row)
  fileId: string
  time: string
  status: string
  fileName: string
  youtubeId: string
  gameTitle: string
  pic: string
  duration: string
}

function getAuthClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  )
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
  return auth
}

export async function readYtbUploaded(): Promise<YtbRow[]> {
  const auth = getAuthClient()
  const sheets = google.sheets({ version: 'v4', auth })
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${YTB_SHEET}!A:H`,
  })
  const rows = res.data.values ?? []
  // Skip header row (index 0), data starts at index 1 → sheet row 2
  return rows.slice(1).map((row, i) => ({
    row_index: i + 2,
    fileId:    row[0] ?? '',
    time:      row[1] ?? '',
    status:    row[2] ?? '',
    fileName:  row[3] ?? '',
    youtubeId: row[4] ?? '',
    gameTitle: row[5] ?? '',
    pic:       row[6] ?? '',
    duration:  row[7] ?? '',
  })).filter(r => r.fileId || r.fileName)  // skip fully empty rows
}

// Column letter map — only update the exact cells changed, never touch array-formula columns
const COLUMN_LETTER: Record<YtbColumn, string> = {
  fileId:    'A',
  time:      'B',
  status:    'C',
  fileName:  'D',
  youtubeId: 'E',
  gameTitle: 'F',
  pic:       'G',
  duration:  'H',
}

export async function updateYtbRow(rowIndex: number, updates: Partial<Record<YtbColumn, string>>) {
  const entries = Object.entries(updates).filter(([field]) => COLUMN_LETTER[field as YtbColumn])
  if (entries.length === 0) return

  const auth = getAuthClient()
  const sheets = google.sheets({ version: 'v4', auth })

  // One batchUpdate call — one range per changed cell, leaves everything else untouched
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: entries.map(([field, value]) => ({
        range: `${YTB_SHEET}!${COLUMN_LETTER[field as YtbColumn]}${rowIndex}`,
        values: [[value]],
      })),
    },
  })
}

export async function appendYtbRow(row: Omit<YtbRow, 'row_index'>) {
  const auth = getAuthClient()
  const sheets = google.sheets({ version: 'v4', auth })
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${YTB_SHEET}!A:H`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[row.fileId, row.time, row.status, row.fileName, row.youtubeId, row.gameTitle, row.pic, row.duration]] },
  })
}

// ── Realtime status tab ──────────────────────────────────────────────────────

const REALTIME_SHEET = 'realtime'

export interface RealtimeRow { workflow: string; status: string }

export async function readRealtimeStatus(): Promise<RealtimeRow[]> {
  const auth = getAuthClient()
  const sheets = google.sheets({ version: 'v4', auth })
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${REALTIME_SHEET}!A:B`,
  })
  const rows = res.data.values ?? []
  return rows.slice(1).map(row => ({
    workflow: row[0] ?? '',
    status:   row[1] ?? 'idle',
  })).filter(r => r.workflow)
}

// ── Flow log tab ──────────────────────────────────────────────────────────────

const FLOW_LOG_SHEET = 'flow_log'

export interface FlowLogRow { date: string; name: string; status: string; note: string; sheet_id?: string }

export async function readFlowLog(limit = 50): Promise<FlowLogRow[]> {
  const auth = getAuthClient()
  const sheets = google.sheets({ version: 'v4', auth })
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${FLOW_LOG_SHEET}!A:E`,
  })
  const rows = res.data.values ?? []
  return rows.slice(1)
    .reverse()
    .slice(0, limit)
    .map(row => ({
      date:     row[0] ?? '',
      name:     row[1] ?? '',
      status:   row[2] ?? '',
      note:     row[3] ?? '',
      sheet_id: row[4] ?? '',
    }))
    .filter(r => r.date || r.name)
}

export async function appendFlowLog(row: FlowLogRow) {
  const auth = getAuthClient()
  const sheets = google.sheets({ version: 'v4', auth })
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${FLOW_LOG_SHEET}!A:E`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[row.date, row.name, row.status, row.note, row.sheet_id ?? '']] },
  })
}

// ── Routing tab ──────────────────────────────────────────────────────────────

const ROUTING_SHEET = 'routing'

export async function readRoutingBlocking(): Promise<string> {
  const auth = getAuthClient()
  const sheets = google.sheets({ version: 'v4', auth })
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${ROUTING_SHEET}!A1:B2`,
  })
  const rows = res.data.values ?? []
  // Find the "blocking" header in row 1, read value from row 2
  const headers = (rows[0] ?? []).map((h: string) => h.toLowerCase().trim())
  const idx = headers.indexOf('blocking')
  if (idx === -1) return 'no'
  return (rows[1]?.[idx] ?? 'no').toString().toLowerCase().trim()
}

export async function updateRoutingBlocking(value: 'yes' | 'no'): Promise<void> {
  const auth = getAuthClient()
  const sheets = google.sheets({ version: 'v4', auth })
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${ROUTING_SHEET}!A1:Z1`,
  })
  const headers = (res.data.values?.[0] ?? []).map((h: string) => h.toLowerCase().trim())
  const idx = headers.indexOf('blocking')
  if (idx === -1) throw new Error('blocking column not found in routing sheet')
  const colLetter = String.fromCharCode(65 + idx)
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${ROUTING_SHEET}!${colLetter}2`,
    valueInputOption: 'RAW',
    requestBody: { values: [[value]] },
  })
}

// ── Handover Puzzle tab ──────────────────────────────────────────────────────

const HANDOVER_PUZZLE_SHEET = 'handover_puzzle'

// Column order: Date, Evaluator Name, Start Date, End Date, Status
export const HANDOVER_PUZZLE_COLUMNS = ['date', 'evaluatorName', 'startDate', 'endDate', 'status'] as const
export type HandoverPuzzleColumn = typeof HANDOVER_PUZZLE_COLUMNS[number]

export interface HandoverPuzzleRow {
  row_index: number
  date: string
  evaluatorName: string
  startDate: string
  endDate: string
  status: string
}

export async function readHandoverPuzzle(): Promise<HandoverPuzzleRow[]> {
  const auth = getAuthClient()
  const sheets = google.sheets({ version: 'v4', auth })
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${HANDOVER_PUZZLE_SHEET}!A:E`,
  })
  const rows = res.data.values ?? []
  return rows.slice(1).map((row, i) => ({
    row_index: i + 2,
    date: row[0] ?? '',
    evaluatorName: row[1] ?? '',
    startDate: row[2] ?? '',
    endDate: row[3] ?? '',
    status: row[4] ?? '',
  })).filter(r => r.evaluatorName)
}

export async function appendHandoverPuzzle(row: Omit<HandoverPuzzleRow, 'row_index'>) {
  const auth = getAuthClient()
  const sheets = google.sheets({ version: 'v4', auth })
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${HANDOVER_PUZZLE_SHEET}!A:E`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[row.date, row.evaluatorName, row.startDate, row.endDate, row.status]] },
  })
}

export async function updateHandoverPuzzleStatus(rowIndex: number, status: string) {
  const auth = getAuthClient()
  const sheets = google.sheets({ version: 'v4', auth })
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${HANDOVER_PUZZLE_SHEET}!E${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[status]] },
  })
}

// ── Handover Logging tab (sheet: Handover Game List Request) ─────────────────

const HANDOVER_LOG_SPREADSHEET_ID = '1kR6I3DnYCn67GUqZv0ms6cksUnRTHEBQniVjOuoEqlo'
const HANDOVER_LOG_SHEET = 'Logging'

// Columns: Date | Evaluator Name | Start Date | End Date | Sheet Type | Status
export interface HandoverLogRow {
  row_index: number
  date: string
  evaluatorName: string
  startDate: string
  endDate: string
  sheetType: string
  status: string
}

export async function readHandoverLog(): Promise<HandoverLogRow[]> {
  const auth = getAuthClient()
  const sheets = google.sheets({ version: 'v4', auth })
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: HANDOVER_LOG_SPREADSHEET_ID,
    range: `${HANDOVER_LOG_SHEET}!A:F`,
  })
  const rows = res.data.values ?? []
  return rows.slice(1).map((row, i) => ({
    row_index: i + 2,
    date:          row[0] ?? '',
    evaluatorName: row[1] ?? '',
    startDate:     row[2] ?? '',
    endDate:       row[3] ?? '',
    sheetType:     row[4] ?? '',
    status:        row[5] ?? '',
  })).filter(r => r.evaluatorName)
}

export async function appendHandoverLog(row: Omit<HandoverLogRow, 'row_index'>) {
  const auth = getAuthClient()
  const sheets = google.sheets({ version: 'v4', auth })
  await sheets.spreadsheets.values.append({
    spreadsheetId: HANDOVER_LOG_SPREADSHEET_ID,
    range: `${HANDOVER_LOG_SHEET}!A:F`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[row.date, row.evaluatorName, row.startDate, row.endDate, row.sheetType, row.status]] },
  })
}

export async function updateHandoverLogStatus(rowIndex: number, status: string) {
  const auth = getAuthClient()
  const sheets = google.sheets({ version: 'v4', auth })
  await sheets.spreadsheets.values.update({
    spreadsheetId: HANDOVER_LOG_SPREADSHEET_ID,
    range: `${HANDOVER_LOG_SHEET}!F${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[status]] },
  })
}

// ── Evaluator List tab (shared spreadsheet with Handover Log) ────────────────
// The Team "Initial Evaluator" data lives here. Reads still flow through the
// WEBHOOK_TEAM_INITIAL_GET n8n webhook; the Weight cell is written directly.
const EVALUATOR_LIST_SPREADSHEET_ID = process.env.EVALUATOR_LIST_SPREADSHEET_ID || HANDOVER_LOG_SPREADSHEET_ID
const EVALUATOR_LIST_SHEET = process.env.EVALUATOR_LIST_SHEET_NAME || 'Evaluator List'

// 0-based column index → A1 letter (handles columns past Z).
function columnLetter(index: number): string {
  let n = index, letter = ''
  do { letter = String.fromCharCode(65 + (n % 26)) + letter; n = Math.floor(n / 26) - 1 } while (n >= 0)
  return letter
}

// Write the Weight cell for one Evaluator List row. `rowNumber` is the 1-based
// sheet row (header = 1), matching the row_number the GET webhook returns.
export async function updateEvaluatorWeight(rowNumber: number, weight: number): Promise<void> {
  const auth = getAuthClient()
  const sheets = google.sheets({ version: 'v4', auth })
  const head = await sheets.spreadsheets.values.get({
    spreadsheetId: EVALUATOR_LIST_SPREADSHEET_ID,
    range: `${EVALUATOR_LIST_SHEET}!1:1`,
  })
  const headers = (head.data.values?.[0] ?? []).map((h: string) => String(h).toLowerCase().trim())
  const idx = headers.indexOf('weight')
  if (idx === -1) throw new Error('Weight column not found in Evaluator List sheet')
  await sheets.spreadsheets.values.update({
    spreadsheetId: EVALUATOR_LIST_SPREADSHEET_ID,
    range: `${EVALUATOR_LIST_SHEET}!${columnLetter(idx)}${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[weight]] },
  })
}

export async function deleteYtbRow(rowIndex: number) {
  const auth = getAuthClient()
  const sheets = google.sheets({ version: 'v4', auth })
  // Get sheet gid for batchUpdate
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID })
  const sheet = meta.data.sheets?.find(s => s.properties?.title === YTB_SHEET)
  const sheetId = sheet?.properties?.sheetId ?? 0
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex },
        },
      }],
    },
  })
}
