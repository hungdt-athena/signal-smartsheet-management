#!/usr/bin/env node
// Backfill game_evaluations.genre_1 / genre_2 from game_info.metadata->'categories'.
//
// Rows pushed by the DB-native flow (from 2026-07 on) never got these columns filled —
// only the Smartsheet-era import did — so the Evaluate panel's Genre field renders empty
// for them. Push now writes them; this fills in the rows that predate the fix.
//
// Only touches rows where BOTH columns are NULL, so a manually-edited genre is never
// overwritten.
//
// Usage:
//   node scripts/backfill-eval-genres.mjs            # dry run (default)
//   node scripts/backfill-eval-genres.mjs --apply
import fs from 'node:fs'
import postgres from 'postgres'

const apply = process.argv.includes('--apply')

if (!process.env.DATABASE_URL && fs.existsSync('.env.local')) {
  const m = fs.readFileSync('.env.local', 'utf8').match(/^DATABASE_URL=(.*)$/m)
  if (m) process.env.DATABASE_URL = m[1].trim().replace(/^"|"$/g, '')
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set')
  process.exit(1)
}

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', connect_timeout: 30 })

try {
  const [stats] = await sql`
    SELECT count(*)::int AS blank,
           count(*) FILTER (WHERE gi.metadata -> 'categories' ->> 0 IS NOT NULL)::int AS fillable
    FROM game_evaluations ge
    JOIN game_info gi USING (game_id)
    WHERE ge.genre_1 IS NULL AND ge.genre_2 IS NULL
  `
  console.log(`${apply ? 'BACKFILL' : 'DRY RUN'} — ${stats.blank} rows with no genre, ${stats.fillable} of them have categories in game_info`)

  const sample = await sql`
    SELECT ge.game_id, gi.metadata -> 'categories' AS cats
    FROM game_evaluations ge
    JOIN game_info gi USING (game_id)
    WHERE ge.genre_1 IS NULL AND ge.genre_2 IS NULL
      AND gi.metadata -> 'categories' ->> 0 IS NOT NULL
    ORDER BY ge.imported_at DESC
    LIMIT 5
  `
  console.log('\nSample:')
  for (const r of sample) console.log(`  ${r.game_id.padEnd(45)} ${JSON.stringify(r.cats)}`)

  if (!apply) {
    console.log('\nNothing changed. Re-run with --apply to backfill.')
    process.exit(0)
  }

  const res = await sql`
    UPDATE game_evaluations ge
    SET genre_1 = left(gi.metadata -> 'categories' ->> 0, 50),
        genre_2 = left(gi.metadata -> 'categories' ->> 1, 50),
        updated_at = NOW()
    FROM game_info gi
    WHERE gi.game_id = ge.game_id
      AND ge.genre_1 IS NULL AND ge.genre_2 IS NULL
      AND gi.metadata -> 'categories' ->> 0 IS NOT NULL
  `
  console.log(`\nBackfilled ${res.count} rows.`)
} finally {
  await sql.end({ timeout: 5 })
}
