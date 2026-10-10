export type MoveResult = { ok: true; moved: number } | { ok: false; error: string }

/** Most games one move may carry. The route enforces the same number (it keeps its own
 *  private constant: a route file may export only HTTP handlers). Same as the Short List
 *  page size, so "select all shown" always fits. */
export const MAX_MOVE = 500

/** A move that has not answered by now is given up, so the dialog is never stuck. */
const MOVE_TIMEOUT_MS = 30_000

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
    // A body that does not parse must not read as a failed request: the move may well have
    // happened. It counts as 0 moved, which the caller reports as "nothing moved, reload".
    let json: { error?: unknown; moved?: unknown } = {}
    try {
      const parsed = await res.json()
      if (parsed && typeof parsed === 'object') json = parsed
    } catch { /* keep {} */ }
    if (!res.ok) return { ok: false, error: typeof json.error === 'string' ? json.error : 'Request failed' }
    const moved = typeof json.moved === 'number' && Number.isInteger(json.moved) && json.moved >= 0 ? json.moved : 0
    return { ok: true, moved }
  } catch {
    return { ok: false, error: abort.signal.aborted ? 'Timed out' : 'Network error' }
  } finally {
    clearTimeout(timer)
  }
}
