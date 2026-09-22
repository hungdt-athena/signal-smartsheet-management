import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ReportView } from '@/components/report/ReportView'

// The Overview tab's contract, which is a reading contract before it is a data one:
//
//   1. The guide comes first, then one sentence, three chips and four numbers, then AT
//      MOST THREE action lines. Nothing is folded away behind a toggle.
//   2. An action line only prints when a number crosses a threshold. A tab where every
//      chart carries an "Act" has, in effect, no actions at all - that is the rule this
//      file exists to hold, because it is the one that rots first: the easiest way to
//      write a chart is to give it a sentence that is true either way.
//   3. No action asks for a smaller push. Intake is set upstream in the genre filter;
//      what this team can move is how fast it clears and how well it judges, so every
//      line has to name one of those two.
//   4. Team health gauges are read against what the team actually did in the 90 days
//      before the window, not against a target somebody picked once.
//
// Everything here goes through <ReportView/> with a stubbed /api/report, so the tab
// wiring is exercised too - Pipeline was merged into Overview and must not come back
// as its own tab.

jest.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 1, role: 'admin', name: 'Admin' } }, status: 'authenticated' }),
}))

type Bundle = Record<string, unknown>

// A window that is entirely healthy: everything at or above its baseline, intake and
// output in step, a small and fresh backlog. Individual tests break one thing at a
// time from here, so a failure names the threshold that moved.
function healthy(): Bundle {
  const buckets = ['1/9', '2/9', '3/9', '4/9', '5/9']
  const metricSeries = buckets.map((label, i) => ({
    key: `2026-09-0${i + 1}`, label,
    volume: 200, assigned: 200, evaluated: 200, shortlisted: 16,
    priorityIV: 2, insight: 1, finalPriority: 3, personDays: 2,
    signalRate: 0.015, survivalRate: 0.08,
  }))
  const series = buckets.map((label, i) => ({
    key: `2026-09-0${i + 1}`, label, newGames: 200, evaluated: 200, backlog: 400, people: 2,
  }))
  const age = { a0: 300, a1: 60, a2: 30, a3: 10 }
  return {
    empty: false, canSeeTeam: true, view: 'week', category: 'puzzle',
    window: { label: 'W1 Sep 2026', from: '2026-09-01', to: '2026-09-06' },
    bucketUnit: 'day',
    options: { week: [], month: [], quarter: [], batch: [] },
    teamTotals: {
      evaluators: 2, totalAssigned: 1000, totalEvaluated: 1000,
      avgThroughput: 100, personDayThroughput: 100, avgTurnaround: 2,
      signalRate: 0.015, survivalRate: 0.08, totalRecorded: 10, linkDead: 0, noteRate: 0.95,
    },
    bench: {},
    baseline: {
      from: '2026-06-03', to: '2026-09-01', days: 90, evaluated: 9000,
      survivalRate: 0.08, signalRate: 0.015, noteRate: 0.93, personDayThroughput: 100,
    },
    // The window the KPI row compares with. Deliberately NOT the same thing as
    // `baseline`, which is the Team health threshold - see the tests below.
    prev: {
      from: '2026-08-25', to: '2026-09-01', label: 'last week', evaluated: 900,
      survivalRate: 0.08, signalRate: 0.015, personDayThroughput: 100,
    },
    self: null,
    funnel: { assigned: 1000, evaluated: 1000, shortlisted: 80, priorityIV: 10, insight: 5, finalPriority: 15 },
    initialConclusions: [{ name: 'Bypass', count: 920 }, { name: 'List_Idea', count: 80 }],
    finalConclusions: [{ name: 'Theme/Art', count: 9 }, { name: 'Priority IV', count: 6 }],
    series: [], metricSeries,
    heatmap: { periods: [], rows: [] }, scoreRank: { periods: [], rows: [] },
    config: { excluded: [], included: [], weights: {} },
    personSeries: {}, videos: {}, dailyMix: {},
    evaluators: [
      { key: 'a', name: 'Alpha', title: null, assigned: 500, evaluated: 500, activeDays: 5, throughput: 100, turnaround: 2, signalRate: 0.015, consistency: 1, shortlisted: 40, priorityIV: 5, insight: 3, finalPriority: 8, survivalRate: 0.08, linkDead: 0, noted: 475, noteRate: 0.95, recorded: 5, rec5: 3, rec20: 2, initialConclusions: { Bypass: 460, List_Idea: 40 }, finalConclusions: { 'Theme/Art': 5 } },
      { key: 'b', name: 'Beta', title: null, assigned: 500, evaluated: 500, activeDays: 5, throughput: 100, turnaround: 2, signalRate: 0.015, consistency: 1, shortlisted: 40, priorityIV: 5, insight: 2, finalPriority: 7, survivalRate: 0.08, linkDead: 0, noted: 475, noteRate: 0.95, recorded: 5, rec5: 3, rec20: 2, initialConclusions: { Bypass: 460, List_Idea: 40 }, finalConclusions: { 'Theme/Art': 4 } },
    ],
    radar: [],
    // The backlog, outside the pipeline: it has no window in it, so it is sent on
    // every view including batch, where the pipeline is null.
    stock: { backlog: 400, age },
    pipeline: {
      series,
      current: { backlog: 400, age },
      window: { newGames: 1000, evaluated: 1000 },
      aging: buckets.map((label, i) => ({ key: `k${i}`, label, ...age, waiting: 400, medAge: 2, p90Age: 9, maxAge: 16 })),
      cleared: buckets.map((label, i) => ({ key: `c${i}`, label, a0: 150, a1: 30, a2: 15, a3: 5, avgAge: 2.5 })),
      sources: buckets.map((label, i) => ({ key: `s${i}`, label, parts: { 'appagg-scraper': 120, 'top-pub-scraper': 80 } })),
      sourceYield: [
        { src: 'appagg-scraper', n: 600, evaluated: 600, shortlisted: 48, finalPriority: 9 },
        { src: 'top-pub-scraper', n: 400, evaluated: 400, shortlisted: 32, finalPriority: 6 },
      ],
      // games crossing an age boundary in each bucket, keyed by the band crossed INTO
      aged: buckets.map((label, i) => ({ key: `g${i}`, label, parts: { a1: 30, a2: 10, a3: 20 } })),
    },
  }
}

