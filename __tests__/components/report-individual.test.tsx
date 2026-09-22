import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReportView } from '@/components/report/ReportView'

// ReportView now reads ?rtab=/?focus= (Task 5); this file doesn't exercise that, so a
// static stub is enough - same idiom as report-url-state.test.tsx.
jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: jest.fn() }),
  usePathname: () => '/team-ops',
}))

// The Individual tab's contract after the 2026-09-16 redesign. Same reading contract
// as Overview and Leaderboard, plus the two things that are only true here:
//
//   1. Guide, then one sentence, then chips, then AT MOST THREE moves. Five KPIs, not
//      twelve. Nothing is folded behind a toggle and no card carries its own "Act".
//   2. "Backlog" is a STOCK. It is the only number on the tab the window filter does
//      not reach, and it is this person's slice of the same backlog Overview counts.
//   3. Every comparison against the team LEAVES THIS PERSON OUT. One evaluator judges
//      a third of all games on the real roster, so a pool they are inside moves
//      towards them - and the further out they are, the harder it hides them.
//   4. An evaluator's own bundle carries no team series at all, so the team overlay on
//      the quality chart falls back to a flat window average instead of plotting the
//      empty map as 0%.
//   5. A percentage and the benchmark it is compared against never print identically.

jest.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 1, role: 'admin', name: 'Admin' } }, status: 'authenticated' }),
}))

type Bundle = Record<string, unknown>
const BUCKETS = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6']

type P = {
  name: string; evaluated: number; shortlisted: number; assigned: number
  turnaround: number | null; recorded: number
}
const person = (name: string, over: Partial<P> = {}): P => ({
  name, evaluated: 600, shortlisted: 60, assigned: 600, turnaround: 2, recorded: 2, ...over,
})

// A window where nothing crosses a threshold: two people at the same output, the same
// bypass bar, clearing what they are given, with nothing stale and no lost videos.
// Each test breaks exactly one of those, so a failure names the rule that moved.
function bundleOf(people: P[], patch: Bundle = {}): Bundle {
  const evaluators = people.map((p, i) => ({
    key: `k${i}`, name: p.name, title: null,
    assigned: p.assigned, evaluated: p.evaluated,
    activeDays: p.evaluated > 0 ? 6 : 0, throughput: p.evaluated / 6,
    turnaround: p.turnaround, signalRate: p.evaluated ? 0.01 : 0, consistency: 1,
    shortlisted: p.shortlisted, priorityIV: 2, insight: 1, finalPriority: p.evaluated ? 3 : 0,
    survivalRate: p.evaluated ? p.shortlisted / p.evaluated : 0,
    linkDead: 0, noted: p.evaluated, noteRate: 1,
    recorded: p.recorded, rec5: 1, rec20: 1,
    initialConclusions: p.evaluated ? { Bypass: p.evaluated - p.shortlisted, List_Idea: p.shortlisted } : {},
    finalConclusions: { 'Priority IV': 2, 'Theme/Art': 1 },
  }))
  const totalEvaluated = people.reduce((s, p) => s + p.evaluated, 0)
  const totalShort = people.reduce((s, p) => s + p.shortlisted, 0)
  return {
    empty: false, canSeeTeam: true, view: 'week', category: 'puzzle',
    window: { label: 'W1 Sep 2026', from: '2026-09-01', to: '2026-09-07' },
    bucketUnit: 'day', activityUnit: 'day',
    options: { week: [], month: [], quarter: [], batch: [] },
    teamTotals: {
      evaluators: people.length, totalAssigned: totalEvaluated, totalEvaluated,
      avgThroughput: 100, personDayThroughput: 100, avgTurnaround: 2,
      signalRate: 0.01, survivalRate: totalShort / totalEvaluated,
      totalRecorded: 4, linkDead: 0, noteRate: 1,
    },
    bench: {
      people: people.length, evaluated: totalEvaluated / people.length,
      throughput: 100, turnaround: 2, survivalRate: totalShort / totalEvaluated,
      signalRate: 0.01, noteRate: 1, perDay: {},
    },
    baseline: null, prev: null, self: null,
    staleDays: 8, selfStale: null, rescue: null,
    funnel: {
      assigned: totalEvaluated, evaluated: totalEvaluated, shortlisted: totalShort,
      priorityIV: 8, insight: 4, finalPriority: 12,
    },
    initialConclusions: [], finalConclusions: [],
    series: [],
    // the team's own per-bucket rates, for the overlay on the quality chart
    metricSeries: BUCKETS.map((b) => ({
      key: b, label: b, volume: 100, assigned: 100, evaluated: 100,
      shortlisted: Math.round((totalShort / totalEvaluated) * 100),
      priorityIV: 1, insight: 1, finalPriority: 2, personDays: 1,
      signalRate: 0.01, survivalRate: totalShort / totalEvaluated,
    })),
    heatmap: { periods: [], rows: [] },
    config: {
      excluded: [], included: true,
      weights: { Volume: 40, Consistency: 15, Signal: 15, Survival: 15, Recording: 15 },
      credibility: true,
    },
    personSeries: Object.fromEntries(people.map((p, i) => [`k${i}`, BUCKETS.map((b) => ({
      key: b, label: b,
      assigned: Math.round(p.assigned / BUCKETS.length),
      evaluated: Math.round(p.evaluated / BUCKETS.length),
      shortlisted: Math.round(p.shortlisted / BUCKETS.length),
      linkDead: 0,
    }))])),
    videos: {}, dailyMix: {},
    // everyone is holding a fresh backlog: nothing past 3 days
    backlogBy: people.map((p, i) => ({
      key: `k${i}`, name: p.name, n: 120, a0: 120, a1: 0, a2: 0, a3: 0, oldest: 2, stale: 0,
    })),
    // and clearing it faster than it ages: judged fresh, nothing crossing a boundary
    personMoves: Object.fromEntries(people.map((p, i) => [`k${i}`, BUCKETS.map((b) => ({
      key: b, label: b,
      cleared: [Math.round(p.evaluated / BUCKETS.length), 0, 0, 0],
      aged: [0, 0, 0],
    }))])),
    evaluators,
    radar: people.map((p, i) => ({
      key: `k${i}`, name: p.name,
      axes: { Volume: 80, Consistency: 90, Signal: 60, Survival: 70, Recording: 50 },
    })),
    pipeline: null,
    ...patch,
  }
}

