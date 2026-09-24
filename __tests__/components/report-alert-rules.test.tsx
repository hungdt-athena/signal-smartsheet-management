import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ReportView } from '@/components/report/ReportView'
import { DEFAULT_REPORT_RULES, parseReportConfig, parseReportRules } from '@/lib/report-config'

// Config -> Alert rules. The numbers behind every colour and "Do this" line used to be
// constants in ReportView, two of them copied (50 games, 15%) and one of them
// DIFFERENT on two tabs for the same question (high shortlist rate: 5x on the
// Leaderboard, 2.5x on Individual). They are one saved blob now:
//
//   1. parse is tolerant and clamps - a typo can neither switch a rule off nor break
//      the report; an old blob without `rules` reads the defaults;
//   2. a saved rule really moves the tab that reads it;
//   3. the Config card shows every rule with its default, shows the stale-days rule as
//      read-only (it belongs to Rescue), and Save sends the whole blob, rules included.

jest.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 1, role: 'admin', name: 'Admin' } }, status: 'authenticated' }),
}))
jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: jest.fn() }),
  usePathname: () => '/team-ops',
}))

type Bundle = Record<string, unknown>

function bundle(rules?: Record<string, number>): Bundle {
  // Alpha keeps 1% of 900 games, Beta 50% of 100: Alpha is far under the rest.
  const people = [
    { name: 'Alpha', evaluated: 900, shortlisted: 9 },
    { name: 'Beta', evaluated: 100, shortlisted: 50 },
  ]
  const evaluators = people.map((p, i) => ({
    key: `k${i}`, name: p.name, title: null, assigned: p.evaluated, evaluated: p.evaluated,
    activeDays: 6, throughput: p.evaluated / 6, turnaround: 2, signalRate: 0.01, consistency: 1,
    shortlisted: p.shortlisted, priorityIV: 2, insight: 1, finalPriority: 3,
    survivalRate: p.shortlisted / p.evaluated, linkDead: 0, recorded: 0, rec5: 0, rec20: 0, noteRate: 1,
    initialConclusions: { Bypass: p.evaluated - p.shortlisted, List_Idea: p.shortlisted }, finalConclusions: {},
  }))
  return {
    empty: false, canSeeTeam: true, view: 'week', category: 'puzzle',
    window: { label: 'W1 Sep 2026', from: '2026-09-01', to: '2026-09-08' },
    bucketUnit: 'day',
    options: { week: [], month: [], quarter: [], batch: [] },
    teamTotals: { evaluators: 2, totalAssigned: 1000, totalEvaluated: 1000, avgThroughput: 90, personDayThroughput: 90, avgTurnaround: 2, signalRate: 0.01, survivalRate: 59 / 1000, totalRecorded: 0, linkDead: 0, noteRate: 1 },
    bench: { people: 2, evaluated: 500, throughput: 90, turnaround: 2, survivalRate: 59 / 1000 },
    funnel: { assigned: 1000, evaluated: 1000, shortlisted: 59, priorityIV: 4, insight: 2, finalPriority: 6 },
    initialConclusions: [], finalConclusions: [],
    series: [], metricSeries: [],
    heatmap: { periods: [], rows: [] }, scoreRank: { periods: [], rows: [] },
    config: {
      excluded: [], weights: { Volume: 40, Consistency: 20, Signal: 20, Survival: 20 }, credibility: true,
      ...(rules ? { rules: { ...DEFAULT_REPORT_RULES, ...rules } } : {}),
    },
    personSeries: {}, videos: {}, evaluators, radar: [], backlogBy: [], personMoves: {},
    staleDays: 7, selfStale: null, rescue: null, stock: { backlog: 0, age: { a0: 0, a1: 0, a2: 0, a3: 0 } },
    pipeline: null,
  }
}

async function open(b: Bundle, tab: string) {
  global.fetch = jest.fn().mockImplementation((url: string) => Promise.resolve({
    ok: true,
    json: async () => (String(url).startsWith('/api/report/config')
      ? { config: b.config, roster: [{ key: 'k0', name: 'Alpha' }, { key: 'k1', name: 'Beta' }] }
      : b),
  })) as unknown as typeof fetch
  const view = render(<ReportView />)
  await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: tab }))
  return view
}

