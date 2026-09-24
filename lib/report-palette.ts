// lib/report-palette.ts - the ONE palette every Performance chart draws from.
//
// PURE module (no DB, no React): the client bundle imports it.
//
// Two layers, and only the first is themeable:
//
//   1. Roles. Every metric has ONE colour on every tab: games in (arrived / received /
//      assigned), evaluated, backlog, shortlist rate, hit rate, people working. Before
//      this, "Evaluated" was amber on Overview and blue on Individual, "games in" was
//      blue on one tab and red on the other, and green meant both Backlog and
//      Shortlist rate. A role is a slot of the chosen preset, so switching presets can
//      never make two roles collide.
//   2. Fixed colours that are NOT themed, because they mean something: status
//      (good / warning / bad), the conclusion colours, the age bands, and the neutral
//      grey for reference lines (team average, link dead).
//
// Every preset below was run through the dataviz skill's validator
// (scripts/validate_palette.js, light mode, surface #ffffff) and its slot ORDER was
// chosen by searching all orders of its hues for ones that pass:
//   - all slots, adjacent pairs (stacks, bars, multi-line)
//   - slots 1-3 all-pairs: games in / evaluated / backlog share every flow chart
//   - slots 4-5 all-pairs: shortlist and hit rate share the quality chart
//   - the score-weight bar (slot 2, 6, 5, 4 in that order)
// The worst CVD Delta E of each is in `cvd` (OKLab x100; >= 8 target, 6-8 legal only
// with secondary encoding - direct labels, the dashed backlog line, gaps).

export type PaletteKey = 'standard' | 'classic' | 'cvd'

export interface PalettePreset {
  key: PaletteKey
  label: string
  note: string
  cvd: number
  slots: string[]
  // Two groups on ONE scatter (Fulltime / Freelancer). A scatter is an all-pairs form,
  // so this pair was validated all-pairs, and kept clear of the red outlier ring.
  groups: [string, string]
}

export const PALETTES: Record<PaletteKey, PalettePreset> = {
  standard: {
    key: 'standard', label: 'Standard',
    note: 'The dataviz reference hues, in the order that separates best.',
    cvd: 9.2,
    slots: ['#2a78d6', '#eb6834', '#1baf7a', '#008300', '#e87ba4', '#4a3aa7', '#eda100', '#e34948'],
    groups: ['#4a3aa7', '#1baf7a'],   // all-pairs CVD dE 31.1
  },
  classic: {
    key: 'classic', label: 'Classic',
    note: 'The colours the Report used before: blue in, amber evaluated, green backlog.',
    cvd: 6.9,
    slots: ['#2a78d6', '#eda100', '#008300', '#e87ba4', '#4a3aa7', '#e34948', '#1baf7a', '#eb6834'],
    groups: ['#4a3aa7', '#1baf7a'],   // all-pairs CVD dE 31.1
  },
  cvd: {
    key: 'cvd', label: 'Colour-blind safe',
    note: 'Okabe-Ito, the palette built for colour-blind readers. Six colours.',
    cvd: 11.4,
    slots: ['#0072b2', '#e69f00', '#009e73', '#56b4e9', '#d55e00', '#cc79a7'],
    groups: ['#0072b2', '#e69f00'],   // all-pairs CVD dE 29.2
  },
}
export const PALETTE_KEYS = Object.keys(PALETTES) as PaletteKey[]
export const DEFAULT_PALETTE: PaletteKey = 'standard'

export const parsePaletteKey = (v: unknown): PaletteKey =>
  typeof v === 'string' && (PALETTE_KEYS as string[]).includes(v) ? (v as PaletteKey) : DEFAULT_PALETTE

// Not themed - see the header.
export const NEUTRAL = '#94a3b8'   // team average, link dead, any reference line

export interface Palette {
  key: PaletteKey
  slots: string[]
  groups: [string, string]
  role: {
    intake: string       // arrived / received / assigned
    evaluated: string
    backlog: string
    shortlist: string    // shortlist rate
    hit: string          // hit rate, final priority
    people: string       // people working
    consistency: string  // the one score axis with no metric of its own elsewhere
    neutral: string
  }
}

export function resolvePalette(key: unknown): Palette {
  const p = PALETTES[parsePaletteKey(key)]
  const s = p.slots
  return {
    key: p.key,
    slots: s,
    groups: p.groups,
    role: {
      intake: s[0], evaluated: s[1], backlog: s[2], shortlist: s[3], hit: s[4],
      people: s[5], consistency: s[5], neutral: NEUTRAL,
    },
  }
}

// Names of the roles as the Config picker shows them, in slot order.
export const ROLE_LABELS: Array<[keyof Palette['role'], string]> = [
  ['intake', 'Games in'], ['evaluated', 'Evaluated'], ['backlog', 'Backlog'],
  ['shortlist', 'Shortlist rate'], ['hit', 'Hit rate'], ['people', 'People working'],
]
