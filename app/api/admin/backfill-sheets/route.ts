import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import {
  readYtbUploaded,
  readFlowLog,
  readRealtimeStatus,
  readHandoverPuzzle,
  readHandoverLog,
  readRoutingBlocking,
} from '@/lib/google-sheets'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// One-time backfill: read every Google-Sheet / n8n-managed source and load it into
// the mirror tables created in migration 008. Idempotent — each table is cleared
// then reloaded (these tables have no other writers yet). Admin-only + destructive,
// so it is gated behind requireRole(['admin']). Remove this route after switch-over.

function parseTs(s?: string | null): string | null {
  if (!s || !String(s).trim()) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d.toISOString()
}
function parseDate(s?: string | null): string | null {
  const ts = parseTs(s)
  return ts ? ts.slice(0, 10) : null
}

// Fetch a source; on failure record the error instead of aborting the whole run.
async function load<T>(name: string, fn: () => Promise<T>, errors: Record<string, string>): Promise<T | null> {
  try {
    return await fn()
  } catch (e) {
    errors[name] = e instanceof Error ? e.message : String(e)
    return null
  }
}

interface RawInitial {
  'Evaluator Name'?: string
  row_number?: number
  'Today Available'?: string
  'Game Platform'?: string
  'Game Category'?: string
}
interface RawFinal {
  'Evaluator Name'?: string
  row_number?: number
}

async function fetchJson(url?: string): Promise<unknown[]> {
  if (!url) throw new Error('webhook url not configured')
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`webhook ${res.status}`)
  const text = await res.text()
  if (!text.trim()) return []
  return JSON.parse(text) as unknown[]
}

