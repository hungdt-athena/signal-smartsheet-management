import fs from 'fs'
import path from 'path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReportView } from '@/components/report/ReportView'

// Task 11: every other test in this plan is unit-level and shares the code's own
// assumptions about what a bundle looks like. Nothing in this repo's history has
// caught a "0 of 0 games" / "divides to Infinity" / "names a threshold the payload
// never carried" bug except rendering a REAL payload through jsdom and reading the
// text back by hand. This file is that net.
//
// Fixtures, and exactly how each one was obtained:
//
//   report-prod.json            REAL. Captured with the exact command the task brief
//                                specifies: an isolated `NEXT_DIST_DIR=.next-probe
//                                SKIP_AUTH=true npx next dev -p 3399`, then
//                                `curl 'http://localhost:3399/api/report?view=month
//                                &category=puzzle'`. Admin/manager scope, resolves to
//                                "All time" (no key given), staleDays=7 in prod right
//                                now (not 8), pipeline null.
//   report-prod-batch-latest.json  REAL, same probe: `?view=batch&category=puzzle`
//                                (the app's actual landing view), resolves to the
//                                newest real batch. pipeline present, rescue has both
//                                sources and receivers.
//   report-prod-batch-all.json  REAL, same probe: `?view=batch&key=all&category=
//                                puzzle` ("All batches" - the one shape of batch view
//                                that still sends pipeline: null; the current route
//                                resolves an ordinary batch to real from/to dates and
//                                DOES populate pipeline for it, so this is the genuine
//                                pipeline-null case, not the newest batch).
//   report-prod-no-receivers.json  report-prod-batch-latest.json with `rescue.
//                                receivers` PATCHED to `[]` by hand - the real payload
//                                had six receivers and no scoped/live payload with
//                                zero receivers was available to capture. Numbers are
//                                otherwise the real ones.
//   report-prod-contractor.json  DERIVED from report-prod-batch-latest.json by
//                                applying, by hand, the exact scoped-shape transform
//                                app/api/report/route.ts applies server-side for a
//                                non-manager session (filter every person-keyed field
//                                to one key, canSeeTeam: false, pipeline: null, rescue:
//                                null, selfStale from that person's real backlogBy
//                                row). Could not capture this live: SKIP_AUTH only
//                                yields the admin/manager path (Google OAuth is the
//                                only real login and there is no dev credentials
//                                provider), and fighting that further was not worth
//                                it per the brief's own guidance. Every NUMBER in it is
//                                real; the SCOPING was applied by this file's author,
//                                not the server.
//   report-prod-healthy.json    SYNTHETIC. Same "nothing crosses a threshold" bundle
//                                report-overview.test.tsx's healthy() already uses
//                                (that function is the suite's own proof it prints no
//                                actions), extended with the fields this task's Bundle
//                                also reads (backlogBy, personMoves, radar, staleDays,
//                                selfStale, rescue). staleDays is deliberately still 8
//                                here - the "not 8" requirement is covered by the four
//                                REAL fixtures above, all of which are 7.
//
// PSEUDONYMS. Every evaluator name in all six fixtures is `Ev1`..`Ev11`. The captured
// payloads carried the team's real names, and with them performance judgements about
// named individuals ("keeps 1 game in 42 where the rest of the team keeps 1 in 17") -
// which merging would write into permanent history, where deleting them later does not
// remove them. One real name maps to one pseudonym across ALL SIX files and every field
// that holds one (`rescue.sources`/`receivers`, `backlogBy`, `evaluators`, `radar`,
// `heatmap.rows`, and the object KEYS of `personSeries`, `videos`, `dailyMix`,
// `personMoves`), so the fixtures still join up. `Alpha`/`Beta` in the synthetic
// healthy fixture were never real and are untouched. No test reads a name, and the
// rename changed no number.
//
// See __tests__/fixtures/*.json for the raw bytes, and task-11-report.md for the full
// dumped text of every case and the hand-read findings against it.

