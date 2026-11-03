// Template map + games -> the Slides batchUpdate requests that build the deck. Pure.
//
// Only the game's name (+ store link), icon, "X released by Y", the Gameplay / video link and
// the release date are filled. Every other text stays as the template wrote it, for the report
// owner to edit by hand.
//
// Copies are made with duplicateObject and explicit ids (`<id>_x<n>`, copy 0 = the template slide
// itself), so every request can be written up front without reading the deck back.

import type { slides_v1 } from 'googleapis'
import { extractYtId } from '@/lib/ytb-match'
import type { Box, TemplateMap } from './slides-template'
import type { ExportGame, ExportScope, ExportType } from './types'

type R = slides_v1.Schema$Request

export interface MediaItem { gameId: string; title: string; requests: R[] }
export interface SlidesPlan { structure: R[]; images: MediaItem[]; warnings: string[] }

export const INSIGHT_PER_SLIDE_FALLBACK = 8
export const TOP_PICKS_WARNING = 'More than 40 Top Picks: list packed as small as it goes, check it by hand'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MONTH_YEAR = new RegExp(`(${MONTHS.join('|')}) \\d{4}`)
const REPORT_TAG = /(Monthly|W\d) Report/

export function youtubeId(url: string | null): string | null {
  return extractYtId(url)
}

/** Icon scale for the Top Picks list (PJ202 R-SL4, FS 9.1): <=20 original, 21-30 75%, 31-40 60%. */
function topPicksScale(n: number, box: Box, size: number, pitch: number): { s: number; cols: number } {
  const grid = (s: number) => ({
    cols: Math.floor((box.w - size * s) / (pitch * s)) + 1,
    rows: Math.floor((box.h - size * s) / (pitch * s)) + 1,
  })
  const fixed = n <= 20 ? 1 : n <= 30 ? 0.75 : n <= 40 ? 0.6 : null
  if (fixed != null) return { s: fixed, cols: grid(fixed).cols }
  for (let s = 0.6; s > 0.05; s -= 0.01) {
    const g = grid(s)
    if (g.cols * g.rows >= n) return { s, cols: g.cols }
  }
  return { s: 0.05, cols: grid(0.05).cols }
}

const id = (src: string, copy: number) => (copy === 0 ? src : `${src}_x${copy}`)
const emu = (v: number) => ({ magnitude: Math.round(v), unit: 'EMU' })

