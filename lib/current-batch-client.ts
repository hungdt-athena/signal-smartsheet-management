/** Set (or clear, with null) the global current batch. Resolves true on success.
 *  `startsAt` ("YYYY-MM-DDTHH:mm", Vietnam time) is the moment the batch starts; leave it out
 *  and a new batch starts now while one that already has a start keeps it.
 *  A network failure resolves false rather than throwing. */
export async function saveCurrentBatch(batch: string | null, startsAt?: string): Promise<boolean> {
  try {
    const res = await fetch('/api/evaluations/current-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(startsAt ? { batch, starts_at: startsAt } : { batch }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** The moment the current batch starts ("YYYY-MM-DDTHH:mm", Vietnam time), or null when
 *  there is none or it cannot be read. */
export async function loadCurrentBatchStart(): Promise<string | null> {
  try {
    const res = await fetch('/api/evaluations/current-batch')
    if (!res.ok) return null
    const json = await res.json()
    return typeof json.starts_at === 'string' ? json.starts_at : null
  } catch {
    return null
  }
}
