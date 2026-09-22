import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReportView } from '@/components/report/ReportView'

// Same idiom as report-individual.test.tsx / report-url-state.test.tsx: ReportView
// reads ?rtab=/?focus= via next/navigation, which this file does not exercise.
jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: jest.fn() }),
  usePathname: () => '/team-ops',
}))

jest.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 1, role: 'evaluator', name: 'Alpha' } }, status: 'authenticated' }),
}))

// Task 10: the Individual tab as a contractor reads it. `canSeeTeam` is false for
// them, `SELF_TABS` leaves them on this one tab alone, and every line here must be
// something they can act on by themselves this week - no operation button, because
// they cannot run one.
//
// This is NOT a second act list: the self reading reuses the exact acts the admin
// reading uses (stale/callow/behind/rec, keyed `stale|callow|behind|rec` in the DOM),
// switched by the existing `self` flag and `They`/`their`/`Their` helpers, plus two
// acts that fire ONLY in the self reading (`rhythm`, `up`).

type Bundle = Record<string, unknown>

// A window where nothing crosses a threshold: intake matches output, the bar matches
// the team (leave-one-out), nothing is stale by the Rescue definition, no recording is
// stuck, and this window's per-day pace matches both their own last window and the
// team's. Each test below breaks exactly one of those.
function selfBundle(over: Partial<{
  selfStale: number
  evaluated: number
  assigned: number
  throughput: number
  activeDays: number
  survivalRate: number
  prevThroughput: number
  prevActiveDays: number
  prevSurvival: number
  benchThroughput: number
  benchSurvival: number
  stuckVideos: number
}> = {}): Bundle {
  const evaluated = over.evaluated ?? 300
  const assigned = over.assigned ?? evaluated
  const activeDays = over.activeDays ?? 20
  const throughput = over.throughput ?? 15
  const survivalRate = over.survivalRate ?? 0.1
  const shortlisted = Math.round(evaluated * survivalRate)
  const selfStale = over.selfStale ?? 0
  const benchSurvival = over.benchSurvival ?? survivalRate
  const benchThroughput = over.benchThroughput ?? throughput
  // The rest of the team, leave-one-out: `callow`/`calhigh` compare this person
  // against everyone ELSE, never a pool they are inside (report-individual.test.tsx
  // "LEAVE ONE OUT" rule). Built FROM `benchSurvival` so the two stay consistent, the
  // way they would on a real roster where one person is a small share of the total.
  const restEvaluated = 1000
  const restShortlisted = Math.round(restEvaluated * benchSurvival)

  const stuckVideos = over.stuckVideos ?? 0

  const prev = over.prevThroughput != null || over.prevActiveDays != null || over.prevSurvival != null
    ? {
      from: '2026-08-25', to: '2026-09-01', label: 'last week',
      evaluated: 280,
      survivalRate: over.prevSurvival ?? survivalRate,
      signalRate: 0.01,
      personDayThroughput: over.prevThroughput ?? throughput,
      ...(over.prevActiveDays != null ? { activeDays: over.prevActiveDays } : {}),
    }
    : null

  const evaluator = {
    key: 'k0', name: 'Alpha', title: null,
    assigned, evaluated, activeDays, throughput,
    turnaround: 2, signalRate: evaluated ? 0.01 : 0, consistency: 1,
    shortlisted, priorityIV: 2, insight: 1, finalPriority: evaluated ? 3 : 0,
    survivalRate,
    linkDead: 0, noted: evaluated, noteRate: 1,
    recorded: 2, rec5: 1, rec20: 1,
    initialConclusions: evaluated ? { Bypass: evaluated - shortlisted, List_Idea: shortlisted } : {},
    finalConclusions: { 'Priority IV': 2, 'Theme/Art': 1 },
  }

  return {
    empty: false, canSeeTeam: false, view: 'week', category: 'puzzle',
    window: { label: 'W1 Sep 2026', from: '2026-09-01', to: '2026-09-07' },
    bucketUnit: 'day', activityUnit: 'day',
    options: { week: [], month: [], quarter: [], batch: [] },
    teamTotals: {
      evaluators: 6, totalAssigned: restEvaluated + assigned, totalEvaluated: restEvaluated + evaluated,
      avgThroughput: benchThroughput, personDayThroughput: benchThroughput, avgTurnaround: 2,
      signalRate: 0.01, survivalRate: benchSurvival,
      totalRecorded: 10, linkDead: 0, noteRate: 1,
    },
    bench: {
      people: 6, evaluated: (restEvaluated + evaluated) / 6,
      throughput: benchThroughput, turnaround: 2, survivalRate: benchSurvival,
      signalRate: 0.01, noteRate: 1, perDay: {},
    },
    baseline: null, prev, self: 'k0',
    staleDays: 8, selfStale, rescue: null,
    funnel: {
      // team-wide, per the route (d.funnel is never scoped) - "the rest of the team"
      // this person is measured against is everyone ELSE in it.
      assigned: restEvaluated + assigned, evaluated: restEvaluated + evaluated,
      shortlisted: restShortlisted + shortlisted,
      priorityIV: 8, insight: 4, finalPriority: 12,
    },
    initialConclusions: [], finalConclusions: [],
    series: [], metricSeries: [], heatmap: { periods: [], rows: [] },
    config: {
      excluded: [], included: true,
      weights: { Volume: 40, Consistency: 15, Signal: 15, Survival: 15, Recording: 15 },
      credibility: true,
    },
    personSeries: { k0: [] },
    videos: { k0: Array.from({ length: stuckVideos }, (_, i) => ({
      gameId: `g${i}`, title: `Game ${i}`, os: 'android', slot: '5min', batch: null,
      recordedOn: '2026-08-01', confirmedOn: '2026-08-01', youtube: null,
    })) },
    dailyMix: { k0: {} },
    backlogBy: [{ key: 'k0', name: 'Alpha', n: 200, a0: 150, a1: 30, a2: 15, a3: 5, oldest: 40, stale: selfStale }],
    personMoves: { k0: [] },
    evaluators: [evaluator],
    radar: [{ key: 'k0', name: 'Alpha', axes: { Volume: 80, Consistency: 90, Signal: 60, Survival: 70, Recording: 50 } }],
    pipeline: null,
  }
}

