import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { TRENDS_FIELD } from '@/lib/playtest-tags'

export const dynamic = 'force-dynamic'

interface Options {
  values: string[]
  subValues: { id: number; name: string }[]
}

// ~351 Trends values and 2 sub-values that change rarely, but the combobox is
// opened on every game. Cache in module scope for 10 minutes.
const TTL_MS = 10 * 60 * 1000
let cache: { at: number; data: Options } | null = null

// GET /api/trends/options — the Trends values and sub-values an evaluator may
// pick. Definitions are Signal Sense's to own; this app never creates them.
export async function GET(_req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  if (cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json(cache.data, { headers: { 'Cache-Control': 'no-store' } })
  }

  const [values, subValues] = await Promise.all([
    sql`
      SELECT DISTINCT field_value
      FROM custom_field_definitions
      WHERE field_name = ${TRENDS_FIELD} AND is_active
      ORDER BY field_value
    `,
    sql`SELECT id, name FROM sub_value_definitions WHERE is_active ORDER BY name`,
  ])

  const data: Options = {
    values: values.map(r => r.field_value as string),
    subValues: subValues.map(r => ({ id: r.id as number, name: r.name as string })),
  }
  cache = { at: Date.now(), data }
  return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } })
}
