import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReportView } from '@/components/report/ReportView'

// Task 5: the Report's inner tab (?rtab=) and a one-shot focus key (?focus=) live in
// the URL, so a later action elsewhere on the page can link straight into a tab. This
// file only proves the mechanism - rtab round-trips through the URL and an id the
// viewer isn't allowed to see falls back the same way the plain-state guard already
// did. No action button reads `focus` yet; that lands in a later task.

jest.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 1, role: 'admin', name: 'Admin' } }, status: 'authenticated' }),
}))

const replace = jest.fn()
let params = new URLSearchParams()
jest.mock('next/navigation', () => ({
  useSearchParams: () => params,
  useRouter: () => ({ replace }),
  usePathname: () => '/team-ops',
}))

beforeEach(() => { replace.mockClear(); params = new URLSearchParams() })

type Bundle = Record<string, unknown>
type P = {
  name: string; evaluated: number; shortlisted: number; assigned: number
  turnaround: number | null; recorded: number
}
const person = (name: string, over: Partial<P> = {}): P => ({
  name, evaluated: 600, shortlisted: 60, assigned: 600, turnaround: 2, recorded: 2, ...over,
})
const BUCKETS = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6']

// Same shape as the bundleOf() fixture in report-individual.test.tsx /
// report-leaderboard.test.tsx (as of 2026-09-22: carries staleDays, selfStale, rescue,
// and backlogBy[].stale), just renamed for what this file uses it for.
function teamBundle(people: P[] = [person('Alpha'), person('Beta')], patch: Bundle = {}): Bundle {
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
    metricSeries: BUCKETS.map((b) => ({
      key: b, label: b, volume: 100, assigned: 100, evaluated: 100,
      shortlisted: Math.round((totalShort / totalEvaluated) * 100),
      priorityIV: 1, insight: 1, finalPriority: 2, personDays: 1,
      signalRate: 0.01, survivalRate: totalShort / totalEvaluated,
    })),
    heatmap: { periods: [], rows: [] },
    config: {
      excluded: [], included: true,
      weights: { Volume: 40, Consistency: 20, Signal: 20, Survival: 20 },
      credibility: true,
    },
    personSeries: Object.fromEntries(people.map((p, i) => [`k${i}`, BUCKETS.map((b) => ({
      key: b, label: b,
      assigned: Math.round(p.assigned / BUCKETS.length),
      evaluated: Math.round(p.evaluated / BUCKETS.length),
      shortlisted: Math.round(p.shortlisted / BUCKETS.length),
      linkDead: 0,
    }))])),
    videos: {},
    backlogBy: people.map((p, i) => ({
      key: `k${i}`, name: p.name, n: 120, a0: 120, a1: 0, a2: 0, a3: 0, oldest: 2, stale: 0,
    })),
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

// canSeeTeam: false - the shape /api/report sends an evaluator. Individual is the
// only tab this role is ever offered (see SELF_TABS in ReportView.tsx).
function selfBundle(): Bundle {
  return teamBundle([person('Alpha', { evaluated: 0, assigned: 600 })], {
    canSeeTeam: false, self: 'k0',
  })
}

it('opens on the tab named in the URL', async () => {
  params = new URLSearchParams('rtab=leaderboard')
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => teamBundle() })
  render(<ReportView />)
  await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument())
  expect(screen.getByRole('button', { name: 'Leaderboard' }).className).toContain('active')
})

it('ignores a tab an evaluator may not see', async () => {
  // An evaluator's payload offers only the Individual tab (SELF_TABS), so the tab bar
  // itself doesn't render (tabs.length > 1 guard) - there is no "Individual" button to
  // assert against. What's checkable is that the requested id (leaderboard, not on
  // their list) didn't stick: the page still renders Individual's own content, the
  // same fallback the pre-existing plain-state guard already gave.
  params = new URLSearchParams('rtab=leaderboard')
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => selfBundle() })
  const { container } = render(<ReportView />)
  await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument())
  expect(screen.queryByRole('button', { name: 'Leaderboard' })).not.toBeInTheDocument()
  expect(container.querySelector('.rp-headline')?.textContent).toBe('You have not evaluated anything this week.')
})

it('writes rtab back to the URL on tab change without touching other params', async () => {
  params = new URLSearchParams('tab=performance&foo=bar')
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => teamBundle() })
  render(<ReportView />)
  await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument())
  const { fireEvent } = await import('@testing-library/react')
  fireEvent.click(screen.getByRole('button', { name: 'Leaderboard' }))
  expect(replace).toHaveBeenCalledTimes(1)
  const [url, opts] = replace.mock.calls[0]
  expect(url).toBe('/team-ops?tab=performance&foo=bar&rtab=leaderboard')
  expect(opts).toEqual({ scroll: false })
})

