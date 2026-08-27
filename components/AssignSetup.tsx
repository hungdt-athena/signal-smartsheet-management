// components/AssignSetup.tsx — roster một trang: một dòng = một cặp (người, genre).
// Không còn prop bucket; genre là filter view do page truyền xuống. Render uỷ
// cho RosterTable, ở đây chỉ còn fetch và bốn thao tác ghi.
'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RosterTable } from '@/components/RosterTable'
import { useCategoryMappings } from '@/hooks/useCategoryMappings'
import { groupRosterByPerson, type RosterRow } from '@/lib/assign-roster'
import type { Bucket } from '@/lib/buckets'

type ListType = 'initial' | 'final'

export function AssignSetup({ isEvaluator = false, userName = '', genre, onRosterNames }: {
  isEvaluator?: boolean
  userName?: string
  genre: Bucket | 'all'
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

  // Tên roster của list Initial, cho matrix History biết ai đang trong roster —
  // người 0 history vẫn phải ra một dòng, đó là thứ cần quan sát.
  useEffect(() => {
    onRosterNames?.(Array.from(new Set(initial.map(r => r.name))))
  }, [initial, onRosterNames])

  const visible = useCallback(
    (rows: RosterRow[]) => rows.filter(r => genre === 'all' || r.category_group === genre),
    [genre],
  )

  // Evaluator chỉ thấy dòng của chính họ ở Initial (server cũng đã lọc).
  const initialGroups = useMemo(() => groupRosterByPerson(
    visible(isEvaluator ? initial.filter(r => r.name.toLowerCase() === userName.toLowerCase()) : initial),
  ), [visible, isEvaluator, initial, userName])
  const finalGroups = useMemo(() => groupRosterByPerson(visible(final)), [visible, final])

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
        onPatchRow={patchRow} onPatchAvailable={patchAvailable('initial')} onRemoveRow={removeRow}
        onAddGenre={addGenre('initial')} onAddEvaluator={addEvaluator('initial')} />
      {!isEvaluator && (
        <RosterTable title="Final Evaluator" groups={finalGroups} subGenres={subGenres}
          onPatchRow={patchRow} onPatchAvailable={patchAvailable('final')} onRemoveRow={removeRow}
          onAddGenre={addGenre('final')} onAddEvaluator={addEvaluator('final')} />
      )}
    </div>
  )
}
