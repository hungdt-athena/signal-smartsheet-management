import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DailyBlock } from '@/components/report/DailyBlock'

// The Leaderboard's daily block: one day at a time, with a strip of the days in the
// period. It is not the Leaderboard at a shorter window -- that tab asks where people
// differ and answers in rates and ranks, which one day is far too noisy to support.
// This asks whether the day's work happened and answers in counts.

function bucket(over: Record<string, unknown> = {}) {
  return {
    bucket: 'puzzle', evaluators: 2, total: 140, linkDead: 6, staleRelease: 0,
    rows: [
      { name: 'ThuDT', total: 100, idea: 1, pbp: 0, bypass: 99, other: 0, tagRows: 0, tagged: 0 },
      { name: 'NhiLV', total: 40, idea: 0, pbp: 0, bypass: 40, other: 0, tagRows: 0, tagged: 0 },
    ],
    ...over,
  }
}
const day = (over: Record<string, unknown> = {}) =>
  ({ date: '2026-09-22', total: 140, buckets: [bucket()], ...over })

const INDEX = [{ date: '2026-09-22', total: 140 }, { date: '2026-09-21', total: 9 }]

// One dispatcher: the first request (no `day`) answers with the index and the newest
// day; a request carrying `day` answers with that day only, as the route does.
function mockApi(opts: {
  index?: unknown[]
  first?: unknown
  byDay?: Record<string, unknown>
  from?: string
  to?: string
} = {}) {
  return jest.fn(async (url: string) => {
    const p = new URL(String(url), 'http://x').searchParams
    const d = p.get('day')
    const body = d
      ? { day: opts.byDay?.[d] ?? null, index: [] }
      : {
        day: opts.first === undefined ? day() : opts.first,
        index: opts.index ?? INDEX,
        from: opts.from ?? '2026-09-20', to: opts.to ?? '2026-09-22',
      }
    return { ok: true, json: async () => body } as Response
  })
}

function props(over: Record<string, unknown> = {}) {
  return { windowFrom: '2026-09-20', windowTo: '2026-09-22', category: 'all', ...over }
}

