/**
 * @jest-environment node
 */
import fixture from '../fixtures/master-template.json'
import { readTemplate } from '@/lib/shortlist-export/slides-template'
import { planSlides, youtubeId } from '@/lib/shortlist-export/slides-plan'
import type { ExportGame, ExportScope } from '@/lib/shortlist-export/types'
import type { slides_v1 } from 'googleapis'

const MAP = readTemplate(fixture as unknown as slides_v1.Schema$Presentation)
const WEEK: ExportScope = { kind: 'week', labels: ['W3 Oct, 2026'], monthKey: '2026-10', weekTag: 'W3' }
const MONTH: ExportScope = { kind: 'month', labels: ['W1 Oct, 2026', 'W2 Oct, 2026', 'W3 Oct, 2026', 'W4 Oct, 2026'], monthKey: '2026-10', weekTag: null }
const BOTH = ['insight', 'priority_iv'] as const

function g(n: number, conclusion: ExportGame['conclusion'], over: Partial<ExportGame> = {}): ExportGame {
  return {
    gameId: `${conclusion[0]}${n}`, title: `${conclusion} Game ${n}`, publisher: 'Pub', platform: 'android',
    storeUrl: `https://play.google.com/store/apps/details?id=g${n}`, iconUrl: `https://img.example/${conclusion[0]}${n}.png`,
    releaseDate: '2026-09-25', conclusion, batch: 'W3 Oct, 2026', youtubeUrl: 'https://youtu.be/abcdefghijk', ...over,
  }
}
const ins = (k: number) => Array.from({ length: k }, (_, i) => g(i + 1, 'Insight'))
const p4 = (k: number) => Array.from({ length: k }, (_, i) => g(i + 1, 'Priority IV'))

type R = slides_v1.Schema$Request
const kinds = (rs: R[], k: keyof R) => rs.filter(r => r[k]).map(r => r[k] as any)
const deleted = (rs: R[]) => kinds(rs, 'deleteObject').map((d: any) => d.objectId as string)
const inserts = (rs: R[]) => kinds(rs, 'insertText') as { objectId: string; text: string; insertionIndex: number }[]
/** Final slide order: the slides the updateSlidesPosition moves put at index 0..n. */
const order = (rs: R[]) => kinds(rs, 'updateSlidesPosition').map((u: any) => u.slideObjectIds[0] as string)
const allMedia = (plan: ReturnType<typeof planSlides>) => plan.images.flatMap(i => i.requests)

describe('youtubeId', () => {
  it('reads the id from youtu.be and watch links', () => {
    expect(youtubeId('https://youtu.be/abcdefghijk')).toBe('abcdefghijk')
    expect(youtubeId('https://www.youtube.com/watch?v=abcdefghijk&t=3')).toBe('abcdefghijk')
    expect(youtubeId(null)).toBeNull()
  })
})

