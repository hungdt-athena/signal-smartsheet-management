// THROWAWAY teardown for the legacy-sheet import. Drops the staging table, then
// prints the git commands to remove the rest of the import code.
//
//   DATABASE_URL='<...>' npm run import-feedback:teardown
//
// Run this only after the sync is approved into weekly_feedback and you no longer
// need to re-pull. The multi-group game-alike model is a real feature — KEEP it.
import { readFileSync } from 'fs'
import postgres from 'postgres'

try {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* no .env.local */ }

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1) }
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' })

async function main() {
  await sql`DROP TABLE IF EXISTS weekly_feedback_import`
  console.log('✓ Dropped table weekly_feedback_import.\n')
  console.log(`Now remove the throwaway CODE:

  git rm scripts/import-weekly-feedback.ts \\
         scripts/import-weekly-feedback-teardown.ts \\
         lib/weekly-feedback-import.ts \\
         __tests__/lib/weekly-feedback-import.test.ts \\
         config/evaluator-map.example.json \\
         migrations/020_weekly_feedback_import.sql \\
         components/weekly-feedback/ImportReviewView.tsx
  git rm -r app/api/weekly-feedback/import

Then hand-revert the Import-only bits from these shared files (KEEP everything else):
  • components/weekly-feedback/WeeklyFeedbackTab.tsx
      - the ImportReviewView import
      - the 'import' value in the view useState union
      - the admin-only Import <button>
      - the "{view !== 'import' && (" guard around the filter-row (and its closing ")}")
      - the "view === 'import' ? <ImportReviewView /> :" branch in the card
  • app/globals.css   — the "Weekly Feedback Import review (THROWAWAY)" block
  • package.json      — the import-feedback / import-feedback:teardown script lines
  • .gitignore        — config/evaluator-map.json (optional)

Tip: 'git show b962d17 -- components/weekly-feedback/WeeklyFeedbackTab.tsx app/globals.css'
shows exactly the hunks that were added, to reverse them precisely.`)
  await sql.end()
}

main().catch(e => { console.error(e); process.exit(1) })
