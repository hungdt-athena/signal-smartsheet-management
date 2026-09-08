import { act, render, waitFor } from '@testing-library/react'

// Opening the Evaluate tab must cost ONE rows request and ONE facets request.
//
// It used to cost five. `useSession()` starts out `{ data: undefined, status: 'loading' }`
// and resolves a moment later; the fetch callbacks read `role`/`userName` off it, so
// resolving changed their identity and re-ran both effects. Worse, the first rows
// response was then thrown away by the `fetchSeqRef` stale-guard, so the table did not
// paint until the SECOND rows request came back -- i.e. never before the session had
// resolved. On top of that, locking in the server-resolved month=auto re-ran the facets
// effect a third time, for a response identical to the first.
//
// The fix was to stop scoping requests by the session (the server does that from the
// session itself and ignores the client's `evaluator` param for evaluators) and to give
// the facets effect the same suppress-ref the rows effect already had. This test is
// what keeps both from creeping back.
//
// Note jsdom has no React StrictMode, so these counts are the real ones. A dev server
// DOES double-invoke every effect (Next enables StrictMode for the app router by
// default), which is why the dev log shows each request twice no matter what.

// jsdom has no IntersectionObserver; the table's infinite-scroll sentinel wants one.
class NoopObserver {
  observe() { /* the sentinel never intersects in jsdom */ }
  disconnect() { /* nothing to tear down */ }
  unobserve() { /* nothing to tear down */ }
}
global.IntersectionObserver = NoopObserver as unknown as typeof IntersectionObserver

let resolveSession: (() => void) | null = null

jest.mock('next-auth/react', () => {
  const React = jest.requireActual('react')
  return {
    useSession: () => {
      // Models next-auth: 'loading' on first render, authenticated once the
      // /api/auth/session round-trip lands.
      const [ready, setReady] = React.useState(false)
      resolveSession = () => setReady(true)
      return ready
        ? {
          data: { user: { id: 1, role: 'admin', name: 'HungDT', email: 'hungdt@athena.studio' } },
          status: 'authenticated',
        }
        : { data: undefined, status: 'loading' }
    },
  }
})

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
}))

jest.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ conclusion: [], final_conclusion: [] }),
}))

// Children that do their own fetching or need a DOM the table does not give them.
jest.mock('@/components/EvalDetailPanel', () => ({
  __esModule: true,
  default: () => <div data-testid="eval-panel" />,
  weekBatches: () => [],
}))
jest.mock('@/components/QuickStatsModal', () => ({ QuickStatsModal: () => null }))
jest.mock('@/components/weekly-feedback/WeeklyFeedbackTab', () => ({ WeeklyFeedbackTab: () => null }))
jest.mock('@/components/TaggingTab', () => ({ TaggingTab: () => null }))

import EvaluationsPage from '@/app/(manager)/evaluations/page'

const APPLIED_MONTH = { year: 2026, month: 9 }

function stubFetch() {
  const calls: string[] = []
  const fn = jest.fn((input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    const body = url.startsWith('/api/evaluations/facets')
      ? {
        available_months: [APPLIED_MONTH],
        available_conclusions: ['List_Idea'],
        available_evaluators: ['HungDT', 'KhangNA'],
      }
      : {
        data: [],
        total: 0,
        stats: { total: 0, evaluated: 0, pending: 0 },
        applied_month: APPLIED_MONTH,
      }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
  })
  global.fetch = fn as unknown as typeof fetch
  return calls
}

const rows = (calls: string[]) => calls.filter(u => u.startsWith('/api/evaluations?'))
const facets = (calls: string[]) => calls.filter(u => u.startsWith('/api/evaluations/facets'))

describe('opening the Evaluate tab', () => {
  it('fires one rows request and one facets request, and does not wait for the session', async () => {
    const calls = stubFetch()
    render(<EvaluationsPage />)

    // Both go out on mount, before the session has resolved. That is the point: the
    // server scopes an evaluator from the session, so there is nothing to wait for.
    await waitFor(() => expect(rows(calls).length).toBe(1))
    expect(facets(calls).length).toBe(1)

    // The session resolving must not re-issue anything...
    await act(async () => { resolveSession?.() })
    // ...and neither must locking in the month the server resolved for month=auto.
    await waitFor(() => expect(rows(calls).length).toBe(1))
    expect(facets(calls).length).toBe(1)
  })

  it('sends month=auto once and never pins the signed-in evaluator', async () => {
    const calls = stubFetch()
    render(<EvaluationsPage />)
    await waitFor(() => expect(rows(calls).length).toBe(1))
    await act(async () => { resolveSession?.() })

    expect(rows(calls)[0]).toContain('month=auto')
    // `evaluator=` is the server's business. A client that sends it re-couples this
    // request to the session and brings the duplicate back.
    for (const url of calls) expect(url).not.toContain('evaluator=')
  })
})
