/** `moved` is null when the server answered 2xx but the count could not be read: the UPDATE
 *  committed, only the number is unknown. */
export type MoveResult = { ok: true; moved: number | null } | { ok: false; error: string }

/** Most games one move may carry. The route enforces the same number (it keeps its own
 *  private constant: a route file may export only HTTP handlers). Same as the Short List
 *  page size, so "select all shown" always fits. */
export const MAX_MOVE = 500

/** A move that has not answered by now is given up, so the dialog is never stuck. */
const MOVE_TIMEOUT_MS = 30_000

const MSG_TIMED_OUT = 'Timed out. The move may have gone through. Reload the list to check.'

/** Move games to another batch. Never throws: a network failure or timeout is a failed result. */
export async function moveBatch(ids: number[], batch: string): Promise<MoveResult> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), MOVE_TIMEOUT_MS)
  try {
    const res = await fetch('/api/evaluations/batch-move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, batch }),
      signal: abort.signal,
    })
    // Read once, tolerating a bad body: on a 2xx the move has already happened, so an unreadable
    // body (or one cut short by the timer) is an unknown count, never "nothing moved".
    let json: { error?: unknown; moved?: unknown } | null = null
    try {
      const parsed = await res.json()
      if (parsed && typeof parsed === 'object') json = parsed
    } catch { /* json stays null */ }
    if (!res.ok) return { ok: false, error: typeof json?.error === 'string' ? json.error : 'Request failed' }
    if (!json) return { ok: true, moved: null }
    const moved = typeof json.moved === 'number' && Number.isInteger(json.moved) && json.moved >= 0 ? json.moved : 0
    return { ok: true, moved }
  } catch {
    return { ok: false, error: abort.signal.aborted ? MSG_TIMED_OUT : 'Network error' }
  } finally {
    clearTimeout(timer)
  }
}
