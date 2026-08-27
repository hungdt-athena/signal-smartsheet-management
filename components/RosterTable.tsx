// components/RosterTable.tsx — the single-page roster table: one row is one
// (person, genre) pair. Presentational, with every action leaving through props,
// so a fixture-driven page and the live page share exactly one component.
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
            {/* Genre and its sub-genres read as one thing, so they share a header.
                The sub-genre column is the only one without a width, so the
                table's slack collects there instead of stretching the name. */}
            <tr>
              <th style={{ width: 160 }}>Evaluator Name</th>
              <th style={{ width: 92 }}>Available</th>
              <th className="col-split" colSpan={2}>Genre &amp; sub-genre details</th>
              <th style={{ width: 96 }} />
              <th style={{ width: 76 }} />
              {!readOnly && <th style={{ width: 80 }} />}
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && <tr><td colSpan={colSpan} className="empty">No evaluators yet</td></tr>}
            {groups.map((g, gi) => {
              const showAdd = !readOnly && g.missingGenres.length > 0
              return (
                <PersonRows key={g.name} group={g} span={g.rows.length + (showAdd ? 1 : 0)} showAdd={showAdd}
                  alt={gi % 2 === 1} subGenres={subGenres} readOnly={readOnly}
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

// A person renders as several <tr>. Evaluator and Available exist only on the
// first row and span the rest, so there is physically one Available control per
// person — the UI cannot put a person's genres into disagreeing states.
function PersonRows({ group, span, showAdd, alt, subGenres, readOnly, onPatchRow, onPatchAvailable, onRemoveRow, onAddGenre }: {
  group: PersonGroup
  span: number
  showAdd: boolean
  alt: boolean
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
        <tr key={r.id} className={`${alt ? 'person-alt' : ''}${i === 0 ? ' person-first' : ''}`}>
          {i === 0 && <td className="cell-name" rowSpan={span}>{group.name}</td>}
          {i === 0 && (
            <td rowSpan={span} data-testid="avail-cell">
              <StyledSelect value={group.today_available ? 'Yes' : 'No'} options={AVAIL_OPTS} disabled={readOnly}
                onChange={v => onPatchAvailable(group.name, v === 'Yes')} />
            </td>
          )}
          <td className="cell-genre col-split">{BUCKET_LABELS[r.category_group]}</td>
          <td>
            <SubGenrePicker value={r.game_category} options={subGenres[r.category_group] ?? []} disabled={readOnly}
              onChange={v => onPatchRow(r.id, 'game_category', v)} />
          </td>
          <td>
            <StyledSelect value={r.game_platform || 'all'} options={PLATFORM_OPTS} disabled={readOnly}
              onChange={v => onPatchRow(r.id, 'game_platform', v)} />
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
        <tr className={`person-add${alt ? ' person-alt' : ''}`}>
          <td className="col-split" colSpan={4}>
            <span data-testid={`add-genre-${group.name}`}>
              <StyledSelect value="" placeholder="+ genre"
                options={group.missingGenres.map(b => ({ value: b, label: BUCKET_LABELS[b] }))}
                onChange={v => onAddGenre(group.name, v as Bucket)} />
            </span>
          </td>
          {!readOnly && <td />}
        </tr>
      )}
    </>
  )
}

// Sub-genres of this row's own genre, as inline checkboxes. A dropdown hid the
// choice behind a click and read "All" on every row.
//
// 'All' stays the stored value for "no restriction" — the cron reads it, so it is
// not ours to change — but it renders as every box ticked rather than as a
// separate All box, because that is what it means. Ticking every box stores 'All'
// again. Unticking the last remaining box is refused: an empty list would
// normalize back to 'All' on the server and silently mean the opposite.
function SubGenrePicker({ value, options, onChange, disabled }: {
  value: string; options: string[]; onChange: (v: string) => void; disabled?: boolean
}) {
  const picked = useMemo(
    () => (value && value.toLowerCase() !== 'all' ? value.split(',').map(s => s.trim()).filter(Boolean) : []),
    [value],
  )
  const all = picked.length === 0 || picked.length >= options.length
  const checked = (g: string) => all || picked.includes(g)

  function toggle(g: string) {
    const current = all ? [...options] : picked
    const next = current.includes(g) ? current.filter(x => x !== g) : [...current, g]
    if (next.length === 0) return
    onChange(next.length >= options.length ? 'All' : next.join(','))
  }

  return (
    <div className="subg">
      {options.map(g => (
        <label key={g} className={`subg-item${checked(g) ? ' on' : ''}`}>
          <input type="checkbox" checked={checked(g)} disabled={disabled}
            onChange={() => toggle(g)} />
          <span>{g}</span>
        </label>
      ))}
    </div>
  )
}

// Add-eval input with dashboard_users autocomplete; an unknown id sets the
// provision flag. Unlike the old one it takes several genres at once, each of
// which becomes its own roster row.
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
