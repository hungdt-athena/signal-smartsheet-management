/** Set (or clear, with null) the global current batch. Resolves true on success.
 *  A network failure resolves false rather than throwing. */
export async function saveCurrentBatch(batch: string | null): Promise<boolean> {
  try {
    const res = await fetch('/api/evaluations/current-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch }),
    })
    return res.ok
  } catch {
    return false
  }
}
