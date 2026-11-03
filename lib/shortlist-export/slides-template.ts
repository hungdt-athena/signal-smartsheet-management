// Find the slots of the Master Template by reading the deck itself. Pure.
//
// No object id is written down anywhere: the exporter copies the template, reads the copy and
// locates every slot by its sample text ("The game name", "TOP PICKS!", "Core Gameplay"...),
// so a template edit that keeps the sample text keeps the export working.

import type { slides_v1 } from 'googleapis'

type El = slides_v1.Schema$PageElement
type Slide = slides_v1.Schema$Page

/** In EMU, page coordinates. */
export type Box = { x: number; y: number; w: number; h: number }

export interface InsightCard { groupId: string; box: Box; iconId: string; nameId: string; nameBoxW: number; nameFontPt: number; gameplayId: string; releasedById: string | null }

export interface TemplateMap {
  coverSlideId: string
  coverTextId: string
  /** The cover text as written in the template ("December 2026 Monthly Report"). */
  coverText: string
  /** Length of every shape's text without its final newline: where an insert at the end goes. */
  textLen: Record<string, number>
  insight: { slideId: string; cards: InsightCard[] } | null
  trendingSlideId: string | null
  topPicks: { slideId: string; iconIds: string[]; iconGroupIds: string[]; iconBox: Box; iconSize: number; iconPitch: number; nameColumnIds: [string, string]; nameFontPt: number; nameBoxH: number } | null
  detail: { slideId: string; nameId: string; iconId: string; dateId: string; videoId: string | null; videoBox: Box | null } | null
  dropSlideIds: string[]
}

const PT = 12700
const DATE = /^\d{4}-\d{2}-\d{2}$/

interface Flat { el: El; id: string; box: Box | null; depth: number; top: El; text: string }

type M = [number, number, number, number, number, number] // a b c d tx ty (x' = a x + c y + tx)
const ID: M = [1, 0, 0, 1, 0, 0]
function mat(t: slides_v1.Schema$AffineTransform | undefined): M {
  if (!t) return ID
  return [t.scaleX ?? 1, t.shearY ?? 0, t.shearX ?? 0, t.scaleY ?? 1, t.translateX ?? 0, t.translateY ?? 0]
}
function mul(p: M, c: M): M {
  return [
    p[0] * c[0] + p[2] * c[1], p[1] * c[0] + p[3] * c[1],
    p[0] * c[2] + p[2] * c[3], p[1] * c[2] + p[3] * c[3],
    p[0] * c[4] + p[2] * c[5] + p[4], p[1] * c[4] + p[3] * c[5] + p[5],
  ]
}

function rawText(el: El): string {
  return (el.shape?.text?.textElements ?? []).map(t => t.textRun?.content ?? '').join('')
}
export function textOf(el: El): string {
  return rawText(el).trim()
}

function flatten(els: El[] | undefined, parent: M, depth: number, top: El | null, out: Flat[]) {
  for (const el of els ?? []) {
    const m = mul(parent, mat(el.transform ?? undefined))
    const w = el.size?.width?.magnitude, h = el.size?.height?.magnitude
    const box = w != null && h != null ? { x: m[4], y: m[5], w: w * m[0], h: h * m[3] } : null
    out.push({ el, id: el.objectId!, box, depth, top: top ?? el, text: textOf(el) })
    if (el.elementGroup) flatten(el.elementGroup.children ?? undefined, m, depth + 1, top ?? el, out)
  }
}

function flat(slide: Slide): Flat[] {
  const out: Flat[] = []
  flatten(slide.pageElements ?? undefined, ID, 0, null, out)
  return out
}

function union(boxes: (Box | null)[]): Box {
  const bs = boxes.filter((b): b is Box => !!b)
  const x = Math.min(...bs.map(b => b.x)), y = Math.min(...bs.map(b => b.y))
  return { x, y, w: Math.max(...bs.map(b => b.x + b.w)) - x, h: Math.max(...bs.map(b => b.y + b.h)) - y }
}

/** Row-major: top to bottom, then left to right; boxes within 5pt vertically share a row. */
function rowMajor(a: Box, b: Box): number {
  return Math.abs(a.y - b.y) > 5 * PT ? a.y - b.y : a.x - b.x
}

const hasText = (f: Flat[], t: string) => f.some(e => e.text === t)

