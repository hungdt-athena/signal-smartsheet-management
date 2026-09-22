import { fireEvent, render, screen, waitFor } from '@testing-library/react'

// Team Ops is the receiving end of the Report's action lines ("Move N stale games
// from X, Y and Z" / "Reassign X's backlog"). This covers the contract those links
// rely on:
//
//   1. ?from=<name> preselects Reassign's source evaluator.
//   2. ?flash=<comma,separated,names> rings the matching rows on Rescue, same idiom
//      as the Config page's ?highlight=.
//   3. Nothing else in the URL is allowed near Rescue's saved thresholds.
//      POST /api/operations/rescue with action:'scan' PERSISTS whatever config it is
//      handed into app_config, so a link carrying ?staleDays= must never reach it —
//      that would let a Report link silently rewrite the admin's saved settings.

// jsdom has no scrollIntoView; RescuePanel calls it once a ringed row is found.
Element.prototype.scrollIntoView = jest.fn()

let params = new URLSearchParams('')

jest.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { id: 1, role: 'admin', name: 'HungDT', email: 'hungdt@athena.studio' } },
    status: 'authenticated',
  }),
}))

jest.mock('next/navigation', () => ({
  useSearchParams: () => params,
}))

import TeamOpsPage from '@/app/(manager)/team-ops/page'

const RESCUE_CONFIG = { staleDays: 30, sourceMinBacklog: 20, receiverMaxStale: 0, activeDays: 7, cooldownDays: 7 }

const RESCUE_ROWS = [
  { name: 'PhuongNT1', platform: null, weight: null, available: true, pending: 40, stale: 12, movable: 12, evaluatedRecent: 3, role: 'source', pull: 12, reason: 'over backlog threshold' },
  { name: 'ThuDT', platform: null, weight: null, available: true, pending: 30, stale: 8, movable: 8, evaluatedRecent: 2, role: 'source', pull: 8, reason: 'over backlog threshold' },
  { name: 'KietCD', platform: null, weight: null, available: true, pending: 5, stale: 0, movable: 0, evaluatedRecent: 5, role: 'receiver', pull: 0, reason: 'clear own shelf' },
]

const ROSTER = [
  { id: 1, name: 'PhuongNT1', today_available: true, game_platform: 'all', weight: 100 },
  { id: 2, name: 'ThuDT', today_available: true, game_platform: 'all', weight: 100 },
  { id: 3, name: 'KietCD', today_available: true, game_platform: 'all', weight: 100 },
]

function scanBody() {
  const calls = (global.fetch as jest.Mock).mock.calls
  const call = calls.find(([input, init]) =>
    String(input).startsWith('/api/operations/rescue') && (init as RequestInit | undefined)?.method === 'POST',
  )
  if (!call) return null
  return JSON.parse((call[1] as RequestInit).body as string)
}

beforeEach(() => {
  params = new URLSearchParams('')
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/operations/rescue')) {
      return Promise.resolve({ ok: true, json: async () => ({ rows: RESCUE_ROWS, config: RESCUE_CONFIG }) } as Response)
    }
    if (url.startsWith('/api/assign-setup')) {
      return Promise.resolve({ ok: true, json: async () => ({ initial: ROSTER }) } as Response)
    }
    if (url.startsWith('/api/operations/runs')) {
      return Promise.resolve({ ok: true, json: async () => ({ rows: [], viewer: null }) } as Response)
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  }) as unknown as typeof fetch
})

afterEach(() => { jest.clearAllMocks() })

describe('team-ops deep links', () => {
  it('preselects the evaluator named in the URL on Reassign', async () => {
    params = new URLSearchParams('tab=reassign&from=PhuongNT1')
    render(<TeamOpsPage />)
    // ReassignPanel's source picker is a StyledSelect (a button showing the chosen
    // name, not a native <select>) — its accessible name IS the selected label.
    await waitFor(() => expect(screen.getByRole('button', { name: 'PhuongNT1' })).toBeInTheDocument())
  })

  it('resolves a casing-drifted ?from= to the roster’s own spelling', async () => {
    // The Report builds this link from game_evaluations.initial_evaluator; the roster
    // it has to match against is evaluator_roster.name — a table with a known history
    // of casing drift against that one. A case-sensitive match would land on an empty
    // select and say nothing about why.
    params = new URLSearchParams('tab=reassign&from=phuongnt1')
    render(<TeamOpsPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'PhuongNT1' })).toBeInTheDocument())
  })

  it('drops the preselection when the named evaluator is not on this roster', async () => {
    params = new URLSearchParams('tab=reassign&from=NobodyHere')
    render(<TeamOpsPage />)
    await waitFor(() => expect(screen.getByText(/select evaluator/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'NobodyHere' })).not.toBeInTheDocument()
  })

  it('rings the rows named in the URL on Rescue', async () => {
    params = new URLSearchParams('tab=rescue&flash=PhuongNT1,ThuDT')
    render(<TeamOpsPage />)
    await waitFor(() => {
      expect(screen.getByText('PhuongNT1').closest('tr')!.className).toContain('cfg-highlight')
      expect(screen.getByText('ThuDT').closest('tr')!.className).toContain('cfg-highlight')
      expect(screen.getByText('KietCD').closest('tr')!.className).not.toContain('cfg-highlight')
    })
  })

  it('never lets a URL change the saved rescue threshold', async () => {
    params = new URLSearchParams('tab=rescue&staleDays=3')
    render(<TeamOpsPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: /^Scan$/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /^Scan$/i }))
    await waitFor(() => expect(scanBody()).toBeTruthy())
    // The config posted is whatever the panel loaded (30), never the URL's 3 — the
    // page never even reads ?staleDays=.
    expect(scanBody()).not.toHaveProperty('config.staleDays', 3)
    expect(scanBody()).toHaveProperty('config.staleDays', 30)
  })
})
