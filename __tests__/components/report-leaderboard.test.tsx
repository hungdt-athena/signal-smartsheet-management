import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReportView } from '@/components/report/ReportView'

// The Leaderboard tab's contract. It is a reading contract first, like Overview's:
//
//   1. Guide, then one sentence, then chips, then AT MOST THREE actions. Nothing is
//      folded behind a toggle, and there is no KPI row - the table below IS the
//      numbers, and four boxes repeating them would be Overview a second time.
//   2. Eight single-metric rank boards became ONE sortable table, and every rate
//      carries the counts it came from in the same cell. That pairing is the whole
//      point: the best-looking percentage on the tab is usually the thinnest sample on
//      the tab, and those two facts used to sit half a screen apart.
//   3. An action only prints when a number crosses a named threshold, at most one per
//      family, and never two lines about the same person.
//   4. Charts explain themselves in a ReadNote. None of them carries an "Act" - eight
//      Acts is how a tab ends up with no actions at all.
//   5. Every noun is the right noun. The heatmap's cells are `activityUnit` (finer);
//      the trend charts' are `bucketUnit`; the selection is neither. Each of those
//      three has printed the wrong word at least once.

jest.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 1, role: 'admin', name: 'Admin' } }, status: 'authenticated' }),
}))

type Bundle = Record<string, unknown>
type Person = {
  name: string; evaluated: number; turnaround: number | null
  bypass: number; listIdea: number; final: Record<string, number>
  cells: Record<string, number>
}

// A window where nothing crosses a threshold: four people at the same output, the same
// bypass bar, the same turnaround, working every day, and picks that hold up alike.
// Each test breaks exactly one of those, so a failure names the rule that moved.
const DAYS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']
const even = (name: string, over: Partial<Person> = {}): Person => ({
  name, evaluated: 250, turnaround: 2,
  bypass: 200, listIdea: 50,
  final: { 'Priority IV': 3, 'Theme/Art': 3 },
  cells: Object.fromEntries(DAYS.map((d) => [d, 42])),
  ...over,
})

function bundleOf(people: Person[], patch: Bundle = {}): Bundle {
  const evaluators = people.map((p, i) => ({
    key: `k${i}`, name: p.name, title: null,
    assigned: p.evaluated, evaluated: p.evaluated,
    activeDays: p.evaluated > 0 ? 5 : 0, throughput: p.evaluated / 5,
    turnaround: p.turnaround, signalRate: p.evaluated ? 0.01 : 0, consistency: 1,
    shortlisted: p.listIdea, priorityIV: 2, insight: 1, finalPriority: p.evaluated ? 3 : 0,
    survivalRate: p.evaluated ? p.listIdea / p.evaluated : 0,
    linkDead: 0, noted: p.evaluated, noteRate: 1, recorded: 2, rec5: 1, rec20: 1,
    initialConclusions: p.evaluated ? { Bypass: p.bypass, List_Idea: p.listIdea } : {},
    finalConclusions: p.final,
  }))
  const totalEvaluated = people.reduce((s, p) => s + p.evaluated, 0)
  return {
    empty: false, canSeeTeam: true, view: 'week', category: 'puzzle',
    window: { label: 'W1 Sep 2026', from: '2026-09-01', to: '2026-09-06' },
    bucketUnit: 'day', activityUnit: 'day',
    options: { week: [], month: [], quarter: [], batch: [] },
    teamTotals: {
      evaluators: people.filter((p) => p.evaluated > 0).length,
      totalAssigned: totalEvaluated, totalEvaluated,
      avgThroughput: 50, personDayThroughput: 50, avgTurnaround: 2,
      signalRate: 0.01, survivalRate: 0.2, totalRecorded: 8, linkDead: 0, noteRate: 1,
    },
    bench: {}, baseline: null, self: null,
    funnel: { assigned: totalEvaluated, evaluated: totalEvaluated, shortlisted: 200, priorityIV: 8, insight: 4, finalPriority: 12 },
    initialConclusions: [], finalConclusions: [],
    series: [], metricSeries: [],
    heatmap: {
      periods: DAYS.map((d) => ({ key: d, label: d })),
      rows: people.filter((p) => p.evaluated > 0).map((p) => ({ name: p.name, cells: p.cells })),
    },
    config: {
      excluded: [], included: true,
      weights: { Volume: 40, Consistency: 15, Signal: 15, Survival: 15, Recording: 15 },
      credibility: true,
    },
    personSeries: {}, videos: {}, dailyMix: {},
    evaluators,
    radar: people.map((p, i) => ({
      key: `k${i}`, name: p.name,
      axes: { Volume: 80, Consistency: 90, Signal: 60, Survival: 70, Recording: 50 },
    })),
    pipeline: null,
    ...patch,
  }
}