jest.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 1, role: 'admin', name: 'Admin' } }, status: 'authenticated' }),
}))

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: jest.fn() }),
  usePathname: () => '/team-ops',
}))

type Bundle = Record<string, unknown>

function load(name: string): Bundle {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8'))
}

async function renderTab(bundle: Bundle, tab?: 'Overview' | 'Leaderboard' | 'Individual') {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => bundle }) as unknown as typeof fetch
  const view = render(<ReportView />)
  await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument())
  if (tab) {
    // getByRole, not queryByRole-and-maybe-click: a tab bar that stopped rendering
    // would have silently collapsed all three dumps into three copies of Overview,
    // and every assertion downstream would still have passed.
    fireEvent.click(screen.getByRole('button', { name: tab }))
  }
  return view
}

// Every "Do this" line, ReadNote and headline on the page right now, as plain text -
// this dump IS the deliverable for this task, not a pass/fail bit.
function dump(label: string) {
  const block = document.querySelector('.rp-do-block')
  const lines = Array.from(block?.querySelectorAll('.rp-do-line, .rp-do-why, .rp-do-payoff, .rp-do-cta') ?? [])
    .map((n) => n.textContent!.trim())
  const headline = document.querySelector('.rp-headline')?.textContent?.trim() ?? '(no headline)'
  // eslint-disable-next-line no-console
  console.log(`\n===== ${label} =====\nheadline: ${headline}\n${lines.length ? lines.join('\n') : '(Do this block: empty - nothing to do)'}\n`)
  return { headline, lines }
}

// Task 7: the six rewritten chips (Leaderboard's cal/people/top, Individual's
// net/wait/share), the section titles, and the KPI sub-lines that now carry the
// figures the three removed blocks used to show - everything Task 1/2's own unit
// suites already asserted on synthetic fixtures, read back here on the REAL payloads
// this file exists for. Printed alongside `dump()`'s output, not instead of it: the
// brief's deliverable is the full text, and a human reads all of it, not just the
// bit a regex happens to check.
// `expectKpis` is explicit rather than sniffed off the DOM, because sniffing for the
// KPI row with the very selector under test is how a renamed selector goes quiet: only
// Individual carries a KPI row (the Leaderboard deliberately has none - its table IS
// the numbers), so the caller states which tab it is dumping.
function dumpChipsAndKpis(label: string, { expectKpis }: { expectKpis: boolean }) {
  const chips = Array.from(document.querySelectorAll('.rp-chip-text')).map((n) => n.textContent!.trim())
  const sectionTitles = Array.from(document.querySelectorAll('.rp-section-title')).map((n) => n.textContent!.trim())
  const kpis = Array.from(document.querySelectorAll('.rp-kpi')).map((k) => {
    const label = k.querySelector('.rp-kpi-label')?.textContent?.trim() ?? ''
    const value = k.querySelector('.rp-kpi-value')?.textContent?.trim() ?? ''
    const sub = k.querySelector('.rp-kpi-sub')?.textContent?.trim() ?? ''
    return `${label}: ${value} (${sub})`
  })
  const reviewNote = document.querySelector('.rp-review-scope-note')?.textContent?.trim() ?? null
  // eslint-disable-next-line no-console
  console.log(`\n----- ${label} / chips+kpis -----\nchips:\n${chips.length ? chips.join('\n') : '(none)'}\nsection titles:\n${sectionTitles.length ? sectionTitles.join('\n') : '(none)'}\nkpis:\n${kpis.length ? kpis.join('\n') : '(none)'}\nreview scope note: ${reviewNote ?? '(absent)'}\n`)
  // The non-empty guarantee assertReviewSeparatorIsLast already carries, and the
  // reason it matters: assertClean() iterates with forEach, so `assertClean([])`
  // passes every check it makes. Without this, renaming `.rp-chip-text` or `.rp-kpi`
  // would turn all five call sites below green while reading nothing at all.
  expect(chips.length).toBeGreaterThan(0)
  expect(sectionTitles.length).toBeGreaterThan(0)
  if (expectKpis) expect(kpis.length).toBeGreaterThan(0)
  return { chips, sectionTitles, kpis, reviewNote }
}

