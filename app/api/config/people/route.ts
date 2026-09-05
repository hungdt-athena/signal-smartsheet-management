// app/api/config/people/route.ts — who appears in the evaluator dropdowns, and
// who counts in the Report.
//
// Two flags per person, stored in two different places on purpose:
//   inFilters → people_config.hiddenInFilters  (this feature's own blob)
//   inReport  → report_config.excluded         (the array the Report tab's Config
//               already edits — one store, so the two screens cannot drift)
// Assign is deliberately absent: the roster lives in Team Ops.
import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { loadPeopleConfig, savePeopleConfig } from '@/lib/people-config-db'
import { loadReportConfig, saveReportConfig } from '@/lib/report-config-db'
import { SYSTEM_LABEL_KEY_LIST } from '@/lib/system-accounts'

export const dynamic = 'force-dynamic'

// Someone with no evaluation in this many days is flagged as inactive. Only a
// suggestion in the UI — nothing is hidden automatically.
const STALE_DAYS = 7

interface Person {
  key: string          // lower(name) — the id every flag is stored under
  name: string         // display casing
  title: string        // Admin / Fulltime / Freelancer / Recorder / —
  lastEval: string | null
  recent: number       // evaluations in the last STALE_DAYS days
  total: number
  hasAccount: boolean  // false = evaluates games but has no dashboard_users row
  inFilters: boolean
  inReport: boolean
}

async function buildPeople(): Promise<{ people: Person[]; staleDays: number; noAccount: number }> {
  const [rosterRows, statRows, userRows, peopleCfg, report] = await Promise.all([
    sql<{ key: string; name: string }[]>`
      SELECT lower(name) AS key, mode() WITHIN GROUP (ORDER BY name) AS name
      FROM evaluator_roster
      WHERE list_type = 'initial' AND name IS NOT NULL AND name <> ''
      GROUP BY lower(name)
    `,
    // Everyone who has ever evaluated, so a person off the roster but still on old
    // games stays editable here instead of being stuck in the dropdown forever.
    sql<{ key: string; name: string; last_eval: string | null; recent: number; total: number }[]>`
      SELECT lower(initial_evaluator) AS key,
             mode() WITHIN GROUP (ORDER BY initial_evaluator) AS name,
             MAX(evaluate_date) AS last_eval,
             COUNT(*) FILTER (WHERE evaluate_date >= NOW() - ${`${STALE_DAYS} days`}::interval)::int AS recent,
             COUNT(*)::int AS total
      FROM game_evaluations
      WHERE initial_evaluator IS NOT NULL AND initial_evaluator <> ''
      GROUP BY lower(initial_evaluator)
    `,
    sql<{ key: string; title: string | null; active: boolean }[]>`
      SELECT lower(name) AS key,
             mode() WITHIN GROUP (ORDER BY title) AS title,
             bool_or(active) AS active
      FROM dashboard_users
      WHERE name IS NOT NULL AND name <> ''
      GROUP BY lower(name)
    `,
    loadPeopleConfig(),
    loadReportConfig(),
  ])

  const hidden = new Set(peopleCfg.hiddenInFilters)
  const excluded = new Set(report.config.excluded)
  const titles = new Map(userRows.map(r => [r.key, r.title]))
  const accounts = new Map(userRows.map(r => [r.key, r.active]))
  const stats = new Map(statRows.map(r => [r.key, r]))

  // Two kinds of name never reach this table:
  //   - deactivated users, because Users Management is where someone comes back;
  //   - system labels like `Shortcut`, because there is no person to manage.
  // A name with no account at all DOES stay visible — hiding it would leave
  // nowhere to notice it needs one.
  const keys = new Set(
    [...rosterRows.map(r => r.key), ...statRows.map(r => r.key)]
      .filter(k => accounts.get(k) !== false && !SYSTEM_LABEL_KEY_LIST.includes(k)),
  )
  const names = new Map<string, string>()
  for (const r of statRows) names.set(r.key, r.name)
  for (const r of rosterRows) names.set(r.key, r.name)   // roster casing wins

  const people = Array.from(keys).map<Person>(key => {
    const s = stats.get(key)
    return {
      key,
      name: names.get(key) ?? key,
      title: titles.get(key) || '—',
      lastEval: s?.last_eval ? new Date(s.last_eval).toISOString() : null,
      recent: s?.recent ?? 0,
      total: s?.total ?? 0,
      hasAccount: accounts.has(key),
      inFilters: !hidden.has(key),
      inReport: !excluded.has(key),
    }
  })

  people.sort((a, b) => a.name.localeCompare(b.name))
  return { people, staleDays: STALE_DAYS, noAccount: people.filter(p => !p.hasAccount).length }
}

export async function GET() {
  const guard = await requireManager()
  if (guard) return guard
  try {
    return NextResponse.json(await buildPeople(), { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('GET /api/config/people error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

// PATCH /api/config/people — { key | keys, inFilters?, inReport? }. Send either
// flag or both; whichever is present is written to its own store. `keys` applies
// the same flags to several people in one write, which is what the "hide everyone
// inactive" shortcut needs.
export async function PATCH(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  try {
    const body = await req.json()
    const raw: unknown[] = Array.isArray(body?.keys) ? body.keys : [body?.key]
    const keys = raw
      .map(k => (typeof k === 'string' ? k.trim().toLowerCase() : ''))
      .filter(Boolean)
    if (keys.length === 0) return NextResponse.json({ error: 'key is required' }, { status: 400 })
    if (typeof body.inFilters !== 'boolean' && typeof body.inReport !== 'boolean') {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }
    const touched = new Set(keys)

    if (typeof body.inFilters === 'boolean') {
      const cfg = await loadPeopleConfig()
      const next = cfg.hiddenInFilters.filter(k => !touched.has(k))
      if (!body.inFilters) next.push(...keys)
      await savePeopleConfig({ hiddenInFilters: next })
    }

    if (typeof body.inReport === 'boolean') {
      const { config } = await loadReportConfig()
      const excluded = config.excluded.filter(k => !touched.has(k))
      if (!body.inReport) excluded.push(...keys)
      await saveReportConfig({ ...config, excluded })
    }

    return NextResponse.json(await buildPeople())
  } catch (err) {
    console.error('PATCH /api/config/people error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