const FOUR = () => [even('Alpha'), even('Beta'), even('Gamma'), even('Delta')]

async function leaderboard(bundle: Bundle) {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => bundle }) as unknown as typeof fetch
  const view = render(<ReportView />)
  await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: 'Leaderboard' }))
  return view
}

const actions = (c: HTMLElement) => Array.from(c.querySelectorAll('.rp-do')).map((el) => ({
  urgent: el.classList.contains('urgent'),
  do: el.querySelector('.rp-do-line')?.textContent || '',
  why: el.querySelector('.rp-do-why')?.textContent || '',
}))
const rows = (c: HTMLElement) => Array.from(c.querySelectorAll('.rp-lbt tbody tr'))
  .filter((r) => !r.classList.contains('rp-lbt-sep'))
const names = (c: HTMLElement) => rows(c).map((r) => r.querySelector('.rp-lbt-name')?.textContent)
// by the name cell, not the row text: a ranked row starts with its rank number
const rowNamed = (c: HTMLElement, name: string) =>
  rows(c).find((r) => r.querySelector('.rp-lbt-name')?.textContent === name)!
const readNotes = (c: HTMLElement) => Array.from(c.querySelectorAll('.rp-readnote')).map((r) => r.textContent || '')
// the computed half of a chart footer: what this window's numbers say, as opposed to
// the standing explanation of how to read the chart
const nowLines = (c: HTMLElement) => Array.from(c.querySelectorAll('.rp-foot-now')).map((r) => r.textContent || '')

