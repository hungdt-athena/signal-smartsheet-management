import { fireEvent, render, screen, waitFor } from '@testing-library/react'

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

const OPTIONS = ['W3 Oct, 2026', 'W2 Oct, 2026']
const plain = { id: 1, final_conclusion: null }
const locked = { id: 2, final_conclusion: 'Good' }

function mount(selected = [plain, locked], over: Partial<React.ComponentProps<typeof BatchMoveBar>> = {}) {
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

  it('says how many selected games already have a final conclusion', () => {
    mount([plain, locked, { id: 3, final_conclusion: 'Priority I' }])
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
    mount([plain, { id: 5, final_conclusion: null }])
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
})
