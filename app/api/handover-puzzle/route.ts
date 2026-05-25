import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { readHandoverLog, appendHandoverLog, updateHandoverLogStatus, appendFlowLog } from '@/lib/google-sheets'

export const dynamic = 'force-dynamic'

export async function GET() {
  const guard = await requireAuth()
  if (guard) return guard

  try {
    const rows = await readHandoverLog()
    return NextResponse.json(rows.reverse(), { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('Failed to read Logging sheet:', err)
    return NextResponse.json({ error: 'Failed to read handover data' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  const { evaluator_name, start_date, end_date, sheet_type } = await req.json()
  if (!evaluator_name || !start_date || !end_date || !sheet_type) {
    return NextResponse.json({ error: 'evaluator_name, start_date, end_date, and sheet_type are required' }, { status: 400 })
  }

  const now = new Date()
  const dateStr = now.toISOString().split('T')[0]
  const timeStr = now.toLocaleString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' })

  // 1. Log to Logging tab of Handover sheet with "running" status
  let rowIndex: number | null = null
  try {
    await appendHandoverLog({
      date: dateStr,
      evaluatorName: evaluator_name,
      startDate: start_date,
      endDate: end_date,
      sheetType: sheet_type,
      status: 'running',
    })
    const rows = await readHandoverLog()
    const last = rows[rows.length - 1]
    if (last) rowIndex = last.row_index
  } catch (err) {
    console.error('Failed to log handover:', err)
    return NextResponse.json({ error: 'Failed to log handover' }, { status: 500 })
  }

  // 2. Auto-toggle "Today Available" to No if today is within the range
  const today = new Date(dateStr).getTime()
  const startMs = new Date(start_date).getTime()
  const endMs = new Date(end_date).getTime()

  if (today >= startMs && today <= endMs) {
    const availUrl = process.env.WEBHOOK_TEAM_INITIAL_AVAILABILITY
    const getUrl = process.env.WEBHOOK_TEAM_INITIAL_GET
    if (availUrl && getUrl) {
      try {
        const listRes = await fetch(getUrl, { cache: 'no-store' })
        if (listRes.ok) {
          const evaluators = await listRes.json()
          const match = evaluators.find((ev: { 'Evaluator Name'?: string }) =>
            ev['Evaluator Name']?.trim() === evaluator_name.trim()
          )
          if (match) {
            await fetch(availUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ row_number: match.row_number, today_available: 'No' }),
            })
          }
        }
      } catch (err) {
        console.error('Failed to toggle availability:', err)
      }
    }
  }

  // 3. Trigger n8n handover-reassign webhook
  let finalStatus = 'success'
  const webhookUrl = process.env.WEBHOOK_HANDOVER
  if (webhookUrl) {
    try {
      const whRes = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evaluator_name, start_date, end_date, sheet_type }),
      })
      finalStatus = whRes.ok ? 'success' : 'error'
    } catch (err) {
      console.error('Failed to trigger handover webhook:', err)
      finalStatus = 'error'
    }
  }

  // 4. Update status in handover_puzzle sheet
  if (rowIndex) {
    try { await updateHandoverLogStatus(rowIndex, finalStatus) } catch { /* best effort */ }
  }

  // 5. Log final status to flow_log
  try {
    await appendFlowLog({
      date: `${dateStr} ${timeStr}`,
      name: 'Handover Puzzle',
      status: finalStatus,
      note: `${evaluator_name} | ${start_date} to ${end_date}`,
    })
  } catch { /* best effort */ }

  return NextResponse.json({ ok: true, date: dateStr, status: finalStatus })
}
