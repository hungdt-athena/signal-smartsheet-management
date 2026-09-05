// components/OptionRows.tsx — the option list every Config section renders.
// Replaces the old Used/Archived drag-and-drop columns: one compact row per
// option, order by ▲▼, on/off by switch, delete by ✕. Inactive options stay in
// place struck through instead of jumping to a second column, so the list keeps
// one height and the page has no dead space. Keyboard-operable throughout, which
// the drag version never was.
'use client'
import { useState } from 'react'

export interface OptionItem {
  id: number
  label: string
  active: boolean
  usage?: string        // e.g. "1,204 games" — omitted where counting is not cheap
}

export function OptionRows({
  items, loading, onToggle, onDelete, onReorder, onRename, emptyText = 'No options yet',
}: {
  items: OptionItem[]
  loading?: boolean
  onToggle: (id: number, active: boolean) => void
  onDelete: (id: number) => void
  onReorder?: (orderedIds: number[]) => void   // enables ▲▼; omit where order is meaningless
  onRename?: (id: number, value: string) => void
  emptyText?: string
}) {
  function move(index: number, delta: number) {
    if (!onReorder) return
    const next = index + delta
    if (next < 0 || next >= items.length) return
    const ids = items.map(i => i.id)
    ;[ids[index], ids[next]] = [ids[next], ids[index]]
    onReorder(ids)
  }

  if (items.length === 0) {
    return <div className="opt-empty">{loading ? 'Loading…' : emptyText}</div>
  }

  return (
    <div className="opt-rows">
      {items.map((it, i) => (
        <div key={it.id} className={'opt-row' + (it.active ? '' : ' is-off')}>
          {onReorder ? (
            <div className="opt-ord">
              <button type="button" aria-label={`Move ${it.label} up`} disabled={i === 0}
                onClick={() => move(i, -1)}>▲</button>
              <button type="button" aria-label={`Move ${it.label} down`} disabled={i === items.length - 1}
                onClick={() => move(i, 1)}>▼</button>
            </div>
          ) : <span className="opt-ord" />}

          <Label label={it.label} canRename={!!onRename} onRename={v => onRename?.(it.id, v)} />

          {it.usage && <span className="opt-usage">{it.usage}</span>}

          <button
            type="button"
            className="opt-sw"
            role="switch"
            aria-checked={it.active}
            aria-label={`${it.active ? 'Turn off' : 'Turn on'} ${it.label}`}
            title={it.active ? 'On — shows in the dropdown' : 'Off — hidden from the dropdown'}
            onClick={() => onToggle(it.id, !it.active)}
          />
          <DeleteButton label={it.label} onDelete={() => onDelete(it.id)} />
        </div>
      ))}
    </div>
  )
}

// Deleting an option is permanent and the row may be attached to thousands of
// games, so the ✕ asks once. Turning the switch off is the reversible way out.
function DeleteButton({ label, onDelete }: { label: string; onDelete: () => void }) {
  const [armed, setArmed] = useState(false)

  if (armed) {
    return (
      <button type="button" className="opt-del is-armed" onClick={onDelete} onBlur={() => setArmed(false)}
        autoFocus aria-label={`Confirm delete ${label}`}>Delete?</button>
    )
  }
  return (
    <button type="button" className="opt-del" aria-label={`Delete ${label}`} title="Delete"
      onClick={() => setArmed(true)}>✕</button>
  )
}

function Label({ label, canRename, onRename }: {
  label: string
  canRename: boolean
  onRename: (value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(label)

  function commit() {
    setEditing(false)
    const v = val.trim()
    if (v && v !== label) onRename(v)
    else setVal(label)
  }

  if (editing) {
    return (
      <input
        className="opt-edit"
        autoFocus
        value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') { setVal(label); setEditing(false) }
        }}
      />
    )
  }

  if (!canRename) return <span className="opt-label">{label}</span>

  return (
    <button type="button" className="opt-label opt-label-btn" title="Click to rename"
      onClick={() => { setVal(label); setEditing(true) }}>
      {label}
    </button>
  )
}
