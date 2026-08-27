// Shared validation rules for an evaluation, enforced on both sides: the panel
// blocks Save so the evaluator sees why, the PATCH route rejects so nothing
// slips in past the UI.

/** A written evaluation note must be at least this long. */
export const NOTE_MIN_LEN = 10

/** Conclusions with nothing to write about — the note rule does not apply. */
const NOTE_EXEMPT_CONCLUSIONS = ['Link_dead']

/**
 * The note rule has exactly one trigger: someone *writes* the note. Reopening an
 * already-evaluated game never blocks Save on its own — not even a first-time
 * evaluation, and not a legacy row whose stored note is empty or too short. Only
 * once the text in the field differs from what is stored does it have to clear
 * NOTE_MIN_LEN. ~28% of historical rows carry a shorter note than that, and
 * nobody should be forced to author a missing note to save an unrelated field.
 */
export function noteRequirementError(o: {
  /** The note as it will be stored. */
  note: string | null | undefined
  /** The note currently stored on the row. */
  prevNote: string | null | undefined
  /** Initial conclusion as it will be stored. */
  conclusion: string | null | undefined
}): string | null {
  if (o.conclusion && NOTE_EXEMPT_CONCLUSIONS.includes(o.conclusion)) return null
  const note = (o.note ?? '').trim()
  if (note === (o.prevNote ?? '').trim()) return null   // untouched → never blocks
  if (note.length >= NOTE_MIN_LEN) return null
  return `Initial Note is required (at least ${NOTE_MIN_LEN} characters)`
}
