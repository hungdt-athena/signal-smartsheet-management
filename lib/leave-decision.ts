// lib/leave-decision.ts — what the eval panel does when the user tries to leave the game
// on screen (Next, Prev, the game picker, ✕, Esc, a click outside) while it may hold
// edits that were never saved.

export type LeaveAction = 'next' | 'prev' | 'jump' | 'close'
export type LeaveDecision = 'go' | 'save-then-go' | 'ask'

/**
 * - nothing unsaved            → go
 * - unsaved, auto-save is on   → save first, go only if that worked (no popup: the user
 *                                already chose "save for me"; the 1.5s timer would be
 *                                cleared by the move and the edit lost)
 * - unsaved, auto-save is off  → ask
 * - a save is already running  → go: it persists what was typed, and the panel already
 *                                keeps a save in flight correct across a move
 */
export function leaveDecision(s: { dirty: boolean; autoSave: boolean; saving: boolean }): LeaveDecision {
  if (!s.dirty || s.saving) return 'go'
  return s.autoSave ? 'save-then-go' : 'ask'
}

/** The verb that finishes each button's label: "Save & next", "Discard & close". */
export const LEAVE_WORD: Record<LeaveAction, string> = {
  next: 'next',
  prev: 'previous',
  jump: 'open',
  close: 'close',
}
