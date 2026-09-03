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
