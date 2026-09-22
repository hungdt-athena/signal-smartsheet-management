import { render } from '@testing-library/react'
import { LineChart } from '@/components/report/charts'

// The chart is hand-rolled SVG, so overlapping text is a coordinate bug and can be
// caught by reading the coordinates. What went wrong before, and must not come back:
//
//   • A right-hand axis put its tick labels at the same x as the value printed at the
//     last data point, so "5,589" and "6,000" were drawn on top of each other. There
//     is one axis now: every series here counts games, so they belong on one scale.
//   • Every point carried a value label, which on a 7-day chart with three series is
//     21 numbers fighting the gridlines. Only the first and last are labelled now.
//
// jsdom does no layout, so these read the SVG attributes directly. That is enough:
// the labels are absolutely positioned text nodes, and their x/y ARE the layout.

const days = ['1/9', '2/9', '3/9', '4/9', '5/9', '6/9', '7/9']
const line = (name: string, vals: number[]) => ({ name, points: days.map((label, i) => ({ label, value: vals[i] })) })
const flow = [
  line('New games in', [171, 300, 520, 620, 700, 900, 1131]),
  line('Evaluated', [610, 480, 400, 350, 300, 200, 291]),
]
const stock = { name: 'Backlog', area: false, points: days.map((label, i) => ({ label, value: 4600 + i * 150 })) }
const withStock = [...flow, stock]

const texts = (c: HTMLElement, cls: string) =>
  Array.from(c.querySelectorAll(`text.${cls}`)).map((t) => ({
    text: t.textContent || '',
    x: Number(t.getAttribute('x')),
    y: Number(t.getAttribute('y')),
    anchor: t.getAttribute('text-anchor'),
  }))

describe('LineChart', () => {
  it('labels the first and last point of each series, and nothing in between', () => {
    const { container } = render(<LineChart series={flow} area />)
    const vals = texts(container, 'rp-dotval')
    expect(vals).toHaveLength(4)
    expect(vals.map((v) => v.text).sort()).toEqual(['1,131', '171', '291', '610'])
  })

  it('keeps two labels at the same point from landing on each other', () => {
    // both series start close together, which is what used to stack the two labels
    const tight = [line('a', [500, 100, 100, 100, 100, 100, 100]), line('b', [505, 900, 900, 900, 900, 900, 900])]
    const { container } = render(<LineChart series={tight} />)
    const first = texts(container, 'rp-dotval').filter((v) => v.anchor === 'start')
    expect(first).toHaveLength(2)
    expect(Math.abs(first[0].y - first[1].y)).toBeGreaterThanOrEqual(14)
  })

  it('has no right-hand axis to collide with the end-of-line values', () => {
    const { container } = render(<LineChart series={withStock} area />)
    // every y-axis tick label is anchored end, in the left gutter, left of every value
    const ticks = texts(container, 'rp-ylabel')
    expect(ticks.length).toBeGreaterThan(0)
    const rightmostTick = Math.max(...ticks.map((t) => t.x))
    const leftmostValue = Math.min(...texts(container, 'rp-dotval').map((v) => v.x))
    // .rp-ylabel is anchored end in CSS; a right-hand tick had to override that to
    // "start", so any tick carrying that attribute means the second axis is back
    expect(ticks.every((t) => t.anchor !== 'start')).toBe(true)
    expect(rightmostTick).toBeLessThan(leftmostValue)
  })

  it('draws one row of day labels', () => {
    const { container } = render(<LineChart series={withStock} area />)
    const xs = texts(container, 'rp-xlabel')
    expect(xs.map((t) => t.text)).toEqual(days)
    expect(new Set(xs.map((t) => t.y)).size).toBe(1)
  })

  it('keeps every label at one end apart, even when a big series squashes the rest', () => {
    // Backlog runs ~5,000 against flow in the hundreds, so on a shared axis the two
    // flow lines bunch at the bottom. That is the honest picture, but their labels
    // still have to be readable.
    const { container } = render(<LineChart series={withStock} area />)
    for (const anchor of ['start', 'end']) {
      const col = texts(container, 'rp-dotval').filter((v) => v.anchor === anchor).sort((a, b) => a.y - b.y)
      expect(col).toHaveLength(3)
      for (let i = 1; i < col.length; i++) expect(col[i].y - col[i - 1].y).toBeGreaterThanOrEqual(14)
    }
  })

  it('skips the area fill on a series that would bury the others', () => {
    const { container } = render(<LineChart series={withStock} area />)
    // one gradient per filled series: the two flow lines, not the backlog line
    expect(container.querySelectorAll('linearGradient')).toHaveLength(2)
  })
})
