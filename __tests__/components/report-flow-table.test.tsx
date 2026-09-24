import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReportView } from '@/components/report/ReportView'

// The flow table under Overview's "Flow & backlog" chart (and Individual's activity
// chart): the exact numbers behind the lines, one ROW per metric and one COLUMN per
// bucket, so time runs left to right under a chart whose x axis also runs left to
// right. Four rows on Overview whatever the window.
//
//   1. It lives in the Flow card, not under "Do this" - it is evidence, not an action.
//   2. Arrived, Evaluated, Change and Backlog per bucket, plus a Total column for the
//      flows. Backlog is a stock, so it has no total.
//   3. Change = Arrived - Evaluated, signed. Positive means the backlog grew (amber), negative
//      shrank (green), zero neither.
//   4. The last bucket of an open window is a part-day and says so.
//   5. No pipeline (no time axis) means no table.

jest.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 1, role: 'admin', name: 'Admin' } }, status: 'authenticated' }),
}))
jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: jest.fn() }),
  usePathname: () => '/team-ops',
}))

type Bundle = Record<string, unknown>

function bundle(over: Partial<Record<string, unknown>> = {}): Bundle {
  const buckets = ['1/9', '2/9', '3/9']
  const flow = [
    { newGames: 512, evaluated: 487, backlog: 3912 },
    { newGames: 498, evaluated: 530, backlog: 3880 },
    { newGames: 210, evaluated: 210, backlog: 3880 },
  ]
  const series = buckets.map((label, i) => ({ key: `2026-09-0${i + 1}`, label, ...flow[i], people: 5 }))
  const metricSeries = buckets.map((label, i) => ({
    key: `2026-09-0${i + 1}`, label, volume: 200, assigned: 200, evaluated: 200, shortlisted: 16,
    priorityIV: 2, insight: 1, finalPriority: 3, personDays: 2, signalRate: 0.015, survivalRate: 0.08,
  }))
  const age = { a0: 3000, a1: 600, a2: 200, a3: 80 }
  return {
    empty: false, canSeeTeam: true, view: 'week', category: 'puzzle',
    window: { label: 'W1 Sep 2026', from: '2026-09-01', to: '2026-09-04' },
    bucketUnit: 'day',
    options: { week: [], month: [], quarter: [], batch: [] },
    teamTotals: { evaluators: 5, totalAssigned: 1220, totalEvaluated: 1227, avgThroughput: 100, personDayThroughput: 100, avgTurnaround: 2, signalRate: 0.015, survivalRate: 0.08, totalRecorded: 10, linkDead: 0, noteRate: 0.95 },
    bench: {},
    baseline: { from: '2026-06-03', to: '2026-09-01', days: 90, evaluated: 9000, survivalRate: 0.08, signalRate: 0.015, noteRate: 0.93, personDayThroughput: 100 },
    prev: { from: '2026-08-25', to: '2026-09-01', label: 'last week', evaluated: 900, survivalRate: 0.08, signalRate: 0.015, personDayThroughput: 100 },
    self: null, staleDays: 8, selfStale: null, rescue: null,
    funnel: { assigned: 1220, evaluated: 1227, shortlisted: 80, priorityIV: 10, insight: 5, finalPriority: 15 },
    initialConclusions: [{ name: 'Bypass', count: 920 }, { name: 'List_Idea', count: 80 }],
    finalConclusions: [{ name: 'Theme/Art', count: 9 }],
    series: [], metricSeries,
    heatmap: { periods: [], rows: [] }, scoreRank: { periods: [], rows: [] },
    config: { excluded: [], included: [], weights: {} },
    personSeries: {}, videos: {}, evaluators: [], radar: [],
    stock: { backlog: 3880, age },
    pipeline: {
      series,
      current: { backlog: 3880, age },
      window: { newGames: 1220, evaluated: 1227 },
      aging: buckets.map((label, i) => ({ key: `k${i}`, label, ...age, waiting: 3880, medAge: 2, p90Age: 9, maxAge: 16 })),
      cleared: buckets.map((label, i) => ({ key: `c${i}`, label, a0: 150, a1: 30, a2: 15, a3: 5, avgAge: 2.5 })),
      sources: buckets.map((label, i) => ({ key: `s${i}`, label, parts: { 'appagg-scraper': 120 } })),
      sourceYield: [{ src: 'appagg-scraper', n: 1220, evaluated: 600, shortlisted: 48, finalPriority: 9 }],
      aged: buckets.map((label, i) => ({ key: `g${i}`, label, parts: { a1: 30, a2: 10, a3: 20 } })),
    },
    ...over,
  }
}

