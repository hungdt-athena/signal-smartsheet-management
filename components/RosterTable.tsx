// components/RosterTable.tsx — bảng roster một trang, một dòng = một cặp
// (người, genre). Presentational: mọi thao tác đi ra ngoài qua props, nên page
// giả lập fixture và page thật dùng chung đúng một component.
'use client'
import { useEffect, useMemo, useState } from 'react'
import { StyledSelect } from '@/components/StyledSelect'
import { MultiSelect } from '@/components/MultiSelect'
import { BUCKETS, WEIGHTS, type Bucket } from '@/lib/buckets'
import type { PersonGroup } from '@/lib/assign-roster'

export const BUCKET_LABELS: Record<Bucket, string> = {
  puzzle: 'Puzzle', arcade: 'Arcade', simulation: 'Simulation',
}

const WEIGHT_OPTS = WEIGHTS.map(w => ({ value: String(w), label: String(w) }))
const PLATFORM_OPTS = ['all', 'ios', 'android'].map(p => ({ value: p, label: p }))
const AVAIL_OPTS = [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }]

export interface RosterTableProps {
  title: string
  groups: PersonGroup[]
  subGenres: Record<Bucket, string[]>
  readOnly?: boolean
  scroll?: boolean
  onPatchRow: (id: number, field: 'game_platform' | 'game_category' | 'weight', value: unknown) => void
  onPatchAvailable: (name: string, value: boolean) => void
  onRemoveRow: (id: number) => void
  onAddGenre: (name: string, genre: Bucket) => void
  onAddEvaluator: (p: { name: string; provision: boolean; genres: Bucket[] }) => void
}

export function RosterTable({
  title, groups, subGenres, readOnly = false, scroll = false,
  onPatchRow, onPatchAvailable, onRemoveRow, onAddGenre, onAddEvaluator,
}: RosterTableProps) {
  const colSpan = readOnly ? 6 : 7
  return (
    <div className="card">
      <div className="card-head"><span className="card-label">{title}</span></div>
      <div className={`tbl-wrap roster-tbl${scroll ? ' roster-scroll' : ''}`}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Evaluator Name</th>
              <th style={{ width: 110 }}>Genre</th>
              <th style={{ width: 92 }}>Available</th>
              <th style={{ width: 88 }}>Platform</th>
              <th style={{ width: 150 }}>Sub-genre</th>
              <th style={{ width: 76 }}>Weight</th>
              {!readOnly && <th style={{ width: 70 }} />}
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && <tr><td colSpan={colSpan} className="empty">No evaluators yet</td></tr>}
            {groups.map(g => {
              const showAdd = !readOnly && g.missingGenres.length > 0
              return (
                <PersonRows key={g.name} group={g} span={g.rows.length + (showAdd ? 1 : 0)} showAdd={showAdd}
                  subGenres={subGenres} readOnly={readOnly}
                  onPatchRow={onPatchRow} onPatchAvailable={onPatchAvailable}
                  onRemoveRow={onRemoveRow} onAddGenre={onAddGenre} />
              )
            })}
          </tbody>
        </table>
      </div>
      {!readOnly && <AddEvalRow onAdd={onAddEvaluator} />}
    </div>
  )
}

// Một người ra nhiều <tr>. Cột Evaluator và Available chỉ tồn tại trên dòng đầu
// và gộp cell xuống hết nhóm, nên ô Available vật lý chỉ có một — UI không thể
// tạo ra trạng thái lệch giữa các genre của cùng một người.
function PersonRows({ group, span, showAdd, subGenres, readOnly, onPatchRow, onPatchAvailable, onRemoveRow, onAddGenre }: {
  group: PersonGroup
  span: number
  showAdd: boolean
  subGenres: Record<Bucket, string[]>
  readOnly: boolean
  onPatchRow: RosterTableProps['onPatchRow']
  onPatchAvailable: RosterTableProps['onPatchAvailable']
  onRemoveRow: RosterTableProps['onRemoveRow']
  onAddGenre: RosterTableProps['onAddGenre']
}) {
  return (
    <>
      {group.rows.map((r, i) => (
        <tr key={r.id} className={i === 0 ? 'person-first' : undefined}>
          {i === 0 && <td className="cell-name" rowSpan={span}>{group.name}</td>}
          <td className="cell-genre">{BUCKET_LABELS[r.category_group]}</td>
          {i === 0 && (
            <td rowSpan={span} data-testid="avail-cell">
              <StyledSelect value={group.today_available ? 'Yes' : 'No'} options={AVAIL_OPTS} disabled={readOnly}
                onChange={v => onPatchAvailable(group.name, v === 'Yes')} />
            </td>
          )}
          <td>
            <StyledSelect value={r.game_platform || 'all'} options={PLATFORM_OPTS} disabled={readOnly}
              onChange={v => onPatchRow(r.id, 'game_platform', v)} />
          </td>
          <td>
            <SubGenrePicker value={r.game_category} options={subGenres[r.category_group] ?? []} disabled={readOnly}
              onChange={v => onPatchRow(r.id, 'game_category', v)} />
          </td>
          <td>
            <StyledSelect value={String(r.weight ?? 100)} options={WEIGHT_OPTS} disabled={readOnly}
              onChange={v => onPatchRow(r.id, 'weight', Number(v))} />
          </td>
          {!readOnly && (
            <td><button className="btn btn-sm btn-danger" onClick={() => onRemoveRow(r.id)}>Remove</button></td>
          )}
        </tr>
      ))}
      {showAdd && (
        <tr className="person-add">
          <td className="cell-genre">
            <span data-testid={`add-genre-${group.name}`}>
              <StyledSelect value="" placeholder="+ genre"
                options={group.missingGenres.map(b => ({ value: b, label: BUCKET_LABELS[b] }))}
                onChange={v => onAddGenre(group.name, v as Bucket)} />
            </span>
          </td>
          <td colSpan={4} />
        </tr>
      )}
    </>
  )
}

// Multi-select sub-genre trong genre của chính dòng này. Rỗng ↔ 'All'.
function SubGenrePicker({ value, options, onChange, disabled }: {
  value: string; options: string[]; onChange: (v: string) => void; disabled?: boolean
}) {
  const selected = useMemo(
    () => (value && value.toLowerCase() !== 'all' ? value.split(',').map(s => s.trim()).filter(Boolean) : []),
    [value],
  )
  return (
    <MultiSelect
      value={selected}
      placeholder="All"
      disabled={disabled}
      options={options.map(g => ({ value: g, label: g }))}
      onChange={vals => onChange(vals.length === 0 ? 'All' : vals.join(','))}
    />
  )
}

// Add-eval input với autocomplete dashboard_users; id lạ → cờ provision.
// Khác bản cũ: chọn được nhiều genre một lượt, mỗi genre thành một dòng roster.
function AddEvalRow({ onAdd }: { onAdd: RosterTableProps['onAddEvaluator'] }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [genres, setGenres] = useState<Bucket[]>(['puzzle'])
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
    if (!n || genres.length === 0) return
    onAdd({ name: n, provision, genres })
    setName(''); setSugg([]); setGenres(['puzzle']); setOpen(false)
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
        <MultiSelect value={genres} placeholder="Genre" style={{ width: 190 }}
          options={BUCKETS.map(b => ({ value: b, label: BUCKET_LABELS[b] }))}
          onChange={vals => setGenres(vals.filter((v): v is Bucket => (BUCKETS as readonly string[]).includes(v)))} />
        <button className="btn btn-primary btn-sm" disabled={!name.trim() || genres.length === 0}
          onClick={() => submit(!isKnown)}>
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
