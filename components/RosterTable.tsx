// components/RosterTable.tsx — the single-page roster table: one row is one
// PERSON. Their (person, genre) pairs ride in the last cell as genre pills, and
// the pill expands into a panel row underneath. Presentational, with every
// action leaving through props, so a fixture-driven page and the live page
// share exactly one component.
'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { StyledSelect } from '@/components/StyledSelect'
import { MultiSelect } from '@/components/MultiSelect'
import { BUCKETS, WEIGHTS, type Bucket } from '@/lib/buckets'
import type { PersonGroup, RosterRow } from '@/lib/assign-roster'

export const BUCKET_LABELS: Record<Bucket, string> = {
  puzzle: 'Puzzle', arcade: 'Arcade', simulation: 'Simulation',
}

const PLATFORM_OPTS = ['all', 'ios', 'android'].map(p => ({ value: p, label: p }))
const AVAIL_OPTS = [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }]

/**
 * The sub-genres a row actually covers, given its genre's full list.
 *
 * 'All' is the stored value for "no restriction" — the cron reads it, so it is
 * not ours to change — and a list naming every option means the same thing.
 * Both resolve to the full list, which is what lets one predicate
 * (`length < options.length`) answer "is this row restricted".
 */
export function pickedSubGenres(stored: string, options: string[]): string[] {
  const parts = stored && stored.toLowerCase() !== 'all'
    ? stored.split(',').map(s => s.trim()).filter(Boolean)
    : []
  return parts.length === 0 || parts.length >= options.length ? options : parts
}

export interface RosterTableProps {
  title: string
  groups: PersonGroup[]
  subGenres: Record<Bucket, string[]>
  readOnly?: boolean
  onPatchRow: (id: number, field: 'game_category' | 'weight', value: unknown) => void
  onPatchAvailable: (name: string, value: boolean) => void
  onPatchPerson: (name: string, field: 'game_platform', value: unknown) => void
  onRemoveRow: (id: number) => void
  onAddGenre: (name: string, genre: Bucket) => void
  onAddEvaluator: (p: { name: string; provision: boolean; genres: Bucket[] }) => void
}