export async function POST(_req: NextRequest) {
  const guard = await requireRole(['admin'])
  if (guard) return guard

  const errors: Record<string, string> = {}

  // ── 1. Read all sources up front (outside the DB transaction) ──────────────
  const ytb = await load('ytb_uploaded', () => readYtbUploaded(), errors)
  const flow = await load('flow_log', () => readFlowLog(100000), errors)
  const realtime = await load('realtime', () => readRealtimeStatus(), errors)
  const hpuzzle = await load('handover_puzzle', () => readHandoverPuzzle(), errors)
  const hlog = await load('handover_log', () => readHandoverLog(), errors)
  const blocking = await load('routing', () => readRoutingBlocking(), errors)
  const initialRaw = await load('team_initial', () => fetchJson(process.env.WEBHOOK_TEAM_INITIAL_GET), errors)
  const finalRaw = await load('team_final', () => fetchJson(process.env.WEBHOOK_TEAM_FINAL_GET), errors)

  // ── 2. Transform ────────────────────────────────────────────────────────────
  const ytbRows = (ytb ?? []).map(r => ({
    file_id: r.fileId || null,
    uploaded_at: parseTs(r.time),
    status: r.status || null,
    file_name: r.fileName || null,
    youtube_id: r.youtubeId || null,
    game_title: r.gameTitle || null,
    pic: r.pic || null,
    duration: r.duration || null,
  }))

  const opRows = (flow ?? []).map(r => ({
    log_date: parseTs(r.date),
    name: r.name || null,
    status: r.status || null,
    note: r.note || null,
    sheet_id: r.sheet_id || null,
  }))

  const statusRows = (realtime ?? []).map(r => ({ workflow: r.workflow, status: r.status || 'idle' }))

  // handover: merge puzzle (sheet_type='puzzle') + log (its own sheetType), dedup by tuple
  const handoverMap = new Map<string, {
    request_date: string | null; evaluator_name: string; start_date: string | null
    end_date: string | null; sheet_type: string | null; status: string | null
  }>()
  for (const r of hpuzzle ?? []) {
    const row = { request_date: parseTs(r.date), evaluator_name: r.evaluatorName, start_date: parseDate(r.startDate), end_date: parseDate(r.endDate), sheet_type: 'puzzle', status: r.status || null }
    handoverMap.set(`${row.evaluator_name}|${row.sheet_type}|${row.start_date}|${row.end_date}`, row)
  }
  for (const r of hlog ?? []) {
    const st = (r.sheetType || '').toLowerCase() || null
    const row = { request_date: parseTs(r.date), evaluator_name: r.evaluatorName, start_date: parseDate(r.startDate), end_date: parseDate(r.endDate), sheet_type: st, status: r.status || null }
    handoverMap.set(`${row.evaluator_name}|${row.sheet_type}|${row.start_date}|${row.end_date}`, row)
  }
  const handoverRows = Array.from(handoverMap.values())

  // evaluator roster: initial + final, dedup by (list_type, name)
  const rosterMap = new Map<string, {
    list_type: string; name: string; today_available: boolean
    game_platform: string | null; game_category: string | null; sort_order: number | null
  }>()
  for (const r of (initialRaw ?? []) as RawInitial[]) {
    const name = r['Evaluator Name']?.trim()
    if (!name) continue
    rosterMap.set(`initial|${name}`, {
      list_type: 'initial', name,
      today_available: (r['Today Available'] ?? '').toLowerCase() === 'yes',
      game_platform: (r['Game Platform'] ?? '').toLowerCase() || null,
      game_category: r['Game Category'] || null,
      sort_order: r.row_number ?? null,
    })
  }
  for (const r of (finalRaw ?? []) as RawFinal[]) {
    const name = r['Evaluator Name']?.trim()
    if (!name) continue
    rosterMap.set(`final|${name}`, {
      list_type: 'final', name, today_available: true,
      game_platform: null, game_category: null, sort_order: r.row_number ?? null,
    })
  }
  const rosterRows = Array.from(rosterMap.values())

  // ── 3. Write to DB (clear + reload per table, in one transaction) ───────────
  const counts: Record<string, number> = {}
  try {
    await sql.begin(async txRaw => {
      // postgres.js TransactionSql typings omit the call signature; cast for the
      // tagged-template + bulk-insert helpers (both valid at runtime).
      const tx = txRaw as unknown as typeof sql
      if (ytb !== null) {
        await tx`DELETE FROM ytb_uploads`
        if (ytbRows.length) await tx`INSERT INTO ytb_uploads ${tx(ytbRows, 'file_id', 'uploaded_at', 'status', 'file_name', 'youtube_id', 'game_title', 'pic', 'duration')}`
        counts.ytb_uploads = ytbRows.length
      }
      if (flow !== null) {
        await tx`DELETE FROM operation_logs`
        if (opRows.length) await tx`INSERT INTO operation_logs ${tx(opRows, 'log_date', 'name', 'status', 'note', 'sheet_id')}`
        counts.operation_logs = opRows.length
      }
      if (realtime !== null) {
        await tx`DELETE FROM workflow_status`
        if (statusRows.length) await tx`INSERT INTO workflow_status ${tx(statusRows, 'workflow', 'status')}`
        counts.workflow_status = statusRows.length
      }
      if (hpuzzle !== null || hlog !== null) {
        await tx`DELETE FROM handover_requests`
        if (handoverRows.length) await tx`INSERT INTO handover_requests ${tx(handoverRows, 'request_date', 'evaluator_name', 'start_date', 'end_date', 'sheet_type', 'status')}`
        counts.handover_requests = handoverRows.length
      }
      if (blocking !== null) {
        await tx`
          INSERT INTO app_config (key, value, updated_at) VALUES ('blocking', ${blocking}, NOW())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `
        counts.app_config = 1
      }
      if (initialRaw !== null || finalRaw !== null) {
        await tx`DELETE FROM evaluator_roster`
        if (rosterRows.length) await tx`INSERT INTO evaluator_roster ${tx(rosterRows, 'list_type', 'name', 'today_available', 'game_platform', 'game_category', 'sort_order')}`
        counts.evaluator_roster = rosterRows.length
      }
    })
  } catch (e) {
    console.error('backfill-sheets DB error:', e)
    return NextResponse.json({ error: 'DB write failed', detail: e instanceof Error ? e.message : String(e), errors }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    counts,
    source_errors: errors,
    note: Object.keys(errors).length
      ? 'Some sources failed (likely n8n offline or webhook env missing); their tables were left untouched.'
      : 'All sources loaded.',
  })
}