function readInsight(slide: Slide, f: Flat[]): TemplateMap['insight'] {
  const groups = f.filter(e => e.depth === 0 && e.el.elementGroup)
  const cards: InsightCard[] = []
  for (const g of groups) {
    const kids = f.filter(e => e.top === g.el && e.depth > 0)
    const name = kids.find(e => e.text === 'The game name')
    const gameplay = kids.find(e => e.text === 'Gameplay')
    const icon = kids.find(e => e.el.image)
    if (!name || !gameplay || !icon) continue
    cards.push({
      groupId: g.id, box: union(kids.map(k => k.box)), iconId: icon.id, nameId: name.id,
      nameBoxW: name.box?.w ?? 0, nameFontPt: fontOf(name.el),
      gameplayId: gameplay.id, releasedById: null,
    })
  }
  cards.sort((a, b) => rowMajor(a.box, b.box))
  const lines = f.filter(e => e.depth === 0 && e.box && e.text.includes('released by'))
  const used = new Set<string>()
  for (const c of cards) {
    const bottom = c.box.y + c.box.h - 2 * PT
    const below = lines
      .filter(l => !used.has(l.id))
      .filter(l => { const cx = l.box!.x + l.box!.w / 2; return cx >= c.box.x && cx <= c.box.x + c.box.w && l.box!.y >= bottom })
      .sort((a, b) => a.box!.y - b.box!.y)[0]
    if (below) { c.releasedById = below.id; used.add(below.id) }
  }
  return { slideId: slide.objectId!, cards }
}

function fontOf(el: El): number {
  return el.shape?.text?.textElements?.find(t => t.textRun)?.textRun?.style?.fontSize?.magnitude ?? 14
}

function readTopPicks(slide: Slide, f: Flat[]): TemplateMap['topPicks'] {
  const icons = f.filter(e => e.depth > 0 && e.el.image && e.box).sort((a, b) => rowMajor(a.box!, b.box!))
  const cols = f.filter(e => e.el.shape && e.box && e.text.startsWith('Game')).sort((a, b) => a.box!.x - b.box!.x)
  if (!icons.length || cols.length < 2) return null
  return {
    slideId: slide.objectId!,
    iconIds: icons.map(i => i.id),
    iconGroupIds: Array.from(new Set(icons.filter(i => i.top !== i.el).map(i => i.top.objectId!))),
    iconBox: union(icons.map(i => i.box)),
    iconSize: icons[0].box!.w,
    iconPitch: icons.length > 1 && Math.abs(icons[1].box!.y - icons[0].box!.y) <= 5 * PT ? icons[1].box!.x - icons[0].box!.x : icons[0].box!.w * 1.25,
    nameColumnIds: [cols[0].id, cols[1].id],
    nameFontPt: fontOf(cols[0].el),
    nameBoxH: cols[0].box!.h,
  }
}

function readDetail(slide: Slide, f: Flat[]): TemplateMap['detail'] {
  const name = f.filter(e => e.depth === 0 && e.text === 'Game Name' && e.box).sort((a, b) => a.box!.y - b.box!.y)[0]
  const date = f.find(e => DATE.test(e.text))
  if (!name || !date) return null
  const nb = name.box!
  const icon = f.find(e => e.depth === 0 && e.el.image && e.box
    && Math.abs(e.box.x + e.box.w - nb.x) <= 0.1 * nb.w
    && e.box.y < nb.y + nb.h && e.box.y + e.box.h > nb.y)
  if (!icon) return null
  const video = f.find(e => e.el.video)
  return { slideId: slide.objectId!, nameId: name.id, iconId: icon.id, dateId: date.id, videoId: video?.id ?? null, videoBox: video?.box ?? null }
}

export function readTemplate(p: slides_v1.Schema$Presentation): TemplateMap {
  const slides = p.slides ?? []
  if (!slides.length) throw new Error('Template has no slides')
  const cover = slides[0]
  const coverText = flat(cover).find(e => e.el.shape && e.text)
  if (!coverText) throw new Error('Template cover has no text box')

  const textLen: Record<string, number> = {}
  for (const s of slides) for (const e of flat(s)) {
    if (!e.el.shape?.text) continue
    const raw = rawText(e.el)
    textLen[e.id] = raw.endsWith('\n') ? raw.length - 1 : raw.length
  }
  const map: TemplateMap = {
    coverSlideId: cover.objectId!, coverTextId: coverText.id, coverText: coverText.text, textLen,
    insight: null, trendingSlideId: null, topPicks: null, detail: null, dropSlideIds: [],
  }
  for (const s of slides.slice(1)) {
    const f = flat(s)
    const plus = f.filter(e => e.depth === 0 && e.text === '+').length
    let used = false
    if (!map.insight && hasText(f, 'Insight')) { map.insight = readInsight(s, f); used = !!map.insight?.cards.length }
    else if (!map.trendingSlideId && hasText(f, 'Trending!')) { map.trendingSlideId = s.objectId!; used = true }
    else if (!map.topPicks && hasText(f, 'TOP PICKS!')) { map.topPicks = readTopPicks(s, f); used = !!map.topPicks }
    else if (!map.detail && hasText(f, 'Core Gameplay') && !hasText(f, 'NEW GAMEPLAY') && plus === 2) { map.detail = readDetail(s, f); used = !!map.detail }
    if (!used) map.dropSlideIds.push(s.objectId!)
  }
  if (map.insight && !map.insight.cards.length) map.insight = null
  return map
}
