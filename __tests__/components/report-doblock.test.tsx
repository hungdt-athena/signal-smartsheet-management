import { render, screen } from '@testing-library/react'
import { DoBlock } from '@/components/report/ReportView'

const act = (over: Partial<Parameters<typeof DoBlock>[0]['acts'][number]> = {}) => ({
  sev: 3, key: 'k', kicker: 'AGE', do: <>Move 926 stale games</>,
  why: <>4 people hold 1,152 of 1,248</>, ...over,
})

describe('DoBlock', () => {
  it('renders nothing when there is nothing to do', () => {
    const { container } = render(<DoBlock acts={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders at most three cards, worst first', () => {
    render(<DoBlock acts={[
      act({ key: 'a', sev: 1 }), act({ key: 'b', sev: 3 }),
      act({ key: 'c', sev: 2 }), act({ key: 'd', sev: 3 }),
    ]} />)
    const cards = document.querySelectorAll('.rp-do')
    expect(cards).toHaveLength(3)
    expect(cards[0].className).toContain('urgent')
  })

  it('shows the payoff and the button when an action carries them', () => {
    render(<DoBlock acts={[act({
      payoff: <>Stale games gone in 6 days instead of 31</>,
      cta: { label: 'Open Rescue', href: '/team-ops?tab=rescue' },
    })]} />)
    expect(screen.getByText(/gone in 6 days/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open Rescue' }))
      .toHaveAttribute('href', '/team-ops?tab=rescue')
  })

  it('omits the button entirely when an action has no cta', () => {
    render(<DoBlock acts={[act()]} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button', { name: /open/i })).toBeNull()
  })
})
