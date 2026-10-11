// A tiny registry of "unsaved work" guards. Editors (e.g. the eval detail panel)
// register a guard describing whether they currently hold unsaved changes and how
// to flush them. The deploy-update watcher consults this before reloading so a
// version refresh — and the browser's own close/refresh — never silently discards
// work in progress. Module-level singleton (shared across the client bundle).

export interface UnsavedGuard {
  /** True while this editor holds changes not yet persisted to the server. */
  isDirty: () => boolean
  /** Persist the pending changes. Resolves once the save has completed. */
  flush: () => Promise<unknown>
  /** Optional: ask the user before leaving, then call `proceed` if they go ahead. Used
   *  by whatever closes the editor from outside (a click on the backdrop). */
  requestLeave?: (proceed: () => void) => void
}

const guards = new Set<UnsavedGuard>()

/** Register a guard; returns an unregister fn (call from a useEffect cleanup). */
export function registerUnsavedGuard(guard: UnsavedGuard): () => void {
  guards.add(guard)
  return () => { guards.delete(guard) }
}

/** True if any registered editor reports unsaved changes. */
export function hasUnsavedWork(): boolean {
  let dirty = false
  guards.forEach(g => {
    try { if (g.isDirty()) dirty = true } catch { /* a faulty guard must not block */ }
  })
  return dirty
}

/** Flush every dirty guard, waiting for all saves to settle. */
export async function flushUnsavedWork(): Promise<void> {
  const pending: Promise<unknown>[] = []
  guards.forEach(g => {
    try { if (g.isDirty()) pending.push(Promise.resolve(g.flush())) } catch { /* a faulty guard must not block */ }
  })
  await Promise.all(pending)
}

/** Run `proceed` (e.g. close the panel) — but if an editor holds unsaved changes and can
 *  ask about them, let it ask first. With nothing unsaved it just runs. */
export function requestLeaveUnsaved(proceed: () => void): void {
  let asked = false
  guards.forEach(g => {
    if (asked) return
    try {
      if (g.isDirty() && g.requestLeave) { g.requestLeave(proceed); asked = true }
    } catch { /* a faulty guard must not block */ }
  })
  if (!asked) proceed()
}
