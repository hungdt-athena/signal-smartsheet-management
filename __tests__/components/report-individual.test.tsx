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
    // the chip's SENTENCE (not the kicker Task 13 put in front of it - see
    // "boxes its chips in the shared verdict banner" above) still names the backlog
    // in plain words (Task 1 rewrote "Backlog 120, oldest 2d" into a full sentence,
    // so the check is "mentions the noun", not "starts with the old label").
    expect(Array.from(container.querySelectorAll('.rp-chips .rp-chip-text')).map(txt)
      .some((c) => c.toLowerCase().includes('backlog') || c.includes('waiting'))).toBe(true)
    // and it carries no bench: a stock has no team average to be above or below
    expect(waiting.querySelector('.rp-kpi-bench')).toBeNull()
  })

  // Overview's verdict banner (headline + boxed, clickable chips) is now shared by
  // all three tabs - Task 13. Individual used to print the same three chips as bare
  // spans with no kicker; they must now be the same control, labelled with this
  // tab's own vocabulary. `share`/`net`/`wait` reuse Overview's own words on purpose:
  // this tab's "Backlog +N" chip IS growth and its "oldest Nd" chip IS age.
  it('boxes its chips in the shared verdict banner, labelled with its own vocabulary', async () => {
    const { container } = await individual(bundleOf(TWO()))
    const verdict = container.querySelector('.rp-verdict')!
    expect(verdict).not.toBeNull()
    expect(verdict.querySelector('.rp-headline')).not.toBeNull()
    const chips = Array.from(verdict.querySelectorAll('.rp-chip'))
    expect(chips).toHaveLength(3)
    expect(chips.every((c) => c.tagName === 'BUTTON')).toBe(true)
    expect(chips.map((c) => c.querySelector('.rp-chip-kicker')?.textContent))
      .toEqual(['OUTPUT', 'GROWTH', 'AGE'])
  })

  // Each chip has to take the reader to the number it was computed from, same
  // contract as Overview and Leaderboard.
  it('sends each chip to the number it was computed from', async () => {
    const { container } = await individual(bundleOf(TWO()))
    // jsdom has no scrollIntoView at all here (unlike report-leaderboard.test.tsx,
    // which stubs one at module scope), so this file must clean up its own override.
    const original = Element.prototype.scrollIntoView
    const seen: string[] = []
    Element.prototype.scrollIntoView = jest.fn(function (this: Element) {
      seen.push(this.getAttribute('data-rp-focus') || '?')
    }) as unknown as typeof Element.prototype.scrollIntoView
    try {
      const chips = Array.from(container.querySelectorAll('.rp-verdict .rp-chip'))
      chips.forEach((c) => fireEvent.click(c))
      expect(seen).toEqual(['share', 'net', 'wait'])
      expect(container.querySelector('[data-rp-focus="share"] .rp-kpi-label')!.textContent!.replace('?', ''))
        .toBe('Evaluated')
      expect(container.querySelector('[data-rp-focus="net"] .rp-kpi-label')!.textContent!.replace('?', ''))
        .toBe('Backlog')
      expect(container.querySelector('[data-rp-focus="wait"]')!.textContent).toContain('Backlog by age')
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  // The hazard this task warns about by name: Individual reuses the `.rp-chip` class
  // for its person-switcher (a different control entirely, outside `.rp-verdict`).
  // Lifting the verdict's chip styling must not drag the switcher along with it.
  it('leaves the person-switcher chips exactly as they were', async () => {
    const { container } = await individual(bundleOf(TWO()))
    const people = Array.from(container.querySelectorAll('.rp-people .rp-chip'))
    expect(people).toHaveLength(2)
    people.forEach((p) => {
      // no kicker/text split - that is the verdict chip's own shape
      expect(p.querySelector('.rp-chip-kicker')).toBeNull()
      expect(p.querySelector('.rp-chip-text')).toBeNull()
      // no tone class - the switcher was never good/warn/bad
      expect(p.classList.contains('good')).toBe(false)
      expect(p.classList.contains('warn')).toBe(false)
      expect(p.classList.contains('bad')).toBe(false)
    })
    expect(txt(people[0])).toContain('Alpha')
    expect(people[0].classList.contains('active')).toBe(true)
    expect(people[1].classList.contains('active')).toBe(false)
    // clicking still switches the selected person - the control still works
    fireEvent.click(people[1])
    expect(container.querySelector('.rp-headline')).toHaveTextContent('Beta')
  })

  // Reads a chip's own SENTENCE off the verdict banner by its kicker label
  // ('OUTPUT'/'GROWTH'/'AGE' for 'share'/'net'/'wait' - see "boxes its chips in the
  // shared verdict banner" above), the same idiom report-leaderboard.test.tsx uses,
  // rather than `[data-rp-focus]` which lands on the KPI card the chip scrolls to.
  const IND_KICKER: Record<string, string> = { share: 'OUTPUT', net: 'GROWTH', wait: 'AGE' }
  const verdictChipText = (c: HTMLElement, key: string) =>
    txt(Array.from(c.querySelectorAll('.rp-verdict .rp-chip'))
      .find((chip) => chip.querySelector('.rp-chip-kicker')?.textContent === IND_KICKER[key])
      ?.querySelector('.rp-chip-text') ?? null)

  // Task 1: "Backlog +33 this week" and "Backlog 763, oldest 13d" were shorthand -
  // a number with no noun. Both now read as sentences, and zero/negative get their
  // own wording rather than a sign in front of the same clause (Overview's `growth`
  // chip already sets this precedent for `net`). One `it` per fixture: each helper
  // call renders a fresh tree into `document.body`, and RTL only auto-unmounts
  // between tests, not between two `individual(...)` calls inside one test.
  it('reads the net chip as a sentence when the backlog grew', async () => {
    // Alpha: assigned 636, evaluated 600 -> psTotals nets to +36 across six even buckets.
    const grew = [person('Alpha', { assigned: 636, evaluated: 600 }), person('Beta')]
    const { container } = await individual(bundleOf(grew))
    const net = verdictChipText(container, 'net')
    expect(net).toBe('36 games joined their backlog this week')
    expect(net.length).toBeLessThanOrEqual(150)
  })

  it('reads the net chip as a sentence when the backlog shrank', async () => {
    // Alpha: assigned 600, evaluated 636 -> nets to -36: the backlog shrank.
    const shrank = [person('Alpha', { assigned: 600, evaluated: 636 }), person('Beta')]
    const { container } = await individual(bundleOf(shrank))
    expect(verdictChipText(container, 'net')).toBe('36 games cleared from their backlog this week')
  })

  it('reads the net chip with its own wording when nothing changed, not a signed zero', async () => {
    // TWO()'s Alpha is assigned === evaluated: net is exactly zero, not a sign in
    // front of "0 games".
    const { container } = await individual(bundleOf(TWO()))
    const zeroNet = verdictChipText(container, 'net')
    expect(zeroNet).toBe('No games joined or cleared from their backlog this week')
    expect(zeroNet).not.toMatch(/[-+]0 games/)
  })

  it('reads the wait chip as a sentence naming the count and the oldest game', async () => {
    const { container } = await individual(bundleOf(TWO(), {
      backlogBy: [{ key: 'k0', name: 'Alpha', n: 763, a0: 400, a1: 200, a2: 100, a3: 63, oldest: 13, stale: 0 },
        { key: 'k1', name: 'Beta', n: 120, a0: 120, a1: 0, a2: 0, a3: 0, oldest: 2, stale: 0 }],
    }))
    const wait = verdictChipText(container, 'wait')
    expect(wait).toBe('763 games waiting, the oldest sat 13 days')
    expect(wait.length).toBeLessThanOrEqual(150)
  })

  it('reads the wait chip with its own wording for an empty backlog', async () => {
    const { container } = await individual(bundleOf(TWO(), {
      backlogBy: [{ key: 'k0', name: 'Alpha', n: 0, a0: 0, a1: 0, a2: 0, a3: 0, oldest: 0, stale: 0 },
        { key: 'k1', name: 'Beta', n: 120, a0: 120, a1: 0, a2: 0, a3: 0, oldest: 2, stale: 0 }],
    }))
    expect(verdictChipText(container, 'wait')).toBe('Nothing is waiting in their backlog')
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
    // and the projection says whose rate it applies. "At their rate their 1,000
    // games..." over a sentence whose subject is this person reads as their OWN rate,
    // which would make the clause say nothing at all.
    expect(why).toContain("At the team's rate their 1,000 games")
    expect(why).not.toContain('At their rate')
  })

  /* Two of the three tabs printed `fam.toUpperCase()` as the card's kicker, so the
     reader met CAL, REC and COVER - which are not words - on the one branch whose
     point is a single vocabulary across three tabs. Overview always mapped its topic
     through a label table; this is the same table for the other two. The lexicon gate
     greps this component's SOURCE, so it cannot see an identifier upper-cased at
     render time, and only an assertion on the rendered text can. */
  it('names the card topic in words, never as an internal code', async () => {
    const { container } = await individual(bundleOf(TWO(), {
      backlogBy: [{ key: 'k0', name: 'Alpha', n: 400, a0: 200, a1: 80, a2: 100, a3: 20, oldest: 21, stale: 120 }],
    }))
    const kickers = Array.from(container.querySelectorAll('.rp-do-topic')).map((n) => n.textContent || '')
    expect(kickers.length).toBeGreaterThan(0)
    expect(kickers).toContain('Backlog')
    for (const k of kickers) {
      expect(['Backlog', 'Calibration', 'Coverage', 'Output', 'Picks', 'Recording', 'Rhythm', 'Speed']).toContain(k)
    }
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
    // with its unit. The self voice says "oldest 41d"; this one used to stop at the
    // bare number, so the same field read as two different quantities across voices.
    expect(act.why).toContain('oldest 21d.')
    // this tab coaches the person, it does not move their games - Leaderboard already did
    expect(act.do).not.toMatch(/Rescue|Reassign/)
  })

  /* The payoff answers the instruction on the card, which asks for FIVE games a day -
     not the person's full measured pace. Reading `e.throughput` instead answered a
     question nobody asked and made the two voices disagree by 25x on the same person:
     2.6 "working days" for a manager against 64 days for the contractor, off the same
     316 games and the same threshold. It also divided by zero on a quiet window. */
  const staleRow = { key: 'k0', name: 'Alpha', n: 400, a0: 200, a1: 80, a2: 100, a3: 20, oldest: 21, stale: 120 }
  const cleanRow = { key: 'k1', name: 'Beta', n: 120, a0: 120, a1: 0, a2: 0, a3: 0, oldest: 2, stale: 0 }

  it('prices the stale backlog at the five a day it just asked for', async () => {
    const { container } = await individual(bundleOf(TWO(), { backlogBy: [staleRow, cleanRow] }))
    // 120 stale games, five a day: 24 days.
    expect(txt(container.querySelector('.rp-do-payoff'))).toBe('Their stale games gone in about 24 days')
  })

  it('gives the same answer whatever pace the person happens to be running at', async () => {
    // Alpha has judged nothing this window (throughput = evaluated / activeDays = 0)
    // but is still sitting on the same stale backlog. The instruction has not changed,
    // so neither has the answer - and a zero throughput can no longer reach the
    // arithmetic to print "Infinity working days".
    const { container } = await individual(bundleOf([
      person('Alpha', { evaluated: 0, assigned: 600 }),
      person('Beta'),
    ], { backlogBy: [staleRow, cleanRow] }))
    const payoff = txt(container.querySelector('.rp-do-payoff'))
    expect(payoff).toBe('Their stale games gone in about 24 days')
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

  // Task 2: three blocks removed for the same reason - they describe a distribution
  // and cannot be acted on. `d.radar` stays on the payload (Leaderboard's Overall score
  // and the Config weight preview both read it); only the Individual-tab consumption
  // of it goes away here.
  it('renders no radar, no pick funnel and no daily-breakdown trigger', async () => {
    const { container } = await individual(bundleOf(TWO()))
    expect(txt(container).includes('performance shape')).toBe(false)
    expect(container.querySelector('.rp-radar-wrap')).toBeNull()
    expect(Array.from(container.querySelectorAll('.card-label')).map(txt)).not.toContain('Pick funnel')
    expect(screen.queryByRole('button', { name: /Daily breakdown/ })).toBeNull()
    expect(container.querySelector('.rp-daily-modal')).toBeNull()
  })

  it('names the final-priority count in the Shortlist rate KPI sub-line', async () => {
    // finalPriority: 3 on a fixture where each of the two people evaluates 600 games,
    // via `person()`'s default in `bundleOf`.
    const { container } = await individual(bundleOf(TWO()))
    const sr = Array.from(container.querySelectorAll('.rp-kpi'))
      .find((k) => txt(k.querySelector('.rp-kpi-label')).startsWith('Shortlist rate'))!
    const sub = txt(sr.querySelector('.rp-kpi-sub'))
    expect(sub).toContain('3 final priority')
  })

  // The guide used to teach "Backlog is the only number here the window filter does
  // not reach" and then, three screens down, the reader met the review table - which
  // ignores the window too and says so in its own note. A guide whose rule has an
  // unannounced exception on the same page is worse than no guide.
  it('does not claim Backlog is the only thing the window filter misses, now the review table misses it too', async () => {
    const { container } = await individual(bundleOf(TWO()))
    fireEvent.click(container.querySelector('.rp-guide button')!)
    const read = txt(container.querySelector('.rp-guide .read'))
    expect(read).toContain('Backlog is the only KPI here the week filter does not reach')
    expect(read).not.toContain('the only number here')
    expect(read).toContain('the review table at the bottom has its own filters too')
  })

  // Task 6: the review table is the last block on the tab, and unlike everything above
  // it, it does not obey the window/genre filter bar - so it must be introduced by its
  // own separator (rule + title + a sentence saying so), or a reader assumes it is the
  // same selection as the charts above and reads a contradiction as a bug.
  describe('review table', () => {
    it('places a rule, section title, scope note and the table itself - in that order - right after the recording list', async () => {
      const { container } = await individual(bundleOf(TWO()))
      // The fixture's `videos: {}` means the recording list itself renders as an Empty
      // placeholder rather than a populated table, so anchor on the "Recording" section
      // title instead of the list's own row markup.
      const recordingTitle = Array.from(container.querySelectorAll('.rp-section-title'))
        .find((el) => txt(el).startsWith('Recording'))
      expect(recordingTitle).toBeTruthy()
      const section = container.querySelector('.rp-review-section')
      expect(section).not.toBeNull()
      // the recording section sits before the review section, in document order
      expect(recordingTitle!.compareDocumentPosition(section!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      const kids = Array.from(section!.children).map((c) => c.classList[0])
      expect(kids).toEqual(['rp-review-rule', 'rp-section-title', 'rp-review-scope-note', 'rp-review-table'])
      expect(txt(section!.querySelector('.rp-section-title'))).toMatch(/^Review/)
    })

    // The note has to name the two controls by the labels the filter bar prints:
    // "View by" (ReportView.tsx's first Seg) and "Category" (its last one). "genre"
    // is a word the Report's screen text does not contain anywhere else, and this
    // table's own filter is ALSO labelled Category, so the mismatch was loud.
    it('names the filter bar controls by their real labels, not "window" and "genre"', async () => {
      const { container } = await individual(bundleOf(TWO()))
      const note = container.querySelector('.rp-review-scope-note')
      expect(txt(note)).toBe('This table has its own filters. It ignores the View by and Category filters at the top of the page.')
      expect(txt(note)).not.toMatch(/genre/i)
      // and those labels are really on the page, so the reader can find them
      const segLabels = Array.from(container.querySelectorAll('.rp-filters .rp-seg-label')).map(txt)
      expect(segLabels).toContain('View by')
      expect(segLabels).toContain('Category')
    })

    it('renders it for the contractor themselves when the view is scoped to one person', async () => {
      const { container } = await individual(bundleOf([person('Alpha', { evaluated: 0 })], {
        canSeeTeam: false, self: 'k0',
      }))
      expect(container.querySelector('.rp-review-table')).not.toBeNull()
      const calls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]))
      expect(calls.some((u) => u.includes('/api/evaluations') && u.includes('evaluator=Alpha'))).toBe(true)
    })

    it('re-targets to the newly selected person when the switcher changes', async () => {
      const { container } = await individual(bundleOf(TWO()))
      const people = Array.from(container.querySelectorAll('.rp-people .rp-chip'))
      fireEvent.click(people[1])
      await waitFor(() => {
        const calls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]))
        expect(calls.some((u) => u.includes('/api/evaluations') && u.includes('evaluator=Beta'))).toBe(true)
      })
    })
  })
})
