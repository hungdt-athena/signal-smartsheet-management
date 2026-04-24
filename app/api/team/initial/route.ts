import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'

export const dynamic = 'force-dynamic'

export interface InitialEvaluator {
  row_number: number
  name: string
  today_available: 'Yes' | 'No'
  game_platform: string
  game_category: string
}

export async function GET(_req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const url = process.env.WEBHOOK_TEAM_INITIAL_GET
  if (!url) return NextResponse.json({ error: 'WEBHOOK_TEAM_INITIAL_GET not configured' }, { status: 500 })

  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) return NextResponse.json({ error: 'Failed to fetch from webhook' }, { status: 502 })
  const rawData = await res.json()

  interface RawWebhookRow {
    'Evaluator Name'?: string
    row_number: number
    'Today Available': 'Yes' | 'No'
    'Game Platform': string
    'Game Category': string
  }

  // Transform Google Sheets fields → expected schema, filter empty rows
  const data: InitialEvaluator[] = (rawData as RawWebhookRow[])
    .filter((row: RawWebhookRow) => row['Evaluator Name']?.trim())
    .map((row: RawWebhookRow) => ({
      row_number: row.row_number,
      name: row['Evaluator Name'] as string,
      today_available: row['Today Available'],
      game_platform: row['Game Platform'],
      game_category: row['Game Category'],
    }))

  return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } })
}
