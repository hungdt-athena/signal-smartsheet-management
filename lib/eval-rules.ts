// Shared validation rules for an evaluation, enforced on both sides: the panel
// blocks Save so the evaluator sees why, the PATCH route rejects so nothing
// slips in past the UI.

/** A written evaluation note must be at least this long. */
export const NOTE_MIN_LEN = 10

/** Conclusions with nothing to write about — the note rule does not apply. */
const NOTE_EXEMPT_CONCLUSIONS = ['Link_dead']

/**
 * An evaluation does not save without a real note. The rule applies to every
 * save, not only to the keystroke that writes the note: reopening a game whose
 * stored note is empty or shorter than NOTE_MIN_LEN blocks Save until a note is
 * written, and a first-time evaluation cannot be saved noteless either. Roughly
 * 28% of historical rows carry a shorter note than this, so an evaluator who
 * reopens one of them to edit another field has to fill the note in first.
 * Link_dead is exempt — there is nothing to write about.
 */
export function noteRequirementError(o: {
  /** The note as it will be stored. */
  note: string | null | undefined
  /** Initial conclusion as it will be stored. */
  conclusion: string | null | undefined
}): string | null {
  if (o.conclusion && NOTE_EXEMPT_CONCLUSIONS.includes(o.conclusion)) return null
  if ((o.note ?? '').trim().length >= NOTE_MIN_LEN) return null
  return `Initial Note is required (at least ${NOTE_MIN_LEN} characters)`
}

/**
 * The initial note is written as four parts. Self Note is the evaluator's own
 * comment; Gameplay and the two end conditions are required on List_Idea games
 * and feed the Top Pick core gameplay of the weekly report (PJ202, R-SL5:
 * "... game over; level complete").
 * Each part has its own column; `initial_note` keeps the joined text so every
 * reader of the single note (lists, Report, Effort Tracker, Record) is unchanged.
 */
export interface NoteParts {
  gameplay: string
  game_over: string
  level_complete: string
  self_note: string
}

export const EMPTY_NOTE_PARTS: NoteParts = { gameplay: '', game_over: '', level_complete: '', self_note: '' }

/** Line prefix of each part inside the joined `initial_note`. */
const PART_PREFIX: [keyof NoteParts, string][] = [
  ['self_note', 'Note'],
  ['gameplay', 'Gameplay'],
  ['game_over', 'Game over'],
  ['level_complete', 'Level complete'],
]

/**
 * The single-text note stored in `initial_note`. A note that is only a Self
 * Note is stored as-is, so an old note re-saved through the new form reads the
 * same as before; otherwise one prefixed line per filled part.
 */
export function composeInitialNote(p: NoteParts): string | null {
  const filled = PART_PREFIX.filter(([k]) => p[k].trim())
  if (filled.length === 0) return null
  if (filled.length === 1 && filled[0][0] === 'self_note') return p.self_note.trim()
  return filled.map(([k, label]) => `${label}: ${p[k].trim()}`).join('\n')
}

/** The stored note columns, as the GET routes return them. */
export interface NoteColumns {
  initial_note: string | null
  initial_gameplay?: string | null
  initial_game_over?: string | null
  initial_level_complete?: string | null
  initial_self_note?: string | null
}

/**
 * Parts to load into the form. A game noted before the split has only
 * `initial_note`; that text goes into Self Note untouched rather than being
 * guessed apart.
 */
export function notePartsFromRow(r: NoteColumns): NoteParts {
  const parts: NoteParts = {
    gameplay: r.initial_gameplay || '',
    game_over: r.initial_game_over || '',
    level_complete: r.initial_level_complete || '',
    self_note: r.initial_self_note || '',
  }
  if (!Object.values(parts).some(v => v.trim()) && r.initial_note) parts.self_note = r.initial_note
  return parts
}

/**
 * A List_Idea game noted before the split: stored as List_Idea, with a note but
 * no Gameplay. It keeps the old rule (the note as a whole), so reopening it does
 * not force the three gameplay parts for a game played weeks ago. Only the
 * stored conclusion counts: a game switched to List_Idea now is not legacy.
 */
export function isLegacyNote(r: {
  initial_note: string | null
  initial_gameplay?: string | null
  initial_conclusion?: string | null
}): boolean {
  return r.initial_conclusion === 'List_Idea' && !!r.initial_note?.trim() && !r.initial_gameplay?.trim()
}

/** Field names, as the panel labels them, for the error message. */
const PART_LABEL: Record<keyof NoteParts, string> = {
  gameplay: 'Gameplay',
  game_over: 'The game is over when',
  level_complete: 'The level is complete when',
  self_note: 'Self Note',
}

/**
 * Which parts still block Save. A List_Idea game goes into the weekly report,
 * so it needs Gameplay (at least NOTE_MIN_LEN) and both end conditions; its
 * Self Note is optional. Any other conclusion needs only a Self Note of at
 * least NOTE_MIN_LEN. A legacy List_Idea note needs the whole note to reach
 * NOTE_MIN_LEN, as before. Link_dead is exempt.
 */
export function missingNoteParts(o: {
  parts: NoteParts
  conclusion: string | null | undefined
  legacy: boolean
}): (keyof NoteParts)[] {
  if (o.conclusion && NOTE_EXEMPT_CONCLUSIONS.includes(o.conclusion)) return []
  const len = (k: keyof NoteParts) => o.parts[k].trim().length
  if (o.conclusion !== 'List_Idea') return len('self_note') >= NOTE_MIN_LEN ? [] : ['self_note']
  if (o.legacy) {
    const whole = Object.values(o.parts).map(v => v.trim()).filter(Boolean).join(' ')
    return whole.length >= NOTE_MIN_LEN ? [] : ['self_note']
  }
  const missing: (keyof NoteParts)[] = []
  if (len('gameplay') < NOTE_MIN_LEN) missing.push('gameplay')
  if (!len('game_over')) missing.push('game_over')
  if (!len('level_complete')) missing.push('level_complete')
  return missing
}

/** The note rule for the four-part form, as one message; null when Save may go ahead. */
export function notePartsRequirementError(o: {
  parts: NoteParts
  conclusion: string | null | undefined
  legacy: boolean
}): string | null {
  const missing = missingNoteParts(o)
  if (missing.length === 0) return null
  const needsLen = missing.filter(k => k === 'gameplay' || k === 'self_note')
  return `Required: ${missing.map(k => PART_LABEL[k]).join(', ')}`
    + (needsLen.length ? ` (${needsLen.map(k => PART_LABEL[k]).join(', ')} at least ${NOTE_MIN_LEN} characters)` : '')
}

/** A request body's `initial_note_parts`, coerced; null when it is not an object. */
export function parseNoteParts(v: unknown): NoteParts | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const s = (x: unknown) => (typeof x === 'string' ? x : '')
  return { gameplay: s(o.gameplay), game_over: s(o.game_over), level_complete: s(o.level_complete), self_note: s(o.self_note) }
}
