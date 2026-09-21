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

const personRow = (name: string) => screen.getByText(name).closest('tr') as HTMLElement

/**
 * The pill for one (person, genre) pair. Scoped to the person: two people on
 * the same genre at the same weight have identical pill labels, which is
 * correct — the person's row is what tells them apart.
 */
function pill(person: string, label: RegExp): HTMLElement {
  return within(personRow(person)).getByRole('button', { name: label })
}

/** Open a genre's panel and return the panel row it expands into. */
function openPanel(person: string, genre: string): HTMLElement {
  fireEvent.click(pill(person, new RegExp(`^${genre},`)))
  // Panels render as sibling rows immediately after their person's row.
  let n = personRow(person).nextElementSibling
  while (n?.classList.contains('genre-xrow')) {
    if (within(n as HTMLElement).queryByText(genre)) return n as HTMLElement
    n = n.nextElementSibling
  }
  throw new Error(`panel for ${person} / ${genre} did not open`)
}

describe('RosterTable', () => {
  it('is one row per person, with a pill per genre', () => {
    setup()
    // Three (person, genre) pairs across two people.
    expect(screen.getAllByText('NhiLV')).toHaveLength(1)
    expect(screen.getAllByText('Puzzle')).toHaveLength(2)
    expect(screen.getAllByText('Arcade')).toHaveLength(1)
    expect(screen.getByRole('columnheader', { name: /^genres$/i })).toBeInTheDocument()
  })

  it('there is one Available control per person, and it writes by name', () => {
    const { onPatchAvailable } = setup()
    const avail = screen.getAllByTestId('avail-cell')
    expect(avail).toHaveLength(2) // two people, not three (person, genre) pairs

    const menu = openMenu(avail[0])
    fireEvent.click(within(menu).getByText('No'))
    expect(onPatchAvailable).toHaveBeenCalledWith('NhiLV', false)
  })

  it('there is one Platform control per person, written by name', () => {
    const { onPatchPerson } = setup()
    expect(screen.getAllByTestId('platform-cell')).toHaveLength(2)

    const menu = openMenu(screen.getAllByTestId('platform-cell')[0])
    fireEvent.click(within(menu).getByText('ios'))
    expect(onPatchPerson).toHaveBeenCalledWith('NhiLV', 'game_platform', 'ios')
  })

  it('the pill always shows weight, including the default 100', () => {
    setup()
    // A blank in the common case would turn scanning the column into a lookup.
    expect(pill('NhiLV', /^Puzzle, weight 100/)).toBeInTheDocument()
    expect(pill('NhiLV', /^Arcade, weight 50/)).toBeInTheDocument()
  })

  it('only a restricted row gets a sub-genre badge, and it says "sub-genres"', () => {
    setup()
    // Arcade holds 1 of its 2 options; both Puzzle rows are stored 'All'.
    expect(screen.getByText('1/2 sub-genres')).toBeInTheDocument()
    expect(screen.queryByText(/3\/3 sub-genres/)).not.toBeInTheDocument()
    expect(pill('NhiLV', /^Puzzle, weight 100, all sub-genres$/)).toBeInTheDocument()
    expect(pill('NhiLV', /^Arcade, weight 50, 1 of 2 sub-genres$/)).toBeInTheDocument()
  })

  it('every pill of an unavailable person is dimmed together', () => {
    setup()
    expect(pill('NhiLV', /^Puzzle/)).not.toHaveClass('gpill-off')
    expect(pill('MyTL', /^Puzzle/)).toHaveClass('gpill-off')
  })

  it('a pill expands into a panel row and collapses again', () => {
    setup()
    expect(pill('NhiLV', /^Arcade/)).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(pill('NhiLV', /^Arcade/))
    expect(pill('NhiLV', /^Arcade/)).toHaveAttribute('aria-expanded', 'true')
    expect(document.querySelectorAll('tr.genre-xrow')).toHaveLength(1)

    fireEvent.click(pill('NhiLV', /^Arcade/))
    expect(document.querySelectorAll('tr.genre-xrow')).toHaveLength(0)
  })

  it('several panels stay open at once, across people', () => {
    setup()
    fireEvent.click(pill('NhiLV', /^Arcade/))
    fireEvent.click(pill('MyTL', /^Puzzle/))
    // Comparing two rows is the reason the panel lives in the table.
    expect(document.querySelectorAll('tr.genre-xrow')).toHaveLength(2)
  })

  it('Escape closes every open panel', () => {
    setup()
    fireEvent.click(pill('NhiLV', /^Arcade/))
    expect(document.querySelectorAll('tr.genre-xrow')).toHaveLength(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelectorAll('tr.genre-xrow')).toHaveLength(0)
  })

  it('weight is written per genre, by row id', () => {
    const { onPatchRow } = setup()
    const panel = openPanel('NhiLV', 'Arcade')
    const seventy = within(panel).getByRole('button', { name: '70' })
    expect(within(panel).getByRole('button', { name: '50' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(seventy)
    // Row 2 is NhiLV's arcade row; their puzzle row (id 1) is untouched.
    expect(onPatchRow).toHaveBeenCalledWith(2, 'weight', 70)
    expect(onPatchRow).toHaveBeenCalledTimes(1)
  })

  it("stored 'All' renders as every sub-genre ticked, not as an All box", () => {
    setup()
    const panel = openPanel('NhiLV', 'Puzzle')
    expect(within(panel).queryByLabelText('All')).not.toBeInTheDocument()
    for (const g of SUB_GENRES.puzzle) {
      expect(within(panel).getByLabelText(g)).toBeChecked()
    }
  })

  it('unticking one of an All row stores the rest', () => {
    const { onPatchRow } = setup()
    const panel = openPanel('NhiLV', 'Puzzle')
    fireEvent.click(within(panel).getByLabelText('word'))
    expect(onPatchRow).toHaveBeenCalledWith(1, 'game_category', 'puzzle,trivia')
  })

  it("ticking the rest back stores 'All' again", () => {
    const { onPatchRow } = setup()
    const panel = openPanel('NhiLV', 'Arcade')
    expect(within(panel).getByLabelText('arcade')).not.toBeChecked()
    fireEvent.click(within(panel).getByLabelText('arcade'))
    expect(onPatchRow).toHaveBeenCalledWith(2, 'game_category', 'All')
  })

  it('the last remaining sub-genre is disabled, with a reason', () => {
    const { onPatchRow } = setup()
    const panel = openPanel('NhiLV', 'Arcade')
    const last = within(panel).getByLabelText('action')
    // An empty list would normalize back to 'All' server-side — the opposite.
    // Saying so beats the old silent no-op.
    expect(last).toBeDisabled()
    expect(last.closest('label')).toHaveAttribute('title', 'Keep at least one sub-genre')
    fireEvent.click(last)
    expect(onPatchRow).not.toHaveBeenCalled()
  })

  it("Select all restores 'All' and is disabled once there is nothing to restore", () => {
    const { onPatchRow } = setup()
    const arcade = openPanel('NhiLV', 'Arcade')
    fireEvent.click(within(arcade).getByRole('button', { name: 'Select all' }))
    expect(onPatchRow).toHaveBeenCalledWith(2, 'game_category', 'All')

    fireEvent.keyDown(window, { key: 'Escape' })
    const puzzle = openPanel('NhiLV', 'Puzzle')
    expect(within(puzzle).getByRole('button', { name: 'Select all' })).toBeDisabled()
  })

  it('Remove genre removes that row alone', () => {
    const { onRemoveRow } = setup()
    const panel = openPanel('NhiLV', 'Arcade')
    fireEvent.click(within(panel).getByRole('button', { name: 'Remove genre' }))
    expect(onRemoveRow).toHaveBeenCalledWith(2)
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
        name: 'Full', today_available: true, game_platform: 'all', missingGenres: [],
        rows: (['puzzle', 'arcade', 'simulation'] as const).map((g, i) => ({
          id: 10 + i, name: 'Full', category_group: g, today_available: true,
          game_platform: 'all', game_category: 'All', weight: 100,
        })),
      }],
    })
    expect(screen.queryByTestId('add-genre-Full')).not.toBeInTheDocument()
  })

  it('readOnly still opens a panel, but every control in it is inert', () => {
    setup({ readOnly: true })
    expect(screen.queryByTestId('add-genre-NhiLV')).not.toBeInTheDocument()
    expect(screen.queryByText(/add evaluator/i)).not.toBeInTheDocument()

    // An evaluator has to be able to READ their own sub-genre restriction.
    const panel = openPanel('NhiLV', 'Arcade')
    expect(within(panel).getByLabelText('arcade')).toBeDisabled()
    expect(within(panel).getByRole('button', { name: '70' })).toBeDisabled()
    expect(within(panel).queryByRole('button', { name: 'Remove genre' })).not.toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Select all' })).not.toBeInTheDocument()
  })

  it('an empty roster shows the empty state', () => {
    setup({ groups: [] })
    expect(screen.getByText('No evaluators yet')).toBeInTheDocument()
  })
})
