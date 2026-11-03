/**
 * @jest-environment node
 */
import fixture from '../fixtures/master-template.json'
import { readTemplate } from '@/lib/shortlist-export/slides-template'
import type { slides_v1 } from 'googleapis'

const P = fixture as unknown as slides_v1.Schema$Presentation
const clone = (): slides_v1.Schema$Presentation => JSON.parse(JSON.stringify(P))

describe('readTemplate', () => {
  const map = readTemplate(P)

  it('finds the cover text', () => {
    expect(map.coverSlideId).toBe(P.slides![0].objectId)
    expect(map.coverTextId).toBe('g3876fc6da32_2_18')
    expect(map.coverText).toBe('December 2026 Monthly Report')
    expect(map.textLen['g3876fc6da32_2_439']).toBe('The game name'.length)
  })

  it('finds 8 insight cards row-major, each with icon, name, gameplay and its released-by line', () => {
    const cards = map.insight!.cards
    expect(cards).toHaveLength(8)
    for (let i = 1; i < cards.length; i++) {
      const a = cards[i - 1].box, b = cards[i].box
      expect(a.y < b.y - 1 || (Math.abs(a.y - b.y) <= 1 && a.x < b.x)).toBe(true)
    }
    expect(new Set(cards.map(c => c.releasedById)).size).toBe(8)
    expect(cards.every(c => c.releasedById && c.iconId && c.nameId && c.gameplayId)).toBe(true)
    // first card: the group at top-left
    expect(cards[0]).toMatchObject({ groupId: 'g38d2e837717_0_10', iconId: 'g3876fc6da32_2_437', nameId: 'g3876fc6da32_2_439', gameplayId: 'g3876fc6da32_2_440', releasedById: 'g3876fc6da32_2_538' })
  })

  it('finds 20 top-pick icons and two name columns, left first', () => {
    const tp = map.topPicks!
    expect(tp.iconIds).toHaveLength(20)
    expect(tp.iconIds.slice(0, 5)).toEqual(['g38976c7624e_1_2', 'g38976c7624e_1_3', 'g38976c7624e_1_4', 'g38976c7624e_1_5', 'g38976c7624e_1_7'])
    expect(tp.nameColumnIds).toEqual(['g38976c7624e_1_39', 'g38976c7624e_1_40'])
    expect(tp.nameFontPt).toBe(14)
    expect(tp.iconBox.x).toBeCloseTo(24 * 12700, -2)
    expect(tp.iconSize).toBeCloseTo(49 * 12700, -2)
    expect(tp.iconPitch).toBeCloseTo(61 * 12700, -2)
  })

  it('picks the 3-section detail slide with name, icon, date and video', () => {
    expect(map.detail).toMatchObject({
      slideId: 'g3876fc6da32_2_896', nameId: 'g3876fc6da32_2_901', iconId: 'g3876fc6da32_2_902',
      dateId: 'g3876fc6da32_2_903', videoId: 'g3876fc6da32_2_904',
    })
    expect(map.detail!.videoBox!.w).toBeGreaterThan(0)
  })

  it('finds trending and drops every other slide', () => {
    expect(map.trendingSlideId).toBe('g3876fc6da32_2_0')
    expect(map.dropSlideIds).toHaveLength(9 - 5)
    expect(map.dropSlideIds).toEqual(expect.arrayContaining(['g38d2f5437e4_0_0', 'g3876fc6da32_0_798', 'g3876fc6da32_2_692', 'g3876fc6da32_2_936']))
  })

  it('returns null parts when a slide is missing', () => {
    const p = clone()
    p.slides = p.slides!.filter(s => s.objectId !== 'g3876fc6da32_2_0')
    const m = readTemplate(p)
    expect(m.trendingSlideId).toBeNull()
    expect(m.insight!.cards).toHaveLength(8)
    expect(m.detail!.slideId).toBe('g3876fc6da32_2_896')
  })
})
