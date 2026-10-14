/** Set (or clear, with null) the global current batch. Resolves true on success.
 *  `startsOn` ("YYYY-MM-DD") is the day the batch starts; leave it out and a new batch
 *  starts tomorrow while one that already has a start keeps it.
 *  A network failure resolves false rather than throwing. */
export async function saveCurrentBatch(batch: string | null, startsOn?: string): Promise<boolean> {
  try {
    const res = await fetch('/api/evaluations/current-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(startsOn ? { batch, starts_on: startsOn } : { batch }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** The day the current batch starts, or null when there is none or it cannot be read. */
export async function loadCurrentBatchStart(): Promise<string | null> {
  try {
    const res = await fetch('/api/evaluations/current-batch')
    if (!res.ok) return null
    const json = await res.json()
    return typeof json.starts_on === 'string' ? json.starts_on : null
  } catch {
    return null
  }
}