async function renderTab(bundle: Bundle) {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => bundle }) as unknown as typeof fetch
  const view = render(<ReportView />)
  await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument())
  return view
}

describe('Individual tab, read by a contractor', () => {
  it('offers no operation a contractor is not allowed to run', async () => {
    await renderTab(selfBundle({ selfStale: 34 }))
    const block = screen.getByText('Do this').closest('.rp-do-block')!
    expect(block.querySelectorAll('a[href*="tab=rescue"], a[href*="tab=reassign"], a[href*="tab=assign"]'))
      .toHaveLength(0)
    // Law 4: a contractor's card carries no operation at all - not a link, not a
    // button. Individual's mapping into `DoBlock` does not forward `cta` today, so
    // this goes red the day that mapping starts forwarding one and a self-voice act
    // carries it.
    //
    // The card count is asserted FIRST and on purpose. "No buttons" over an empty
    // block passes for the wrong reason, and both of the assertions this replaces
    // were counting collections that are empty whatever the code does - one of them
    // a strictly narrower duplicate of the other.
    const cards = block.querySelectorAll('.rp-do')
    expect(cards.length).toBeGreaterThan(0)
    expect(block.querySelectorAll('.rp-do-cta')).toHaveLength(0)
  })

  // Adapted from the brief: the brief's `throughput: 62` is a DECREASE from its own
  // `prevThroughput: 78` (62 < 78), so it can never legitimately cross `up`'s ">20%
  // increase" gate - the only output-shaped act this tab has is good news only,
  // by design (see the `up` test below and the binding constraint that it must never
  // read as a complaint). Bumped `throughput` to a genuine >20% rise so this test
  // actually exercises the code path its name promises, and reused for evidence that
  // BOTH references print on that same line.
  it('carries both references on a line about output', async () => {
    await renderTab(selfBundle({ throughput: 96, prevThroughput: 78, benchThroughput: 74 }))
    const block = screen.getByText('Do this').closest('.rp-do-block')!
    expect(block.textContent).toContain('78')   // their own previous window
    expect(block.textContent).toContain('74')   // the team
  })

  it('triggers the bar line against the team, not against themselves', async () => {
    // Their own rate has not moved (prevSurvival === survivalRate); it is the team
    // they are far from - `bar` never reads `d.prev` at all.
    await renderTab(selfBundle({ survivalRate: 0.03, prevSurvival: 0.03, benchSurvival: 0.09, evaluated: 420 }))
    expect(screen.getByText(/send your last 5 bypasses/i)).toBeInTheDocument()
  })

  // Adapted from the brief: the brief's assertion (`not.toMatch(/slower than the
  // team/i)`) checks for a phrase this implementation never writes anywhere, in
  // either voice, so it could not fail no matter what the code did - it had no teeth.
  // What the scenario is actually guarding (a freelancer's low active-day COUNT must
  // not read as a fault when their own per-day pace hasn't dropped, and Law 6 says a
  // contractor with nothing wrong sees nothing) is checked directly: no "Do this"
  // block renders at all.
  it('does not turn red for a freelancer working fewer days', async () => {
    await renderTab(selfBundle({ activeDays: 6, throughput: 90, prevThroughput: 90, benchThroughput: 74 }))
    expect(screen.queryByText('Do this')).toBeNull()
  })

  it('says something good when something got better', async () => {
    await renderTab(selfBundle({ throughput: 96, prevThroughput: 70 }))
    expect(screen.getByText(/up from/i)).toBeInTheDocument()
  })

  /* And says it in green. `DoBlock` only separated sev >= 3, so everything else took
     the base amber warning border and tint - printing "Keep the change you made this
     week" as a caution, which is the opposite of the reason that line exists, on the
     one tab a contractor ever sees. */
  it('prints the good-news line as good news, not as a warning', async () => {
    await renderTab(selfBundle({ throughput: 96, prevThroughput: 70 }))
    const card = screen.getByText(/keep the change you made/i).closest('.rp-do')!
    expect(card.classList.contains('good')).toBe(true)
    expect(card.classList.contains('urgent')).toBe(false)
  })

  // A warning still looks like one. Reading the `good` class off the severity has to
  // leave the other two tiers alone.
  it('still prints a real problem as a warning', async () => {
    await renderTab(selfBundle({ selfStale: 120 }))
    const card = screen.getByText(/start each day with your 5 oldest games/i).closest('.rp-do')!
    expect(card.classList.contains('good')).toBe(false)
    expect(card.classList.contains('urgent')).toBe(true)
  })

  it('prints nothing when nothing crossed a threshold', async () => {
    await renderTab(selfBundle({}))
    expect(screen.queryByText('Do this')).toBeNull()
  })

  // ---- extra coverage past the brief: the two seams the six-line list above cannot
  // see from the outside ----

  it('fires the stale line off d.selfStale, the same number Rescue would show', async () => {
    // Below the admin-only band-share gate (STALE.min=60, share=0.25) but at/above
    // the self-only floor (>=5) - proves the self reading reads `selfStale`, not the
    // admin `queueStale`/band-share test.
    await renderTab(selfBundle({ selfStale: 5 }))
    expect(screen.getByText(/start each day with your 5 oldest games/i)).toBeInTheDocument()
  })

  /* Both voices of the `stale` act price the same backlog the same way, because the
     instruction on the card is the same in both: five oldest a day. The admin side is
     pinned at 24 days for these same 120 games in report-individual.test.tsx ("prices
     the stale backlog at the five a day it just asked for"). They used to disagree by
     25x - the admin side divided by the person's whole measured pace instead. */
  it('prices the stale backlog at five a day, the same as a manager sees it', async () => {
    await renderTab(selfBundle({ selfStale: 120 }))
    const block = screen.getByText('Do this').closest('.rp-do-block')!
    expect(block.textContent).toContain('Start each day with your 5 oldest games')
    expect(block.textContent).toContain('Your stale games gone in about 24 days')
  })

  it('never fires rhythm without a real reference for their own last window', async () => {
    // activeDays crashed to a third, but `d.prev.activeDays` is absent (an admin
    // bundle, or a client built before the field existed) - Law 6: no fallback act,
    // so this prints nothing rather than guessing what "normal" was.
    await renderTab(selfBundle({ activeDays: 2, throughput: 90, prevThroughput: 90 }))
    expect(screen.queryByText('Do this')).toBeNull()
  })

  it('fires rhythm when active days genuinely fell against their own last window', async () => {
    await renderTab(selfBundle({ activeDays: 4, prevActiveDays: 10, throughput: 90, prevThroughput: 90, benchThroughput: 74 }))
    expect(screen.getByText(/spread the same work over more days/i)).toBeInTheDocument()
  })

  it('caps `up` below every other severity so it can never displace a red line', async () => {
    // Four acts qualify at once - stale, callow, rec and up - so the cap of three
    // actually has something to exclude. `up` is `sev: 0`, the lowest of any act on
    // this tab, so it must be the one left out, never one of the three red/amber
    // lines. (An earlier version of this test only had two qualifying acts, so the
    // cap was never exercised and it could not have failed no matter what `up`'s
    // severity was - this fixture adds `callow` and `rec` so it actually can.)
    await renderTab(selfBundle({
      selfStale: 40, survivalRate: 0.03, benchSurvival: 0.09, evaluated: 420,
      stuckVideos: 2, throughput: 96, prevThroughput: 70,
    }))
    const block = screen.getByText('Do this').closest('.rp-do-block')!
    expect(block.querySelectorAll('.rp-do')).toHaveLength(3)
    expect(block.textContent).toMatch(/start each day with your 5 oldest games/i)
    expect(block.textContent).toMatch(/send your last 5 bypasses/i)
    expect(block.textContent).toMatch(/check your 2 recordings/i)
    expect(block.textContent).not.toMatch(/keep the change you made/i)
  })

  // Task 1: the `net`/`wait` chips must read correctly in BOTH voices. The admin
  // suite (report-individual.test.tsx) covers the third-person reading; this proves
  // the second-person one - "their" becomes "your" - reads naturally too, including
  // the zero case, which is its own sentence rather than a signed "0 games".
  const IND_KICKER: Record<string, string> = { share: 'OUTPUT', net: 'GROWTH', wait: 'AGE' }
  const verdictChipText = (c: HTMLElement, key: string) =>
    (Array.from(c.querySelectorAll('.rp-verdict .rp-chip'))
      .find((chip) => chip.querySelector('.rp-chip-kicker')?.textContent === IND_KICKER[key])
      ?.querySelector('.rp-chip-text')?.textContent || '').replace(/\s+/g, ' ').trim()

  it('reads the net chip in the second-person voice when the backlog grew', async () => {
    const b = selfBundle({ assigned: 636, evaluated: 600 }) as Record<string, unknown>
    b.personSeries = { k0: [{ key: 'b1', label: 'b1', assigned: 636, evaluated: 600, linkDead: 0 }] }
    const { container } = await renderTab(b)
    expect(verdictChipText(container, 'net')).toBe('36 games joined your backlog this week')
  })

  it('reads the net chip in the second-person voice when the backlog shrank', async () => {
    const b = selfBundle({ assigned: 600, evaluated: 636 }) as Record<string, unknown>
    b.personSeries = { k0: [{ key: 'b1', label: 'b1', assigned: 600, evaluated: 636, linkDead: 0 }] }
    const { container } = await renderTab(b)
    expect(verdictChipText(container, 'net')).toBe('36 games cleared from your backlog this week')
  })

  it('reads the net chip in the second-person voice with its own wording for zero, not a signed zero', async () => {
    const b = selfBundle({ assigned: 600, evaluated: 600 }) as Record<string, unknown>
    b.personSeries = { k0: [{ key: 'b1', label: 'b1', assigned: 600, evaluated: 600, linkDead: 0 }] }
    const { container } = await renderTab(b)
    const zeroNet = verdictChipText(container, 'net')
    expect(zeroNet).toBe('No games joined or cleared from your backlog this week')
    expect(zeroNet).not.toMatch(/[-+]0 games/)
  })

  it('reads the wait chip in the second-person voice', async () => {
    const { container } = await renderTab(selfBundle({}))
    // selfBundle()'s default backlogBy: n=200, oldest=40
    expect(verdictChipText(container, 'wait')).toBe('200 games waiting, the oldest sat 40 days')
  })

  it('reads the wait chip in the second-person voice for an empty backlog', async () => {
    const b = selfBundle({}) as Record<string, unknown>
    b.backlogBy = [{ key: 'k0', name: 'Alpha', n: 0, a0: 0, a1: 0, a2: 0, a3: 0, oldest: 0, stale: 0 }]
    const { container } = await renderTab(b)
    expect(verdictChipText(container, 'wait')).toBe('Nothing is waiting in your backlog')
  })
})
