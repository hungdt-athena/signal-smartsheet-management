import { render, screen } from '@testing-library/react'
import { AlikeCell } from '@/components/weekly-feedback/FeedbackView'

describe('AlikeCell', () => {
  it('renders every group name and its game links', () => {
    render(<AlikeCell no={null} alikes={[
      { name: 'Match-3', games: [{ game_id: null, title: 'Wildlife Flip', app_link: 'https://x/wildlife', icon_url: null, manual: true }] },
      { name: 'Arrow', games: [{ game_id: 'g2', title: 'Get out my way', app_link: 'https://x/arrow', icon_url: null, manual: false }] },
    ]} />)
    expect(screen.getByText('Match-3')).toBeInTheDocument()
    expect(screen.getByText('Arrow')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Wildlife Flip' })).toHaveAttribute('href', 'https://x/wildlife')
    expect(screen.getByRole('link', { name: 'Get out my way' })).toHaveAttribute('href', 'https://x/arrow')
  })

  it('shows the em dash when there are no groups', () => {
    render(<AlikeCell no={null} alikes={[]} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})
