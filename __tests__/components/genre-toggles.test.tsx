import { fireEvent, render, screen, within } from '@testing-library/react'
import { GenreToggles } from '@/components/GenreToggles'
import type { GenreTarget } from '@/lib/genre-config'

const genres: GenreTarget[] = [
  { bucket: 'puzzle', enabled: true, available: 7, active: true },
  { bucket: 'arcade', enabled: false, available: 0, active: false },
  { bucket: 'simulation', enabled: true, available: 0, active: false },
]

function setup(over: Partial<React.ComponentProps<typeof GenreToggles>> = {}) {
  const onToggle = jest.fn()
  render(<GenreToggles genres={genres} canEdit onToggle={onToggle} {...over} />)
  return { onToggle }
}

const row = (name: string) => screen.getByRole('row', { name: new RegExp(name, 'i') })
const sw = (name: string) => within(row(name)).getByRole('switch')

describe('GenreToggles', () => {
  it('says what the switches actually do', () => {
    setup()
    expect(screen.getByText(/genres receiving new games today/i)).toBeInTheDocument()
  })

  it('counts the people ready for each genre, not the database rows', () => {
    setup()
    expect(row('puzzle')).toHaveTextContent('7 evaluators')
    expect(row('arcade')).toHaveTextContent(/no one available/i)
  })

  it('says "1 evaluator", not "1 evaluators"', () => {
    render(<GenreToggles canEdit onToggle={jest.fn()}
      genres={[{ bucket: 'puzzle', enabled: true, available: 1, active: true }]} />)
    expect(row('puzzle')).toHaveTextContent('1 evaluator')
    expect(row('puzzle')).not.toHaveTextContent('1 evaluators')
  })

  it('offers a real switch that reads its own state', () => {
    setup()
    expect(sw('puzzle')).toHaveAttribute('aria-checked', 'true')
    expect(sw('arcade')).toHaveAttribute('aria-checked', 'false')
    // The state word belongs to the switch, next to the track it describes.
    expect(sw('puzzle')).toHaveTextContent('On')
    expect(sw('arcade')).toHaveTextContent('Off')
  })

  it('flips a genre the other way when an admin uses the switch', () => {
    const { onToggle } = setup()
    fireEvent.click(sw('arcade'))
    expect(onToggle).toHaveBeenCalledWith('arcade', true)
    fireEvent.click(sw('puzzle'))
    expect(onToggle).toHaveBeenCalledWith('puzzle', false)
  })

  // Switching a genre on while nobody is available changes nothing today. Saying
  // "no one available" leaves the reader to guess the fix, so name it.
  it('tells the reader how to unblock a genre that is on with nobody available', () => {
    setup()
    const warn = screen.getByRole('alert')
    expect(warn).toHaveTextContent(/nothing will be pushed/i)
    expect(warn).toHaveTextContent(/mark someone available for simulation/i)
  })

  it('warns only about the genre that is stuck', () => {
    setup()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('does not warn about a genre that is simply switched off', () => {
    render(<GenreToggles canEdit onToggle={jest.fn()}
      genres={[{ bucket: 'arcade', enabled: false, available: 0, active: false }]} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('is read-only for anyone who is not an admin, and says why', () => {
    const { onToggle } = setup({ canEdit: false })
    expect(sw('puzzle')).toBeDisabled()
    fireEvent.click(sw('puzzle'))
    expect(onToggle).not.toHaveBeenCalled()
    expect(screen.getByText(/only an admin can change this/i)).toBeInTheDocument()
  })

  it('leaves the admin note out when the user may edit', () => {
    setup()
    expect(screen.queryByText(/only an admin can change this/i)).not.toBeInTheDocument()
  })
})
