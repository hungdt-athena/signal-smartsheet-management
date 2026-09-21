// components/AssignSetup.tsx — the single-page Assign tab: the Initial roster
// beside the pipeline panel (push targets + next-run preview), with the Final
// roster below. One roster row is one person; their genres are pills.
// Rendering is delegated to RosterTable, leaving fetch and the writes.
'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { GenreToggles } from '@/components/GenreToggles'
import { PushPreview } from '@/components/PushPreview'
import { RosterTable } from '@/components/RosterTable'
import { useCategoryMappings } from '@/hooks/useCategoryMappings'
import { groupRosterByPerson, type RosterRow } from '@/lib/assign-roster'
import type { Bucket } from '@/lib/buckets'
import type { GenreTarget } from '@/lib/genre-config'
import { isPushPreview, type PushPreview as Preview } from '@/lib/push-preview'

type ListType = 'initial' | 'final'

export function AssignSetup({ isEvaluator = false, userName = '', onRosterNames }: {
  isEvaluator?: boolean
  userName?: string
  onRosterNames?: (names: string[]) => void
}) {
  const { data: subGenres } = useCategoryMappings()
  const [initial, setInitial] = useState<RosterRow[]>([])
  const [final, setFinal] = useState<RosterRow[]>([])
  const [genres, setGenres] = useState<GenreTarget[]>([])
  const [canEditGenres, setCanEditGenres] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  // Starts true so the first paint reads "Working it out…" rather than
  // "Not available." — the panel has not failed, it has not been asked yet.
  const [previewing, setPreviewing] = useState(!isEvaluator)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The preview is fetched on its own, NOT alongside the roster. Counting
  // eligible games is a ~9s scan of game_info (see the route's COST note), and
  // putting it in the roster's Promise.all made every weight click appear to
  // hang for that long. It is also the least important thing on the screen, so
  // it is allowed to arrive late and to fail quietly.
  //
  // `fresh` skips the route's one-minute cache; the Refresh button sets it, a
  // roster edit does not.
  const refreshPreview = useCallback(async (fresh = false) => {
    if (isEvaluator) return
    setPreviewing(true)
    try {
      const res = await fetch(`/api/assign-setup/preview${fresh ? '?fresh=1' : ''}`, { cache: 'no-store' })
      if (!res.ok) return
      const p = await res.json()
      // A failed or unreadable preview leaves the last good numbers on screen
      // rather than blanking the panel. The shape is checked because the panel
      // must never be what takes the tab down.
      if (isPushPreview(p)) setPreview(p)
    } catch { /* keep the last good numbers */ }
    finally { setPreviewing(false) }
  }, [isEvaluator])

  // Roster and genre state are fetched together: availability is half of what a
  // genre row says, so showing one without the other would misreport the
  // pipeline. The preview follows separately, for the reason above.
  const refresh = useCallback(async (fresh = false) => {
    setLoading(true); setError(null)
    try {
      const [rosterRes, genreRes] = await Promise.all([
        fetch('/api/assign-setup', { cache: 'no-store' }),
        fetch('/api/genre-config', { cache: 'no-store' }),
      ])
      if (!rosterRes.ok) throw new Error()
      const json = await rosterRes.json()
      setInitial(json.initial ?? []); setFinal(json.final ?? [])
      if (genreRes.ok) {
        const g = await genreRes.json()
        setGenres(g.genres ?? []); setCanEditGenres(g.canEdit === true)
      }
    } catch { setError('Failed to load roster.') }
    finally { setLoading(false) }
    refreshPreview(fresh)
  }, [refreshPreview])

  useEffect(() => { refresh() }, [refresh])

  // Initial-list names, so the history matrix knows who is on the roster: a
  // person with no history still needs a row, which is the point of looking.
  useEffect(() => {
    onRosterNames?.(Array.from(new Set(initial.map(r => r.name))))
  }, [initial, onRosterNames])

  // An evaluator only sees their own Initial rows (the server filters too).
  const initialGroups = useMemo(() => groupRosterByPerson(
    isEvaluator ? initial.filter(r => r.name.toLowerCase() === userName.toLowerCase()) : initial,
  ), [isEvaluator, initial, userName])
  const finalGroups = useMemo(() => groupRosterByPerson(final), [final])

  const send = useCallback(async (method: string, body: unknown, msg: string) => {
    const res = await fetch('/api/assign-setup', {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    if (res.ok) refresh(); else setError(msg)
  }, [refresh])

  // Sub-genre and weight both vary by genre, so they are written by row id.
  const patchRow = (id: number, field: string, value: unknown) =>
    send('PATCH', { id, field, value }, 'Update failed.')
  const patchAvailable = (list_type: ListType) => (name: string, value: boolean) =>
    send('PATCH', { field: 'today_available', list_type, name, value }, 'Update failed.')
  // Platform is person-level, so it goes by name like availability — one write
  // covers every genre that person holds.
  const patchPerson = (list_type: ListType) => (name: string, field: string, value: unknown) =>
    send('PATCH', { field, list_type, name, value }, 'Update failed.')
  const removeRow = (id: number) => send('DELETE', { id }, 'Delete failed.')
  // The reply carries the recomputed genre list, so the chips update without a
  // second round trip -- and without the UI deciding for itself what `active` means.
  const toggleGenre = useCallback(async (bucket: Bucket, enabled: boolean) => {
    const res = await fetch('/api/genre-config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket, enabled }),
    })
    if (res.ok) { const json = await res.json(); setGenres(json.genres ?? []) }
    else setError('Could not change that genre.')
  }, [])
  const addGenre = (list_type: ListType) => (name: string, g: Bucket) =>
    send('POST', { list_type, name, category_groups: [g] }, 'Add failed.')
  const addEvaluator = (list_type: ListType) => (p: { name: string; provision: boolean; genres: Bucket[] }) =>
    send('POST', { list_type, name: p.name, provision: p.provision, category_groups: p.genres }, 'Add failed.')

  return (
    <div className="assign-setup">
      <div className="roster-head">
        <span className="card-label">Roster</span>
        <button className="btn btn-sm" onClick={() => refresh(true)} disabled={loading}>
          <span className={loading ? 'spin' : ''}>↻</span>{loading ? '...' : 'Refresh'}
        </button>
      </div>

      {error && <p className="msg-err">{error}</p>}

      {/* The Initial roster and the pipeline panel sit side by side because
          they are two halves of one question: who is taking games today, and
          what that produces. The genre column leaves slack on the right at any
          realistic roster width, so the panel costs no space the table wanted.
          Below 1280px they stack instead. */}
      <div className="assign-grid">
        <RosterTable title="Initial Evaluator" groups={initialGroups} subGenres={subGenres}
          readOnly={isEvaluator}
          onPatchRow={patchRow} onPatchAvailable={patchAvailable('initial')} onPatchPerson={patchPerson('initial')}
          onRemoveRow={removeRow}
          onAddGenre={addGenre('initial')} onAddEvaluator={addEvaluator('initial')} />

        <aside className="assign-side">
          {genres.length > 0 && (
            <GenreToggles genres={genres} canEdit={canEditGenres && !isEvaluator} onToggle={toggleGenre} />
          )}
          {/* canEdit on /api/genre-config is the admin test, and running the
              pipeline by hand is admin-only for the same reason. */}
          {!isEvaluator && (
            <PushPreview preview={preview} loading={previewing}
              canRun={canEditGenres} onRan={() => refresh(true)} />
          )}
        </aside>
      </div>

      {!isEvaluator && (
        <RosterTable title="Final Evaluator" groups={finalGroups} subGenres={subGenres}
          onPatchRow={patchRow} onPatchAvailable={patchAvailable('final')} onPatchPerson={patchPerson('final')}
          onRemoveRow={removeRow}
          onAddGenre={addGenre('final')} onAddEvaluator={addEvaluator('final')} />
      )}
    </div>
  )
}
