import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

jest.mock('@/components/StyledSelect', () => ({
  StyledSelect: ({ value, onChange, options, placeholder }: {
    value: string; onChange: (v: string) => void
    options: { value: string; label: string }[]; placeholder?: string
  }) => (
    <select aria-label={placeholder ?? 'select'} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}))

import { BatchMoveBar } from '@/components/BatchMoveBar'
import { MAX_MOVE } from '@/lib/batch-move-client'

const OPTIONS = ['W3 Oct, 2026', 'W2 Oct, 2026']
const plain = { id: 1, final_conclusion: null, batch: 'W1 Oct, 2026', evaluate_date: null }
const locked = { id: 2, final_conclusion: 'Good', batch: 'W1 Oct, 2026', evaluate_date: null }

function mount(selected: React.ComponentProps<typeof BatchMoveBar>['selected'] = [plain, locked], over: Partial<React.ComponentProps<typeof BatchMoveBar>> = {}) {
  const onCancel = jest.fn()
  const onMoved = jest.fn()
  render(<BatchMoveBar selected={selected} batchOptions={OPTIONS} onCancel={onCancel} onMoved={onMoved} {...over} />)
  return { onCancel, onMoved }
}
const pick = (v: string) => fireEvent.change(screen.getByLabelText('Move to batch'), { target: { value: v } })

let moveBody: unknown
function stubFetch(result: { ok: boolean; json: unknown }) {
  moveBody = null
  global.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    moveBody = JSON.parse(String(init?.body))
    return { ok: result.ok, json: async () => result.json } as Response
  }) as unknown as typeof fetch
}

