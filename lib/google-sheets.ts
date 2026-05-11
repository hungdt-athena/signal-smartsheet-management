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

export interface FlowLogRow { date: string; name: string; status: string; note: string }

export async function readFlowLog(limit = 50): Promise<FlowLogRow[]> {
  const auth = getAuthClient()
  const sheets = google.sheets({ version: 'v4', auth })
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${FLOW_LOG_SHEET}!A:D`,
  })
  const rows = res.data.values ?? []
  return rows.slice(1)
    .reverse()
    .slice(0, limit)
    .map(row => ({
      date:   row[0] ?? '',
      name:   row[1] ?? '',
      status: row[2] ?? '',
      note:   row[3] ?? '',
    }))
    .filter(r => r.date || r.name)
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
