import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

function verifyWebhookSecret(req: NextRequest) {
  const secret = process.env.WEBHOOK_SECRET
  return !!secret && req.headers.get('x-webhook-secret') === secret
}

export async function POST(req: NextRequest) {
  if (!verifyWebhookSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const { workflow_name, status, triggered_by, summary, error_message } = body

  if (!workflow_name || !status) {
    return NextResponse.json({ error: 'workflow_name and status are required' }, { status: 400 })
  }

  await sql`
    INSERT INTO ops_logs (workflow_name, triggered_by, status, summary, error_message)
    VALUES (${workflow_name}, ${triggered_by ?? null}, ${status}, ${summary ? JSON.stringify(summary) : null}, ${error_message ?? null})
  `

  return NextResponse.json({ ok: true })
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (session.user.role !== 'manager') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const workflow = searchParams.get('workflow')
  const since = searchParams.get('since')

  let rows
  if (workflow && since) {
    rows = await sql`
      SELECT * FROM ops_logs
      WHERE workflow_name = ${workflow} AND created_at > ${since}::timestamptz
      ORDER BY created_at DESC LIMIT 20
    `
  } else {
    rows = await sql`
      SELECT * FROM ops_logs ORDER BY created_at DESC LIMIT 20
    `
  }

  return NextResponse.json(rows)
}