describe('BatchMoveBar', () => {
  it('shows the selected count and keeps Move disabled until a batch is chosen', () => {
    mount()
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled()
    pick('W2 Oct, 2026')
    expect(screen.getByRole('button', { name: 'Move' })).toBeEnabled()
  })

  it('asks for confirmation first, naming the count and the batch', () => {
    mount()
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Move 2 games to W2 Oct, 2026?')
  })

  it('lists every game that will move, with its title, where it is now and where it goes', () => {
    mount([
      { ...plain, title: 'Alpha Quest', icon_url: 'https://x/a.png' },
      { ...plain, id: 3, title: 'Beta Saga', batch: 'W4 Sep, 2026', final_conclusion: 'Priority IV' },
      { ...plain, id: 4, title: '  ', batch: null },
    ])
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    const rows = Array.from(screen.getByRole('dialog').querySelectorAll('[data-move-row]'))
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('Alpha Quest')
    expect(rows[0]).toHaveTextContent('W1 Oct, 2026 → W2 Oct, 2026')
    expect(rows[1]).toHaveTextContent('Beta Saga')
    expect(rows[1]).toHaveTextContent('W4 Sep, 2026 → W2 Oct, 2026')
    expect(rows[1]).toHaveTextContent('Priority IV')
    expect(rows[2]).toHaveTextContent('Untitled game')
    expect(rows[2]).toHaveTextContent('No batch → W2 Oct, 2026')
  })

  it('still lists games when the caller gives no title', () => {
    mount([plain])
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(screen.getByRole('dialog').querySelectorAll('[data-move-row]')).toHaveLength(1)
  })

  it('says how many selected games already have a final conclusion', () => {
    mount([plain, locked, { ...plain, id: 3, final_conclusion: 'Priority I' }])
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('2 of them already have a final conclusion and will move too')
  })

  it('uses the singular for exactly one locked game, and says nothing when none are locked', () => {
    mount([plain, locked])
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('1 of them already has a final conclusion and will move too')
  })

  it('has no final-conclusion line when nobody is locked', () => {
    mount([plain, { ...plain, id: 5 }])
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(screen.getByRole('dialog')).not.toHaveTextContent('final conclusion')
  })

  it('uses the singular title for one game', () => {
    mount([plain])
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Move 1 game to W2 Oct, 2026?')
  })

  it('does nothing when the dialog is cancelled', () => {
    stubFetch({ ok: true, json: { moved: 2 } })
    const { onMoved } = mount()
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(global.fetch).not.toHaveBeenCalled()
    expect(onMoved).not.toHaveBeenCalled()
  })

  it('POSTs the ids and batch on confirm, then reports how many moved', async () => {
    stubFetch({ ok: true, json: { moved: 2 } })
    const { onMoved } = mount()
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }))
    await waitFor(() => expect(onMoved).toHaveBeenCalledWith(2))
    expect(moveBody).toEqual({ ids: [1, 2], batch: 'W2 Oct, 2026' })
  })

  it('shows the server error and does not report a move when the request fails', async () => {
    stubFetch({ ok: false, json: { error: 'Forbidden' } })
    const { onMoved } = mount()
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }))
    await screen.findByText(/Couldn.t move: Forbidden/)
    expect(onMoved).not.toHaveBeenCalled()
  })

  it('Cancel on the bar leaves select mode', () => {
    const { onCancel } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })

  // --- fix wave ---------------------------------------------------------------------------

  it('calls the LATEST onMoved: the filter may have changed while the request was in flight', async () => {
    let finish!: () => void
    global.fetch = jest.fn(() => new Promise<Response>(res => {
      finish = () => res({ ok: true, json: async () => ({ moved: 2 }) } as Response)
    })) as unknown as typeof fetch
    const first = jest.fn()
    const second = jest.fn()
    const props = { selected: [plain, locked], batchOptions: OPTIONS, onCancel: jest.fn() }
    const { rerender } = render(<BatchMoveBar {...props} onMoved={first} />)
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }))
    rerender(<BatchMoveBar {...props} onMoved={second} />)
    await act(async () => { finish() })
    await waitFor(() => expect(second).toHaveBeenCalledWith(2))
    expect(first).not.toHaveBeenCalled()
  })

  it('keeps the dialog open and says so when no game was moved', async () => {
    stubFetch({ ok: true, json: { moved: 0 } })
    const { onMoved } = mount()
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }))
    await screen.findByText('No games were moved. Reload the list and try again.')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(onMoved).not.toHaveBeenCalled()
  })

  it('counts a partial move (0 < moved < selected) as success', async () => {
    stubFetch({ ok: true, json: { moved: 1 } })
    const { onMoved } = mount()
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }))
    await waitFor(() => expect(onMoved).toHaveBeenCalledWith(1))
  })

  it('treats a 2xx with an unreadable count as success: the UPDATE committed, so no "No games were moved"', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json') } }) as unknown as Response) as unknown as typeof fetch
    const { onMoved } = mount()
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }))
    await waitFor(() => expect(onMoved).toHaveBeenCalledWith(0))
    expect(screen.queryByText(/No games were moved/)).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a timeout tells the manager the move may have gone through and to reload', async () => {
    jest.useFakeTimers()
    try {
      global.fetch = jest.fn((_u: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')))
      })) as unknown as typeof fetch
      const { onMoved } = mount()
      pick('W2 Oct, 2026')
      fireEvent.click(screen.getByRole('button', { name: 'Move' }))
      fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }))
      await act(async () => { await jest.advanceTimersByTimeAsync(30_001) })
      expect(screen.getByRole('dialog')).toHaveTextContent(
        "Couldn't move: Timed out. The move may have gone through. Reload the list to check.")
      expect(onMoved).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  describe('guard rails', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...plain, id: i + 1 }))

    it('allows exactly MAX_MOVE games', () => {
      mount(many(MAX_MOVE))
      pick('W2 Oct, 2026')
      expect(screen.getByRole('button', { name: 'Move' })).toBeEnabled()
      expect(screen.queryByText(/at most 500/)).toBeNull()
    })

    it('disables Move above MAX_MOVE and says why', () => {
      expect(MAX_MOVE).toBe(500)
      mount(many(MAX_MOVE + 1))
      pick('W2 Oct, 2026')
      expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled()
      expect(screen.getByText('You can move at most 500 games at a time. Select fewer.')).toBeInTheDocument()
    })

    it('disables Confirm when the selection grows past MAX_MOVE while the dialog is open', () => {
      const props = { batchOptions: OPTIONS, onCancel: jest.fn(), onMoved: jest.fn() }
      const { rerender } = render(<BatchMoveBar {...props} selected={many(2)} />)
      pick('W2 Oct, 2026')
      fireEvent.click(screen.getByRole('button', { name: 'Move' }))
      rerender(<BatchMoveBar {...props} selected={many(MAX_MOVE + 1)} />)
      expect(screen.getByRole('button', { name: 'Confirm move' })).toBeDisabled()
      expect(screen.getByText('You can move at most 500 games at a time. Select fewer.')).toBeInTheDocument()
    })

    it('disables Confirm and never POSTs when the rows reload to nothing under an open dialog', () => {
      stubFetch({ ok: true, json: { moved: 0 } })
      const props = { batchOptions: OPTIONS, onCancel: jest.fn(), onMoved: jest.fn() }
      const { rerender } = render(<BatchMoveBar {...props} selected={[plain]} />)
      pick('W2 Oct, 2026')
      fireEvent.click(screen.getByRole('button', { name: 'Move' }))
      rerender(<BatchMoveBar {...props} selected={[]} />)
      const confirm = screen.getByRole('button', { name: 'Confirm move' })
      expect(confirm).toBeDisabled()
      fireEvent.click(confirm)
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('disables Move when every selected game is already in the chosen batch', () => {
      mount([{ ...plain, batch: 'W2 Oct, 2026' }, { ...locked, batch: 'W2 Oct, 2026' }])
      pick('W2 Oct, 2026')
      expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled()
      expect(screen.getByText('They are already in this batch.')).toBeInTheDocument()
      pick('W3 Oct, 2026')
      expect(screen.getByRole('button', { name: 'Move' })).toBeEnabled()
      expect(screen.queryByText('They are already in this batch.')).toBeNull()
    })

    it('still allows Move when only some of the selected games are already there', () => {
      mount([{ ...plain, batch: 'W2 Oct, 2026' }, { ...locked, batch: 'W3 Oct, 2026' }])
      pick('W2 Oct, 2026')
      expect(screen.getByRole('button', { name: 'Move' })).toBeEnabled()
      expect(screen.queryByText('They are already in this batch.')).toBeNull()
    })
  })

  describe('Report window note', () => {
    const NOW = Date.parse('2026-10-10T00:00:00Z')
    const day = 86400000
    const at = (daysAgo: number) => new Date(NOW - daysAgo * day).toISOString()
    let nowSpy: jest.SpyInstance
    beforeEach(() => { nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW) })
    afterEach(() => nowSpy.mockRestore())

    const open = (selected: React.ComponentProps<typeof BatchMoveBar>['selected'], target = 'W2 Oct, 2026') => {
      mount(selected)
      pick(target)
      fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    }
    const NOTE = /evaluated more than 8 days ago\. Moving them to a newer batch can change the date range the Report uses for that batch\./

    it('names how many games were evaluated more than 8 days ago and move forward (plural)', () => {
      open([
        { ...plain, id: 1, batch: 'W4 Sep, 2026', evaluate_date: at(20) },
        { ...plain, id: 2, batch: 'W4 Sep, 2026', evaluate_date: at(9) },
        { ...plain, id: 3, batch: 'W4 Sep, 2026', evaluate_date: at(2) },
      ])
      expect(screen.getByRole('dialog')).toHaveTextContent(/2 of them were evaluated more than 8 days ago\./)
      expect(screen.getByRole('dialog')).toHaveTextContent(NOTE)
    })

    it('uses the singular for one game', () => {
      open([{ ...plain, batch: 'W4 Sep, 2026', evaluate_date: at(20) }, { ...plain, id: 2, batch: 'W4 Sep, 2026', evaluate_date: at(1) }])
      expect(screen.getByRole('dialog')).toHaveTextContent(/1 of them was evaluated more than 8 days ago\./)
    })

    it('says nothing when the games were evaluated within 8 days', () => {
      open([{ ...plain, batch: 'W4 Sep, 2026', evaluate_date: at(8) }, { ...plain, id: 2, batch: 'W4 Sep, 2026', evaluate_date: at(3) }])
      expect(screen.getByRole('dialog')).not.toHaveTextContent(/8 days/)
    })

    it('says nothing when an old game moves to an OLDER batch', () => {
      open([{ ...plain, batch: 'W3 Oct, 2026', evaluate_date: at(30) }], 'W2 Oct, 2026')
      expect(screen.getByRole('dialog')).not.toHaveTextContent(/8 days/)
    })

    it('says nothing for a game with no evaluate_date, or an unreadable one', () => {
      open([{ ...plain, batch: 'W4 Sep, 2026', evaluate_date: null }, { ...plain, id: 2, batch: null, evaluate_date: null },
        { ...plain, id: 3, batch: 'W4 Sep, 2026', evaluate_date: 'not a date' }])
      expect(screen.getByRole('dialog')).not.toHaveTextContent(/8 days/)
    })

    // A game with no batch also stretches the target batch's start date once it joins it.
    it('counts an old game that has no batch yet', () => {
      open([{ ...plain, batch: null, evaluate_date: at(30) }, { ...plain, id: 2, batch: null, evaluate_date: at(1) }])
      expect(screen.getByRole('dialog')).toHaveTextContent(/1 of them was evaluated more than 8 days ago\./)
    })

    it('counts old games with no batch together with old games from an earlier batch', () => {
      open([
        { ...plain, id: 1, batch: null, evaluate_date: at(30) },
        { ...plain, id: 2, batch: 'W4 Sep, 2026', evaluate_date: at(20) },
        { ...plain, id: 3, batch: 'W3 Oct, 2026', evaluate_date: at(20) },
      ])
      expect(screen.getByRole('dialog')).toHaveTextContent(/2 of them were evaluated more than 8 days ago\./)
    })
  })
})