async function renderTab(b: Bundle) {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => b }) as unknown as typeof fetch
  const view = render(<ReportView />)
  await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument())
  return view
}

const cardNamed = (c: HTMLElement, label: string) =>
  Array.from(c.querySelectorAll('.card-label'))
    .find((l) => l.textContent?.startsWith(label))!.closest('.card') as HTMLElement

const cells = (tr: Element) => Array.from(tr.querySelectorAll('th, td')).map((c) => c.textContent)

describe('Overview flow table', () => {
  afterEach(() => jest.restoreAllMocks())

  it('lists arrived, evaluated, change and backlog per bucket with time running left to right', async () => {
    const { container } = await renderTab(bundle())
    const card = cardNamed(container, 'Flow & backlog')
    const table = card.querySelector('table.rp-flow-table')!
    expect(table).toBeTruthy()
    // not under "Do this"
    expect(container.querySelector('.rp-do-block table')).toBeNull()

    const head = table.querySelector('thead tr')!
    expect(cells(head)).toEqual(['', '1/9', '2/9', '3/9', 'Total'])

    const rows = Array.from(table.querySelectorAll('tbody tr'))
    expect(rows.map((r) => r.querySelector('th')!.textContent)).toEqual(['Arrived', 'Evaluated', 'Change', 'Backlog'])
    expect(cells(rows[0])).toEqual(['Arrived', '512', '498', '210', '1,220'])
    expect(cells(rows[1])).toEqual(['Evaluated', '487', '530', '210', '1,227'])
    expect(cells(rows[2])).toEqual(['Change', '+25', '-32', '0', '-7'])
    // a stock, not a flow: no total
    expect(cells(rows[3])).toEqual(['Backlog', '3,912', '3,880', '3,880', ''])

    // only the Change row carries a sign colour, and only when it is not zero
    const net = Array.from(rows[2].querySelectorAll('td'))
    expect(net[0].className).toContain('up')       // backlog grew
    expect(net[1].className).toContain('down')     // backlog shrank
    expect(net[2].className).not.toMatch(/\b(up|down)\b/)
    expect(net[3].className).toContain('down')     // window total
    for (const r of [rows[0], rows[1], rows[3]]) {
      for (const td of Array.from(r.querySelectorAll('td'))) expect(td.className).not.toMatch(/\b(up|down)\b/)
    }
  })

  it('marks the last bucket of an open window as not finished', async () => {
    // window.to in the future = the window is still running, so the last bucket is a
    // part-day. It stays in the table (a running count is true as far as it goes) and
    // says so.
    const { container } = await renderTab(bundle({ window: { label: 'W1 Sep 2026', from: '2026-09-01', to: '2999-01-01' } }))
    const table = cardNamed(container, 'Flow & backlog').querySelector('table.rp-flow-table')!
    const heads = Array.from(table.querySelectorAll('thead th'))
    expect(heads[3].textContent).toBe('3/9so far')
    expect(heads[3].className).toContain('partial')
    expect(heads[2].className).not.toContain('partial')
  })

  it('shows nothing when there is no time axis', async () => {
    const { container } = await renderTab(bundle({
      view: 'batch', window: { label: 'All batches' }, pipeline: null,
    }))
    expect(container.querySelector('table.rp-flow-table')).toBeNull()
  })
})

