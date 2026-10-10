import fs from 'node:fs'
import path from 'node:path'

// The preview route carries its own copy of the push-eligibility predicate,
// because /api/cron/push-evaluations builds its SQL as two literal copies (one
// for the dry run, one for the insert) and the dry-run count is only worth
// reading if it filters exactly like the insert.
//
// A copy that nobody checks is a copy that drifts, and the failure is silent:
// the panel would keep showing a confident number for a rule the cron no longer
// uses. So this test reads both files and asserts the parts that decide
// eligibility still read the same. It is deliberately about the SQL text — if
// you change the window, this test is the reminder that there is a second place
// to change.
//
// The scraper-type list is the exception. It was a fourth copy, it drifted, and
// the drift cost 1,935 games: appranking-scraper produced from 2026-09-02 and
// never entered the queue because three files listed it and the fourth did not.
// It now lives in lib/push-sources.ts, so the assertion below is that both
// routes CALL that helper rather than that they spell the same SQL.

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

/** Collapse whitespace so indentation differences are not "drift". */
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

const CRON = squash(read('app/api/cron/push-evaluations/route.ts'))
const PREVIEW = squash(read('app/api/assign-setup/preview/route.ts'))
const SPLIT = squash(read('app/api/admin/push-split/route.ts'))
// Read as text, not imported: lib/push-sources pulls in lib/db, and this suite
// has no business opening a connection to assert what a list says.
const SOURCES = squash(read('lib/push-sources.ts'))

describe('the preview shares the cron\'s push eligibility', () => {
  it('uses the same window on release, falling back to created_date', () => {
    // The fallback is the narrow one on purpose: a game merely CRAWLED inside
    // the window is back catalogue, not a new release. Widening this to
    // created_date alone is what flooded the queue on 2026-08-19.
    const window = squash(`
      w.rel BETWEEN (w.today - (${'${windowDays}'} || ' days')::interval) AND w.today
      OR (w.rel IS NULL AND gi.created_date BETWEEN (w.today - (${'${windowDays}'} || ' days')::interval) AND w.today)
    `)
    expect(CRON).toContain(window)
    expect(PREVIEW).toContain(window)
  })

  it('takes the window length from Config, not from a literal', () => {
    // Both must read push_window_config, or the panel previews one window while
    // the cron pushes another.
    for (const src of [CRON, PREVIEW]) {
      expect(src).toContain('pushWindowFor(')
      expect(src).toContain('loadPushWindowConfig')
      expect(src).not.toContain("INTERVAL '30 days'")
    }
  })

  it('reads "today" as a VN calendar date, not the server\'s', () => {
    const today = squash(`(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS today`)
    expect(CRON).toContain(today)
    expect(PREVIEW).toContain(today)
  })

  it('takes release from initial_release, then temp_release', () => {
    const rel = squash('SELECT COALESCE(gi.initial_release, gi.temp_release) AS rel')
    expect(CRON).toContain(rel)
    expect(PREVIEW).toContain(rel)
  })

  it('takes the scraper list from one shared helper, not from a fourth copy', () => {
    for (const src of [CRON, PREVIEW, SPLIT]) {
      expect(src).toContain('pushSourceFilter')
      expect(src).toContain("from '@/lib/push-sources'")
      // The literal list is what drifted. Nobody may spell it inline again.
      expect(src).not.toContain("ILIKE '%apkcombo-scraper%'")
    }
  })

  it('admits only live rows with a link', () => {
    for (const clause of ['gi.app_link IS NOT NULL', 'gi.is_active = TRUE']) {
      expect(CRON).toContain(clause)
      expect(PREVIEW).toContain(clause)
    }
  })

  it('lists the importer the team calls insight-track', () => {
    // It is `appranking-scraper` in game_info and `insight-track` on the Report.
    expect(SOURCES).toContain("'appranking-scraper'")
  })

  it('skips games already in game_evaluations in ANY genre', () => {
    // Both dedupe, so both count "new", not "eligible". And the dedupe is on the
    // game, not on (game, genre): one game gets one row. See push-evaluations.
    const dedupe = squash(`NOT EXISTS ( SELECT 1 FROM game_evaluations ge
      WHERE ge.game_id = gi.game_id )`)
    expect(CRON).toContain(dedupe)
    expect(PREVIEW).toContain(dedupe)
    expect(CRON).not.toContain('ge.category_group = ${category}')
    expect(PREVIEW).not.toContain('ge.category_group = ${bucket}')
  })

  it('does not count a game under a later genre that an earlier one takes this run', () => {
    // The run walks BUCKETS in order and the first genre to push a game keeps it.
    expect(PREVIEW).toContain('BUCKETS.slice(0, i)')
    expect(PREVIEW).toContain('AND NOT ${claimedBy(b)}')
    // Never an array of fragments: an empty one renders as broken SQL.
    expect(PREVIEW).not.toContain('${earlier.map(')
    expect(squash(read('app/api/assign-setup/run/route.ts'))).toContain('BUCKETS.filter(b => asked.includes(b))')
  })

  it('orders the crew the way the assign cron does, since the split follows it', () => {
    const order = squash('ORDER BY sort_order NULLS LAST, name')
    expect(squash(read('app/api/cron/assign-evaluators/route.ts'))).toContain(order)
    expect(PREVIEW).toContain(order)
  })

  it('tests categories with EXISTS, so a game is counted once per genre', () => {
    // A game tagged both "puzzle" and "casual" is one puzzle game. EXISTS is
    // also the fast shape: joining the categories out and de-duplicating with
    // DISTINCT measured 75s against production, versus 9s for this. See the
    // COST note in the route.
    const exists = squash(`
      EXISTS ( SELECT 1 FROM jsonb_array_elements_text(gi.metadata -> 'categories') AS cat
               WHERE lower(cat) = ANY(
    `)
    expect(CRON).toContain(exists)
    expect(PREVIEW).toContain(exists)
    expect(PREVIEW).not.toContain('SELECT DISTINCT')
  })

  it('is a GET with no write in it', () => {
    // The panel must never be able to change anything: it is read on every
    // roster edit, including by a moderator.
    expect(PREVIEW).toMatch(/export async function GET\(/)
    expect(PREVIEW).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/)
    expect(PREVIEW).toContain('requireManager()')
  })
})
