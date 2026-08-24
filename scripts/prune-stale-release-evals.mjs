#!/usr/bin/env node
// Take back-catalog games out of the evaluation queue. They only got pushed because the
// eligibility filter's created_date branch ignored release date (apkcombo-scraper started
// crawling publisher back catalogs on 2026-08-19).
//
// Rows are KEPT — this marks initial_conclusion = 'Stale_release', the same
// out-of-queue-but-on-record pattern as Link_dead: the game leaves the pending list and
// the backlog, and Report/rollup/quick-stats exclude it from evaluated + shortlisted
// counts so nobody's numbers move. evaluate_date stays NULL (no work was done) and
// initial_evaluator is left in place so it stays auditable who had it.
//
// Only rows that are safe to take out are considered:
//   - release date (COALESCE initial_release, temp_release) older than --max-age days
//   - no evaluation yet (initial_conclusion IS NULL)
//   - no work attached: no drive/youtube link, no recorder, no final conclusion
//
// Usage:
//   node scripts/prune-stale-release-evals.mjs                 # dry run (default)
//   node scripts/prune-stale-release-evals.mjs --max-age 365   # different cap
//   node scripts/prune-stale-release-evals.mjs --apply         # actually mark
//   node scripts/prune-stale-release-evals.mjs --undo --apply  # put them back in the queue
//
//   --release-before YYYY-MM-DD   absolute cutoff instead of --max-age
//   --imported-days N             only rows pushed in the last N days
//
// Requires DATABASE_URL (read from .env.local when not already in the environment).
import fs from 'node:fs'
import postgres from 'postgres'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const undo = args.includes('--undo')
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const maxAge = flag('--max-age') !== undefined ? Number(flag('--max-age')) : 180
if (!Number.isFinite(maxAge) || maxAge <= 0) {
  console.error('--max-age must be a positive number of days')
  process.exit(1)
}

// Absolute cutoff, e.g. --release-before 2026-08-01 for "released before August".
const releaseBefore = flag('--release-before')
if (releaseBefore !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(releaseBefore)) {
  console.error('--release-before must be YYYY-MM-DD')
  process.exit(1)
}

// Restrict to a recent push cohort, e.g. --imported-days 5.
const importedDays = flag('--imported-days') !== undefined ? Number(flag('--imported-days')) : undefined
if (importedDays !== undefined && (!Number.isFinite(importedDays) || importedDays <= 0)) {
  console.error('--imported-days must be a positive number of days')
  process.exit(1)
}

if (!process.env.DATABASE_URL && fs.existsSync('.env.local')) {
  const m = fs.readFileSync('.env.local', 'utf8').match(/^DATABASE_URL=(.*)$/m)
  if (m) process.env.DATABASE_URL = m[1].trim().replace(/^"|"$/g, '')
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set')
  process.exit(1)
}

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', connect_timeout: 30 })

const MARK = 'Stale_release'

// Undo looks for rows already marked; the forward pass looks for untouched rows whose
// release date is beyond the cap.
const releaseCutoff = releaseBefore
  ? sql`COALESCE(gi.initial_release, gi.temp_release) < ${releaseBefore}::date`
  : sql`COALESCE(gi.initial_release, gi.temp_release) < (CURRENT_DATE - (${maxAge} || ' days')::interval)`

const importedCutoff = importedDays === undefined
  ? sql``
  : sql`AND ge.imported_at >= (CURRENT_DATE - (${importedDays} || ' days')::interval)`

const scope = undo
  ? sql`ge.initial_conclusion = ${MARK}`
  : sql`${releaseCutoff} ${importedCutoff}
        AND ge.initial_conclusion IS NULL
        AND ge.final_conclusion IS NULL
        AND ge.drive_link IS NULL
        AND ge.youtube_link IS NULL
        AND ge.record_assignee IS NULL
        AND ge.record_5min_assignee IS NULL
        AND ge.record_20min_assignee IS NULL`

const candidates = sql`
  SELECT ge.id, ge.game_id, ge.category_group, ge.initial_evaluator,
         COALESCE(gi.initial_release, gi.temp_release) AS release_date,
         gi.type::text AS source_type, ge.imported_at::date AS pushed_on
  FROM game_evaluations ge
  JOIN game_info gi USING (game_id)
  WHERE ${scope}
`

try {
  const rows = await candidates
  const criteria = [
    releaseBefore ? `release before ${releaseBefore}` : `release older than ${maxAge} days`,
    importedDays === undefined ? null : `pushed in the last ${importedDays} days`,
  ].filter(Boolean).join(', ')

  if (rows.length === 0) {
    console.log(undo
      ? `Nothing marked ${MARK} — nothing to undo.`
      : `Nothing to take out (${criteria}, untouched).`)
    process.exit(0)
  }

  const byEvaluator = new Map()
  const bySource = new Map()
  for (const r of rows) {
    const k = r.initial_evaluator ?? '(unassigned)'
    const e = byEvaluator.get(k) ?? { n: 0, oldest: r.release_date, newest: r.release_date }
    e.n += 1
    if (r.release_date < e.oldest) e.oldest = r.release_date
    if (r.release_date > e.newest) e.newest = r.release_date
    byEvaluator.set(k, e)
    bySource.set(r.source_type ?? '(null)', (bySource.get(r.source_type ?? '(null)') ?? 0) + 1)
  }

  const d = (v) => new Date(v).toISOString().slice(0, 10)
  const verb = undo
    ? `${apply ? 'RESTORING' : 'DRY RUN (undo)'} — ${rows.length} rows marked ${MARK}`
    : `${apply ? `MARKING ${MARK}` : 'DRY RUN'} — ${rows.length} rows, ${criteria}`
  console.log(`${verb}\n`)
  console.log('By evaluator:')
  for (const [name, e] of [...byEvaluator].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${name.padEnd(16)} ${String(e.n).padStart(5)}   release ${d(e.oldest)} → ${d(e.newest)}`)
  }
  console.log('\nBy source type:')
  for (const [t, n] of [...bySource].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(20)} ${String(n).padStart(5)}`)
  }

  if (!apply) {
    console.log(`\nNothing changed. Re-run with --apply to ${undo ? 'restore' : 'mark'}.`)
    process.exit(0)
  }

  const ids = rows.map((r) => r.id)
  const res = undo
    ? await sql`UPDATE game_evaluations SET initial_conclusion = NULL, updated_at = NOW()
                WHERE id = ANY(${ids}) AND initial_conclusion = ${MARK}`
    : await sql`UPDATE game_evaluations SET initial_conclusion = ${MARK}, updated_at = NOW()
                WHERE id = ANY(${ids}) AND initial_conclusion IS NULL`
  console.log(`\n${undo ? 'Restored' : 'Marked'} ${res.count} rows.`)
} finally {
  await sql.end({ timeout: 5 })
}