// Task 2 removed these three blocks from Individual. This is a regression guard, not
// a smoke test on the current tree: the exact strings and selectors below are the
// ones review-task2.diff's own unit test anchored on when it deleted the blocks
// (`performance shape`, `.rp-radar-wrap`, the "Pick funnel" card-label, the "Daily
// breakdown" button, `.rp-daily-modal`). Proven to actually catch a regression, not
// just always-pass: markup carrying all five markers was temporarily reinserted into
// ReportView.tsx's Individual render (uncommitted) and this suite was re-run against
// report-prod.json - `assertRemovedBlocksAbsent` failed on the `performance shape`
// check as expected, the markup was then reverted, and the suite was confirmed green
// again before committing (see task-7-report.md for the failure output and the diff
// that was reverted). Checking out the actual pre-Task-2 commit was not usable for
// this proof: the ReviewTable this function also depends on (`waitForReviewTableSettled`
// finding `.rp-review-empty`/`.rp-review-row`) did not exist until Task 5/6, two
// commits later, so that commit fails for an unrelated reason (no review table at
// all) rather than proving this specific guard.
function assertRemovedBlocksAbsent() {
  const bodyText = document.body.textContent || ''
  expect(bodyText.toLowerCase()).not.toContain('performance shape')
  expect(document.querySelector('.rp-radar-wrap')).toBeNull()
  const cardLabels = Array.from(document.querySelectorAll('.card-label')).map((n) => n.textContent!.trim())
  expect(cardLabels).not.toContain('Pick funnel')
  expect(screen.queryByRole('button', { name: /Daily breakdown/i })).toBeNull()
}

// The separator + its scope note must exist, and must sit AFTER every other section
// on the tab (Design section C: "Last block on the tab, after the recording list").
// Checking the note's plain text, not just its presence, is the point: a reader who
// only sees the review table with no note above it reads the tab as contradicting
// itself (numbers not matching the window/genre bar at the top).
function assertReviewSeparatorIsLast() {
  const titles = Array.from(document.querySelectorAll('.rp-section-title')).map((n) => n.textContent!.trim())
  expect(titles.length).toBeGreaterThan(0)
  expect(titles[titles.length - 1]).toMatch(/^Review /)
  const rule = document.querySelector('.rp-review-rule')
  expect(rule).not.toBeNull()
  const note = document.querySelector('.rp-review-scope-note')
  expect(note?.textContent?.trim()).toBe(
    'This table has its own filters. It ignores the View by and Category filters at the top of the page.',
  )
  // DOM order: the rule/title/note must precede the ReviewTable's own toolbar, i.e.
  // live inside the same `.rp-review-section` wrapper, not just appear somewhere on
  // the page.
  const section = document.querySelector('.rp-review-section')
  expect(section?.contains(rule!)).toBe(true)
  expect(section?.contains(note!)).toBe(true)
  expect(section?.querySelector('.rp-review-toolbar')).not.toBeNull()
}

// `rec`'s admin-voice why is a known, pre-existing ~158-char exception to the 150-char
// evidence budget (see the plan's self-review notes); every other `why` must fit.
//
// Leaderboard's `outlow` used to be exempted here too: on a real five-digit evaluated
// count it ran to 153 characters, and the exemption was added so the rest of this
// file's assertions could run while the overage was reported. The sentence has since
// been trimmed (it said "games" twice, once over the evaluated count and once over the
// projection), so the exemption is GONE and the gate covers that act again.
//
// The remaining exception cannot be anchored to a stable DOM attribute (`.rp-do`
// carries only a React `key`, never rendered to an attribute - see the `.map((a) =>
// ...)` in ReportView.tsx's DoBlock), so the pattern matches the FULL distinctive
// clause `rec`'s copy is built from, not a loose keyword, and is verified (by grep
// against ReportView.tsx, 2026-09-22) to appear nowhere else in the component: the
// exact fixed sentence "no video has ever matched". If that act's copy changes, this
// regex must be revisited - it is deliberately narrow rather than a loose keyword so a
// future, unrelated `why` cannot coincidentally slip through it and mask a real
// overage.
const KNOWN_OVER_BUDGET_WHY = /no video has ever matched/i

