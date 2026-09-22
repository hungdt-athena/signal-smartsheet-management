import { render, screen, waitFor } from '@testing-library/react'
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
  expect(container.querySelector('.rp-headline')?.textContent).toBe('You have not judged anything this week.')
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