export function planSlides(map: TemplateMap, games: ExportGame[], scope: ExportScope, types: ExportType[]): SlidesPlan {
  const insight = types.includes('insight') ? games.filter(g => g.conclusion === 'Insight') : []
  const p4 = types.includes('priority_iv') ? games.filter(g => g.conclusion === 'Priority IV') : []
  if (insight.length && !map.insight) throw new Error('The template has no Insight slide')
  if (p4.length && (!map.topPicks || !map.detail)) throw new Error('The template has no Top Picks or detail slide')

  const dups: R[] = []
  const fills: R[] = []
  const deletes: string[] = [...map.dropSlideIds]
  const images: MediaItem[] = []
  const warnings: string[] = []

  const replace = (objectId: string, src: string, text: string) => {
    const len = map.textLen[src] ?? 0
    fills.push({ insertText: { objectId, insertionIndex: len, text } })
    if (len > 0) fills.push({ deleteText: { objectId, textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: len } } })
  }
  // Set the link, or clear it: text inserted at the end inherits the run before it, so a
  // sample link in the template would otherwise stay on a game that has none.
  const link = (objectId: string, url: string | null) => {
    fills.push({ updateTextStyle: { objectId, style: url ? { link: { url } } : {}, textRange: { type: 'ALL' }, fields: 'link' } })
  }
  const duplicate = (slideId: string, ids: string[], copies: number) => {
    for (let n = 1; n < copies; n++) {
      const objectIds: Record<string, string> = { [slideId]: id(slideId, n) }
      for (const e of ids) objectIds[e] = id(e, n)
      dups.push({ duplicateObject: { objectId: slideId, objectIds } })
    }
  }
  const iconImage = (g: ExportGame, imageObjectId: string) => {
    if (g.iconUrl) images.push({ gameId: g.gameId, title: g.title, requests: [{ replaceImage: { imageObjectId, url: g.iconUrl, imageReplaceMethod: 'CENTER_CROP' } }] })
  }

  // Cover
  const month = `${MONTHS[parseInt(scope.monthKey.slice(5, 7), 10) - 1]} ${scope.monthKey.slice(0, 4)}`
  const tag = `${scope.weekTag ?? 'Monthly'} Report`
  const oldMonth = MONTH_YEAR.exec(map.coverText)?.[0]
  const oldTag = REPORT_TAG.exec(map.coverText)?.[0]
  if (oldMonth && oldTag) {
    for (const [from, to] of [[oldMonth, month], [oldTag, tag]]) {
      if (from !== to) fills.push({ replaceAllText: { containsText: { text: from, matchCase: true }, replaceText: to, pageObjectIds: [map.coverSlideId] } })
    }
  } else {
    replace(map.coverTextId, map.coverTextId, `${month}\n${tag}`)
  }

  const order: string[] = [map.coverSlideId]

  // Insight
  if (map.insight) {
    const { slideId, cards } = map.insight
    if (!insight.length) deletes.push(slideId)
    else {
      const per = cards.length || INSIGHT_PER_SLIDE_FALLBACK
      const copies = Math.ceil(insight.length / per)
      duplicate(slideId, cards.flatMap(c => [c.groupId, c.iconId, c.nameId, c.gameplayId, ...(c.releasedById ? [c.releasedById] : [])]), copies)
      for (let n = 0; n < copies; n++) {
        order.push(id(slideId, n))
        cards.forEach((c, i) => {
          const g = insight[n * per + i]
          if (!g) {
            deletes.push(id(c.groupId, n))
            if (c.releasedById) deletes.push(id(c.releasedById, n))
            return
          }
          replace(id(c.nameId, n), c.nameId, g.title)
          link(id(c.nameId, n), g.storeUrl)
          if (c.releasedById && g.publisher) {
            replace(id(c.releasedById, n), c.releasedById, `${g.title} released by ${g.publisher}`)
            link(id(c.releasedById, n), null)
          }
          link(id(c.gameplayId, n), g.youtubeUrl)
          iconImage(g, id(c.iconId, n))
        })
      }
    }
  }

  // Trending: month decks only, untouched
  if (map.trendingSlideId) {
    if (scope.kind === 'month') order.push(map.trendingSlideId)
    else deletes.push(map.trendingSlideId)
  }

  // Top Picks: always one slide
  if (map.topPicks) {
    const tp = map.topPicks
    if (!p4.length) deletes.push(tp.slideId)
    else {
      order.push(tp.slideId)
      const half = Math.ceil(p4.length / 2)
      const lines = p4.map((g, i) => `${i + 1}. ${g.title}`)
      const cols = [lines.slice(0, half), lines.slice(half)]
      const { s, cols: gridCols } = topPicksScale(p4.length, tp.iconBox, tp.iconSize, tp.iconPitch)
      tp.nameColumnIds.forEach((colId, i) => {
        if (cols[i].length) { replace(colId, colId, cols[i].join('\n')); link(colId, null) }
        else deletes.push(colId)
        fills.push({ deleteParagraphBullets: { objectId: colId, textRange: { type: 'ALL' } } })
        if (s < 1 && cols[i].length) {
          fills.push({ updateTextStyle: { objectId: colId, style: { fontSize: { magnitude: Math.round(tp.nameFontPt * s * 10) / 10, unit: 'PT' } }, textRange: { type: 'ALL' }, fields: 'fontSize' } })
        }
      })
      if (s === 1) {
        tp.iconIds.forEach((iconId, i) => {
          const g = p4[i]
          if (g) iconImage(g, iconId)
          else deletes.push(iconId)
        })
        // A delete that leaves a group with one element removes the group -- and with it the
        // icon still to fill. Ungroup first so each slot stands alone.
        if (p4.length < tp.iconIds.length && tp.iconGroupIds.length) fills.push({ ungroupObjects: { objectIds: tp.iconGroupIds } })
      } else {
        deletes.push(...tp.iconIds)
        const size = tp.iconSize * s, pitch = tp.iconPitch * s
        p4.forEach((g, i) => {
          if (!g.iconUrl) return
          images.push({
            gameId: g.gameId, title: g.title, requests: [{
              createImage: {
                objectId: `tp_icon_${i}`, url: g.iconUrl,
                elementProperties: {
                  pageObjectId: tp.slideId,
                  size: { width: emu(size), height: emu(size) },
                  transform: {
                    scaleX: 1, scaleY: 1, unit: 'EMU',
                    translateX: Math.round(tp.iconBox.x + (i % gridCols) * pitch),
                    translateY: Math.round(tp.iconBox.y + Math.floor(i / gridCols) * pitch),
                  },
                },
              },
            }],
          })
        })
      }
      if (p4.length > 40) warnings.push(TOP_PICKS_WARNING)
    }
  }

  // Detail: one 3-section slide per Priority IV game
  if (map.detail) {
    const d = map.detail
    if (!p4.length) deletes.push(d.slideId)
    else {
      duplicate(d.slideId, [d.nameId, d.iconId, d.dateId, ...(d.videoId ? [d.videoId] : [])], p4.length)
      p4.forEach((g, n) => {
        const page = id(d.slideId, n)
        order.push(page)
        replace(id(d.nameId, n), d.nameId, g.title)
        link(id(d.nameId, n), g.storeUrl)
        if (g.releaseDate) replace(id(d.dateId, n), d.dateId, g.releaseDate)
        link(id(d.dateId, n), null)
        iconImage(g, id(d.iconId, n))
        if (!d.videoId || !d.videoBox) return
        const elementProperties = {
          pageObjectId: page,
          size: { width: emu(d.videoBox.w), height: emu(d.videoBox.h) },
          transform: { scaleX: 1, scaleY: 1, translateX: Math.round(d.videoBox.x), translateY: Math.round(d.videoBox.y), unit: 'EMU' },
        }
        const vid = youtubeId(g.youtubeUrl)
        if (vid) {
          images.push({
            gameId: g.gameId, title: g.title, requests: [
              { deleteObject: { objectId: id(d.videoId, n) } },
              { createVideo: { objectId: `${d.videoId}_v${n}`, source: 'YOUTUBE', id: vid, elementProperties } },
            ],
          })
        } else {
          const ph = `${d.videoId}_ph${n}`
          fills.push({ deleteObject: { objectId: id(d.videoId, n) } })
          fills.push({ createShape: { objectId: ph, shapeType: 'ROUND_RECTANGLE', elementProperties } })
          fills.push({ insertText: { objectId: ph, insertionIndex: 0, text: 'Add recording video' } })
        }
      })
    }
  }

  const structure: R[] = [
    ...dups,
    ...fills,
    ...deletes.map(objectId => ({ deleteObject: { objectId } })),
    ...order.map((slideId, i) => ({ updateSlidesPosition: { slideObjectIds: [slideId], insertionIndex: i } })),
  ]
  return { structure, images, warnings }
}