function assertClean(lines: string[]) {
  lines.forEach((t) => {
    expect(t).not.toMatch(/\bNaN\b|\bundefined\b|\bInfinity\b/)
    expect(t).not.toMatch(/\b0 of 0\b/)
    expect(t).not.toMatch(/—/) // no em dashes in screen copy
  })
}

// The ReviewTable fetches `/api/evaluations` itself, on mount, twice (the
// newest-3-days probe, then the paginated page-1 fetch) - see fetchNewestDays and
// fetchPage in components/report/ReviewTable.tsx. This suite's `global.fetch` mock
// (set once in `renderTab`, for the WHOLE page) answers every call with the report
// bundle, which has no `.data` array, so both of those calls resolve to zero rows
// and the table settles on its own empty-state sentence. That sentence is real copy
// worth reading, not a stub artifact this test papers over - see task-7-report.md
// for what it says on each fixture. Waiting for `.rp-review-empty` (rather than
// asserting immediately) is what proves the two fetches actually resolved rather
// than the assertion running against the pre-fetch, still-loading frame.
async function waitForReviewTableSettled() {
  await waitFor(() => {
    const settled = document.querySelector('.rp-review-empty') || document.querySelector('.rp-review-row')
    expect(settled).not.toBeNull()
  }, { timeout: 10000 })
}

// The ReviewTable's own settled state, read back and logged - since `global.fetch`
// is not stubbed to answer `/api/evaluations` with a real evaluations shape (see
// waitForReviewTableSettled above), this is always the empty-state sentence in this
// suite, never a populated row. Printed so a human reads exactly what it says, not
// just that "something" rendered.
function dumpReviewTableState(label: string) {
  const empty = document.querySelector('.rp-review-empty')?.textContent?.trim() ?? null
  const rowCount = document.querySelectorAll('.rp-review-row').length
  // eslint-disable-next-line no-console
  console.log(`\n----- ${label} / ReviewTable state -----\n${empty ? `empty-state sentence: "${empty}"` : `${rowCount} row(s) rendered`}\n`)
}

// File-level, not per-test: rendering six real prod payloads through three tabs each
// and reading every sentence back is genuinely slow, not a hang - a future case added
// to this file inherits the same budget without needing to remember to raise it.
// Measured under `npx jest` (87 suites, parallel, this machine): the heaviest case
// (report-prod.json, three tabs) ranged 5-8.7s across five full-suite runs, and the
// task brief that found this defect measured ~33s on its own hardware under load.
// 45s covers both with real headroom rather than trimming coverage to fit 5s.
jest.setTimeout(45000)