describe('alert rules: parsing', () => {
  it('reads the defaults from an old blob with no rules at all', () => {
    const cfg = parseReportConfig(JSON.stringify({ excluded: [], weights: {}, credibility: true }))
    expect(cfg.rules).toEqual(DEFAULT_REPORT_RULES)
  })

  it('clamps a value out of bounds instead of switching the rule off', () => {
    const r = parseReportRules({ minGames: 0, growthGap: 7, highRate: 'abc', clearDays: '' })
    expect(r.minGames).toBe(5)          // floor, never 0 = "judge everyone"
    expect(r.growthGap).toBe(1)         // ceiling
    expect(r.highRate).toBe(DEFAULT_REPORT_RULES.highRate)   // junk -> default
    expect(r.clearDays).toBe(DEFAULT_REPORT_RULES.clearDays) // empty -> default
  })

  it('reads an old five-axis DEFAULT blob as the new four-axis defaults, and keeps a customised one', () => {
    const old = parseReportConfig(JSON.stringify({ weights: { Volume: 40, Consistency: 15, Signal: 15, Survival: 15, Recording: 15 } }))
    expect(old.weights).toEqual({ Volume: 40, Consistency: 20, Signal: 20, Survival: 20 })
    const custom = parseReportConfig(JSON.stringify({ weights: { Volume: 50, Consistency: 10, Signal: 20, Survival: 10, Recording: 10 } }))
    expect(custom.weights).toEqual({ Volume: 50, Consistency: 10, Signal: 20, Survival: 10 })
  })

  it('uses one high-rate rule, at the Leaderboard\'s 5x', () => {
    expect(DEFAULT_REPORT_RULES.highRate).toBe(5)
    expect(DEFAULT_REPORT_RULES.lowRate).toBe(0.5)
  })
})

describe('alert rules: a saved rule moves the tab', () => {
  afterEach(() => jest.restoreAllMocks())

  it('judges a shortlist rate at the default 50 games', async () => {
    const { container } = await open(bundle(), 'Individual')
    expect(container.querySelector('.rp-headline')!.textContent).toBe('Alpha bypasses far more games than the team.')
  })

  it('stops judging it when the admin raises the floor above their games', async () => {
    const { container } = await open(bundle({ minGames: 1000 }), 'Individual')
    expect(container.querySelector('.rp-headline')!.textContent).not.toMatch(/bypasses far more/)
    expect(container.querySelector('.rp-do-block')?.textContent || '').not.toMatch(/bypassed/)
  })
})

