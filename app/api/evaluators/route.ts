import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (session.user.role !== 'manager') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const webhookUrl = process.env.WEBHOOK_GET_EVALUATORS
  if (!webhookUrl) return NextResponse.json({ error: 'Evaluator webhook not configured' }, { status: 500 })

  const n8nRes = await fetch(webhookUrl)
  if (!n8nRes.ok) return NextResponse.json({ error: 'Failed to fetch evaluator list' }, { status: 502 })
  const evaluators: { name: string; email: string; is_available: boolean }[] = await n8nRes.json()

  type StatRow = { evaluator_name: string; games_assigned: number; games_evaluated: number }
  const stats = await sql`
    SELECT evaluator_name, games_assigned, games_evaluated
    FROM daily_stats
    WHERE stat_date = CURRENT_DATE AND evaluator_name IS NOT NULL
  ` as StatRow[]

  const statsMap = Object.fromEntries(stats.map((s) => [s.evaluator_name, s]))

  const merged = evaluators.map(ev => ({
    ...ev,
    games_assigned: statsMap[ev.name]?.games_assigned ?? 0,
    games_evaluated: statsMap[ev.name]?.games_evaluated ?? 0,
  }))

  return NextResponse.json(merged)
}
