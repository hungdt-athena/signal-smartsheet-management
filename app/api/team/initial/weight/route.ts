// app/api/team/initial/weight/route.ts — writes the Weight cell straight to the
// Evaluator List sheet (no n8n webhook); reads still come via WEBHOOK_TEAM_INITIAL_GET.
import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { isWeight } from '@/lib/buckets'
import { updateEvaluatorWeight } from '@/lib/google-sheets'

export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  const body = await req.json()
  const rowNumber = Number(body?.row_number)
  if (!rowNumber) return NextResponse.json({ error: 'row_number is required' }, { status: 400 })
  if (!isWeight(body?.weight)) return NextResponse.json({ error: 'weight must be 30/50/70/100' }, { status: 400 })

  try {
    await updateEvaluatorWeight(rowNumber, body.weight)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('POST /api/team/initial/weight error:', err)
    return NextResponse.json({ error: 'Failed to update weight in sheet' }, { status: 502 })
  }
}