describe('DailyBlock', () => {
  it('opens on the newest day with work and names it in full', async () => {
    const fetchMock = mockApi()
    global.fetch = fetchMock as unknown as typeof fetch

    render(<DailyBlock {...props()} />)
    await waitFor(() => expect(screen.getByText('Tue 22 Sep 2026')).toBeInTheDocument())

    const p = new URL(String(fetchMock.mock.calls[0][0]), 'http://x').searchParams
    expect(p.get('from')).toBe('2026-09-20')
    expect(p.get('to')).toBe('2026-09-22')
    expect(p.get('day')).toBeNull() // the server picks it, in the same round trip
    expect(screen.getByText('140 judged')).toBeInTheDocument()
  })

  it('passes the page Category through, so the block cannot contradict the bar above it', async () => {
    const fetchMock = mockApi()
    global.fetch = fetchMock as unknown as typeof fetch
    render(<DailyBlock {...props({ category: 'arcade' })} />)
    await waitFor(() => expect(screen.getByText('Tue 22 Sep 2026')).toBeInTheDocument())
    expect(new URL(String(fetchMock.mock.calls[0][0]), 'http://x').searchParams.get('category')).toBe('arcade')
  })

  it('shows every day of a short period, marking the quiet ones instead of hiding them', async () => {
    // 20-22 Sep with work on the 21st and 22nd: the 20th is still on the strip,
    // because "nobody worked that day" is what a daily check is for.
    global.fetch = mockApi() as unknown as typeof fetch
    render(<DailyBlock {...props()} />)
    await waitFor(() => expect(screen.getByText('Tue 22 Sep 2026')).toBeInTheDocument())

    const chips = Array.from(document.querySelectorAll('.rp-daily-chip')) as HTMLButtonElement[]
    expect(chips.map(c => c.textContent)).toEqual(['20/9', '21/9', '22/9'])
    expect(chips[0].disabled).toBe(true)
    expect(chips[0].className).toContain('quiet')
    expect(chips[2].className).toContain('on')
    expect(chips[1].disabled).toBe(false)
  })

  it('drops the quiet days from the strip once the period is too long to list', async () => {
    // A quarter: one button per calendar day would be hundreds of them to say it.
    global.fetch = mockApi({ from: '2026-07-01', to: '2026-09-30' }) as unknown as typeof fetch
    render(<DailyBlock {...props({ windowFrom: '2026-07-01', windowTo: '2026-09-30' })} />)
    await waitFor(() => expect(screen.getByText('Tue 22 Sep 2026')).toBeInTheDocument())

    const chips = Array.from(document.querySelectorAll('.rp-daily-chip'))
    expect(chips.map(c => c.textContent)).toEqual(['21/9', '22/9'])
  })

  it('switches day from the strip without re-reading the strip', async () => {
    const fetchMock = mockApi({ byDay: { '2026-09-21': day({ date: '2026-09-21', total: 9 }) } })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<DailyBlock {...props()} />)
    await waitFor(() => expect(screen.getByText('Tue 22 Sep 2026')).toBeInTheDocument())

    fireEvent.click(screen.getByText('21/9'))
    await waitFor(() => expect(screen.getByText('Mon 21 Sep 2026')).toBeInTheDocument())

    const p = new URL(String(fetchMock.mock.calls[1][0]), 'http://x').searchParams
    expect(p.get('day')).toBe('2026-09-21')
    expect(p.get('index')).toBe('0')
    // and the strip is still there, still showing the same days
    expect(document.querySelectorAll('.rp-daily-chip')).toHaveLength(3)
    expect(screen.getByText('21/9').className).toContain('on')
  })

  it('steps between days that HAVE work, never onto an empty one', async () => {
    const fetchMock = mockApi({
      index: [{ date: '2026-09-22', total: 140 }, { date: '2026-09-18', total: 9 }],
      byDay: { '2026-09-18': day({ date: '2026-09-18', total: 9 }) },
      from: '2026-09-16', to: '2026-09-22',
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<DailyBlock {...props({ windowFrom: '2026-09-16', windowTo: '2026-09-22' })} />)
    await waitFor(() => expect(screen.getByText('Tue 22 Sep 2026')).toBeInTheDocument())

    // 19, 20 and 21 are on the strip and quiet; Previous skips straight over them.
    fireEvent.click(screen.getByRole('button', { name: /previous day/i }))
    await waitFor(() => expect(screen.getByText('Fri 18 Sep 2026')).toBeInTheDocument())
    expect(new URL(String(fetchMock.mock.calls[1][0]), 'http://x').searchParams.get('day')).toBe('2026-09-18')
  })

  it('disables the step buttons at each end of the worked days', async () => {
    global.fetch = mockApi() as unknown as typeof fetch
    render(<DailyBlock {...props()} />)
    await waitFor(() => expect(screen.getByText('Tue 22 Sep 2026')).toBeInTheDocument())
    // newest day selected: nothing newer to step to
    expect((screen.getByRole('button', { name: /next day/i }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /previous day/i }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('prints the per-person counts and a Total row that agrees with them', async () => {
    global.fetch = mockApi() as unknown as typeof fetch
    render(<DailyBlock {...props()} />)
    await waitFor(() => expect(screen.getByText('ThuDT')).toBeInTheDocument())

    const total = document.querySelector('.rp-daily-total') as HTMLElement
    const cells = Array.from(total.querySelectorAll('td')).map(c => c.textContent)
    expect(cells[0]).toBe('140')  // 100 + 40
    expect(cells[3]).toBe('139')  // bypass 99 + 40
  })

  it('says the housekeeping counts are OUTSIDE the total, the opposite of the chat card', async () => {
    global.fetch = mockApi() as unknown as typeof fetch
    render(<DailyBlock {...props()} />)
    await waitFor(() => expect(screen.getByText('ThuDT')).toBeInTheDocument())

    const foot = document.querySelector('.rp-daily-foot')!
    expect(foot.textContent).toContain('6 link dead')
    expect(foot.textContent).toContain('not counted in Total')
  })

  it('leaves the housekeeping line out when there is none to report', async () => {
    global.fetch = mockApi({
      first: day({ buckets: [bucket({ linkDead: 0, staleRelease: 0 })] }),
    }) as unknown as typeof fetch
    render(<DailyBlock {...props()} />)
    await waitFor(() => expect(screen.getByText('ThuDT')).toBeInTheDocument())
    expect(document.querySelector('.rp-daily-foot')).toBeNull()
  })

  it('shows the Other column only when something landed outside the three named ones', async () => {
    global.fetch = mockApi() as unknown as typeof fetch
    const { unmount } = render(<DailyBlock {...props()} />)
    await waitFor(() => expect(screen.getByText('ThuDT')).toBeInTheDocument())
    expect(screen.queryByText('Other')).toBeNull()
    unmount()

    global.fetch = mockApi({
      first: day({
        buckets: [bucket({
          rows: [{ name: 'ThuDT', total: 10, idea: 2, pbp: 3, bypass: 1, other: 4, tagRows: 0, tagged: 0 }],
        })],
      }),
    }) as unknown as typeof fetch
    render(<DailyBlock {...props()} />)
    await waitFor(() => expect(screen.getByText('Other')).toBeInTheDocument())
  })

  it('reads tagging as tags over games, because one game can carry several', async () => {
    global.fetch = mockApi({
      first: day({
        buckets: [bucket({
          rows: [{ name: 'KietCD', total: 0, idea: 0, pbp: 0, bypass: 0, other: 0, tagRows: 11, tagged: 6 }],
        })],
      }),
    }) as unknown as typeof fetch
    render(<DailyBlock {...props()} />)
    await waitFor(() => expect(screen.getByText('KietCD')).toBeInTheDocument())

    const row = screen.getByText('KietCD').closest('tr') as HTMLElement
    expect(within(row).getByText('11/6')).toBeInTheDocument()
  })

  it('says the period is empty in words, rather than rendering a blank card', async () => {
    global.fetch = mockApi({ first: null, index: [] }) as unknown as typeof fetch
    render(<DailyBlock {...props()} />)
    await waitFor(() => expect(screen.getByText(/No evaluation work landed/)).toBeInTheDocument())
  })

  it('re-reads when the page period changes, so it never describes a stretch nobody selected', async () => {
    const fetchMock = mockApi()
    global.fetch = fetchMock as unknown as typeof fetch

    const { rerender } = render(<DailyBlock {...props()} />)
    await waitFor(() => expect(screen.getByText('ThuDT')).toBeInTheDocument())

    rerender(<DailyBlock {...props({ windowFrom: '2026-08-01', windowTo: '2026-08-31' })} />)
    await waitFor(() => {
      const last = new URL(String(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0]), 'http://x')
      expect(last.searchParams.get('from')).toBe('2026-08-01')
      expect(last.searchParams.get('day')).toBeNull() // and picks that period's newest day
    })
  })

  it('prints no rate, rank or score: that is the rest of the tab s job, not this block s', async () => {
    global.fetch = mockApi() as unknown as typeof fetch
    const { container } = render(<DailyBlock {...props()} />)
    await waitFor(() => expect(screen.getByText('ThuDT')).toBeInTheDocument())

    // One day is far too noisy to judge calibration on, which is the whole reason
    // this block counts instead of rating. A percentage here is the first step back.
    expect(container.textContent).not.toMatch(/%/)
    expect(container.textContent).not.toMatch(/rate|rank|score/i)
  })
})