// Deep-merges only the keys a test cares about, so a scenario reads as the one thing
// it changed rather than a second full copy of the bundle.
function withPatch(patch: Record<string, unknown>): Bundle {
  const base = healthy()
  for (const [k, v] of Object.entries(patch)) {
    base[k] = v && typeof v === 'object' && !Array.isArray(v)
      ? { ...(base[k] as object), ...(v as object) }
      : v
  }
  return base
}

async function renderTab(bundle: Bundle) {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => bundle }) as unknown as typeof fetch
  const view = render(<ReportView />)
  await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument())
  return view
}

// Find a chart card by its own label. Matching on card text finds the Guide first,
// because the Guide is a .card too and it names the charts it is explaining.
const cardNamed = (c: HTMLElement, label: string) =>
  Array.from(c.querySelectorAll('.card-label'))
    .find((l) => l.textContent?.startsWith(label))!.closest('.card') as HTMLElement

// One entry per action: the instruction, then the numbers behind it.
const actions = (c: HTMLElement) => Array.from(c.querySelectorAll('.rp-do')).map((el) => ({
  urgent: el.classList.contains('urgent'),
  do: el.querySelector('.rp-do-line')?.textContent || '',
  why: el.querySelector('.rp-do-why')?.textContent || '',
}))