describe('Individual activity: backlog line and flow table', () => {
  afterEach(() => jest.restoreAllMocks())

  // One evaluator whose backlog runs 661 -> 759 -> 657 -> 568 over four days, the
  // shape of a real W4 Sep week: each step is received - evaluated - link dead.
  function individual() {
    const b = bundle()
    const ps = [
      { key: '2026-09-21', label: '21/9', assigned: 42, evaluated: 103, shortlisted: 3, linkDead: 0, backlog: 661 },
      { key: '2026-09-22', label: '22/9', assigned: 234, evaluated: 135, shortlisted: 4, linkDead: 1, backlog: 759 },
      { key: '2026-09-23', label: '23/9', assigned: 0, evaluated: 102, shortlisted: 2, linkDead: 0, backlog: 657 },
      { key: '2026-09-24', label: '24/9', assigned: 45, evaluated: 134, shortlisted: 3, linkDead: 0, backlog: 568 },
    ]
    const ev = {
      key: 'thudt', name: 'ThuDT', title: null, assigned: 321, evaluated: 474, shortlisted: 12, linkDead: 1,
      activeDays: 4, throughput: 118.5, turnaround: 1.2, survivalRate: 12 / 474, signalRate: 0, finalPriority: 0,
      recorded: 0, rec5: 0, rec20: 0, noteRate: 1, initialConclusions: { Bypass: 462, List_Idea: 12 }, finalConclusions: {},
    }
    return {
      ...b,
      evaluators: [ev],
      personSeries: { thudt: ps },
      backlogBy: [{ key: 'thudt', name: 'ThuDT', n: 568, a0: 400, a1: 100, a2: 60, a3: 8, oldest: 16, stale: 30 }],
      bench: { people: 5, evaluated: 300, throughput: 100, turnaround: 2, survivalRate: 0.05 },
    }
  }

  it('draws the backlog on the chart and lists it under the chart', async () => {
    const view = await renderTab(individual())
    fireEvent.click(screen.getByRole('button', { name: 'Individual' }))
    const card = cardNamed(view.container, 'ThuDT - activity over time')

    expect(card.textContent).toContain('Backlog')
    const table = card.querySelector('table.rp-flow-table')!
    expect(table).toBeTruthy()
    expect(cells(table.querySelector('thead tr')!)).toEqual(['', '21/9', '22/9', '23/9', '24/9', 'Total'])
    const rows = Array.from(table.querySelectorAll('tbody tr'))
    expect(rows.map((r) => r.querySelector('th')!.textContent)).toEqual(['Received', 'Evaluated', 'Link dead', 'Change', 'Backlog'])
    expect(cells(rows[3])).toEqual(['Change', '-61', '+98', '-102', '-89', '-154'])
    expect(cells(rows[4])).toEqual(['Backlog', '661', '759', '657', '568', ''])

    // the footer reads the pile at the start of the window against the end of it
    const pill = Array.from(card.querySelectorAll('.rp-fact')).find((f) => f.querySelector('.rp-fact-l')?.textContent === 'Backlog')!
    expect(pill.textContent?.replace(/\s+/g, ' ')).toContain('722 → 568')
    expect(pill.className).toContain('good')
  })

  it('draws each metric in ONE colour on Overview and Individual, from the saved preset', async () => {
    // Colour-blind preset: games in = #0072b2, evaluated = #e69f00, backlog = #009e73
    const dots = (card: HTMLElement) => Array.from(card.querySelectorAll('.rp-legend .rp-dot, .rp-dot'))
      .map((dt) => [dt.parentElement?.textContent?.trim(), (dt as HTMLElement).style.background])
    const ov = await renderTab({ ...bundle(), config: { palette: 'cvd' } })
    const ovDots = Object.fromEntries(dots(cardNamed(ov.container, 'Flow & backlog')))
    ov.unmount()
    const ind = await renderTab({ ...individual(), config: { palette: 'cvd' } })
    fireEvent.click(screen.getByRole('button', { name: 'Individual' }))
    const indDots = Object.fromEntries(dots(cardNamed(ind.container, 'ThuDT - activity over time')))
    expect(ovDots['Evaluated']).toBe('rgb(230, 159, 0)')
    expect(indDots['Evaluated']).toBe(ovDots['Evaluated'])
    expect(indDots['Backlog']).toBe(ovDots['Backlog'])
    // "games in" is one colour too, under its tab's own name
    expect(indDots['Assigned']).toBe(ovDots['New games in'])
    expect(indDots['Link dead']).toBe('rgb(148, 163, 184)')   // the fixed neutral
  })
})

describe('age bands and the funnel', () => {
  afterEach(() => jest.restoreAllMocks())

  it('draws backlog age as one hue, light to dark, with ink that reads on each band', async () => {
    const { container } = await renderTab(bundle())
    const bar = Array.from(container.querySelectorAll('.rp-mix-block'))
      .find((b) => b.querySelector('.rp-mix-label')?.textContent?.startsWith('Backlog by age'))!
    const segs = Array.from(bar.querySelectorAll('.rp-band-bar > span')) as HTMLElement[]
    expect(segs.map((sg) => sg.style.background)).toEqual([
      'rgb(241, 159, 145)', 'rgb(218, 109, 93)', 'rgb(185, 63, 49)', 'rgb(134, 40, 29)',
    ])
    // the palest band takes dark ink; a dark band keeps white
    const ink = (sg: HTMLElement) => (sg.querySelector('em') as HTMLElement | null)?.style.color
    expect(ink(segs[0])).toBe('rgb(26, 28, 34)')
    if (segs[1].querySelector('em')) expect(ink(segs[1])).toBe('rgb(255, 255, 255)')
  })

  it('says the top of the funnel is this window, not "new intake"', async () => {
    const { container } = await renderTab(bundle())
    const funnel = cardNamed(container, 'Shortlist funnel')
    expect(funnel.textContent).toContain('in this window')
    expect(funnel.textContent).not.toContain('new intake')
  })
})
