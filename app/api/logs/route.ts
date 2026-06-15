import { NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'

// Vestigial stub from the original Operations dashboard (TriggerButton, now
// removed). Real logging lives in /api/flow-logs/*. Gated to the manager tier
// to match the Operations UI it belonged to.
export async function POST() {
  const guard = await requireManager()
  if (guard) return guard
  return NextResponse.json({ ok: true })
}

export async function GET() {
  const guard = await requireManager()
  if (guard) return guard
  return NextResponse.json([])
}
