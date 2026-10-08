/** Save (or clear, with null) one evaluation's demo video link. Resolves true on success.
 *  Shared by the Short List's inline cell and the missing-demo prompt so both hit the same
 *  PATCH the same way. A network failure resolves false rather than throwing. */
export async function saveDriveLink(id: number, value: string | null): Promise<boolean> {
  try {
    const res = await fetch('/api/evaluations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, drive_link: value }),
    })
    return res.ok
  } catch {
    return false
  }
}