const TWO = () => [person('Alpha'), person('Beta')]

// The tab defaults to Overview and this fixture is Individual-shaped (no pipeline, no
// team series), so Overview renders once against degenerate data before the click. That
// is where the "Received NaN" warnings in this suite come from; the Individual DOM they
// leave behind is clean, and a sweep of every real prod payload across all three tabs
// finds no NaN attribute anywhere.
async function individual(bundle: Bundle) {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => bundle }) as unknown as typeof fetch
  const view = render(<ReportView />)
  await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument())
  // A scoped evaluator has no tab bar to click: this panel is the whole report for them.
  const tab = screen.queryByRole('button', { name: 'Individual' })
  if (tab) fireEvent.click(tab)
  return view
}

const txt = (el: Element | null) => (el?.textContent || '').replace(/\s+/g, ' ').trim()
const actions = (c: HTMLElement) => Array.from(c.querySelectorAll('.rp-do')).map((el) => ({
  do: txt(el.querySelector('.rp-do-line')), why: txt(el.querySelector('.rp-do-why')),
}))
const kpis = (c: HTMLElement) => Array.from(c.querySelectorAll('.rp-kpi'))
  .map((k) => txt(k.querySelector('.rp-kpi-label')))
const nowLines = (c: HTMLElement) => Array.from(c.querySelectorAll('.rp-foot-now')).map(txt)

