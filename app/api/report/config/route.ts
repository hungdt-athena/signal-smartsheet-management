import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { ALL_ROUNDER_AXES, DEFAULT_REPORT_CONFIG, parseReportConfig, type AxisName, type ReportConfig } from '@/lib/report-config'
import { loadReportConfig, saveReportConfig } from '@/lib/report-config-db'

export const dynamic = 'force-dynamic'

// GET /api/report/config - current settings plus the full roster to tick against.
// Admin-only, same guard as the report itself.
export async function GET() {
  const guard = await requireRole('admin')
  if (guard) return guard
  try {
    const { config } = await loadReportConfig()
    const roster = await sql`
      SELECT lower(name) AS key, mode() WITHIN GROUP (ORDER BY name) AS name
      FROM evaluator_roster WHERE list_type = 'initial' AND name IS NOT NULL AND name <> ''
      GROUP BY lower(name) ORDER BY 2`
    return NextResponse.json({ config, roster, defaults: DEFAULT_REPORT_CONFIG })
  } catch (err) {
    console.error('GET /api/report/config error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

// PUT /api/report/config - replace the whole blob. Parsed through the same tolerant
// reader as the read path, so a malformed body degrades to defaults per field
// instead of persisting something the report cannot use.
export async function PUT(req: NextRequest) {
  const guard = await requireRole('admin')
  if (guard) return guard
  try {
    const body = await req.json()
    const weights = {} as Record<AxisName, number>
    for (const a of ALL_ROUNDER_AXES) weights[a] = Number(body?.weights?.[a])
    const cfg: ReportConfig = parseReportConfig(JSON.stringify({
      excluded: body?.excluded, weights, credibility: body?.credibility,
    }))
    await saveReportConfig(cfg)
    return NextResponse.json({ ok: true, config: cfg })
  } catch (err) {
    console.error('PUT /api/report/config error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
