export type MoveResult = { ok: true; moved: number } | { ok: false; error: string }

/** Move games to another batch. Never throws: a network failure is a failed result. */
export async function moveBatch(ids: number[], batch: string): Promise<MoveResult> {
  try {
    const res = await fetch('/api/evaluations/batch-move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, batch }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: typeof json.error === 'string' ? json.error : 'Request failed' }
    return { ok: true, moved: Number(json.moved) || 0 }
  } catch {
    return { ok: false, error: 'Network error' }
  }
}
