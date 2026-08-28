import { fireEvent, render, screen, within } from '@testing-library/react'
import { RosterTable } from '@/components/RosterTable'
import type { PersonGroup } from '@/lib/assign-roster'

const SUB_GENRES = {
  puzzle: ['puzzle', 'word', 'trivia'],
  arcade: ['arcade', 'action'],
  simulation: ['simulation', 'strategy'],
}

const groups: PersonGroup[] = [
  {
    name: 'NhiLV',
    today_available: true,
    game_platform: 'all',
    weight: 100,
    missingGenres: ['simulation'],
    rows: [
      { id: 1, name: 'NhiLV', category_group: 'puzzle', today_available: true, game_platform: 'all', game_category: 'All', weight: 100 },
      { id: 2, name: 'NhiLV', category_group: 'arcade', today_available: true, game_platform: 'ios', game_category: 'action', weight: 50 },
    ],
  },
  {
    name: 'MyTL',
    today_available: false,
    game_platform: 'ios',
    weight: 50,
    missingGenres: ['arcade', 'simulation'],
    rows: [
      { id: 3, name: 'MyTL', category_group: 'puzzle', today_available: false, game_platform: 'all', game_category: 'All', weight: 100 },
    ],
  },
]

function setup(over: Partial<React.ComponentProps<typeof RosterTable>> = {}) {
  const props = {
    title: 'Initial Evaluator',
    groups,
    subGenres: SUB_GENRES,
    onPatchRow: jest.fn(),
    onPatchAvailable: jest.fn(),
    onPatchPerson: jest.fn(),
    onRemoveRow: jest.fn(),
    onAddGenre: jest.fn(),
    onAddEvaluator: jest.fn(),
    ...over,
  }
  render(<RosterTable {...props} />)
  return props
}

// StyledSelect portals its menu into document.body and renders options as
// div.ssel-opt rather than role="option", so query the real class.
function openMenu(trigger: HTMLElement): HTMLElement {
  fireEvent.click(within(trigger).getByRole('button'))
  const menu = document.querySelector('.ssel-menu')
  if (!menu) throw new Error('menu did not open')
  return menu as HTMLElement
}

describe('RosterTable', () => {
  it('the Genre column names each row\'s genre, and the header reads Sub-genre', () => {
    setup()
    expect(screen.getAllByText('Puzzle')).toHaveLength(2)
    expect(screen.getAllByText('Arcade')).toHaveLength(1)
    expect(screen.getByRole('columnheader', { name: /sub-genre/i })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: /^category$/i })).not.toBeInTheDocument()
  })

  it('a name appears once across two genre rows', () => {
    setup()
    expect(screen.getAllByText('NhiLV')).toHaveLength(1)
  })

  it('there is one Available control per person, and it writes by name', () => {
    const { onPatchAvailable } = setup()
    const avail = screen.getAllByTestId('avail-cell')
    expect(avail).toHaveLength(2) // two people, not three rows

    const menu = openMenu(avail[0])
    fireEvent.click(within(menu).getByText('No'))
    expect(onPatchAvailable).toHaveBeenCalledWith('NhiLV', false)
  })

  it('there is one Platform and one Weight control per person, written by name', () => {
    const { onPatchPerson } = setup()
    // Two people, three rows: the controls span a person's genres.
    expect(screen.getAllByTestId('platform-cell')).toHaveLength(2)
    expect(screen.getAllByTestId('weight-cell')).toHaveLength(2)

    const pMenu = openMenu(screen.getAllByTestId('platform-cell')[0])
    fireEvent.click(within(pMenu).getByText('ios'))
    expect(onPatchPerson).toHaveBeenCalledWith('NhiLV', 'game_platform', 'ios')

    const wMenu = openMenu(screen.getAllByTestId('weight-cell')[0])
    fireEvent.click(within(wMenu).getByText('70'))
    expect(onPatchPerson).toHaveBeenCalledWith('NhiLV', 'weight', 70)
  })

  it('+ genre only offers the genres that person is missing', () => {
    const { onAddGenre } = setup()
    const menu = openMenu(screen.getByTestId('add-genre-NhiLV'))
    expect(within(menu).getByText('Simulation')).toBeInTheDocument()
    expect(within(menu).queryByText('Puzzle')).not.toBeInTheDocument()
    fireEvent.click(within(menu).getByText('Simulation'))
    expect(onAddGenre).toHaveBeenCalledWith('NhiLV', 'simulation')
  })

  it('someone covering all three genres gets no + genre control', () => {
    setup({
      groups: [{
        name: 'Full', today_available: true, game_platform: 'all', weight: 100, missingGenres: [],
        rows: (['puzzle', 'arcade', 'simulation'] as const).map((g, i) => ({
          id: 10 + i, name: 'Full', category_group: g, today_available: true,
          game_platform: 'all', game_category: 'All', weight: 100,
        })),
      }],
    })
    expect(screen.queryByTestId('add-genre-Full')).not.toBeInTheDocument()
  })

  it('readOnly drops Remove, + genre and + Add evaluator', () => {
    setup({ readOnly: true })
    expect(screen.queryByText('Remove')).not.toBeInTheDocument()
    expect(screen.queryByTestId('add-genre-NhiLV')).not.toBeInTheDocument()
    expect(screen.queryByText(/add evaluator/i)).not.toBeInTheDocument()
  })

  it("stored 'All' renders as every sub-genre ticked, not as an All box", () => {
    setup()
    const puzzleRow = screen.getAllByTestId('avail-cell')[0].closest('tr')!
    expect(within(puzzleRow).queryByLabelText('All')).not.toBeInTheDocument()
    for (const g of SUB_GENRES.puzzle) {
      expect(within(puzzleRow).getByLabelText(g)).toBeChecked()
    }
  })

  it('unticking one of an All row stores the rest', () => {
    const { onPatchRow } = setup()
    const puzzleRow = screen.getAllByTestId('avail-cell')[0].closest('tr')!
    fireEvent.click(within(puzzleRow).getByLabelText('word'))
    expect(onPatchRow).toHaveBeenCalledWith(1, 'game_category', 'puzzle,trivia')
  })

  it("ticking the rest back stores 'All' again", () => {
    const { onPatchRow } = setup()
    // The Arcade row holds only 'action' of arcade's two options.
    const arcadeRow = screen.getByText('Arcade').closest('tr')!
    expect(within(arcadeRow).getByLabelText('arcade')).not.toBeChecked()
    fireEvent.click(within(arcadeRow).getByLabelText('arcade'))
    expect(onPatchRow).toHaveBeenCalledWith(2, 'game_category', 'All')
  })

  it('refuses to untick the last remaining sub-genre', () => {
    const { onPatchRow } = setup()
    const arcadeRow = screen.getByText('Arcade').closest('tr')!
    fireEvent.click(within(arcadeRow).getByLabelText('action'))
    // An empty list would normalize back to 'All' server-side — the opposite.
    expect(onPatchRow).not.toHaveBeenCalled()
  })

  it('an empty roster shows the empty state', () => {
    setup({ groups: [] })
    expect(screen.getByText('No evaluators yet')).toBeInTheDocument()
  })
})
