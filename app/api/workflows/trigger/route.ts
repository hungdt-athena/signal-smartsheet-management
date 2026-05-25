/**
 * @jest-environment node
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

function getWebhookMap(): Record<string, string | undefined> {
  return {
    pull_ios:          process.env.WEBHOOK_PULL_IOS,
    pull_android:      process.env.WEBHOOK_PULL_ANDROID,
    push_smartsheet:   process.env.WEBHOOK_PUSH_SMARTSHEET,
    assign_evaluator:  process.env.WEBHOOK_ASSIGN_EVALUATOR,
    assign_initial:    process.env.WEBHOOK_ASSIGN_INITIAL,
    clean_links:       process.env.WEBHOOK_CLEAN_LINKS,
    upload_ytb:        process.env.WEBHOOK_YTB_TRIGGER,
    delete_bypass:     process.env.WEBHOOK_DELETE_BYPASS,
    delete_blank:      process.env.WEBHOOK_DELETE_BLANK,
    append_sheet:      process.env.WEBHOOK_APPEND_SHEET,
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireRole('admin')
  if (guard) return guard

  const session = process.env.SKIP_AUTH === 'true' ? null : await getServerSession(authOptions)
  const triggeredBy = session?.user?.email ?? 'dev'

  const { workflow, sheet_type } = await req.json()
  const webhookUrl = getWebhookMap()[workflow]

  if (!webhookUrl) {
    return NextResponse.json({ error: `Unknown workflow: ${workflow}` }, { status: 400 })
  }

  const triggeredAt = new Date().toISOString()

  // Insert running row before calling n8n
  await sql`
    INSERT INTO ops_logs (workflow_name, triggered_by, status, created_at)
    VALUES (${workflow}, ${triggeredBy}, 'running', ${triggeredAt}::timestamptz)
  `

  // Fire-and-forget: call n8n webhook
  fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      triggered_by: triggeredBy,
      ...(sheet_type ? { sheet_type } : {}),
    }),
  }).catch(console.error)

  return NextResponse.json({ triggered_at: triggeredAt })
}
