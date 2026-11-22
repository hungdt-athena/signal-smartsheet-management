import { render, screen } from '@testing-library/react'
import { StoresCell } from '@/components/ui/StoreIcons'
import { GameIcon } from '@/components/ui/GameIcon'
import { Switch } from '@/components/ui/Switch'
import type { PairStore } from '@/lib/eval-pairs'

const ios: PairStore = { os: 'ios', game_id: '6822015244', eval_id: 1, app_link: 'https://apps.apple.com/app/id6822015244', is_active: true, dead: false }
const and: PairStore = { os: 'android', game_id: 'com.x.y', eval_id: 2, app_link: 'https://play.google.com/store/apps/details?id=com.x.y', is_active: true, dead: false }

describe('StoresCell', () => {
  it('renders one cell per store, iOS first', () => {
    const { container } = render(<StoresCell stores={[and, ios]} />)
    const cells = container.querySelectorAll('.store-ico')
    expect(cells).toHaveLength(2)
    expect(cells[0].getAttribute('title')).toBe('iOS · 6822015244')
    expect(cells[1].getAttribute('title')).toBe('Android · com.x.y')
  })
  it('marks dead and removed stores', () => {
    const { container } = render(<StoresCell stores={[{ ...ios, dead: true }, { ...and, is_active: false }]} />)
    const [a, b] = Array.from(container.querySelectorAll('.store-ico'))
    expect(a.className).toContain('dead')
    expect(a.getAttribute('title')).toContain('Link dead')
    expect(b.className).toContain('removed')
    expect(b.getAttribute('title')).toContain('Removed')
  })
  it('renders anchors with asLinks', () => {
    const { container } = render(<StoresCell stores={[ios]} asLinks />)
    const a = container.querySelector('a.store-ico')!
    expect(a.getAttribute('href')).toBe(ios.app_link)
    expect(a.getAttribute('target')).toBe('_blank')
  })
})

describe('GameIcon', () => {
  it('draws two marks for oses, iOS left of Android', () => {
    const { container } = render(<GameIcon src={null} oses={['android', 'ios']} />)
    const marks = container.querySelectorAll('.game-icon-plat')
    expect(marks).toHaveLength(2)
    expect(marks[0].getAttribute('aria-label')).toBe('iOS')
    expect((marks[0] as HTMLElement).style.right).toBe('10px')
    expect((marks[1] as HTMLElement).style.right).toBe('-4px')
  })
  it('keeps the single os mark and honours hideMark', () => {
    expect(render(<GameIcon src={null} os="ios" />).container.querySelectorAll('.game-icon-plat')).toHaveLength(1)
    expect(render(<GameIcon src={null} os="ios" hideMark />).container.querySelectorAll('.game-icon-plat')).toHaveLength(0)
  })
})

describe('Switch', () => {
  it('danger tone adds sw-dead', () => {
    render(<Switch checked onChange={() => {}} label="Link dead" tone="danger" />)
    expect(screen.getByRole('switch').className).toContain('sw-dead')
  })
})
