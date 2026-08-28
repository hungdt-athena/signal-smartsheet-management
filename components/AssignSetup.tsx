// components/AssignSetup.tsx — the single-page roster: one row is one
// (person, genre) pair. No bucket prop; genre is a view filter passed down by the
// page. Rendering is delegated to RosterTable, leaving fetch and four writes.
'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RosterTable } from '@/components/RosterTable'
import { useCategoryMappings } from '@/hooks/useCategoryMappings'
import { groupRosterByPerson, type RosterRow } from '@/lib/assign-roster'
import type { Bucket } from '@/lib/buckets'

type ListType = 'initial' | 'final'

export function AssignSetup({ isEvaluator = false, userName = '', onRosterNames }: {
  isEvaluator?: boolean
  userName?: string
  onRosterNames?: (names: string[]) => void
}) {
  const { data: subGenres } = useCategoryMappings()
  const [initial, setInitial] = useState<RosterRow[]>([])
  const [final, setFinal] = useState<RosterRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/assign-setup', { cache: 'no-store' })
      if (!res.ok) throw new Error()
      const json = await res.json()
      setInitial(json.initial ?? []); setFinal(json.final ?? [])
    } catch { setError('Failed to load roster.') }
    finally { setLoading(false) }
  }, [])

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

  const patchRow = (id: number, field: string, value: unknown) =>
    send('PATCH', { id, field, value }, 'Update failed.')
  const patchAvailable = (list_type: ListType) => (name: string, value: boolean) =>
    send('PATCH', { field: 'today_available', list_type, name, value }, 'Update failed.')
  // Platform and weight are person-level too, so they go by name like
  // availability — one write covers every genre that person holds.
  const patchPerson = (list_type: ListType) => (name: string, field: string, value: unknown) =>
    send('PATCH', { field, list_type, name, value }, 'Update failed.')
  const removeRow = (id: number) => send('DELETE', { id }, 'Delete failed.')
  const addGenre = (list_type: ListType) => (name: string, g: Bucket) =>
    send('POST', { list_type, name, category_groups: [g] }, 'Add failed.')
  const addEvaluator = (list_type: ListType) => (p: { name: string; provision: boolean; genres: Bucket[] }) =>
    send('POST', { list_type, name: p.name, provision: p.provision, category_groups: p.genres }, 'Add failed.')

  return (
    <div className="assign-setup">
      <div className="roster-head">
        <span className="card-label">Roster</span>
        <button className="btn btn-sm" onClick={refresh} disabled={loading}>
          <span className={loading ? 'spin' : ''}>↻</span>{loading ? '...' : 'Refresh'}
        </button>
      </div>

      {error && <p className="msg-err">{error}</p>}

      <RosterTable title="Initial Evaluator" groups={initialGroups} subGenres={subGenres} scroll
        readOnly={isEvaluator}
        onPatchRow={patchRow} onPatchAvailable={patchAvailable('initial')} onPatchPerson={patchPerson('initial')}
        onRemoveRow={removeRow}
        onAddGenre={addGenre('initial')} onAddEvaluator={addEvaluator('initial')} />
      {!isEvaluator && (
        <RosterTable title="Final Evaluator" groups={finalGroups} subGenres={subGenres}
          onPatchRow={patchRow} onPatchAvailable={patchAvailable('final')} onPatchPerson={patchPerson('final')}
          onRemoveRow={removeRow}
          onAddGenre={addGenre('final')} onAddEvaluator={addEvaluator('final')} />
      )}
    </div>
  )
}
