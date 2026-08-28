import { fireEvent, render, screen } from '@testing-library/react'
import { GenreToggles } from '@/components/GenreToggles'
import type { GenreTarget } from '@/lib/genre-config'

const genres: GenreTarget[] = [
  { bucket: 'puzzle', enabled: true, available: 7, active: true },
  { bucket: 'arcade', enabled: true, available: 0, active: false },
  { bucket: 'simulation', enabled: false, available: 3, active: false },
]

function setup(over: Partial<React.ComponentProps<typeof GenreToggles>> = {}) {
  const onToggle = jest.fn()
  render(<GenreToggles genres={genres} canEdit onToggle={onToggle} {...over} />)
  return { onToggle }
}

const chip = (name: string) => screen.getByRole('button', { name: new RegExp(name, 'i') })

describe('GenreToggles', () => {
  it('shows how many people are available behind a running genre', () => {
    setup()
    expect(chip('puzzle')).toHaveTextContent('7 available')
  })

  it('warns that a staffless genre will be skipped today', () => {
    setup()
    const arcade = chip('arcade')
    expect(arcade).toHaveTextContent(/no one available/i)
    expect(arcade.className).toContain('genre-chip-warn')
  })

  it('reads as off when the toggle is off, whoever is available', () => {
    setup()
    expect(chip('simulation')).toHaveTextContent(/off/i)
    expect(chip('simulation')).not.toHaveTextContent('3 available')
  })

  it('flips a genre the other way when an admin clicks it', () => {
    const { onToggle } = setup()
    fireEvent.click(chip('simulation'))
    expect(onToggle).toHaveBeenCalledWith('simulation', true)
    fireEvent.click(chip('puzzle'))
    expect(onToggle).toHaveBeenCalledWith('puzzle', false)
  })

  it('is read-only for anyone who is not an admin', () => {
    const { onToggle } = setup({ canEdit: false })
    expect(chip('puzzle')).toBeDisabled()
    fireEvent.click(chip('puzzle'))
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('marks the pressed state so the toggle is legible to a screen reader', () => {
    setup()
    expect(chip('puzzle')).toHaveAttribute('aria-pressed', 'true')
    expect(chip('simulation')).toHaveAttribute('aria-pressed', 'false')
  })
})