export function RosterTable({
  title, groups, subGenres, readOnly = false,
  onPatchRow, onPatchAvailable, onPatchPerson, onRemoveRow, onAddGenre, onAddEvaluator,
}: RosterTableProps) {
  // Which genre panels are expanded, keyed by roster row id. Several may be
  // open at once on purpose: two people's sub-genres are only comparable when
  // both are on screen, which a panel floating over the table cannot do.
  //
  // Row ids survive the parent's refetch-after-write, so an open panel stays
  // open across a save.
  const [openIds, setOpenIds] = useState<ReadonlySet<number>>(() => new Set())
  const toggleOpen = useCallback((id: number) => {
    setOpenIds(prev => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  // Esc closes every panel. Without it the only way out is hunting for each
  // Close button, and a keyboard user who opened four has no exit at all.
  useEffect(() => {
    if (openIds.size === 0) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenIds(new Set()) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openIds])

  return (
    <div className="card">
      <div className="card-head"><span className="card-label">{title}</span></div>
      {/* No inner scroller: the roster is the page's content, so it runs to its
          full height and the page does the scrolling. */}
      <div className="tbl-wrap roster-tbl">
        <table className="tbl">
          <thead>
            {/* The three person-level facts come first and read left to right.
                Genres is the only column without a width, so the table's slack
                collects in the pills instead of stretching the name. */}
            <tr>
              <th style={{ width: 170 }}>Evaluator Name</th>
              <th style={{ width: 92 }}>Available</th>
              <th style={{ width: 96 }}>Platform</th>
              <th className="col-split">Genres</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && <tr><td colSpan={4} className="empty">No evaluators yet</td></tr>}
            {groups.map((g, gi) => (
              <PersonRow key={g.name} group={g} alt={gi % 2 === 1} subGenres={subGenres} readOnly={readOnly}
                openIds={openIds} onToggleOpen={toggleOpen}
                onPatchRow={onPatchRow} onPatchAvailable={onPatchAvailable} onPatchPerson={onPatchPerson}
                onRemoveRow={onRemoveRow} onAddGenre={onAddGenre} />
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && <AddEvalRow onAdd={onAddEvaluator} />}
    </div>
  )
}

// A person is one <tr>, plus one <tr> per genre panel they have open. Evaluator,
// Available and Platform exist once, so there is physically one control each per
// person — the UI cannot put a person's genres into disagreeing states. Weight
// and sub-genre live on the pill's panel, because both vary by genre.
function PersonRow({ group, alt, subGenres, readOnly, openIds, onToggleOpen, onPatchRow, onPatchAvailable, onPatchPerson, onRemoveRow, onAddGenre }: {
  group: PersonGroup
  alt: boolean
  subGenres: Record<Bucket, string[]>
  readOnly: boolean
  openIds: ReadonlySet<number>
  onToggleOpen: (id: number) => void
  onPatchRow: RosterTableProps['onPatchRow']
  onPatchAvailable: RosterTableProps['onPatchAvailable']
  onPatchPerson: RosterTableProps['onPatchPerson']
  onRemoveRow: RosterTableProps['onRemoveRow']
  onAddGenre: RosterTableProps['onAddGenre']
}) {
  const expanded = group.rows.filter(r => openIds.has(r.id))
  return (
    <>
      <tr className={`person-first${alt ? ' person-alt' : ''}`}>
        <td className="cell-name">{group.name}</td>
        <td data-testid="avail-cell">
          <StyledSelect value={group.today_available ? 'Yes' : 'No'} options={AVAIL_OPTS} disabled={readOnly}
            onChange={v => onPatchAvailable(group.name, v === 'Yes')} />
        </td>
        <td data-testid="platform-cell">
          <StyledSelect value={group.game_platform || 'all'} options={PLATFORM_OPTS} disabled={readOnly}
            onChange={v => onPatchPerson(group.name, 'game_platform', v)} />
        </td>
        <td className="col-split">
          <div className="gpills">
            {group.rows.map(r => (
              <GenrePill key={r.id} row={r} available={group.today_available}
                options={subGenres[r.category_group] ?? []}
                expanded={openIds.has(r.id)} onToggle={() => onToggleOpen(r.id)} />
            ))}
            {!readOnly && group.missingGenres.length > 0 && (
              <span className="gpill-add" data-testid={`add-genre-${group.name}`}>
                <StyledSelect value="" placeholder="+ genre"
                  options={group.missingGenres.map(b => ({ value: b, label: BUCKET_LABELS[b] }))}
                  onChange={v => onAddGenre(group.name, v as Bucket)} />
              </span>
            )}
          </div>
        </td>
      </tr>
      {expanded.map(r => (
        <tr key={`panel-${r.id}`} className="genre-xrow">
          <td colSpan={4}>
            <GenrePanel row={r} options={subGenres[r.category_group] ?? []} readOnly={readOnly}
              onPatchRow={onPatchRow} onRemove={() => onRemoveRow(r.id)} onClose={() => onToggleOpen(r.id)} />
          </td>
        </tr>
      ))}
    </>
  )
}

// The pill answers four questions without a click: which genre, is this person
// on today, what weight, and are sub-genres cut.
//
// Weight always shows, including 100. The roster is read to compare weights
// down a column, and a blank in the common case would turn that scan into a
// lookup. The sub-genre badge is the opposite: it only appears when the row is
// restricted, because "all of them" is what the absence of a badge means.
function GenrePill({ row, available, options, expanded, onToggle }: {
  row: RosterRow
  available: boolean
  options: string[]
  expanded: boolean
  onToggle: () => void
}) {
  const picked = pickedSubGenres(row.game_category, options)
  const restricted = picked.length < options.length
  const genre = BUCKET_LABELS[row.category_group]
  // The visible text is abbreviated for width; the label spells it out, since
  // "2/3 sub-genres" read aloud character by character is not a sentence.
  const label = `${genre}, weight ${row.weight}`
    + (restricted ? `, ${picked.length} of ${options.length} sub-genres` : ', all sub-genres')

  return (
    <button type="button" aria-expanded={expanded} aria-label={label} onClick={onToggle}
      className={`gpill${available ? '' : ' gpill-off'}`}>
      <span className="gdot" aria-hidden="true" />
      <span className="gname">{genre}</span>
      <span className="gw">{row.weight}</span>
      {restricted && (
        <span className="gsub" aria-hidden="true">{picked.length}/{options.length} sub-genres</span>
      )}
    </button>
  )
}

// The expanded panel is a row of its own directly under the person, so it gets
// the full table width and joins the tab order without a portal, a coordinate
// calculation or a flip-up rule. Everything that varies by genre lives here.
function GenrePanel({ row, options, readOnly, onPatchRow, onRemove, onClose }: {
  row: RosterRow
  options: string[]
  readOnly: boolean
  onPatchRow: RosterTableProps['onPatchRow']
  onRemove: () => void
  onClose: () => void
}) {
  const picked = useMemo(() => pickedSubGenres(row.game_category, options), [row.game_category, options])
  const genre = BUCKET_LABELS[row.category_group]
  const allOn = picked.length >= options.length

  // Unticking the last remaining box is refused at the control rather than
  // here: an empty list normalizes back to 'All' on the server and would
  // silently mean the opposite of what was clicked.
  function toggle(g: string) {
    const next = picked.includes(g) ? picked.filter(x => x !== g) : [...picked, g]
    if (next.length === 0) return
    onPatchRow(row.id, 'game_category', next.length >= options.length ? 'All' : next.join(','))
  }

  return (
    <div className="gpanel">
      <span className="gpanel-title">{genre}</span>

      <div className="gpanel-field">
        <span className="gpanel-label" id={`w-lab-${row.id}`}>Weight</span>
        {/* Four buttons, not a dropdown: WEIGHTS has exactly four members, so a
            menu costs two clicks to show a scale that fits on one line. */}
        <div className="wsteps" role="group" aria-labelledby={`w-lab-${row.id}`}>
          {WEIGHTS.map(w => (
            <button key={w} type="button" className="wstep" aria-pressed={row.weight === w}
              disabled={readOnly} onClick={() => onPatchRow(row.id, 'weight', w)}>{w}</button>
          ))}
        </div>
      </div>

      <div className="gpanel-field">
        <span className="gpanel-label">Sub-genre</span>
        <div className="subg">
          {options.map(g => {
            const on = picked.includes(g)
            const last = on && picked.length === 1
            return (
              <label key={g} className={`subg-item${on ? ' on' : ''}`}
                title={last ? 'Keep at least one sub-genre' : undefined}>
                <input type="checkbox" checked={on} disabled={readOnly || last}
                  onChange={() => toggle(g)} />
                <span>{g}</span>
              </label>
            )
          })}
        </div>
      </div>

      <div className="gpanel-acts">
        {!readOnly && (
          <button type="button" className="glink" disabled={allOn}
            onClick={() => onPatchRow(row.id, 'game_category', 'All')}>Select all</button>
        )}
        {!readOnly && (
          <button type="button" className="glink glink-danger" onClick={onRemove}>Remove genre</button>
        )}
        <button type="button" className="glink glink-quiet" onClick={onClose}>Close</button>
      </div>
    </div>
  )
}

// Add-eval input with dashboard_users autocomplete; an unknown id sets the
// provision flag. It takes several genres at once, each of which becomes its
// own roster row.
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
