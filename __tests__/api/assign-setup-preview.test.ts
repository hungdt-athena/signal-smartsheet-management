import fs from 'node:fs'
import path from 'node:path'

// The preview route carries its own copy of the push-eligibility predicate,
// because /api/cron/push-evaluations builds its SQL as two literal copies (one
// for the dry run, one for the insert) and postgres.js template literals do not
// compose cleanly enough to share one.
//
// A copy that nobody checks is a copy that drifts, and the failure is silent:
// the panel would keep showing a confident number for a rule the cron no longer
// uses. So this test reads both files and asserts the parts that decide
// eligibility still read the same. It is deliberately about the SQL text — if
// you change the window or the scraper list, this test is the reminder that
// there is a second place to change.

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

/** Collapse whitespace so indentation differences are not "drift". */
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

const CRON = squash(read('app/api/cron/push-evaluations/route.ts'))
const PREVIEW = squash(read('app/api/assign-setup/preview/route.ts'))

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

  it('admits the same scraper types, and only live rows with a link', () => {
    const types = squash(`
      (gi.type IS NULL OR gi.type::text ILIKE '%sync%' OR gi.type::text ILIKE '%top-pub-scraper%'
       OR gi.type::text ILIKE '%apkcombo-scraper%' OR gi.type::text ILIKE '%appagg-scraper%')
    `)
    expect(CRON).toContain(types)
    expect(PREVIEW).toContain(types)
    for (const clause of ['gi.app_link IS NOT NULL', 'gi.is_active = TRUE']) {
      expect(CRON).toContain(clause)
      expect(PREVIEW).toContain(clause)
    }
  })

  it('skips games already in game_evaluations for that bucket', () => {
    // Both dedupe, so both count "new", not "eligible".
    expect(CRON).toContain(squash('NOT EXISTS ( SELECT 1 FROM game_evaluations ge'))
    expect(PREVIEW).toContain(squash('NOT EXISTS ( SELECT 1 FROM game_evaluations ge'))
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