describe('Overview tab', () => {
  afterEach(() => jest.restoreAllMocks())

  it('reads guide, then sentence, then chips, then five numbers, and folds nothing away', async () => {
    const { container } = await renderTab(healthy())
    expect(container.querySelector('.rp-headline')).toHaveTextContent('The team is on top of the backlog.')

    // In / out / stock / speed / quality, left to right. Assigned used to appear ONLY
    // on batch view - where the pipeline is null - so the row changed shape depending
    // on which filter was selected, and the reader lost the intake number on every
    // other view.
    const kpis = container.querySelectorAll('.rp-kpi')
    expect(kpis).toHaveLength(5)
    expect(Array.from(kpis).map((k) => k.querySelector('.rp-kpi-label')?.textContent?.replace('?', '')))
      .toEqual(['Assigned', 'Evaluated', 'Backlog', 'Games per day', 'Shortlist rate'])

    // The guide is still the first thing on the tab, but it now opens on demand - see
    // the collapse test below. Its heading stays visible so the reader knows it is there.
    const marks = ['rp-guide', 'rp-headline', 'rp-chips', 'rp-kpi-row']
    const order = Array.from(container.querySelectorAll(marks.map((m) => `.${m}`).join(', ')))
    expect(order.map((el) => marks.find((m) => el.classList.contains(m)))).toEqual(marks)
  })

  /* Batch is the view the tab OPENS on, and it was the one view with no time axis, so
     the server sent `pipeline: null` for it - which took the Backlog KPI, the age bar
     and all three summary chips with it. The backlog never needed a window (it is
     "everything unevaluated, right now"), and a batch does happen on real days even
     though its label is not a date, so both now arrive on batch too. */
  it('keeps the stock numbers on batch view, where there is no pipeline', async () => {
    const { container } = await renderTab(withPatch({
      view: 'batch',
      // what the server sends for a batch: a label, real dates learned from the rows,
      // and no pipeline
      window: { label: 'W1 Sep, 2026', batch: 'W1 Sep, 2026', from: '2026-09-01', to: '2026-09-06' },
      pipeline: null,
    }))
    const kpis = Array.from(container.querySelectorAll('.rp-kpi'))
      .map((k) => k.querySelector('.rp-kpi-label')?.textContent?.replace('?', ''))
    expect(kpis).toEqual(['Assigned', 'Evaluated', 'Backlog', 'Games per day', 'Shortlist rate'])
    // the stock reads the same on batch as on any other view - it is the same backlog
    expect(container.querySelector('[data-rp-focus="growth"] .rp-kpi-value')!.textContent).toBe('400')
    expect(container.querySelector('[data-rp-focus="age"]')!.textContent).toContain('400 waiting')
    // and the banner still carries its three chips
    const chips = Array.from(container.querySelectorAll('.rp-chip .rp-chip-text')).map((c) => c.textContent)
    expect(chips).toHaveLength(3)
    expect(chips[2]).toBe('40 games have waited 8+ days - 10% of the backlog')
    // days-to-clear works because the batch brought dates: 1,000 over 5 days = 200/day
    expect(chips[1]).toBe('2.0 days to clear the whole backlog at the current 200 games/day')
  })

  // The guide used to be pinned open above everything, on the reasoning that a reader
  // who does not know what the numbers mean cannot use them. That is still true on a
  // first visit and false on every visit after it, where eight lines of instructions
  // push the answer below the fold. It now opens on demand and starts closed.
  it('starts with the guide closed and opens it on demand', async () => {
    const { container } = await renderTab(healthy())
    const toggle = container.querySelector('.rp-guide button') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // closed means the instructions are not in the DOM at all, not merely hidden -
    // a screen reader and a word count should both agree with the eye
    expect(container.querySelector('.rp-guide .read')).toBeNull()
    // ...but the reader can still see what it is
    expect(toggle.textContent).toContain('How to use')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.rp-guide .read')).not.toBeNull()
    expect(container.querySelector('.rp-guide .act')).not.toBeNull()
  })

  // The three chips are the arithmetic behind the sentence, so they have to be readable
  // as sentences themselves. The old versions were shorthand for the person who wrote
  // them: "Backlog +927 this month" does not say whether 927 is the backlog or the
  // change in it, and "894 waiting 8+ days · 23%" leaves the reader to work out what the
  // percentage is a share OF.
  it('backs the sentence with three chips that each read as a sentence', async () => {
    const { container } = await renderTab(healthy())
    const chips = Array.from(container.querySelectorAll('.rp-chip'))
    expect(chips).toHaveLength(3)
    // Each chip names the thing it measures, and that name is also what the matching
    // action and the matching KPI are labelled with.
    expect(chips.map((c) => c.querySelector('.rp-chip-kicker')?.textContent)).toEqual(['Growth', 'Speed', 'Age'])
    const body = (c: Element) => c.querySelector('.rp-chip-text')?.textContent || ''
    // "this week", not "this day": the buckets are days but the selection is a week,
    // and mixing the two nouns is what printed "Queue +1,413 this day".
    expect(body(chips[0])).toBe('As many games were cleared as arrived this week')
    expect(body(chips[1])).toBe('2.0 days to clear the whole backlog at the current 200 games/day')
    expect(body(chips[2])).toBe('40 games have waited 8+ days - 10% of the backlog')
    // a healthy backlog reads green, not "no colour"
    expect(chips.every((c) => c.classList.contains('good'))).toBe(true)
  })

  // A backlog that is growing has to say so in words, in both directions - the balanced
  // case above reads fine only because it is a third sentence, not a "+0".
  it('says which way the backlog moved, in words', async () => {
    const flow = (newGames: number) => withPatch({
      pipeline: { window: { newGames, evaluated: 1000 } },
    })
    const grew = await renderTab(flow(1400))
    expect(grew.container.querySelector('.rp-chip .rp-chip-text')!.textContent)
      .toBe('400 more games arrived than were cleared this week')
    const shrank = await renderTab(flow(700))
    expect(shrank.container.querySelector('.rp-chip .rp-chip-text')!.textContent)
      .toBe('300 more games were cleared than arrived this week')
  })

  // The chips, the KPI row and the actions are three views of the same three questions.
  // Clicking a chip has to land the reader on the number it came from, or the tab is
  // still three lists that happen to sit on one page.
  it('sends each chip to the KPI or chart it was computed from', async () => {
    const { container } = await renderTab(healthy())
    const seen: string[] = []
    Element.prototype.scrollIntoView = jest.fn(function (this: Element) {
      seen.push(this.getAttribute('data-rp-focus') || '?')
    }) as unknown as typeof Element.prototype.scrollIntoView
    const chips = Array.from(container.querySelectorAll('.rp-chip'))
    chips.forEach((c) => fireEvent.click(c))
    expect(seen).toEqual(['growth', 'speed', 'age'])
    // every target the chips point at actually exists on the tab
    expect(container.querySelector('[data-rp-focus="growth"] .rp-kpi-label')!.textContent!.replace('?', '')).toBe('Backlog')
    expect(container.querySelector('[data-rp-focus="speed"] .rp-kpi-label')!.textContent!.replace('?', '')).toBe('Games per day')
    expect(container.querySelector('[data-rp-focus="age"]')!.textContent).toContain('Backlog by age')
  })

  // The window used to be a pill inside the filter bar. The bar is one horizontal strip
  // and has no room left for it, so the window went back under the headline - and the
  // bar must not grow a second line to hold it again.
  it('states the window once, under the headline, and keeps the filter bar to one strip', async () => {
    const { container } = await renderTab(healthy())
    const sub = container.querySelector('.h-sub')!
    expect(sub.textContent).toContain('W1 Sep 2026')
    expect(sub.textContent).toContain('1–5 Sep')
    expect(container.querySelector('.rp-range-chip')).toBeNull()
    expect(container.querySelector('.rp-filters')!.querySelector('.rp-range-chip')).toBeNull()
  })

  // Headline -> chips -> KPI -> action is one chain, and an action with no topic on it
  // is a link missing from that chain: the reader has to re-derive which of the three
  // problems it answers. Quality is a fourth topic because two actions are about how
  // well games are judged, not about the backlog - those have no chip, but they still
  // need to say what they are about.
  it('labels every action with the topic it answers', async () => {
    const { container } = await renderTab(withPatch({
      // a team clearing 200 a day against a 600-a-day standing pace, taking in twice
      // what it puts out: one Speed line and one Growth line
      baseline: { ...healthy().baseline as object, evaluated: 54000 },
      pipeline: { ...healthy().pipeline as object, window: { newGames: 2000, evaluated: 1000 } },
    }))
    const rows = Array.from(container.querySelectorAll('.rp-do'))
    expect(rows.length).toBeGreaterThan(0)
    const topics = rows.map((r) => r.querySelector('.rp-do-topic')?.textContent)
    expect(topics.every((t) => t && ['Growth', 'Speed', 'Age', 'Quality'].includes(t))).toBe(true)
    // the pace diagnostic is a speed problem and the intake gap is a growth one
    const byTopic = Object.fromEntries(rows.map((r) => [r.querySelector('.rp-do-line')?.textContent, r.querySelector('.rp-do-topic')?.textContent]))
    expect(byTopic['Find what changed in the working day before adding people']).toBe('Speed')
    expect(byTopic['Clear 1,000 more games to break even on intake']).toBe('Growth')
  })

  /* The real September numbers printed "Add 1,153 person-days to get the queue under 5
     days of work". Every digit of that was correct and none of it was usable: nobody
     hires a person-day, and the size of the ask - the actual finding - was invisible
     inside the unit. Said in people it is unmissable, which is the point: the line
     still prints instead of being suppressed, because "this is past what hiring fixes"
     is exactly what the reader needs to know. */
  it('states the capacity ask in people and weeks, however large it gets', async () => {
    const { container } = await renderTab(withPatch({
      teamTotals: { ...(healthy().teamTotals as Record<string, unknown>), evaluators: 6, personDayThroughput: 3.2 },
      stock: { backlog: 3747, age: { a0: 1900, a1: 953, a2: 791, a3: 103 } },
      pipeline: {
        ...healthy().pipeline as object,
        window: { newGames: 1000, evaluated: 1000 },
        current: { backlog: 3747, age: { a0: 1900, a1: 953, a2: 791, a3: 103 } },
      },
    }))
    const cap = actions(container).find((a) => a.do.includes('backlog under'))!
    expect(cap.do).toMatch(/^Add \d+ more people for (a week|a month|\d+ weeks) to get the backlog under 5 days of work$/)
    // no raw person-days anywhere in the line the reader acts on
    expect(cap.do).not.toMatch(/person-day/)
    // and the evidence reads as a sentence, not three numbers separated by dots
    expect(cap.why).toBe('3,747 games waiting · the team clears 200 a day · that is 18.7 days of work in the backlog')
  })

  it('says nothing when nothing is wrong', async () => {
    const { container } = await renderTab(healthy())
    expect(actions(container)).toHaveLength(0)
    // ...and no chart invents an action of its own either
    expect(container.querySelectorAll('.rp-act')).toHaveLength(0)
  })

  it('caps the action list at three, worst first, and never asks for a smaller push', async () => {
    // four things wrong at once: intake gap, a rotting tail, a backlog worth weeks of
    // work, and a source producing nothing (which must NOT become an action)
    const { container } = await renderTab(withPatch({
      // The stock the KPI and the chips read is the top-level one; `pipeline.current`
      // is the copy the time-axis charts use. Both, or the fixture is describing a
      // payload the server never sends.
      stock: { backlog: 6000, age: { a0: 1000, a1: 1000, a2: 2000, a3: 2000 } },
      pipeline: {
        ...healthy().pipeline as object,
        window: { newGames: 2000, evaluated: 1000 },
        current: { backlog: 6000, age: { a0: 1000, a1: 1000, a2: 2000, a3: 2000 } },
        cleared: ['1/9', '2/9'].map((label, i) => ({ key: `c${i}`, label, a0: 190, a1: 5, a2: 3, a3: 2, avgAge: 1 })),
        sourceYield: [
          { src: 'appagg-scraper', n: 600, evaluated: 600, shortlisted: 48, finalPriority: 9 },
          { src: 'apkcombo-scraper', n: 1400, evaluated: 400, shortlisted: 0, finalPriority: 0 },
        ],
      },
    }))
    const shown = actions(container)
    expect(shown).toHaveLength(3)
    // severity order: the two sev-3 lines (intake gap, rotting tail) come first
    expect(shown[0].urgent && shown[1].urgent).toBe(true)
    expect(shown[2].urgent).toBe(false)
    expect(shown[0].do).toBe('Clear 1,000 more games to break even on intake')
    expect(shown[0].why).toMatch(/^2,000 in against 1,000 out · about 10.0 person-days/)
    expect(shown[1].do).toMatch(/games past 15 days/)
    // The backlog is 30 days of work and the ask is capacity - stated in people and
    // weeks, because "add 50 person-days" is a unit nobody hires in. 50 person-days
    // over a team of 2 is 2 more people for 5 weeks.
    expect(shown[2].do).toBe('Add 2 more people for 5 weeks to get the backlog under 5 days of work')
    expect(shown[2].why).toBe('6,000 games waiting · the team clears 200 a day · that is 30.0 days of work in the backlog')
    // every action leads with the move, and no action reaches for the push filter
    for (const a of shown) {
      expect(a.do).toMatch(/^(Clear|Add|Find|Re-judge|Ask|Put)\b/)
      expect(`${a.do} ${a.why}`.toLowerCase()).not.toMatch(/push|drop |cut |hold /)
    }
  })

  it('never asks for more people in the same breath as asking what went wrong', async () => {
    // The team is at a third of its own pace AND the backlog is weeks of work. The list
    // used to print "add 98 person-days" directly under "find what changed before
    // adding people" - two answers to the same question, pointing opposite ways.
    const { container } = await renderTab(withPatch({
      // 54,000 over 90 days = 600 games a day; the window clears 1,000 over 5 days,
      // i.e. 200 a day. The team is a third of its own standing pace.
      baseline: { ...healthy().baseline as object, evaluated: 54000 },
      pipeline: {
        ...healthy().pipeline as object,
        window: { newGames: 2000, evaluated: 1000 },
        current: { backlog: 6000, age: { a0: 4000, a1: 1000, a2: 800, a3: 200 } },
      },
      stock: { backlog: 6000, age: { a0: 4000, a1: 1000, a2: 800, a3: 200 } },
    }))
    const shown = actions(container)
    expect(shown[0].do).toBe('Find what changed in the working day before adding people')
    // It names BOTH references rather than quoting one of them unlabelled: the KPI row
    // above compares with the previous window, so an unnamed figure here is the same
    // metric shown twice against two different bars with nothing saying which is which.
    expect(shown[0].why).toBe('The team cleared 200 games a day against 129 last week, and 600 over the 90 days before this week')
    expect(shown.some((a) => /person-days to get the backlog under/.test(a.do))).toBe(false)
    // and the catch-up line drops its person-day estimate too, for the same reason
    expect(shown.find((a) => a.do.startsWith('Clear'))!.why).toBe('2,000 in against 1,000 out this week')
  })

  it('compares the KPI row with the window the reader picked, and health with the 90-day bar', async () => {
    // Two different questions, so two different references. Somebody selected "week",
    // so the only comparison that answers them in the KPI row is last week; Team
    // health is a standing bar the team set itself and must NOT move when the filter
    // does. Both used to read "avg of prev 90d", one of them wrongly.
    const { container } = await renderTab(withPatch({
      prev: { from: '2026-08-25', to: '2026-09-01', label: 'last week', evaluated: 900,
        survivalRate: 0.04, signalRate: 0.015, personDayThroughput: 50 },
    }))
    const gpd = Array.from(container.querySelectorAll('.rp-kpi'))
      .find((k) => k.querySelector('.rp-kpi-label')?.textContent?.startsWith('Games per day'))!
    // 900 games over the 7 days of last week = 129 a day, the same unit the number
    // beside it is in. It used to read `prev.personDayThroughput`, a per-evaluator
    // figure, against a per-evaluator value - both of which have left this tab.
    expect(gpd.querySelector('.rp-kpi-bench')?.textContent).toContain('last week 129')
    expect(gpd.querySelector('.rp-kpi-bench')?.textContent).not.toContain('90d')
    // health still reads the trailing baseline
    expect(container.textContent).toContain('avg of prev 90d')
  })

  it('prints no comparison at all where there is no previous window', async () => {
    // All-time and batch have no "the one before". The old fallback compared the
    // window against the average of its own buckets, which is a window against itself.
    const { container } = await renderTab(withPatch({ prev: null }))
    const gpd = Array.from(container.querySelectorAll('.rp-kpi'))
      .find((k) => k.querySelector('.rp-kpi-label')?.textContent?.startsWith('Games per day'))!
    expect(gpd.querySelector('.rp-kpi-bench')).toBeNull()
  })

  it('names who is holding the stale work, without waiting for the team to cross a line', async () => {
    // These are different questions and the aggregate hides the answer to this one: on a
    // real September the team sat at 33% old against a 35% threshold, so nothing fired,
    // while three people were each over a quarter of their own backlog and held 871
    // stale games between them. The action also used to say "by name" and name nobody.
    const { container } = await renderTab(withPatch({
      backlogBy: [
        { key: 'k0', name: 'Alpha', n: 400, a0: 100, a1: 50, a2: 200, a3: 50, oldest: 30 },
        { key: 'k1', name: 'Beta', n: 300, a0: 300, a1: 0, a2: 0, a3: 0, oldest: 2 },
      ],
    }))
    const act = actions(container).find((a) => a.do.includes('Alpha'))!
    expect(act.do).toContain('250 games sitting 8+ days with Alpha')
    expect(act.why).toContain('One person holds 250 of the 250 games')
    expect(act.do).not.toContain('Beta')
    // the denominator comes from the same rows as the holders, never from a stock that
    // is null on a batch window and measured from a different date when it is not
    expect(act.why).not.toContain('of the 0 games')
  })

  it('never shows a +/- badge without saying what it is a change from', async () => {
    // The Backlog tile carried one derived from the last two points of its sparkline -
    // on a month view, one day against the day before - printed beside a number that
    // means "right now, all history", with nothing on screen tying it to either.
    const { container } = await renderTab(withPatch({}))
    for (const badge of Array.from(container.querySelectorAll('.rp-trend'))) {
      expect(badge.querySelector('i')?.textContent?.trim()).toBeTruthy()
    }
    const backlog = Array.from(container.querySelectorAll('.rp-kpi'))
      .find((k) => k.querySelector('.rp-kpi-label')?.textContent?.startsWith('Backlog'))!
    expect(backlog.querySelector('.rp-trend')).toBeNull()
    // and every sparkline says what it plots
    const sparked = Array.from(container.querySelectorAll('.rp-kpi')).filter((k) => k.querySelector('.rp-spark'))
    expect(sparked.length).toBeGreaterThan(0)
    for (const k of sparked) expect(k.querySelector('.rp-kpi-sparknote')?.textContent).toBeTruthy()
  })

  it('does not judge hit rate on a window the moderators have not finished', async () => {
    // Hit rate is stamped days after the evaluation, so an open window reads 0%
    // whatever the work was worth. That used to print as the worst quality gauge on
    // every fresh week; the honest line there is the triage one.
    const { container } = await renderTab(withPatch({
      window: { label: 'W3 Sep 2026', from: '2026-09-14', to: '2026-12-31' },
      funnel: { ...healthy().funnel as object, finalPriority: 0, priorityIV: 0, insight: 0 },
      teamTotals: { ...healthy().teamTotals as object, signalRate: 0 },
    }))
    const shown = actions(container)
    expect(shown.some((a) => /Hit rate/.test(a.why))).toBe(false)
    expect(shown.some((a) => a.do === "Ask a moderator to triage this week's shortlist")).toBe(true)
  })

  it('reads the health gauges against the trailing 90 days, not a fixed target', async () => {
    const { container } = await renderTab(withPatch({
      baseline: { ...healthy().baseline as object, survivalRate: 0.2 },
    }))
    const health = container.querySelector('.rp-hb')!
    expect(within(health as HTMLElement).getByText(/avg of prev 90d 20%/)).toBeInTheDocument()
    // 8% against a 20% norm is a real shortfall, and the move is to re-judge, not to
    // change what gets pushed
    const quality = actions(container).find((a) => a.do.startsWith('Re-judge'))!
    expect(quality.do).toBe('Re-judge a sample of 20 bypassed games from this week')
    expect(quality.why).toBe('Shortlist rate is the furthest below its own baseline · avg of prev 90d 20%')
  })

  it('falls back to the buckets on screen when the window has no "before"', async () => {
    const { container } = await renderTab(withPatch({ baseline: null }))
    expect(container.querySelector('.rp-hb')!.textContent).toMatch(/avg of the 5 days shown/)
  })

  it('drops note coverage from the tab while a note is mandatory in the form', async () => {
    const { container } = await renderTab(withPatch({
      teamTotals: { ...healthy().teamTotals as object, noteRate: 0.6 },
    }))
    // not a KPI, not a health gauge, and 60% coverage raises no action here
    expect(container.textContent).not.toMatch(/Note coverage/)
    expect(actions(container).some((a) => /note/i.test(a.do))).toBe(false)
  })

  it('shows intake per source as volume only, with no yield table and no source action', async () => {
    const { container } = await renderTab(withPatch({
      pipeline: {
        ...healthy().pipeline as object,
        sourceYield: [
          { src: 'appagg-scraper', n: 600, evaluated: 600, shortlisted: 48, finalPriority: 9 },
          // 40% of intake, 400 judged, not a single pick: used to name a source to turn
          // off. Source quality is a call on the push filter, not on this team.
          { src: 'apkcombo-scraper', n: 400, evaluated: 400, shortlisted: 0, finalPriority: 0 },
        ],
      },
    }))
    expect(container.querySelector('.rp-yield')).toBeNull()
    const legend = Array.from(container.querySelectorAll('.rp-srcleg-item')).map((el) => el.textContent)
    expect(legend).toEqual(['appagg60060%', 'apkcombo40040%'])
    expect(actions(container).some((a) => a.do.includes('apkcombo'))).toBe(false)
  })

  it('calls the appranking importer insight-track, which is the team\'s name for it', async () => {
    // `game_info.type` says `appranking-scraper`; nobody on the team calls it that,
    // and this chart is read by the team. Every other source keeps its own name with
    // the `-scraper` suffix dropped.
    const { container } = await renderTab(withPatch({
      pipeline: {
        ...healthy().pipeline as object,
        sources: [{ key: '2026-09-21', label: '21/9', parts: { 'appranking-scraper': 300, 'appagg-scraper': 700 } }],
        sourceYield: [
          { src: 'appagg-scraper', n: 700, evaluated: 700, shortlisted: 50, finalPriority: 8 },
          { src: 'appranking-scraper', n: 300, evaluated: 300, shortlisted: 20, finalPriority: 3 },
        ],
      },
    }))
    const legend = Array.from(container.querySelectorAll('.rp-srcleg-item')).map((el) => el.textContent)
    expect(legend).toEqual(['appagg70070%', 'insight-track30030%'])
    expect(container.textContent).not.toMatch(/appranking/)
  })

  it('keeps the two backlog charts readable as a pair, with the age numbers in the note', async () => {
    // Backlog-by-age and Cleared-old-vs-new answer "what is waiting" against "what got
    // done", and only work side by side if they share bands, colours and unit. A
    // version of the left one drawn in days (median / p90 / oldest) read better alone
    // and broke the pair, so the day numbers moved into the note instead.
    const { container } = await renderTab(withPatch({
      pipeline: {
        ...healthy().pipeline as object,
        aging: ['1/9', '2/9', '3/9'].map((label, i) => ({
          key: `k${i}`, label, a0: 100, a1: 50, a2: 40, a3: 10,
          waiting: 200, medAge: 3 + i, p90Age: 12 + i, maxAge: 20 + i,
        })),
      },
    }))
    const byAge = cardNamed(container, 'Backlog by age over time')
    // the band vocabulary is shared with the card beside it, which is what lets the
    // two be read together
    const bands = Array.from(byAge.querySelectorAll('.rp-legend-item, .rp-legend span'))
      .map((l) => l.textContent).join('|')
    for (const b of ['0–3d', '4–7d', '8–14d', '15d+']) expect(bands).toContain(b)
    // it is not drawn in days any more
    expect(byAge.querySelector('svg text.rp-dotval')).toBeNull()
    expect(byAge.textContent).not.toMatch(/Median wait\s*$/)
    // ...but the age numbers survive, computed, in the note
    expect(byAge.querySelector('.rp-readnote')!.textContent)
      .toBe('Median wait went 3d → 5d across the window, and the slowest tenth is at 14d: games are being added to the backlog faster than the middle of it moves.')
  })

  it('charts the headcount that Games per day divides by', async () => {
    // A thin week and a slow week look identical without it, and that is the first
    // question the pace gauge raises. Separate card, not a second axis on the flow
    // chart: people run 4-11 against games in the thousands.
    const { container } = await renderTab(withPatch({
      pipeline: {
        ...healthy().pipeline as object,
        series: ['1/9', '2/9', '3/9', '4/9', '5/9'].map((label, i) => ({
          key: `k${i}`, label, newGames: 200, evaluated: 200, backlog: 400, people: [6, 5, 2, 7, 6][i],
        })),
      },
    }))
    const card = cardNamed(container, 'People working')
    expect(card.querySelector('.rp-readnote')!.textContent)
      .toBe('Thinnest day was 3/9 with 2 working, against 7 at the fullest.')
    // it sits beside the flow chart, sharing the same buckets
    const flow = cardNamed(container, 'Flow & stock')
    expect(flow.parentElement).toBe(card.parentElement)
    expect(flow.parentElement!.className).toContain('rp-grid-70-30')
  })

  it('puts work finished and work that only got older on the same days', async () => {
    // The snapshot chart beside it cannot tell those apart: 8-14d shrinking looks the
    // same whether the games were judged or turned 15d+. Both halves here count
    // EVENTS - a game is judged once and crosses each boundary once - which is what
    // makes them safe to read per bucket and safe to add across buckets.
    const { container } = await renderTab(healthy())
    const card = cardNamed(container, 'Judged vs aged')
    const rows = Array.from(card.querySelectorAll('.rp-div-row'))
    expect(rows).toHaveLength(5)                       // one per bucket
    const row = rows[0]
    // aged total on the far left, judged total on the far right, bucket in the middle
    expect(row.querySelector('.rp-div-num.left')!.textContent).toBe('60')
    expect(row.querySelector('.rp-div-name')!.textContent).toBe('1/9')
    expect(row.querySelector('.rp-div-num.right')!.textContent).toBe('200')

    // one shared scale, so the longer side really is the bigger number: judged is 200
    // of a 200 max and fills its track, aged is 60 and fills 30% of the other
    const tracks = row.querySelectorAll('.rp-div-track')
    const width = (t: Element) => Array.from(t.querySelectorAll('.rp-stack-seg'))
      .reduce((s, el) => s + parseFloat((el as HTMLElement).style.width), 0)
    expect(tracks[0].classList.contains('flip')).toBe(true)   // left half grows inward
    expect(Math.round(width(tracks[0]))).toBe(30)
    expect(Math.round(width(tracks[1]))).toBe(100)

    expect(card.querySelector('.rp-div-heads .left')!.textContent).toBe('◀ Aged into')
    expect(card.querySelector('.rp-div-heads .right')!.textContent).toBe('Judged ▶')
    // The verdict weighs stale work CLEARED against stale work CREATED - both counted on
    // the 8+ day backlog. Weighing all-ages-cleared against crossings-into-15d+ once
    // printed "cleared faster than created" over a window where the backlog grew.
    expect(card.querySelector('.rp-readnote')!.textContent).toMatch(
      /^1,000 judged this week against 300 that crossed into an older band, 100 of them past 15 days\. On the 8\+ day backlog alone: 100 cleared, 150 created – the stale backlog is growing\./)
  })

  it('still counts a bucket where games aged but nothing was judged', async () => {
    // cleared and aged are separate event streams; a bucket can have one and not the
    // other, and dropping such a bucket would quietly flatter the chart
    const { container } = await renderTab(withPatch({
      pipeline: {
        ...healthy().pipeline as object,
        cleared: [],
        aged: [{ key: 'k0', label: '9/9', parts: { a3: 40 } }],
      },
    }))
    const card = cardNamed(container, 'Judged vs aged')
    const rows = Array.from(card.querySelectorAll('.rp-div-row'))
    expect(rows).toHaveLength(1)
    expect(rows[0].querySelector('.rp-div-name')!.textContent).toBe('9/9')
    expect(rows[0].querySelector('.rp-div-num.left')!.textContent).toBe('40')
    expect(rows[0].querySelector('.rp-div-num.right')!.textContent).toBe('')
    expect(card.querySelector('.rp-readnote')!.textContent).toBe(
      '0 judged this week against 40 that crossed into an older band, 40 of them past 15 days. On the 8+ day backlog alone: 0 cleared, 40 created – the stale backlog is growing.')
  })

  it('has no Pipeline tab - it lives here now', async () => {
    await renderTab(healthy())
    expect(screen.getByRole('button', { name: 'Overview' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pipeline' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Team Overview' })).not.toBeInTheDocument()
  })
})
