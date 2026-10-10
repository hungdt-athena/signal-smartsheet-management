// lib/view-timer.ts — how long a game has been on screen in the Eval panel, for
// evaluation_log.view_s (spec: docs/superpowers/specs/2026-10-10-evaluation-time-log-design.md).
//
// Pure and immutable so it can be tested without a DOM. All durations come from
// timestamp differences, never from interval counting, so background-tab timer
// throttling does not matter. Hidden and idle are recorded, not subtracted: play on
// a phone leaves the panel idle, and input inside an iframe (YouTube demo) never
// reaches the document.

export const IDLE_GAP_MS = 120_000

export interface ViewTimer {
  gameId: string
  startedAt: number
  hiddenMs: number
  hiddenSince: number | null
  idleMs: number
  lastInputAt: number
}

export interface ViewSnapshot { gameId: string; at: number; view_s: number; hidden_s: number; idle_s: number }

export function startView(gameId: string, at: number, hidden: boolean): ViewTimer {
  return { gameId, startedAt: at, hiddenMs: 0, hiddenSince: hidden ? at : null, idleMs: 0, lastInputAt: at }
}

export function onVisibility(t: ViewTimer, hidden: boolean, at: number): ViewTimer {
  if (hidden) return t.hiddenSince === null ? { ...t, hiddenSince: at } : t
  if (t.hiddenSince === null) return t
  return { ...t, hiddenMs: t.hiddenMs + Math.max(0, at - Math.max(t.hiddenSince, t.startedAt)), hiddenSince: null }
}

export function onInput(t: ViewTimer, at: number): ViewTimer {
  const gap = at - Math.max(t.lastInputAt, t.startedAt)
  return { ...t, idleMs: gap > IDLE_GAP_MS ? t.idleMs + gap : t.idleMs, lastInputAt: at }
}

/** Null when the timer belongs to another game (the panel still shows a stale `ev`). */
export function snapshot(t: ViewTimer, gameId: string, at: number): ViewSnapshot | null {
  if (t.gameId !== gameId) return null
  const viewMs = Math.max(0, at - t.startedAt)
  const openHidden = t.hiddenSince === null ? 0 : Math.max(0, at - Math.max(t.hiddenSince, t.startedAt))
  const trailing = at - Math.max(t.lastInputAt, t.startedAt)
  const idleMs = t.idleMs + (trailing > IDLE_GAP_MS ? trailing : 0)
  const sec = (ms: number) => Math.round(Math.min(ms, viewMs) / 1000)
  return { gameId, at, view_s: Math.round(viewMs / 1000), hidden_s: sec(t.hiddenMs + openHidden), idle_s: sec(idleMs) }
}

/** After a successful save: start the next interval where the saved one ended, same game only. */
export function restartAfterSave(t: ViewTimer, snap: ViewSnapshot, hidden: boolean): ViewTimer {
  // Same game AND same interval; a timer restarted after the snapshot (A -> B -> A) is newer, keep it.
  return t.gameId === snap.gameId && t.startedAt <= snap.at ? startView(snap.gameId, snap.at, hidden) : t
}
