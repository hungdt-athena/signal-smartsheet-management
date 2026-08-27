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
    missingGenres: ['simulation'],
    rows: [
      { id: 1, name: 'NhiLV', category_group: 'puzzle', today_available: true, game_platform: 'all', game_category: 'All', weight: 100 },
      { id: 2, name: 'NhiLV', category_group: 'arcade', today_available: true, game_platform: 'ios', game_category: 'action', weight: 50 },
    ],
  },
  {
    name: 'MyTL',
    today_available: false,
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
    onRemoveRow: jest.fn(),
    onAddGenre: jest.fn(),
    onAddEvaluator: jest.fn(),
    ...over,
  }
  render(<RosterTable {...props} />)
  return props
}

// StyledSelect mở menu qua portal vào document.body, option là div.ssel-opt
// (không phải role="option"), nên phải query theo class thật.
function openMenu(trigger: HTMLElement): HTMLElement {
  fireEvent.click(within(trigger).getByRole('button'))
  const menu = document.querySelector('.ssel-menu')
  if (!menu) throw new Error('menu did not open')
  return menu as HTMLElement
}

describe('RosterTable', () => {
  it('cột Genre hiện tên genre của từng dòng, header là Sub-genre chứ không phải Category', () => {
    setup()
    expect(screen.getAllByText('Puzzle')).toHaveLength(2)
    expect(screen.getAllByText('Arcade')).toHaveLength(1)
    expect(screen.getByRole('columnheader', { name: /sub-genre/i })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: /^category$/i })).not.toBeInTheDocument()
  })

  it('tên người xuất hiện một lần cho hai genre (gộp cell)', () => {
    setup()
    expect(screen.getAllByText('NhiLV')).toHaveLength(1)
  })

  it('ô Available chỉ có một cho mỗi người, và ghi theo tên chứ không theo id dòng', () => {
    const { onPatchAvailable } = setup()
    const avail = screen.getAllByTestId('avail-cell')
    expect(avail).toHaveLength(2) // 2 người, không phải 3 dòng

    const menu = openMenu(avail[0])
    fireEvent.click(within(menu).getByText('No'))
    expect(onPatchAvailable).toHaveBeenCalledWith('NhiLV', false)
  })

  it('+ genre chỉ đề xuất genre người đó chưa có', () => {
    const { onAddGenre } = setup()
    const menu = openMenu(screen.getByTestId('add-genre-NhiLV'))
    expect(within(menu).getByText('Simulation')).toBeInTheDocument()
    expect(within(menu).queryByText('Puzzle')).not.toBeInTheDocument()
    fireEvent.click(within(menu).getByText('Simulation'))
    expect(onAddGenre).toHaveBeenCalledWith('NhiLV', 'simulation')
  })

  it('người đủ 3 genre không có nút + genre', () => {
    setup({
      groups: [{
        name: 'Full', today_available: true, missingGenres: [],
        rows: (['puzzle', 'arcade', 'simulation'] as const).map((g, i) => ({
          id: 10 + i, name: 'Full', category_group: g, today_available: true,
          game_platform: 'all', game_category: 'All', weight: 100,
        })),
      }],
    })
    expect(screen.queryByTestId('add-genre-Full')).not.toBeInTheDocument()
  })

  it('readOnly bỏ cột Remove, bỏ + genre và + Add evaluator', () => {
    setup({ readOnly: true })
    expect(screen.queryByText('Remove')).not.toBeInTheDocument()
    expect(screen.queryByTestId('add-genre-NhiLV')).not.toBeInTheDocument()
    expect(screen.queryByText(/add evaluator/i)).not.toBeInTheDocument()
  })

  it('roster rỗng hiện empty state', () => {
    setup({ groups: [] })
    expect(screen.getByText('No evaluators yet')).toBeInTheDocument()
  })
})
