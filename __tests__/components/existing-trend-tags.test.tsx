import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ExistingTrendTags, applyExistingChange } from '@/components/ExistingTrendTags'
import { TrendTagsField } from '@/components/TrendTagsField'

const SUB_VALUES = [{ id: 1, name: 'Theme' }, { id: 2, name: 'Gameplay' }]

// Two tags on one game: one this app synced, one a Signal Sense user made.
const TAGS = [
  { field_value: 'Merge', sub_value_id: 1, sub_value_name: 'Theme', created_by: 'playtest_sync', created_by_name: 'Signal Playtest Sync' },
  { field_value: 'Backpack', sub_value_id: null, sub_value_name: null, created_by: 'LCU6y3G', created_by_name: 'Tran Vinh' },
]

function setup(canEdit: boolean, onChanged = jest.fn()) {
  render(
    <ExistingTrendTags gameId="g1" tags={TAGS} subValues={SUB_VALUES}
      canEdit={canEdit} onChanged={onChanged} />,
  )
  return onChanged
}

const fetchMock = () => global.fetch as unknown as jest.Mock

beforeEach(() => {
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, outcome: 'deleted' }) })) as never
})

describe('ExistingTrendTags — read-only', () => {
  it('shows the tags with no way to change them', () => {
    setup(false)
    expect(screen.getByText('Merge')).toBeInTheDocument()
    expect(screen.getByText('Backpack')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('ExistingTrendTags — a manager editing Signal Sense', () => {
  it('names who tagged it over there, so it is clear whose tag is being changed', () => {
    setup(true)
    expect(screen.getByText(/Tran Vinh/)).toBeInTheDocument()
    // Its own sync account is not a person and says nothing worth the space.
    expect(screen.queryByText(/Signal Playtest Sync/)).not.toBeInTheDocument()
  })

  it('asks before removing a tag, and sends nothing until then', () => {
    setup(true)
    fireEvent.click(screen.getByRole('button', { name: /Remove Backpack/i }))
    expect(fetchMock()).not.toHaveBeenCalled()
    // The question is split across a <strong> holding the trend name.
    expect(screen.getByText(
      (_, el) => el?.tagName === 'SPAN' && /Remove\s*Backpack\s*from Signal Sense\?/.test(el.textContent || ''),
    )).toBeInTheDocument()
  })

  it('removes the tag once confirmed and reports it to the caller', async () => {
    const onChanged = setup(true)
    fireEvent.click(screen.getByRole('button', { name: /Remove Backpack/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Remove$/ }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ kind: 'removed', field_value: 'Backpack' }))
    const [url, init] = fetchMock().mock.calls[0]
    expect(url).toBe('/api/playtest-tags/existing')
    expect(init.method).toBe('DELETE')
    expect(JSON.parse(init.body)).toEqual({ gameId: 'g1', fieldValue: 'Backpack' })
  })

  it('changes a sub-value on pick and reports the new one by name', async () => {
    const onChanged = setup(true)
    fireEvent.click(screen.getByRole('button', { name: /Change the sub-value of Merge/i }))
    fireEvent.change(screen.getByLabelText(/Sub-value for Merge/i), { target: { value: '2' } })
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(
      { kind: 'sub_value', field_value: 'Merge', sub_value_id: 2, sub_value_name: 'Gameplay' }))
    const [url, init] = fetchMock().mock.calls[0]
    expect(url).toBe('/api/playtest-tags/existing')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ gameId: 'g1', fieldValue: 'Merge', subValueId: 2 })
  })

  it('clears a sub-value when None is picked', async () => {
    const onChanged = setup(true)
    fireEvent.click(screen.getByRole('button', { name: /Change the sub-value of Merge/i }))
    fireEvent.change(screen.getByLabelText(/Sub-value for Merge/i), { target: { value: '' } })
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(
      { kind: 'sub_value', field_value: 'Merge', sub_value_id: null, sub_value_name: null }))
    expect(JSON.parse(fetchMock().mock.calls[0][1].body).subValueId).toBeNull()
  })

  it('shows what the server refused and reports no change', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: false, json: () => Promise.resolve({ error: 'Merge is no longer in Signal Sense' }),
    })) as never
    const onChanged = setup(true)
    fireEvent.click(screen.getByRole('button', { name: /Remove Backpack/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Remove$/ }))
    await waitFor(() => expect(screen.getByText(/no longer in Signal Sense/)).toBeInTheDocument())
    expect(onChanged).not.toHaveBeenCalled()
  })
})

// The same section appears in the field and in the Manage Trends Tags dialog it
// opens. Both must reach the one component, or a manager gets a live control in
// one place and a dead chip in the other.
describe('TrendTagsField — passing the section through', () => {
  const base = {
    value: [], existing: TAGS, options: ['Merge', 'Backpack'], subValues: SUB_VALUES,
    onChange: jest.fn(), gameId: 'g1',
  }

  it('leaves the tags read-only for an evaluator', () => {
    render(<TrendTagsField {...base} />)
    expect(screen.getByText('Backpack')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Remove Backpack/i })).not.toBeInTheDocument()
  })

  it('gives a manager the controls, in the field and inside the dialog', () => {
    render(<TrendTagsField {...base} canReview onExistingChanged={jest.fn()} />)
    expect(screen.getByRole('button', { name: /Remove Backpack/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Manage Trends Tags/i }))
    expect(screen.getAllByRole('button', { name: /Remove Backpack/i })).toHaveLength(2)
  })
})

describe('applyExistingChange — folding an edit back into the list', () => {
  it('drops a removed tag', () => {
    expect(applyExistingChange(TAGS, { kind: 'removed', field_value: 'Merge' }))
      .toEqual([TAGS[1]])
  })

  it('moves a sub-value without disturbing the rest of the tag', () => {
    const next = applyExistingChange(TAGS, {
      kind: 'sub_value', field_value: 'Merge', sub_value_id: 2, sub_value_name: 'Gameplay',
    })
    expect(next[0]).toEqual({ ...TAGS[0], sub_value_id: 2, sub_value_name: 'Gameplay' })
    expect(next[1]).toBe(TAGS[1])
  })

  it('leaves the list alone when the tag is not in it', () => {
    expect(applyExistingChange(TAGS, { kind: 'removed', field_value: 'Idle' })).toEqual(TAGS)
  })
})
