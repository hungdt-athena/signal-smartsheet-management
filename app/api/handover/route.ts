import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { readHandoverLog, appendFlowLog } from '@/lib/google-sheets'

export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (session.user.role !== 'evaluator') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const rows = await readHandoverLog()
    const filtered = rows
      .filter(r => r.evaluatorName.toLowerCase() === (session.user.name || '').toLowerCase())
      .reverse()
      .slice(0, 20)
      .map(r => ({
        id: r.row_index,
        status: r.status,
        summary: null,
        created_at: r.date,
      }))
    return NextResponse.json(filtered)
  } catch {
    return NextResponse.json([])
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (session.user.role !== 'evaluator') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { start_date, end_date } = await req.json()
  if (!start_date || !end_date) {
    return NextResponse.json({ error: 'start_date and end_date are required' }, { status: 400 })
  }

  const webhookUrl = process.env.WEBHOOK_HANDOVER
  if (webhookUrl) {
    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        evaluator_name: session.user.name,
        start_date,
        end_date,
        triggered_by: session.user.email,
      }),
    }).catch(console.error)
  }

  const now = new Date()
  const dateStr = now.toISOString().split('T')[0]
  const timeStr = now.toLocaleString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' })
  try {
    await appendFlowLog({
      date: `${dateStr} ${timeStr}`,
      name: 'Handover',
      status: 'success',
      note: `${session.user.name} | ${start_date} to ${end_date}`,
    })
  } catch { /* best effort */ }

  return NextResponse.json({ triggered_at: now.toISOString() })
}