describe('Leaderboard tab', () => {
  afterEach(() => jest.restoreAllMocks())

  it('reads guide, sentence, chips, actions - with no KPI row and nothing folded away', async () => {
    const { container } = await leaderboard(bundleOf(FOUR()))
    const marks = ['rp-guide', 'rp-headline', 'rp-chips']
    const order = Array.from(container.querySelectorAll(marks.map((m) => `.${m}`).join(', ')))
    expect(order.map((el) => marks.find((m) => el.classList.contains(m)))).toEqual(marks)

    // The guide folds and starts folded; nothing else on the tab folds at all.
    const toggle = container.querySelector('.rp-guide button')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.rp-guide .read')).toBeNull()
    expect(container.querySelectorAll('button[aria-expanded]')).toHaveLength(1)
    expect(container.querySelector('details')).toBeNull()
    // Overview owns the team numbers. Repeating four of them above a table of the same
    // numbers is the duplication this redesign existed to remove.
    expect(container.querySelector('.rp-kpi')).toBeNull()
  })

  it('carries six cards and none of the blocks the redesign removed', async () => {
    const { container } = await leaderboard(bundleOf(FOUR()))
    const labels = Array.from(container.querySelectorAll('.card-label')).map((l) => l.textContent?.replace('?', ''))
    expect(labels).toEqual([
      'Volume vs shortlist rate',
      'Everyone, side by side',
      'Whose backlog is it',
      'Activity heatmap',
      'Initial conclusions by evaluator',
      'Their picks - final outcomes',
    ])
    // Eight rank boards, an eight-series radar and two bump charts used to live here.
    expect(container.querySelector('.rp-rank')).toBeNull()
    expect(container.querySelector('.rp-radar-wrap')).toBeNull()
    expect(container.querySelector('.rp-bump-name')).toBeNull()
    // A ReadNote explains a chart; an Act tells someone to do something. Actions live
    // in one block at the top, or the tab has eight of them and therefore none.
    expect(container.querySelectorAll('.rp-act')).toHaveLength(0)
    expect(readNotes(container).length).toBe(6)
  })

  it('prints no actions when nothing crosses a threshold', async () => {
    const { container } = await leaderboard(bundleOf(FOUR()))
    expect(actions(container)).toEqual([])
    expect(container.querySelector('.rp-headline'))
      .toHaveTextContent('The team is judging by one bar, at a comparable pace.')
  })

  it('puts every rate next to the count it was computed from', async () => {
    // Delta's 50% shortlist rate is the best number in the column and rests on 8 games.
    const people = FOUR()
    people[3] = even('Delta', { evaluated: 8, bypass: 4, listIdea: 4, cells: { d1: 8 } })
    const { container } = await leaderboard(bundleOf(people))
    const delta = rowNamed(container, 'Delta')
    const cells = Array.from(delta.querySelectorAll('td')).map((td) => td.textContent)
    expect(cells.some((c) => c?.includes('50%') && c.includes('4 of 8'))).toBe(true)
    // ... and its Overall score is scaled down rather than topping the board on a rate
    expect(cells.some((c) => c?.includes('sample weight'))).toBe(true)
  })

  it('lists someone with no evaluations but never gives them a rank', async () => {
    const people = [...FOUR(), even('Echo', { evaluated: 0, bypass: 0, listIdea: 0, final: {}, cells: {} })]
    const { container } = await leaderboard(bundleOf(people))
    expect(names(container)).toContain('Echo')
    const echo = rowNamed(container, 'Echo')
    expect(echo.classList.contains('rp-lbt-idle')).toBe(true)
    expect(echo.querySelector('.rp-lbt-i')?.textContent).toBe('')
    // and a zero-game row claims no active days: "1 active day" under "0 games" is one
    // cell disagreeing with itself
    expect(echo.textContent).not.toMatch(/active day/)
  })

  it('sorts on any column, and a missing value sinks in both directions', async () => {
    const people = FOUR()
    people[0] = even('Alpha', { turnaround: 9 })
    people[1] = even('Beta', { turnaround: null })
    const { container } = await leaderboard(bundleOf(people))
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Days waiting' }))
    expect(names(container)![0]).toBe('Alpha')
    expect(names(container)!.at(-1)).toBe('Beta')
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Days waiting' }))
    expect(names(container)![0]).not.toBe('Alpha')
    // No turnaround is not a turnaround of zero, so Beta never wins "fastest".
    expect(names(container)!.at(-1)).toBe('Beta')
  })

  it('names the two ends when the team is smeared but nobody is far enough out', async () => {
    // Shortlist rate and bypass share are one quantity read from opposite ends, so the
    // spread rule and the outlier rule measure the same thing. They are separated by
    // job: the outlier names a person and leads; this line speaks only when the ends
    // are far apart and no single person crosses the outlier test.
    const people = FOUR()
    people[0] = even('Alpha', { bypass: 210, listIdea: 40 })  // 84% bypass, 16% kept
    people[1] = even('Beta', { bypass: 165, listIdea: 85 })   // 66% bypass, 34% kept
    const { container } = await leaderboard(bundleOf(people))
    expect(container.querySelector('.rp-headline')).toHaveTextContent('not judging by the same bar')
    expect(container.querySelectorAll('.rp-scatter-lbl.hot')).toHaveLength(0)
    const [first] = actions(container)
    expect(first.do).toContain('Alpha')
    expect(first.do).toContain('Beta')
    expect(first.urgent).toBe(true)
    // The evidence is what the gap costs in games, not two percentages to convert.
    expect(first.why).toContain('would have sent on about 85 instead of 40')
    // and it asks for a re-read of games already judged. Every game goes to exactly one
    // person and is never judged twice, so "put them through the same 20 games" asked
    // for something the assignment model cannot do.
    expect(first.do).toMatch(/re-read/i)
    expect(first.do).not.toMatch(/the same 20 games/i)
  })

  it('never spends two of the three lines on one person', async () => {
    // Gamma is both the slowest backlog and the longest silence. The speed line names
    // them; the cadence line must then pick somebody else or say nothing.
    const people = FOUR()
    people[2] = even('Gamma', { turnaround: 12, cells: { d1: 250 } })
    const { container } = await leaderboard(bundleOf(people))
    const shown = actions(container)
    expect(shown.filter((a) => a.do.includes('Gamma'))).toHaveLength(1)
    expect(shown.length).toBeLessThanOrEqual(3)
  })

  it('names the heatmap cells with the heatmap grain, not the trend charts', async () => {
    // A month window draws weekly trend buckets over a DAILY heatmap. Reading the
    // cadence off one and naming it with the other printed "13 of 13 weeks".
    const people = FOUR()
    people[2] = even('Gamma', { cells: { d1: 250 } })
    const { container } = await leaderboard(bundleOf(people, {
      view: 'month', bucketUnit: 'week', activityUnit: 'day',
      window: { label: 'Sep 2026', from: '2026-09-01', to: '2026-09-07' },
    }))
    const cadence = actions(container).find((a) => a.do.includes('Gamma'))!
    expect(cadence.why).toMatch(/\bdays\b/)
    expect(cadence.why).not.toMatch(/\bweeks\b/)
  })

  it('does not call someone silent when their work is in the part-bucket', async () => {
    // The last bucket of an open window is trimmed from anything read as a rate. It is
    // still conclusive evidence of presence: a game judged this morning means the
    // person is not on leave, whatever the other six days say.
    const people = FOUR()
    people[2] = even('Gamma', { cells: { d6: 250 } })
    const { container } = await leaderboard(bundleOf(people, {
      window: { label: 'This week', from: '2026-09-01' },   // no `to` = still open
    }))
    expect(actions(container).some((a) => a.do.includes('Gamma'))).toBe(false)
  })

  it('captions every column and flags the rows it is about to name', async () => {
    // "984 13d +955" gives a reader no way to know which is a count, which is an age and
    // which is a change. And a footer that names three people is no use if the chart
    // above it leaves them to be found among eleven identical bars.
    const people = [even('Alpha'), even('Beta'), even('Gamma'), even('Delta')]
    const { container } = await leaderboard(bundleOf(people, {
      backlogBy: [
        { key: 'k0', name: 'Alpha', n: 400, a0: 100, a1: 50, a2: 200, a3: 50, oldest: 30 },
        { key: 'k1', name: 'Beta', n: 300, a0: 300, a1: 0, a2: 0, a3: 0, oldest: 2 },
      ],
    }))
    const head = container.querySelector('.rp-queue-head')!
    for (const c of ['Evaluator', 'Games', 'Oldest', 'Net this']) expect(head.textContent).toContain(c)
    // the flagged rows, the footer and the action all name the same person
    const flagged = Array.from(container.querySelectorAll('.rp-queue-row.warn .rp-queue-name')).map((n) => n.textContent)
    expect(flagged).toEqual(['Alpha'])
    const now = nowLines(container).find((n) => n.includes('flagged'))!
    expect(now).toContain('Alpha')
    expect(now).not.toContain('Beta')
    expect(actions(container).find((a) => a.do.includes('Rescue'))!.do).toContain('Alpha')
  })

  it('never prints two moves about the same person', async () => {
    // The family filter cannot catch this: families exist so that different families
    // say different things, and "Alpha bypasses too much" and "Alpha carries the whole
    // team" are genuinely different things about genuinely one person. The reader still
    // gets one name twice and the rest of the team goes unsaid.
    const people = [even('Alpha', { evaluated: 700 }), even('Beta', { evaluated: 100 }),
      even('Gamma', { evaluated: 100 }), even('Delta', { evaluated: 100 })]
    const { container } = await leaderboard(bundleOf(people, { window: { label: 'All time' } }))
    const shown = actions(container)
    const named = shown.filter((a) => a.do.includes('Alpha'))
    expect(named).toHaveLength(1)
    // the one that survives is the worse problem, not whichever was pushed first
    expect(named[0].do).toContain('bypassed')
  })

  it('moves the stale-backlog line to the next person rather than dropping it', async () => {
    // Dropping it outright is the wrong fix for the rule above: a real problem on a
    // second person would disappear because a first person happened to have two.
    const people = [even('Alpha', { evaluated: 700 }), even('Beta'), even('Gamma'), even('Delta')]
    const { container } = await leaderboard(bundleOf(people, {
      backlogBy: [
        { key: 'k0', name: 'Alpha', n: 400, a0: 100, a1: 50, a2: 200, a3: 50, oldest: 30 },
        { key: 'k1', name: 'Beta', n: 300, a0: 100, a1: 40, a2: 120, a3: 40, oldest: 22 },
      ],
    }))
    const shown = actions(container)
    // Alpha is already named by the calibration line, so the backlog line names Beta
    expect(shown.find((a) => a.do.includes('Rescue'))!.do).toContain('Beta')
    expect(shown.filter((a) => a.do.includes('Alpha'))).toHaveLength(1)
  })

  it('does not call an all-time window "this week"', async () => {
    // All-time and batch windows carry no from/to and leave `view` at whatever the
    // segmented control last held, so reading `view` alone printed "this week".
    // Alpha keeps the same SHARE as everyone else - only the volume is concentrated.
    // Give them the team's bypass bar too and they become the calibration outlier as
    // well, and the concentration line is then correctly dropped for naming a person
    // who has already been named.
    const people = [even('Alpha', { evaluated: 700, bypass: 350, listIdea: 350 }), even('Beta', { evaluated: 100 }),
      even('Gamma', { evaluated: 100 }), even('Delta', { evaluated: 100 })]
    const { container } = await leaderboard(bundleOf(people, { window: { label: 'All time' } }))
    const share = actions(container).find((a) => a.do.includes('second person'))!
    expect(share.do).toContain('this window')
    expect(share.do).not.toContain('this week')
  })

  it('sorts largest first, then smallest first, then back to the default', async () => {
    const { container } = await leaderboard(bundleOf(FOUR()))
    const btn = () => screen.getByRole('button', { name: 'Sort by Days waiting' })
    expect(container.querySelector('.rp-lbt-reset')).toBeNull()   // default carries no state to undo
    fireEvent.click(btn())
    expect(container.querySelector('.rp-lbt-state')).toHaveTextContent('Days waiting, largest first')
    fireEvent.click(btn())
    expect(container.querySelector('.rp-lbt-state')).toHaveTextContent('Days waiting, smallest first')
    fireEvent.click(btn())
    expect(container.querySelector('.rp-lbt-bar')).toBeNull()
    // ... and the Reset button is the same exit without three clicks
    fireEvent.click(btn())
    fireEvent.click(container.querySelector('.rp-lbt-reset') as HTMLElement)
    expect(container.querySelector('.rp-lbt-bar')).toBeNull()
  })

  it('draws its icons instead of typing them', async () => {
    // A glyph picks up the reader's font and their browser's emoji substitution, so
    // the sort arrow and the "?" arrived at a different size on every machine.
    const { container } = await leaderboard(bundleOf(FOUR()))
    const head = container.querySelector('.rp-lbt thead')!
    expect(head.textContent).not.toMatch(/[\u25b2\u25bc\u2195?]/)
    expect(head.querySelectorAll('.rp-sortmark').length).toBe(7)
    expect(container.querySelector('.rp-qtip-icon svg')).not.toBeNull()
  })

  it('puts the scatter on round ticks and never stacks two names', async () => {
    // jsdom does no layout, but every tick and every name is an absolutely positioned
    // text node - their x/y ARE the layout, so read the attributes back.
    const people = FOUR().map((p, i) => ({ ...p, evaluated: 471 * (i + 1) }))
    const { container } = await leaderboard(bundleOf(people))
    const ticks = Array.from(container.querySelectorAll('.rp-xlabel')).map((t) => t.textContent)
    expect(ticks).toEqual(['0', '500', '1,000', '1,500', '2,000'])
    const yticks = Array.from(container.querySelectorAll('.rp-ylabel')).map((t) => t.textContent)
    expect(yticks.every((t) => /^\d+%$/.test(t || ''))).toBe(true)

    const lbls = Array.from(container.querySelectorAll('.rp-scatter-lbl')).map((el) => ({
      name: el.textContent || '',
      x: Number(el.getAttribute('x')), y: Number(el.getAttribute('y')),
      anchor: el.getAttribute('text-anchor') || 'start',
    }))
    expect(lbls.length).toBeGreaterThan(0)
    const box = (l: typeof lbls[number]) => {
      const w = l.name.length * 6.5
      const x1 = l.anchor === 'middle' ? l.x - w / 2 : l.anchor === 'start' ? l.x : l.x - w
      return [x1, l.y - 11, x1 + w, l.y + 2]
    }
    for (let i = 0; i < lbls.length; i++) {
      for (let j = i + 1; j < lbls.length; j++) {
        const a = box(lbls[i]), b = box(lbls[j])
        const hit = a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
        expect(hit ? `${lbls[i].name} overlaps ${lbls[j].name}` : 'ok').toBe('ok')
      }
    }
  })

  it('keeps a thin sample off the plot and names it underneath', async () => {
    // A roster splits into two populations: people on hundreds of games, and people on
    // a handful. Plotting the second group costs three things at once - the point is
    // sampling noise, it stretches the y axis over a range nobody else occupies, and it
    // drags the reference lines above every working evaluator.
    const people = [...FOUR(), even('Tiny', { evaluated: 6, bypass: 3, listIdea: 3, cells: { d1: 6 } })]
    const { container } = await leaderboard(bundleOf(people))
    const plotted = Array.from(container.querySelectorAll('.rp-scatter-lbl')).map((t) => t.textContent)
    expect(plotted).not.toContain('Tiny')
    const strip = container.querySelector('.rp-thin')!
    expect(strip.textContent).toContain('Tiny')
    expect(strip.textContent).toContain('6')
    // ... and the axis now covers the people who are on it
    const yTop = Array.from(container.querySelectorAll('.rp-ylabel')).map((t) => parseInt(t.textContent || '0', 10))
    expect(Math.max(...yTop)).toBeLessThanOrEqual(30)
    // Tiny keeps 3 of 6, which is more than 5x the team - and is still not an outlier,
    // because six games is not a sample of anybody's judgement.
    expect(Array.from(container.querySelectorAll('.rp-scatter-lbl.hot')).map((t) => t.textContent))
      .not.toContain('Tiny')
  })

  it('draws the team line at the pooled rate, not the mean of the rates', async () => {
    // A mean of ratios weights a 6-game rate the same as a 1,000-game one. On real data
    // that put the team line at 21% when the team kept 5.7%, above every evaluator on
    // the chart, so all of them read as underperforming against a bar four rookies set.
    const people = [even('Big', { evaluated: 1000, bypass: 990, listIdea: 10 }),
      even('Beta'), even('Gamma'), even('Delta')]
    const { container } = await leaderboard(bundleOf(people))
    // pooled = (10+50+50+50) / (1000+250*3) = 160/1750 = 9.1%, one game in 11.
    // the mean of the four rates would be 15.3%, one in 7.
    const quad = Array.from(container.querySelectorAll('.rp-quad-lbl')).map((t) => t.textContent)
    expect(quad).toContain('team keeps 1 in 11')
  })

  it('calls out a rate half the team or five times it, and nothing in between', async () => {
    const people = [even('Big', { evaluated: 1000, bypass: 990, listIdea: 10 }),
      even('Beta'), even('Gamma'), even('Delta')]
    const { container } = await leaderboard(bundleOf(people))
    const hot = Array.from(container.querySelectorAll('.rp-scatter-lbl.hot')).map((t) => t.textContent)
    // Big keeps 1.0% against a pooled 9.1%: a ninth of the team rate, on 1,000 games.
    expect(hot).toEqual(['Big'])
    // The other three keep 20%, which is 2.2x the team - real, but the high side has to
    // reach 5x before it is called out. A high rate is usually a lower bar or a lucky
    // run; a low rate is signal nobody downstream will ever see.
    expect(hot).not.toContain('Beta')
    expect(nowLines(container)[0]).toContain('Big')
    // measured against EVERYONE ELSE (150 of 750 = 1 in 5), not against a pool Big is
    // inside, which Big's own 1,000 games would otherwise drag down to 1 in 11
    expect(nowLines(container)[0]).toMatch(/1 game in 100 where the others keep 1 in 5/)
    expect(actions(container).some((a) => a.do.includes('Re-read 20 games Big bypassed'))).toBe(true)
  })

  it('cuts an empty middle out of the y axis and says it did', async () => {
    // One person at 88% and four under 17% makes three-quarters of the plot a blank
    // rectangle and squashes the four people actually being compared into a strip.
    const people = [even('Star', { evaluated: 95, bypass: 11, listIdea: 84, cells: { d1: 95 } }),
      even('Beta', { evaluated: 155, bypass: 133, listIdea: 22, cells: { d1: 155 } }),
      even('Gamma', { evaluated: 160, bypass: 144, listIdea: 16, cells: { d1: 160 } }),
      even('Delta', { evaluated: 225, bypass: 214, listIdea: 11, cells: { d1: 225 } })]
    const { container } = await leaderboard(bundleOf(people))
    const ticks = Array.from(container.querySelectorAll('.rp-ylabel')).map((t) => t.textContent)
    expect(ticks).toEqual(['0%', '5%', '10%', '15%', '20%', '25%', '75%', '100%'])
    expect(container.querySelector('.rp-brk-cap')).toHaveTextContent('nobody between 25% and 75%')
  })

  it('leaves the y axis alone when the gap is just how the team is spread', async () => {
    // A softer rule cut a perfectly ordinary week between 5% and 12%, where the gap is
    // the reading rather than something to remove.
    const people = [even('A', { evaluated: 900, bypass: 890, listIdea: 10 }),
      even('B', { evaluated: 800, bypass: 760, listIdea: 40 }),
      even('C', { evaluated: 400, bypass: 353, listIdea: 47 }),
      even('D', { evaluated: 300, bypass: 262, listIdea: 38 })]
    const { container } = await leaderboard(bundleOf(people))
    expect(container.querySelector('.rp-brk-cap')).toBeNull()
  })

  it('measures an outlier against everyone else, not a pool it is inside', async () => {
    // The bigger the outlier, the harder self-inclusion works to hide it. One evaluator
    // who kept 84 of 95 games put those 84 into the team total and scored 4.7x, just
    // under the line, when against the other four they were 10.1x.
    const people = [even('Star', { evaluated: 95, bypass: 11, listIdea: 84, cells: { d1: 95 } }),
      even('Beta', { evaluated: 155, bypass: 133, listIdea: 22, cells: { d1: 155 } }),
      even('Gamma', { evaluated: 160, bypass: 144, listIdea: 16, cells: { d1: 160 } }),
      even('Delta', { evaluated: 225, bypass: 214, listIdea: 11, cells: { d1: 225 } })]
    const { container } = await leaderboard(bundleOf(people))
    const hot = Array.from(container.querySelectorAll('.rp-scatter-lbl.hot'))
      .map((t) => `${t.textContent}:${t.getAttribute('class')?.split(' ').pop()}`)
    expect(hot).toContain('Star:high')
    // the marker is a shape too, so it survives greyscale and a colourblind reader
    expect(container.querySelectorAll('.rp-out-ring').length).toBe(hot.length)
    // and at 88% the count form would read "1 game in 1", so both sides switch to %
    const now = nowLines(container).join(' ')
    expect(now).toContain('Star')
    expect(now).not.toContain('1 game in 1 ')
    expect(now).toMatch(/Star<\/b>? ?keeps 88%|Star keeps 88%/)
  })

  it('reads movement as half the window against the other half', async () => {
    // Not first bucket against last: on a quiet opening day that ranks the whole team
    // off whoever happened to be working, and the line then says something enormous
    // about a Sunday.
    const people = FOUR()
    people[0] = even('Alpha', { cells: { d1: 1, d2: 1, d3: 1, d4: 200, d5: 200, d6: 200 } })
    people[1] = even('Beta', { cells: { d1: 200, d2: 200, d3: 200, d4: 1, d5: 1, d6: 1 } })
    const { container } = await leaderboard(bundleOf(people))
    const heat = nowLines(container).find((n) => n.includes('First half'))!
    expect(heat).toContain('First half of these 6 days against the second')
    expect(heat).toContain('Alpha')
    expect(heat).toContain('Beta')
  })

  it('gives every chart a footer computed from the window on screen', async () => {
    // A fixed sentence about the axes tells a reader who has already looked at them
    // nothing. Each footer carries one line derived from the numbers that were drawn.
    const { container } = await leaderboard(bundleOf(FOUR()))
    const now = nowLines(container)
    expect(now).toHaveLength(6)
    // most of them quote a number; a window where nothing moved is allowed to say so
    expect(now.every((n) => n.trim().length > 20)).toBe(true)
    expect(now.filter((n) => /\d/.test(n)).length).toBeGreaterThanOrEqual(4)
    // ... and none of them is an instruction. Actions live in "Do this" and nowhere else.
    expect(now.some((n) => /^(Ask|Have|Move|Share|Re-read|Review|Put) /.test(n.replace(/^Now/, '').trim()))).toBe(false)
  })
})
