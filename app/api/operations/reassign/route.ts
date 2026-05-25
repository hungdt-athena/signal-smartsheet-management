import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { appendFlowLog } from '@/lib/google-sheets'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const guard = await requireRole('admin')
  if (guard) return guard

  const { evaluator_name, start_date, end_date, sheet_type, selected_evaluators } = await req.json()

  if (!evaluator_name || !start_date || !end_date || !sheet_type) {
    return NextResponse.json({ error: 'evaluator_name, start_date, end_date, and sheet_type are required' }, { status: 400 })
  }
  if (!Array.isArray(selected_evaluators) || selected_evaluators.length === 0) {
    return NextResponse.json({ error: 'selected_evaluators must be a non-empty array' }, { status: 400 })
  }

  const now = new Date()
  const dateStr = now.toISOString().split('T')[0]
  const timeStr = now.toLocaleString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' })
  const note = `${evaluator_name} | ${start_date} to ${end_date} | ${selected_evaluators.length} evaluators`

  // Trigger n8n handover-reassign webhook with selected_evaluators
  let finalStatus = 'success'
  const webhookUrl = process.env.WEBHOOK_HANDOVER
  if (webhookUrl) {
    try {
      const whRes = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          evaluator_name,
          start_date,
          end_date,
          sheet_type,
          selected_evaluators,
        }),
      })
      finalStatus = whRes.ok ? 'success' : 'error'
    } catch (err) {
      console.error('Failed to trigger reassign webhook:', err)
      finalStatus = 'error'
    }
  }

  // Log final status to flow_log
  try {
    await appendFlowLog({
      date: `${dateStr} ${timeStr}`,
      name: 'Re-assign',
      status: finalStatus,
      note,
    })
  } catch { /* best effort */ }

  return NextResponse.json({ ok: true, date: dateStr, status: finalStatus })
}