describe('Individual tab', () => {
  it('leads with a sentence, chips and at most three moves, and carries five KPIs', async () => {
    const { container } = await individual(bundleOf(TWO()))
    const order = Array.from(container.querySelectorAll('.rp-guide, .rp-headline, .rp-chips, .rp-kpi-row'))
    const marks = ['rp-guide', 'rp-headline', 'rp-chips', 'rp-kpi-row']
    expect(order.map((el) => marks.find((m) => el.classList.contains(m)))).toEqual(marks)
    expect(kpis(container)).toEqual(['Evaluated', 'Backlog', 'Games per day', 'Days waiting', 'Shortlist rate'])
    // The guide is the ONE thing on these tabs that folds, and it starts folded. Nothing
    // else does: a chart or a number hidden behind a toggle is a number nobody reads.
    const toggle = container.querySelector('.rp-guide button')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.rp-guide .read')).toBeNull()
    expect(container.querySelectorAll('button[aria-expanded]')).toHaveLength(1)
    expect(container.querySelector('details')).toBeNull()
  })

  it('drops the twelve-KPI blocks the redesign removed', async () => {
    const { container } = await individual(bundleOf(TWO()))
    const body = txt(container)
    // Note coverage went when a note became mandatory in the form: it reads ~100% for
    // everyone and separates nobody. It comes back only as note QUALITY, scored.
    expect(body).not.toContain('Note coverage')
    // three per-day tiles of one distribution became the conclusion-flow bar
    expect(kpis(container)).not.toContain('Bypass / day')
    expect(kpis(container)).not.toContain('List_Idea / day')
    // two donuts became one two-tier bar
    expect(container.querySelector('.rp-donut-wrap')).toBeNull()
    expect(container.querySelectorAll('.rp-tiers')).toHaveLength(1)
    // an Act under every chart is how a tab ends up with eight actions and therefore
    // none. Actions live in "Do this" and nowhere else.
    expect(container.querySelectorAll('.rp-act')).toHaveLength(0)
  })

  it('prints no moves when nothing crosses a threshold', async () => {
    const { container } = await individual(bundleOf(TWO()))
    expect(actions(container)).toEqual([])
    expect(container.querySelector('.rp-headline'))
      .toHaveTextContent('Alpha is keeping up, and their picks hold up.')
  })

  it('reads Backlog as a stock, not as part of the window', async () => {
    // The whole tab is window-scoped except this one number. A reader who assumes
    // otherwise concludes that 120 games arrived and stalled inside one week.
    const { container } = await individual(bundleOf(TWO()))
    const waiting = Array.from(container.querySelectorAll('.rp-kpi'))
      .find((k) => txt(k.querySelector('.rp-kpi-label')).startsWith('Backlog'))!
    expect(txt(waiting.querySelector('.rp-kpi-value'))).toBe('120')
    expect(txt(waiting.querySelector('.rp-kpi-sub'))).toContain('all history')
    // ...and the tab says so where the reader can see it without opening anything. The
    // guide says it too, but the guide now starts closed, so the guide cannot be the
    // only place a number's scope is stated.
    expect(txt(container)).toContain('the week filter does not reach it')
    // One backlog, one word, on all three tabs - it used to be "Waiting" here, "Queue"
    // in the chip above it and "Backlog" on Overview, for the same games.
    expect(txt(container)).not.toContain('Waiting by age')
    expect(Array.from(container.querySelectorAll('.rp-chips .rp-chip')).map(txt)
      .some((c) => c.startsWith('Backlog'))).toBe(true)
    // and it carries no bench: a stock has no team average to be above or below
    expect(waiting.querySelector('.rp-kpi-bench')).toBeNull()
  })

  it('leaves the person out of the team rate they are compared with', async () => {
    // Alpha judges 1,000 of 1,100 games and keeps 1%. Against a pool that includes
    // their own 1,000 games the team rate is 5.5% and Alpha is only 5.5x under; against
    // everyone ELSE it is 50%, and Alpha is 50x under. The bigger the gap, the harder
    // self-inclusion works to hide it - which is exactly backwards.
    const { container } = await individual(bundleOf([
      person('Alpha', { evaluated: 1000, shortlisted: 10, assigned: 1000 }),
      person('Beta', { evaluated: 100, shortlisted: 50, assigned: 100 }),
    ]))
    const why = actions(container).find((a) => a.do.includes('bypassed'))!.why
    expect(why).toContain('the rest of the team keeps 50%')
    expect(why).not.toContain('5.5%')
  })

  it('never prints a rate and its benchmark as the same number', async () => {
    // 6.8% against 7.3% both round to "7%", and the badge between them then claims to
    // be the gap between two figures the reader can see are identical.
    const { container } = await individual(bundleOf([
      person('Alpha', { evaluated: 1000, shortlisted: 68 }),
      person('Beta', { evaluated: 1000, shortlisted: 78 }),
    ]))
    const sr = Array.from(container.querySelectorAll('.rp-kpi'))
      .find((k) => txt(k.querySelector('.rp-kpi-label')).startsWith('Shortlist rate'))!
    const value = txt(sr.querySelector('.rp-kpi-value'))
    const bench = txt(sr.querySelector('.rp-kpi-bench'))
    expect(bench).not.toBe('')
    expect(bench.includes(`team ${value}`)).toBe(false)
    // both sides moved to a decimal together, rather than one of them alone
    expect(value).toBe('6.8%')
    expect(bench).toContain('7.3%')
  })

  it('falls back to a flat team average when the bundle carries no team series', async () => {
    // An evaluator's payload has `metricSeries` EMPTIED, not filtered. Reading the
    // empty map per bucket drew the team flat along 0%, which is not "no data" - it
    // reads as the team having bypassed everything.
    const { container } = await individual(bundleOf(TWO(), { metricSeries: [] }))
    const legend = txt(container)
    expect(legend).toContain('Team, week average')
    // and no series is plotted at zero
    expect(legend).not.toContain('Team 0%')
  })

  it('names the stale backlog, and only past both gates, as coaching not an operation', async () => {
    const fresh = await individual(bundleOf(TWO()))
    expect(actions(fresh.container).some((a) => a.do.includes('5 oldest games'))).toBe(false)
    fresh.unmount()
    // 40 stale games is noise; 30% of a backlog of 400 is not
    const { container } = await individual(bundleOf(TWO(), {
      backlogBy: [{ key: 'k0', name: 'Alpha', n: 400, a0: 200, a1: 80, a2: 100, a3: 20, oldest: 21, stale: 120 }],
    }))
    const act = actions(container).find((a) => a.do.includes('5 oldest games'))!
    expect(act.do).toContain('Ask Alpha')
    expect(act.why).toContain('120 of their 400 games')
    expect(act.why).toContain('oldest 21')
    // this tab coaches the person, it does not move their games - Leaderboard already did
    expect(act.do).not.toMatch(/Rescue|Reassign/)
  })

  it('guards the stale payoff against a zero throughput', async () => {
    // Alpha has judged nothing this window (throughput = evaluated / activeDays = 0)
    // but is still sitting on a real stale backlog - the one case the payoff's
    // division is guarded for. Dividing by the raw throughput here would print
    // "Infinity working days" on screen.
    const { container } = await individual(bundleOf([
      person('Alpha', { evaluated: 0, assigned: 600 }),
      person('Beta'),
    ], {
      backlogBy: [
        { key: 'k0', name: 'Alpha', n: 400, a0: 200, a1: 80, a2: 100, a3: 20, oldest: 21, stale: 120 },
        { key: 'k1', name: 'Beta', n: 120, a0: 120, a1: 0, a2: 0, a3: 0, oldest: 2, stale: 0 },
      ],
    }))
    const payoff = txt(container.querySelector('.rp-do-payoff'))
    expect(payoff).toBe('Their stale games clear in about 120.0 working days')
    expect(payoff).not.toMatch(/Infinity|NaN/)
  })

  it('never offers to move games - that was decided on Leaderboard', async () => {
    const { container } = await individual(bundleOf(TWO(), {
      backlogBy: [{ key: 'k0', name: 'Alpha', n: 400, a0: 200, a1: 80, a2: 100, a3: 20, oldest: 21, stale: 120 }],
    }))
    const block = container.querySelector('.rp-do-block')!
    expect(txt(block)).not.toMatch(/Rescue|Reassign|move .* queue|move .* backlog/i)
  })

  it('does not repeat the Leaderboard idle line', async () => {
    const { container } = await individual(bundleOf([
      person('Alpha', { evaluated: 0, assigned: 600 }),
      person('Beta'),
    ]))
    expect(txt(container)).not.toMatch(/whether it is leave/i)
  })

  it('says a direction only when the two printed rates differ', async () => {
    // "7% -> 8%, holding steady" contradicted itself inside six words: the word came
    // from a threshold and the numbers from a rounder, and the two disagreed.
    const { container } = await individual(bundleOf(TWO()))
    const now = nowLines(container).find((n) => n.includes('the rate went'))
    if (now) {
      const m = now.match(/the rate went ([\d.]+%) → ([\d.]+%), (\w+)/)!
      expect(m[3] === 'steady' || m[3] === 'holding').toBe(m[1] === m[2])
    }
    // every footer carries a reading, and none of them is an instruction
    const all = nowLines(container)
    expect(all.length).toBeGreaterThanOrEqual(5)
    expect(all.some((n) => /^Now(Ask|Have|Move|Run|Re-read|Clear|Check) /.test(n))).toBe(false)
  })

  it('draws judged against aged, and reads the two as movement rather than as a stock', async () => {
    // Both sides are EVENT counts over the window. A game can cross the 8-day line here
    // and be cleared next week, so concluding "the stale backlog grew" from these two
    // numbers can contradict the backlog card sitting right beside it - which is exactly
    // what it did on real data for someone whose oldest game was three days old.
    const { container } = await individual(bundleOf(TWO(), {
      personMoves: { k0: BUCKETS.map((b, i) => ({
        key: b, label: b, cleared: [10, 0, 5, 0], aged: [0, i < 3 ? 40 : 0, 0],
      })) },
    }))
    const now = nowLines(container).find((n) => n.includes('only got older'))!
    expect(now).toContain('90 judged against 120 that only got older')
    expect(now).toContain('30 cleared against 120 that crossed in')
    expect(now).toContain('stale work arrived faster than it was cleared')
    // a movement sentence, never a claim about what is on the desk right now
    expect(now).not.toMatch(/backlog (grew|shrank)/)
  })

  it('shows a single-band backlog as a number, not as a 100% bar', async () => {
    // One band is a one-bar bar chart: a full-width fill reading "100%" over a legend
    // reading "120", spending a chart's height restating the caption.
    const solo = await individual(bundleOf(TWO()))
    const block = Array.from(solo.container.querySelectorAll('.rp-mix-block'))
      .find((b) => txt(b).startsWith('Backlog by age'))!
    expect(block.querySelector('.rp-band-bar')).toBeNull()
    expect(txt(block.querySelector('.rp-band-solo'))).toContain('all within 0–3d')
    expect(txt(block.querySelector('.rp-band-solo b'))).toBe('120')
    // A second ReportView cannot be mounted alongside the first: they both put an
    // "Individual" button in the document and getByRole then matches two of them.
    solo.unmount()
    // ...and a genuine split still gets the bar
    const split = await individual(bundleOf(TWO(), {
      backlogBy: [{ key: 'k0', name: 'Alpha', n: 100, a0: 50, a1: 30, a2: 20, a3: 0, oldest: 11, stale: 20 }],
    }))
    const b2 = Array.from(split.container.querySelectorAll('.rp-mix-block'))
      .find((b) => txt(b).startsWith('Backlog by age'))!
    expect(b2.querySelectorAll('.rp-band-bar > span')).toHaveLength(3)
  })

  it('draws the moderator tier as a subset of the tier above it', async () => {
    // Both tiers stretched to full width made 120 games ruled on look the same size as
    // the 1,842 they came from, under a sentence calling it a subset.
    const { container } = await individual(bundleOf(TWO()))
    const tier = Array.from(container.querySelectorAll('.rp-mix-block'))
      .find((b) => txt(b).startsWith('How those picks were judged'))!
    expect(txt(tier)).toContain('of 600 ruled on')
    const bar = tier.querySelector('.rp-band-bar')!
    expect(bar.classList.contains('scaled')).toBe(true)
    // the unfilled remainder is track, so it carries no legend entry
    expect(bar.querySelector('.rp-band-rest')).not.toBeNull()
    const widths = Array.from(bar.querySelectorAll<HTMLElement>('span[style]'))
      .map((el) => parseFloat(el.style.width))
    expect(widths.reduce((a, b) => a + b, 0)).toBeLessThan(100)
  })

  it('says <1% rather than 0% for a band that is present but tiny', async () => {
    const { container } = await individual(bundleOf(TWO(), {
      backlogBy: [{ key: 'k0', name: 'Alpha', n: 1000, a0: 700, a1: 298, a2: 2, a3: 0, oldest: 9, stale: 2 }],
    }))
    const pcts = Array.from(container.querySelectorAll('.rp-band-pct')).map(txt)
    expect(pcts).toContain('<1%')
    expect(pcts).not.toContain('0%')
  })

  it('speaks to the evaluator in their own voice when the view is scoped', async () => {
    const { container } = await individual(bundleOf([person('Alpha', { evaluated: 0, assigned: 600 })], {
      canSeeTeam: false, self: 'k0',
    }))
    expect(txt(container.querySelector('.rp-headline'))).toBe('You have not judged anything this week.')
    const act = actions(container)[0]
    // idle was deleted here (Leaderboard already has that line); the next act to fire
    // for an assigned-but-untouched backlog is the intake-gap coaching, in the
    // evaluator's own voice - a manager reassigns the backlog, the person holding it can
    // only ask for one
    expect(act.do).toBe('Ask for a rebalance now, not at the end of the week')
    expect(act.do).not.toContain('Ask Alpha')
  })
})