// The filter bar is in the URL too: view, period, start/end, title, cat. The URL is
// the state, so these check both directions - the URL drives the request, and a
// control writes the URL (one replace per change, defaults left out).
describe('filter bar in the URL', () => {
  const reportCalls = () => (global.fetch as jest.Mock).mock.calls
    .map((c) => new URL(String(c[0]), 'http://x'))
    .filter((u) => u.pathname === '/api/report')
  const settle = () => waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument())

  it('asks the API for what the URL says', async () => {
    params = new URLSearchParams('tab=performance&view=month&period=2026-08&cat=arcade&title=fulltime')
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => teamBundle() })
    render(<ReportView />)
    await settle()
    const q = reportCalls()[0].searchParams
    expect(q.get('view')).toBe('month')
    expect(q.get('key')).toBe('2026-08')
    expect(q.get('category')).toBe('arcade')
    expect(q.get('title')).toBe('fulltime')
  })

  it('lands on the newest batch, Puzzle, all titles when the URL says nothing', async () => {
    params = new URLSearchParams('tab=performance')
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => teamBundle() })
    render(<ReportView />)
    await settle()
    const q = reportCalls()[0].searchParams
    expect(q.get('view')).toBe('batch')
    expect(q.get('key')).toBeNull()
    expect(q.get('category')).toBe('puzzle')
    expect(q.get('title')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
  })

  it('puts the category group first, All first, and writes cat to the URL', async () => {
    params = new URLSearchParams('tab=performance')
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => teamBundle() })
    const { container } = render(<ReportView />)
    await settle()
    const groups = Array.from(container.querySelectorAll('.rp-filters [role="group"]'))
    expect(groups[0].getAttribute('aria-label')).toBe('Category')
    expect(Array.from(groups[0].querySelectorAll('button')).map((b) => b.textContent))
      .toEqual(['All', 'Puzzle', 'Arcade', 'Simulation'])
    fireEvent.click(screen.getByRole('button', { name: 'Arcade' }))
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace.mock.calls[0][0]).toBe('/team-ops?tab=performance&cat=arcade')
  })

  it('switching the lens drops the old period and dates in one navigation', async () => {
    params = new URLSearchParams('tab=performance&view=custom&start=2026-08-01&end=2026-08-20&cat=arcade')
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => teamBundle() })
    render(<ReportView />)
    await settle()
    const q = reportCalls()[0].searchParams
    expect(q.get('from')).toBe('2026-08-01')
    expect(q.get('to')).toBe('2026-08-20')
    fireEvent.click(screen.getByRole('button', { name: 'Week' }))
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace.mock.calls[0][0]).toBe('/team-ops?tab=performance&view=week&cat=arcade')
  })

  it('the Batch picker writes the batch, All batches as period=all, and a whole month as the Month lens', async () => {
    params = new URLSearchParams('tab=performance&cat=arcade')
    const bundle = teamBundle([person('Alpha'), person('Beta')], {
      view: 'batch',
      window: { label: 'W2 Aug, 2026', from: '2026-08-03', to: '2026-08-10', batch: 'W2 Aug, 2026' },
      options: { week: [], month: [], quarter: [], batch: [
        { key: 'W2 Aug, 2026', label: 'W2 Aug, 2026 · 3/8 – 9/8' },
        { key: 'W1 Aug, 2026', label: 'W1 Aug, 2026 · 27/7 – 2/8' },
      ] },
    })
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => bundle })
    render(<ReportView />)
    await settle()
    const open = () => fireEvent.click(screen.getByRole('button', { name: 'Batch: W2 Aug, 2026' }))
    open()
    fireEvent.click(screen.getByRole('button', { name: 'W1 Aug, 2026' }))
    expect(replace.mock.calls.at(-1)![0]).toBe('/team-ops?tab=performance&cat=arcade&period=W1+Aug%2C+2026')
    open()
    fireEvent.click(screen.getByRole('button', { name: 'All batches' }))
    expect(replace.mock.calls.at(-1)![0]).toBe('/team-ops?tab=performance&cat=arcade&period=all')
    open()
    fireEvent.click(screen.getByRole('button', { name: /^All of Aug/ }))
    expect(replace.mock.calls.at(-1)![0]).toBe('/team-ops?tab=performance&cat=arcade&view=month&period=2026-08')
  })

  it('Clear filters removes every filter key and keeps the rest of the URL', async () => {
    params = new URLSearchParams('tab=performance&rtab=leaderboard&view=week&period=2026-09-01&cat=all&title=freelancer')
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => teamBundle() })
    render(<ReportView />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace.mock.calls[0][0]).toBe('/team-ops?tab=performance&rtab=leaderboard')
  })
})