describe('planSlides', () => {
  it('week deck: cover, insight, top picks, details; trending deleted', () => {
    const plan = planSlides(MAP, [...ins(3), ...p4(2)], WEEK, [...BOTH])
    expect(deleted(plan.structure)).toContain(MAP.trendingSlideId)
    const o = order(plan.structure)
    expect(o[0]).toBe(MAP.coverSlideId)
    expect(o[1]).toBe(MAP.insight!.slideId)
    expect(o[2]).toBe(MAP.topPicks!.slideId)
    expect(o.slice(3)).toHaveLength(2)
    const cover = kinds(plan.structure, 'replaceAllText')
    expect(cover).toEqual(expect.arrayContaining([
      expect.objectContaining({ containsText: { text: 'December 2026', matchCase: true }, replaceText: 'October 2026', pageObjectIds: [MAP.coverSlideId] }),
      expect.objectContaining({ containsText: { text: 'Monthly Report', matchCase: true }, replaceText: 'W3 Report', pageObjectIds: [MAP.coverSlideId] }),
    ]))
  })

  it('month deck keeps trending untouched', () => {
    const plan = planSlides(MAP, [...ins(2), ...p4(2)], MONTH, [...BOTH])
    expect(deleted(plan.structure)).not.toContain(MAP.trendingSlideId)
    expect(order(plan.structure)[2]).toBe(MAP.trendingSlideId)
    const touches = JSON.stringify(plan.structure.filter(r => !r.updateSlidesPosition))
    expect(touches).not.toContain(MAP.trendingSlideId)
    const cover = kinds(plan.structure, 'replaceAllText')
    // the template cover already reads "Monthly Report": only the month changes
    expect(cover.map((c: any) => c.replaceText)).toEqual(['October 2026'])
  })

  it('plans 30 insight and 45 p4 without dropping a game', () => {
    const games = [...ins(30), ...p4(45)]
    const plan = planSlides(MAP, games, MONTH, [...BOTH])
    const o = order(plan.structure)
    // cover + 4 insight + trending + 1 top picks + 45 details
    expect(o).toHaveLength(1 + 4 + 1 + 1 + 45)
    const texts = inserts(plan.structure).map(i => i.text)
    for (const x of games) expect(texts).toContain(x.title)
    const cols = inserts(plan.structure).filter(i => MAP.topPicks!.nameColumnIds.includes(i.objectId))
    expect(cols).toHaveLength(2)
    expect(cols[0].text.split('\n')).toHaveLength(23)
    expect(cols[0].text.split('\n')[0]).toBe('1. Priority IV Game 1')
    expect(cols[1].text.split('\n')[0]).toBe('24. Priority IV Game 24')
    expect(cols[1].text.split('\n')[21]).toBe('45. Priority IV Game 45')
    // 30 = 8 + 8 + 8 + 6: 2 unused cards (group + released-by line each) on the last slide
    const lastCards = MAP.insight!.cards.slice(6)
    for (const c of lastCards) {
      expect(deleted(plan.structure)).toContain(`${c.groupId}_x3`)
      expect(deleted(plan.structure)).toContain(`${c.releasedById}_x3`)
    }
    const created = allMedia(plan).filter(r => r.createImage && r.createImage.elementProperties?.pageObjectId === MAP.topPicks!.slideId)
    expect(created).toHaveLength(45)
    expect(plan.warnings).toContain('More than 40 Top Picks: list packed as small as it goes, check it by hand')
  })

  it('shrinks top picks by step', () => {
    const tp = MAP.topPicks!
    const sizeAt = (k: number) => {
      const plan = planSlides(MAP, p4(k), WEEK, ['priority_iv'])
      const created = allMedia(plan).filter(r => r.createImage?.elementProperties?.pageObjectId === tp.slideId)
      const font = kinds(plan.structure, 'updateTextStyle').find((u: any) => u.objectId === tp.nameColumnIds[0] && u.fields === 'fontSize')
      return { created, font, plan }
    }
    const a = sizeAt(25)
    expect(a.created).toHaveLength(25)
    expect(a.created[0].createImage!.elementProperties!.size!.width!.magnitude).toBeCloseTo(tp.iconSize * 0.75, 0)
    expect(a.font.style.fontSize.magnitude).toBeCloseTo(tp.nameFontPt * 0.75)
    const b = sizeAt(35)
    expect(b.created[0].createImage!.elementProperties!.size!.width!.magnitude).toBeCloseTo(tp.iconSize * 0.6, 0)
    const c = sizeAt(20)
    expect(c.created).toHaveLength(0)
    expect(allMedia(c.plan).filter(r => r.replaceImage && tp.iconIds.includes(r.replaceImage.imageObjectId!))).toHaveLength(20)
    expect(c.font).toBeUndefined()
    // 12 games: 8 unused template slots deleted, after the icon group is ungrouped --
    // emptying a group down to one element deletes the group, kept icon included
    const d = planSlides(MAP, p4(12), WEEK, ['priority_iv'])
    expect(deleted(d.structure)).toEqual(expect.arrayContaining(tp.iconIds.slice(12)))
    const iUngroup = d.structure.findIndex(r => r.ungroupObjects?.objectIds?.includes('g38976c7624e_1_27'))
    const iDelete = d.structure.findIndex(r => r.deleteObject?.objectId === tp.iconIds[12])
    expect(iUngroup).toBeGreaterThanOrEqual(0)
    expect(iUngroup).toBeLessThan(iDelete)
  })

  it('gives both name columns the same line count so their tops line up', () => {
    const tp = MAP.topPicks!
    const plan = planSlides(MAP, p4(21), WEEK, ['priority_iv'])
    const cols = inserts(plan.structure).filter(i => tp.nameColumnIds.includes(i.objectId))
    expect(cols[0].text.split('\n')).toHaveLength(11)
    expect(cols[1].text.split('\n')).toHaveLength(11)
    expect(cols[1].text.split('\n')[10]).toBe('')
  })

  it('centres a shrunk Top Picks grid in the icon area', () => {
    const tp = MAP.topPicks!
    const plan = planSlides(MAP, p4(25), WEEK, ['priority_iv'])
    const boxes = allMedia(plan).filter(r => r.createImage?.elementProperties?.pageObjectId === tp.slideId)
      .map(r => { const e = r.createImage!.elementProperties!; return { x: e.transform!.translateX!, y: e.transform!.translateY!, s: e.size!.width!.magnitude! } })
    const top = Math.min(...boxes.map(b => b.y)) - tp.iconBox.y
    const bottom = tp.iconBox.y + tp.iconBox.h - Math.max(...boxes.map(b => b.y + b.s))
    const left = Math.min(...boxes.map(b => b.x)) - tp.iconBox.x
    const right = tp.iconBox.x + tp.iconBox.w - Math.max(...boxes.map(b => b.x + b.s))
    expect(Math.abs(top - bottom)).toBeLessThan(12700)
    expect(Math.abs(left - right)).toBeLessThan(12700)
    expect(top).toBeGreaterThanOrEqual(0)
  })

  it('shrinks the name columns so every line fits the box height', () => {
    const tp = MAP.topPicks!
    const fontAt = (k: number) => kinds(planSlides(MAP, p4(k), MONTH, ['priority_iv']).structure, 'updateTextStyle')
      .find((u: any) => u.objectId === tp.nameColumnIds[0] && u.fields === 'fontSize')?.style.fontSize.magnitude as number | undefined
    const lines = (k: number) => Math.ceil(k / 2)
    // a line takes about 1.8x its font size in this template
    for (const k of [25, 35, 76]) {
      const f = fontAt(k)!
      expect(lines(k) * f * 1.8 * 12700).toBeLessThanOrEqual(tp.nameBoxH + 1)
    }
    expect(fontAt(76)!).toBeLessThan(tp.nameFontPt * 0.5)
  })

  it('insight only drops top picks and detail; p4 only drops insight', () => {
    const a = planSlides(MAP, [...ins(2), ...p4(2)], WEEK, ['insight'])
    expect(deleted(a.structure)).toEqual(expect.arrayContaining([MAP.topPicks!.slideId, MAP.detail!.slideId]))
    expect(inserts(a.structure).map(i => i.text)).not.toContain('Priority IV Game 1')
    const b = planSlides(MAP, [...ins(2), ...p4(2)], WEEK, ['priority_iv'])
    expect(deleted(b.structure)).toContain(MAP.insight!.slideId)
    expect(deleted(b.structure)).not.toContain(MAP.detail!.slideId)
  })

  it('drops the template-only slides', () => {
    const plan = planSlides(MAP, [...ins(1), ...p4(1)], WEEK, [...BOTH])
    expect(deleted(plan.structure)).toEqual(expect.arrayContaining(MAP.dropSlideIds))
  })

  it('missing values keep template text', () => {
    const bare = { releaseDate: null, youtubeUrl: null, publisher: null, iconUrl: null, storeUrl: null }
    const plan = planSlides(MAP, [g(1, 'Insight', bare), g(1, 'Priority IV', bare)], WEEK, [...BOTH])
    const card = MAP.insight!.cards[0]
    const d = MAP.detail!
    const ids = inserts(plan.structure).map(i => i.objectId)
    expect(ids).not.toContain(card.releasedById)
    expect(ids).not.toContain(d.dateId)
    const links = kinds(plan.structure, 'updateTextStyle').filter((u: any) => u.fields === 'link')
    // no url anywhere, and the template's own sample link is cleared on name, gameplay and date
    expect(links.every((l: any) => !l.style.link)).toBe(true)
    const cleared = links.map((l: any) => l.objectId)
    expect(cleared).toEqual(expect.arrayContaining([card.nameId, card.gameplayId, d.nameId, d.dateId]))
    expect(plan.images).toHaveLength(0)
    expect(inserts(plan.structure).map(i => i.text)).toContain('Add recording video')
    expect(deleted(plan.structure)).toContain(d.videoId)
    const json = JSON.stringify(plan)
    expect(json).not.toMatch(/null|undefined/)
  })

  it('fills the detail slide: name with link, date, icon and video', () => {
    const plan = planSlides(MAP, p4(1), WEEK, ['priority_iv'])
    const d = MAP.detail!
    const ins1 = inserts(plan.structure)
    expect(ins1).toEqual(expect.arrayContaining([
      expect.objectContaining({ objectId: d.nameId, text: 'Priority IV Game 1' }),
      expect.objectContaining({ objectId: d.dateId, text: '2026-09-25' }),
    ]))
    const links = kinds(plan.structure, 'updateTextStyle').filter((u: any) => u.fields === 'link')
    expect(links.find((l: any) => l.objectId === d.nameId).style.link.url).toBe('https://play.google.com/store/apps/details?id=g1')
    const media = allMedia(plan)
    expect(media.find(r => r.replaceImage?.imageObjectId === d.iconId)!.replaceImage!.url).toBe('https://img.example/P1.png')
    const v = media.find(r => r.createVideo)!.createVideo!
    expect(v).toMatchObject({ source: 'YOUTUBE', id: 'abcdefghijk' })
    expect(v.elementProperties!.pageObjectId).toBe(d.slideId)
    expect(media.find(r => r.deleteObject)!.deleteObject!.objectId).toBe(d.videoId)
  })

  it('fills insight cards: name, released by, gameplay link', () => {
    const plan = planSlides(MAP, ins(1), WEEK, ['insight'])
    const c = MAP.insight!.cards[0]
    expect(inserts(plan.structure)).toEqual(expect.arrayContaining([
      expect.objectContaining({ objectId: c.nameId, text: 'Insight Game 1' }),
      expect.objectContaining({ objectId: c.releasedById, text: 'Insight Game 1 released by Pub' }),
    ]))
    const links = kinds(plan.structure, 'updateTextStyle').filter((u: any) => u.fields === 'link')
    expect(links.find((l: any) => l.objectId === c.gameplayId).style.link.url).toBe('https://youtu.be/abcdefghijk')
    expect(inserts(plan.structure).map(i => i.objectId)).not.toContain(c.gameplayId)
  })

  it('clears an inherited link on text that gets no link of its own', () => {
    const plan = planSlides(MAP, ins(1), WEEK, ['insight'])
    const c = MAP.insight!.cards[0]
    const links = kinds(plan.structure, 'updateTextStyle').filter((u: any) => u.fields === 'link' && u.objectId === c.releasedById)
    expect(links).toEqual([expect.objectContaining({ style: {}, textRange: { type: 'ALL' } })])
  })

  it('picks the largest size that fits, in 0.5pt steps, from real Oswald widths', () => {
    // the cases checked by hand on the W4 Oct deck (template size 13pt)
    const c = MAP.insight!.cards[0]
    const size = (title: string) => {
      const plan = planSlides(MAP, [g(1, 'Insight', { title })], WEEK, ['insight'])
      return kinds(plan.structure, 'updateTextStyle').find((u: any) => u.objectId === c.nameId && u.fields === 'fontSize')?.style.fontSize.magnitude ?? c.nameFontPt
    }
    expect(size('Idle Missile - Evolve Game')).toBeCloseTo(c.nameFontPt, 1)   // 13 fits
    expect(size('Circle Release: Ring Puzzle')).toBeCloseTo(c.nameFontPt, 1)
    expect(size('Find The Suspect - Clue Puzzle')).toBe(12)                    // 13 wraps, 12 fits
    expect(size('Bunny Sort: Color Sort Games')).toBe(12)
  })

  it('widens a long Insight name up to the "-" before Gameplay, and only then shrinks it', () => {
    const c = MAP.insight!.cards[0]
    const run = (title: string) => {
      const plan = planSlides(MAP, [g(1, 'Insight', { title })], WEEK, ['insight'])
      return {
        font: kinds(plan.structure, 'updateTextStyle').find((u: any) => u.objectId === c.nameId && u.fields === 'fontSize'),
        grow: kinds(plan.structure, 'updatePageElementTransform').find((u: any) => u.objectId === c.nameId),
      }
    }
    // every name box grows to the "-": a short name keeps its size
    const short = run('Off You Go!')
    expect(short.font).toBeUndefined()
    expect(short.grow.transform.scaleX).toBeGreaterThan(1)
    // the case that wrapped in the real deck: 18 characters, wide capitals
    expect(run('Sand ASMR Coloring').font).toBeUndefined()
    // fits once the box is wider: original font size kept
    const mid = run('Screw Shot: Bolt Puzzle')
    expect(mid.font).toBeUndefined()
    expect(mid.grow.applyMode).toBe('RELATIVE')
    const k = mid.grow.transform.scaleX
    expect(k).toBeGreaterThan(1)
    // the left edge stays put: x' = k*x + (1-k)*tx maps tx to itself
    expect(mid.grow.transform.translateX).toBeCloseTo((1 - k) * c.nameTx, 0)
    // the widened box stops before the "-"
    expect(c.nameBox.x + c.nameBoxW * k).toBeLessThan(c.sepX!)
    // too long even when wider: shrink, never below 60%
    // wrapped at full size in the real deck even after widening: must shrink
    const bunny = run('Bunny Sort: Color Sort Games')
    expect(bunny.font.style.fontSize.magnitude).toBeLessThan(c.nameFontPt)
    const long = run('Ants Eat Dragons - Color Match and a very long subtitle that goes on')
    expect(long.grow).toBeDefined()
    expect(long.font!.style.fontSize.magnitude).toBeGreaterThanOrEqual(c.nameFontPt * 0.6 - 0.1)
    expect(long.font!.style.fontSize.magnitude).toBeLessThan(c.nameFontPt)
  })

  it('replaces text by insert-then-delete', () => {
    const plan = planSlides(MAP, ins(1), WEEK, ['insight'])
    const c = MAP.insight!.cards[0]
    const len = MAP.textLen[c.nameId]
    const iIns = plan.structure.findIndex(r => r.insertText?.objectId === c.nameId)
    const iDel = plan.structure.findIndex(r => r.deleteText?.objectId === c.nameId)
    expect(plan.structure[iIns].insertText!.insertionIndex).toBe(len)
    expect(iDel).toBeGreaterThan(iIns)
    expect(plan.structure[iDel].deleteText!.textRange).toEqual({ type: 'FIXED_RANGE', startIndex: 0, endIndex: len })
  })

  it('duplicates come before any fill of the copy', () => {
    const plan = planSlides(MAP, p4(3), WEEK, ['priority_iv'])
    const lastDup = plan.structure.map(r => !!r.duplicateObject).lastIndexOf(true)
    const firstFill = plan.structure.findIndex(r => r.insertText)
    expect(lastDup).toBeGreaterThanOrEqual(0)
    expect(lastDup).toBeLessThan(firstFill)
  })
})