describe('Config tab: sections, live rules, one save bar', () => {
  afterEach(() => jest.restoreAllMocks())

  const section = (c: HTMLElement, id: string) => c.querySelector(`#${id}`) as HTMLElement

  it('is six sections with a list of them, and no score preview', async () => {
    const { container } = await open(bundle(), 'Config')
    await waitFor(() => expect(container.querySelector('.cfg-person')).not.toBeNull())
    const nav = Array.from(container.querySelectorAll('.cfg-nav-i .cfg-nav-l')).map((n) => n.textContent)
    expect(nav).toEqual(['People', 'Overall score', 'Shortlist rate', 'Backlog', 'Workload', 'Chart colours'])
    for (const id of ['cfg-people', 'cfg-score', 'cfg-rate', 'cfg-backlog', 'cfg-workload', 'cfg-colours']) expect(section(container, id)).not.toBeNull()
    expect(container.textContent).not.toMatch(/Preview - Overall score/)
  })

  it('weights four axes - Recording is not part of the score', async () => {
    const { container } = await open(bundle(), 'Config')
    const score = section(container, 'cfg-score')
    const axes = Array.from(score.querySelectorAll('.rp-cfg-w .rp-cfg-name')).map((n) => n.textContent)
    expect(axes).toEqual(['Volume', 'Consistency', 'Hit rate', 'Shortlist rate'])
    expect(score.querySelector('.cfg-formula')!.textContent).toContain('Recording is not part of the score')
  })

  it('draws every rule against this window and re-reads it as the slider moves', async () => {
    const { container } = await open(bundle(), 'Config')
    const rate = section(container, 'cfg-rate')
    // Alpha keeps 1% against Beta's 50%: far under; Beta is 50x over, past the 5x line
    const block = within(rate).getByText('Shortlist rate against the rest of the team').closest('.rv-rule') as HTMLElement
    expect(block.querySelector('.rv-rule-verdict')!.className).toContain('flag')
    expect(block.querySelector('.rv-rule-verdict')!.textContent).toMatch(/Too little: Alpha/)
    expect(block.querySelector('.rv-rule-verdict')!.textContent).toMatch(/Too much: Beta/)
    // raise the games floor past Beta's 100 and Beta is no longer compared, at once
    fireEvent.change(within(rate).getByLabelText('Compare shortlist rates after'), { target: { value: '200' } })
    expect(block.querySelector('.rv-rule-verdict')!.textContent).not.toMatch(/Beta/)
    expect(rate.querySelector('.rv-rule .rv-rule-verdict')!.textContent).toContain('Not compared: Beta')
    // one number box per rule, ten in all
    expect(container.querySelectorAll('.rv-ctl input[type="number"]')).toHaveLength(Object.keys(DEFAULT_REPORT_RULES).length)
  })

  it('marks a rule that differs from its default, and shows stale days as Rescue\'s', async () => {
    const { container } = await open(bundle({ growthGap: 0.2 }), 'Config')
    const grow = within(section(container, 'cfg-backlog')).getByLabelText('Backlog growing') as HTMLInputElement
    expect(grow.value).toBe('20')                          // stored 0.2, shown as 20%
    const ctlEl = grow.closest('.rv-ctl')!
    expect(ctlEl.className).toContain('changed')
    expect(ctlEl.textContent).toContain('default 15%')
    const meta = section(container, 'cfg-backlog').querySelector('.cfg-sec-meta')!
    expect(meta.textContent).toContain('7 days')
    expect(meta.querySelector('a')!.getAttribute('href')).toBe('/team-ops?tab=rescue')
  })

  it('counts unsaved changes, discards them, and saves the whole blob with shares as fractions', async () => {
    const { container } = await open(bundle(), 'Config')
    await waitFor(() => expect(container.querySelector('.cfg-person')).not.toBeNull())
    const bar = container.querySelector('.cfg-savebar') as HTMLElement
    expect(bar.textContent).toContain('Up to date')
    fireEvent.change(within(container).getByLabelText('Backlog growing'), { target: { value: '25' } })
    fireEvent.change(within(container).getByLabelText('Compare shortlist rates after'), { target: { value: '80' } })
    expect(bar.textContent).toContain('2 unsaved changes')
    fireEvent.click(within(bar).getByRole('button', { name: 'Discard' }))
    expect(bar.textContent).toContain('Up to date')

    fireEvent.change(within(container).getByLabelText('Backlog growing'), { target: { value: '25' } })
    fireEvent.change(within(container).getByLabelText('Compare shortlist rates after'), { target: { value: '80' } })
    fireEvent.click(within(bar).getByRole('button', { name: 'Save settings' }))
    const put = await waitFor(() => {
      const call = (global.fetch as jest.Mock).mock.calls.find(([, init]) => init?.method === 'PUT')
      expect(call).toBeTruthy()
      return call!
    })
    const body = JSON.parse(put[1].body)
    expect(body.rules.growthGap).toBeCloseTo(0.25)
    expect(body.rules.minGames).toBe(80)
    expect(body.rules.staleMin).toBe(DEFAULT_REPORT_RULES.staleMin)
    // the rest of the blob travels too, or a rules save would wipe the weights
    expect(body.weights).toEqual({ Volume: 40, Consistency: 20, Signal: 20, Survival: 20 })
    expect(body.excluded).toEqual([])
    // exactly one Save on the tab
    expect(within(container).getAllByRole('button', { name: 'Save settings' })).toHaveLength(1)
  })
})

describe('Config tab: chart colours', () => {
  afterEach(() => jest.restoreAllMocks())

  it('offers the validated presets, marks the saved one, and saves a new choice', async () => {
    const { container } = await open(bundle(), 'Config')
    const sec = container.querySelector('#cfg-colours') as HTMLElement
    const cards = Array.from(sec.querySelectorAll('.cfg-pal'))
    expect(cards.map((c) => c.querySelector('.cfg-pal-head b')!.textContent)).toEqual(['Standard', 'Classic', 'Colour-blind safe'])
    expect(cards[0].className).toContain('on')       // no palette saved -> the default
    // every card names the six roles, so a reader sees what each colour will mean
    expect(cards[0].querySelectorAll('.cfg-pal-roles > span')).toHaveLength(6)
    fireEvent.click(within(cards[2] as HTMLElement).getByRole('radio'))
    const bar = container.querySelector('.cfg-savebar') as HTMLElement
    expect(bar.textContent).toContain('1 unsaved change')
    fireEvent.click(within(bar).getByRole('button', { name: 'Save settings' }))
    const put = await waitFor(() => {
      const call = (global.fetch as jest.Mock).mock.calls.find(([, init]) => init?.method === 'PUT')
      expect(call).toBeTruthy()
      return call!
    })
    expect(JSON.parse(put[1].body).palette).toBe('cvd')
  })

  it('reads an unknown or missing preset as the default', () => {
    expect(parseReportConfig(JSON.stringify({ palette: 'rainbow' })).palette).toBe('standard')
    expect(parseReportConfig(JSON.stringify({})).palette).toBe('standard')
    expect(parseReportConfig(JSON.stringify({ palette: 'cvd' })).palette).toBe('cvd')
  })
})
