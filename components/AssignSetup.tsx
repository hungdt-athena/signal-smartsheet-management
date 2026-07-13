// components/AssignSetup.tsx — DB-backed per-bucket evaluator roster editor.
'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { StyledSelect } from '@/components/StyledSelect'
import { MultiSelect } from '@/components/MultiSelect'
import { useCategoryMappings } from '@/hooks/useCategoryMappings'
import { WEIGHTS, type Bucket } from '@/lib/buckets'

interface RosterRow {
  id: number; name: string; today_available: boolean
  game_platform: string; game_category: string; weight: number
}
type ListType = 'initial' | 'final'

const WEIGHT_OPTS = WEIGHTS.map(w => ({ value: String(w), label: String(w) }))
const PLATFORM_OPTS = [{ value: 'all', label: 'all' }, { value: 'ios', label: 'ios' }, { value: 'android', label: 'android' }]
const AVAIL_OPTS = [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }]

// Per-bucket evaluator roster editor. The active bucket is controlled by the
// parent (the Assign tab's segmented switcher) so roster + history stay in sync.
// Evaluators get a read-only view scoped to their own row and no Final list.
export function AssignSetup({ bucket, isEvaluator = false, userName = '' }: {
  bucket: Bucket; isEvaluator?: boolean; userName?: string
}) {
  const { data: catData } = useCategoryMappings()
  const [initial, setInitial] = useState<RosterRow[]>([])
  const [final, setFinal] = useState<RosterRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const genres = catData[bucket] ?? []

  // Evaluators only ever see their own Initial-list row.
  const initialRows = useMemo(
    () => (isEvaluator ? initial.filter(r => r.name.toLowerCase() === userName.toLowerCase()) : initial),
    [isEvaluator, initial, userName],
  )

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/assign-setup?group=${bucket}`, { cache: 'no-store' })
      if (!res.ok) throw new Error()
      const json = await res.json()
      setInitial(json.initial ?? []); setFinal(json.final ?? [])
    } catch { setError('Failed to load roster.') }
    finally { setLoading(false) }
  }, [bucket])

  useEffect(() => { refresh() }, [refresh])

  async function patch(id: number, field: string, value: unknown) {
    const res = await fetch('/api/assign-setup', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, field, value }),
    })
    if (res.ok) refresh(); else setError('Update failed.')
  }
  async function remove(id: number) {
    const res = await fetch('/api/assign-setup', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    })
    if (res.ok) refresh(); else setError('Delete failed.')
  }
  async function add(list_type: ListType, payload: { name: string; provision: boolean }) {
    const res = await fetch('/api/assign-setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category_group: bucket, list_type, ...payload }),
    })
    if (res.ok) refresh(); else setError('Add failed.')
  }

  return (
    <div className="assign-setup">
      <div className="roster-head">
        <span className="card-label">Roster</span>
        <button className="btn btn-sm" onClick={refresh} disabled={loading}>
          <span className={loading ? 'spin' : ''}>↻</span>{loading ? '...' : 'Refresh'}
        </button>
      </div>

      {error && <p className="msg-err">{error}</p>}

      <RosterTable title="Initial Evaluator" rows={initialRows} genres={genres} scroll readOnly={isEvaluator}
        onPatch={patch} onRemove={remove} onAdd={p => add('initial', p)} />
      {!isEvaluator && (
        <RosterTable title="Final Evaluator" rows={final} genres={genres}
          onPatch={patch} onRemove={remove} onAdd={p => add('final', p)} />
      )}
    </div>
  )
}

function RosterTable({
  title, rows, genres, onPatch, onRemove, onAdd, scroll = false, readOnly = false,
}: {
  title: string
  rows: RosterRow[]
  genres: string[]
  onPatch: (id: number, field: string, value: unknown) => void
  onRemove: (id: number) => void
  onAdd: (p: { name: string; provision: boolean }) => void
  scroll?: boolean
  readOnly?: boolean
}) {
  const colSpan = readOnly ? 5 : 6
  return (
    <div className="card">
      <div className="card-head"><span className="card-label">{title}</span></div>
      <div className={`tbl-wrap roster-tbl${scroll ? ' roster-scroll' : ''}`}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Evaluator Name</th>
              <th style={{ width: 92 }}>Available</th>
              <th style={{ width: 88 }}>Platform</th>
              <th style={{ width: 150 }}>Category</th>
              <th style={{ width: 76 }}>Weight</th>
              {!readOnly && <th style={{ width: 70 }} />}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={colSpan} className="empty">No evaluators yet</td></tr>}
            {rows.map(r => (
              <tr key={r.id}>
                <td className="cell-name">{r.name}</td>
                <td>
                  <StyledSelect value={r.today_available ? 'Yes' : 'No'} options={AVAIL_OPTS} disabled={readOnly}
                    onChange={v => onPatch(r.id, 'today_available', v)} />
                </td>
                <td>
                  <StyledSelect value={r.game_platform || 'all'} options={PLATFORM_OPTS} disabled={readOnly}
                    onChange={v => onPatch(r.id, 'game_platform', v)} />
                </td>
                <td>
                  <CategoryPicker value={r.game_category} genres={genres} disabled={readOnly}
                    onChange={v => onPatch(r.id, 'game_category', v)} />
                </td>
                <td>
                  <StyledSelect value={String(r.weight ?? 100)} options={WEIGHT_OPTS} disabled={readOnly}
                    onChange={v => onPatch(r.id, 'weight', Number(v))} />
                </td>
                {!readOnly && (
                  <td>
                    <button className="btn btn-sm btn-danger" onClick={() => onRemove(r.id)}>Remove</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && <AddEvalRow onAdd={onAdd} />}
    </div>
  )
}

// Multi-select category over the active bucket's genres. Empty selection ↔ 'All'.
function CategoryPicker({ value, genres, onChange, disabled }: { value: string; genres: string[]; onChange: (v: string) => void; disabled?: boolean }) {
  const selected = useMemo(
    () => (value && value.toLowerCase() !== 'all' ? value.split(',').map(s => s.trim()).filter(Boolean) : []),
    [value],
  )
  return (
    <MultiSelect
      value={selected}
      placeholder="All"
      disabled={disabled}
      options={genres.map(g => ({ value: g, label: g }))}
      onChange={vals => onChange(vals.length === 0 ? 'All' : vals.join(','))}
    />
  )
}

// Add-eval input with dashboard_users autocomplete; unknown id → provision flag.
function AddEvalRow({ onAdd }: { onAdd: (p: { name: string; provision: boolean }) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [sugg, setSugg] = useState<{ name: string; email: string }[]>([])

  useEffect(() => {
    if (!name.trim()) { setSugg([]); return }
    let alive = true
    const t = setTimeout(async () => {
      const res = await fetch(`/api/assign-setup/recommend?q=${encodeURIComponent(name.trim())}`, { cache: 'no-store' })
      if (alive && res.ok) setSugg((await res.json()).users ?? [])
    }, 200)
    return () => { alive = false; clearTimeout(t) }
  }, [name])

  function submit(provision: boolean, value?: string) {
    const n = (value ?? name).trim()
    if (!n) return
    onAdd({ name: n, provision })
    setName(''); setSugg([]); setOpen(false)
  }

  const isKnown = sugg.some(s => s.name.toLowerCase() === name.trim().toLowerCase())

  if (!open) return <button className="add-row-btn" onClick={() => setOpen(true)}>+ Add evaluator</button>

  return (
    <div style={{ marginTop: 8, position: 'relative' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="input" style={{ flex: 1 }} autoFocus value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(!isKnown) }}
          placeholder="Type a name to search, or a new id (auto @athena.studio)…" />
        <button className="btn btn-primary btn-sm" disabled={!name.trim()} onClick={() => submit(!isKnown)}>
          {isKnown ? 'Add' : 'Add + create user'}
        </button>
        <button className="btn btn-sm" onClick={() => { setOpen(false); setName(''); setSugg([]) }}>✕</button>
      </div>
      {sugg.length > 0 && (
        <div className="ssel-menu" style={{ position: 'absolute', zIndex: 50, top: '100%', left: 0, right: 0, maxHeight: 200, overflowY: 'auto' }}>
          {sugg.map(s => (
            <div key={s.email} className="ssel-opt" onClick={() => submit(false, s.name)}>
              {s.name} <span style={{ color: 'var(--faint)' }}>· {s.email}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
