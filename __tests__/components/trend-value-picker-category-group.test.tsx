import { fireEvent, render, screen } from '@testing-library/react'
import { TrendValuePicker } from '@/components/TrendValuePicker'

const OPTIONS = ['Block Puzzle', 'Farm Life', 'Food Hunt', 'Merge']
// Food Hunt is defined for both category groups; Block Puzzle and Merge only for puzzle.
const CATEGORY_GROUPS: Record<string, string[]> = {
  'Block Puzzle': ['puzzle'],
  'Farm Life': ['arcade'],
  'Food Hunt': ['arcade', 'puzzle'],
  Merge: ['puzzle'],
}

function open(props: Partial<React.ComponentProps<typeof TrendValuePicker>> = {}) {
  const onPick = jest.fn()
  render(
    <TrendValuePicker
      options={OPTIONS}
      categoryGroups={CATEGORY_GROUPS}
      categoryGroup="arcade"
      onPick={onPick}
      label="Pick a trend"
      placeholder
      {...props}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: /pick a trend/i }))
  return onPick
}

const listed = () =>
  Array.from(document.querySelectorAll('ul li button')).map(b => b.firstChild?.textContent)

// Evaluators tag fast: the list opens on the game's own category group, and the rest of
// the catalog is one click away rather than in the way.
describe('TrendValuePicker category-group filter', () => {
  it('opens on the game\'s category group only', () => {
    open()
    expect(listed()).toEqual(['Farm Life', 'Food Hunt'])
  })

  it('says which category group it is showing and offers the whole catalog', () => {
    open()
    expect(screen.getByText(/2 arcade trends/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /show all category groups/i })).toBeTruthy()
  })

  it('Show all category groups lists everything and tags the ones from another category group', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: /show all category groups/i }))
    expect(listed()).toEqual(['Block Puzzle', 'Farm Life', 'Food Hunt', 'Merge'])
    // Badge only where the trend is NOT defined for the game's category group.
    expect(screen.getAllByText('puzzle')).toHaveLength(2)
    expect(screen.getByRole('button', { name: /show arcade only/i })).toBeTruthy()
  })

  it('still lets a trend from another category group be picked once shown', () => {
    const onPick = open()
    fireEvent.click(screen.getByRole('button', { name: /show all category groups/i }))
    fireEvent.click(screen.getByText('Merge'))
    expect(onPick).toHaveBeenCalledWith('Merge')
  })

  it('searches within the category group in view', () => {
    open()
    fireEvent.change(screen.getByPlaceholderText(/search trends/i), { target: { value: 'food' } })
    expect(listed()).toEqual(['Food Hunt'])
    fireEvent.change(screen.getByPlaceholderText(/search trends/i), { target: { value: 'merge' } })
    expect(listed()).toEqual([])
    expect(screen.getByText(/no arcade trend matches that/i)).toBeTruthy()
  })

  // Simulation has no definitions yet: an empty combobox with no way out would
  // read as "nothing can be tagged".
  it('explains an empty category group and keeps the way out', () => {
    open({ categoryGroup: 'simulation' })
    expect(listed()).toEqual([])
    expect(screen.getByText(/no simulation trends yet/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /show all category groups/i }))
    expect(listed()).toHaveLength(4)
  })

  it('does not filter when the game\'s category group is unknown', () => {
    open({ categoryGroup: null })
    expect(listed()).toHaveLength(4)
    expect(screen.queryByRole('button', { name: /show all category groups/i })).toBeNull()
  })

  it('does not filter when no category-group map was given (admin tools that never asked for one)', () => {
    open({ categoryGroups: undefined })
    expect(listed()).toHaveLength(4)
    expect(screen.queryByRole('button', { name: /show all category groups/i })).toBeNull()
  })

  it('keeps values already used elsewhere out of the list, category group or not', () => {
    open({ exclude: new Set(['Food Hunt']) })
    expect(listed()).toEqual(['Farm Life'])
  })
})