describe('Report tabs read back as English on real (or real-derived) prod payloads', () => {
  afterEach(() => jest.restoreAllMocks())

  it('report-prod.json (real, admin, all-time, staleDays=7) - Overview/Leaderboard/Individual', async () => {
    const bundle = load('report-prod.json')
    for (const tab of ['Overview', 'Leaderboard', 'Individual'] as const) {
      const { unmount } = await renderTab(bundle, tab)
      const { lines } = dump(`report-prod.json / ${tab}`)
      assertClean(lines)
      const whys = Array.from(document.querySelectorAll('.rp-do-why')).map((n) => n.textContent!.trim())
      whys.forEach((t) => {
        if (KNOWN_OVER_BUDGET_WHY.test(t)) return
        expect(t.length).toBeLessThanOrEqual(150)
      })
      // staleDays in this real payload is 7, not 8. The "Do this: Age" act reads
      // d.staleDays through the shared `staleDays()` helper (Rescue's definition), so
      // its `why` must name the REAL threshold. (The Overview headline's separate
      // "Age" chip - see report-11-report.md's hand-read notes - names the fixed
      // 8-14d/15d+ backlog age bands instead, a different, unconfigurable metric; that
      // is not this assertion's concern and is flagged separately, not asserted here.)
      // Asserted only on Overview and Leaderboard, where a "past N days" why reliably
      // fires on THIS fixture (see the dump in task-11-report.md: Overview's `age`
      // rebalance act and Leaderboard's `queue` reassign act both name it; Individual
      // shows a different person - Ev2 - whose only act this window is `rec`, with
      // no stale-days sentence at all). Asserting `ageWhy` is found, not just `if
      // (ageWhy)`, keeps this from silently no-opping if either act stops rendering.
      if (tab === 'Overview' || tab === 'Leaderboard') {
        const ageWhy = Array.from(document.querySelectorAll('.rp-do-why'))
          .map((n) => n.textContent || '').find((t) => /past \d+ days/.test(t))
        expect(ageWhy).toBeDefined()
        expect(ageWhy).toMatch(/past 7 days/)
      }
      // Task 7: the rewritten chips + KPI sub-lines, read back on this real payload.
      if (tab === 'Leaderboard' || tab === 'Individual') {
        const { chips, kpis } = dumpChipsAndKpis(`report-prod.json / ${tab}`, { expectKpis: tab === 'Individual' })
        assertClean([...chips, ...kpis])
      }
      if (tab === 'Individual') {
        await waitForReviewTableSettled()
        dumpChipsAndKpis(`report-prod.json / ${tab} (after ReviewTable settled)`, { expectKpis: true })
        dumpReviewTableState(`report-prod.json / ${tab}`)
        assertRemovedBlocksAbsent()
        assertReviewSeparatorIsLast()
      }
      unmount()
    }
  })

  it('report-prod-batch-latest.json (real, admin, newest batch, pipeline present)', async () => {
    const bundle = load('report-prod-batch-latest.json')
    for (const tab of ['Overview', 'Leaderboard', 'Individual'] as const) {
      const { unmount } = await renderTab(bundle, tab)
      const { lines } = dump(`report-prod-batch-latest.json / ${tab}`)
      assertClean(lines)
      if (tab === 'Leaderboard' || tab === 'Individual') {
        const { chips, kpis } = dumpChipsAndKpis(`report-prod-batch-latest.json / ${tab}`, { expectKpis: tab === 'Individual' })
        assertClean([...chips, ...kpis])
      }
      if (tab === 'Individual') {
        await waitForReviewTableSettled()
        dumpReviewTableState(`report-prod-batch-latest.json / ${tab}`)
        assertRemovedBlocksAbsent()
        assertReviewSeparatorIsLast()
      }
      unmount()
    }
  })

  it('report-prod-batch-all.json (real, admin, "All batches", pipeline null)', async () => {
    const bundle = load('report-prod-batch-all.json')
    expect(bundle.pipeline).toBeNull()
    for (const tab of ['Overview', 'Leaderboard', 'Individual'] as const) {
      const { unmount } = await renderTab(bundle, tab)
      const { lines } = dump(`report-prod-batch-all.json / ${tab}`)
      assertClean(lines)
      if (tab === 'Leaderboard' || tab === 'Individual') {
        const { chips, kpis } = dumpChipsAndKpis(`report-prod-batch-all.json / ${tab}`, { expectKpis: tab === 'Individual' })
        assertClean([...chips, ...kpis])
      }
      if (tab === 'Individual') {
        await waitForReviewTableSettled()
        dumpReviewTableState(`report-prod-batch-all.json / ${tab}`)
        assertRemovedBlocksAbsent()
        assertReviewSeparatorIsLast()
      }
      unmount()
    }
  })

  it('report-prod-no-receivers.json (real sources, patched to zero receivers) - rebalance must not print, fallback must', async () => {
    const bundle = load('report-prod-no-receivers.json')
    const { unmount } = await renderTab(bundle, 'Overview')
    const { lines } = dump('report-prod-no-receivers.json / Overview')
    assertClean(lines)
    // The rebalance act's button is an <a className="rp-do-cta" href={...}>; its
    // textContent is only the visible label ("Open Rescue"), never the href, so a
    // URL substring can never appear in `lines` (those come from .textContent) - it
    // has to be read off the actual DOM attribute. See the CTA render at
    // ReportView.tsx ~line 570 and the contractor test above, which reads hrefs the
    // same way.
    const ctaHrefs = Array.from(document.querySelectorAll('a.rp-do-cta'))
      .map((a) => a.getAttribute('href') || '')
    expect(ctaHrefs.some((h) => /tab=rescue&flash=/.test(h))).toBe(false)
    // And the fallback (`holders`) act - which fires exactly where `rebalance`
    // cannot, per the `canRebalance` gate at ReportView.tsx ~line 936 - must
    // positively be there instead of the block just going silent.
    expect(lines.some((t) => /^Put the/.test(t))).toBe(true)
    unmount()
  })

  it('report-prod-contractor.json (real numbers, hand-applied scoped shape) - canSeeTeam false, no tab bar, no operation buttons', async () => {
    const bundle = load('report-prod-contractor.json')
    expect(bundle.canSeeTeam).toBe(false)
    expect(bundle.rescue).toBeNull()
    expect(bundle.selfStale).not.toBeNull()
    const { unmount } = await renderTab(bundle)
    // A contractor has no tab bar to click - this IS the whole report for them.
    expect(screen.queryByRole('button', { name: 'Overview' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Leaderboard' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Individual' })).toBeNull()
    const { lines } = dump('report-prod-contractor.json / self view')
    assertClean(lines)
    // No operation button anywhere on a contractor's own page - Rescue/Reassign/
    // Assign are manager surfaces.
    const links = Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href') || '')
    links.forEach((href) => {
      expect(href).not.toMatch(/tab=rescue|tab=reassign|tab=assign/)
    })
    // A contractor's whole page IS the Individual tab, in the contractor (second-
    // person) voice - `self` is true throughout ReportView's Individual render, so
    // this is the one fixture that actually exercises the "you" wording (net/wait)
    // rather than the admin ("their name") wording every other fixture above reads.
    const { chips, kpis } = dumpChipsAndKpis('report-prod-contractor.json / self view', { expectKpis: true })
    assertClean([...chips, ...kpis])
    await waitForReviewTableSettled()
    dumpReviewTableState('report-prod-contractor.json / self view')
    assertRemovedBlocksAbsent()
    assertReviewSeparatorIsLast()
    unmount()
  })

  it('report-prod-healthy.json (synthetic, nothing crosses a threshold) - Do block prints nothing', async () => {
    const bundle = load('report-prod-healthy.json')
    for (const tab of ['Overview', 'Leaderboard', 'Individual'] as const) {
      const { unmount } = await renderTab(bundle, tab)
      const { lines } = dump(`report-prod-healthy.json / ${tab}`)
      expect(lines).toHaveLength(0)
      if (tab === 'Leaderboard' || tab === 'Individual') {
        const { chips, kpis } = dumpChipsAndKpis(`report-prod-healthy.json / ${tab}`, { expectKpis: tab === 'Individual' })
        assertClean([...chips, ...kpis])
      }
      if (tab === 'Individual') {
        await waitForReviewTableSettled()
        dumpReviewTableState(`report-prod-healthy.json / ${tab}`)
        assertRemovedBlocksAbsent()
        assertReviewSeparatorIsLast()
      }
      unmount()
    }
  })
})
