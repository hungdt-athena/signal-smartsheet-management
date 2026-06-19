// components/DnDColumns.tsx — Used / Archived drag-and-drop columns.
// Used = active (On), Archived = inactive (Off). Cards drag between columns to
// flip active; within the Used column they reorder (when onReorder is given).
// Optional double-click rename. Native HTML5 DnD — no dependencies.
'use client'
import { useState } from 'react'

export interface DnDItem { id: number; label: string; active: boolean }

export function DnDColumns({
  items, loading, onToggle, onDelete, onReorder, onRename,
}: {
  items: DnDItem[]
  loading?: boolean
  onToggle: (id: number, active: boolean) => void
  onDelete: (id: number) => void
  onReorder?: (orderedIds: number[]) => void   // full field order; enables reorder within Used
  onRename?: (id: number, value: string) => void
}) {
  const [dragId, setDragId] = useState<number | null>(null)
  const [overCol, setOverCol] = useState<'used' | 'archived' | null>(null)

  const used = items.filter(i => i.active)
  const archived = items.filter(i => !i.active)

  // Drop relative to a card (targetId) or at the end of a column (targetId null).
  function drop(targetActive: boolean, targetId: number | null) {
    const id = dragId
    setDragId(null); setOverCol(null)
    if (id == null) return
    const dragged = items.find(i => i.id === id)
    if (!dragged) return

    // Cross-column move → flip active (lands at end of the target column).
    if (dragged.active !== targetActive) { onToggle(id, targetActive); return }

    // Same-column reorder — only the Used column has a meaningful (dropdown) order.
    if (!onReorder || !targetActive) return
    const usedIds = used.filter(i => i.id !== id).map(i => i.id)
    const at = targetId != null ? usedIds.indexOf(targetId) : -1
    usedIds.splice(at === -1 ? usedIds.length : at, 0, id)
    onReorder([...usedIds, ...archived.map(i => i.id)])
  }

  function col(key: 'used' | 'archived', title: string, list: DnDItem[], active: boolean) {
    return (
      <div
        className={`dnd-col dnd-col-${key}` + (overCol === key ? ' drag-over' : '')}
        onDragOver={e => { e.preventDefault(); setOverCol(key) }}
        onDragLeave={() => setOverCol(c => (c === key ? null : c))}
        onDrop={() => drop(active, null)}
      >
        <div className="dnd-col-head">{title} <span className="dnd-col-count">{list.length}</span></div>
        <div className="dnd-col-body">
          {list.length === 0 && !loading && <span className="dnd-empty">Drop here</span>}
          {list.map(it => (
            <Card
              key={it.id}
              item={it}
              canRename={!!onRename}
              onDragStart={() => setDragId(it.id)}
              onDragEnd={() => { setDragId(null); setOverCol(null) }}
              onDropOnCard={() => drop(active, it.id)}
              onDelete={() => onDelete(it.id)}
              onRename={v => onRename?.(it.id, v)}
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="dnd-cols">
      {col('used', 'Used', used, true)}
      {col('archived', 'Archived', archived, false)}
    </div>
  )
}

function Card({
  item, canRename, onDragStart, onDragEnd, onDropOnCard, onDelete, onRename,
}: {
  item: DnDItem
  canRename: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onDropOnCard: () => void
  onDelete: () => void
  onRename: (value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(item.label)

  function commit() {
    setEditing(false)
    const v = val.trim()
    if (v && v !== item.label) onRename(v)
    else setVal(item.label)
  }

  return (
    <span
      className="dnd-card"
      draggable={!editing}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={e => e.preventDefault()}
      onDrop={e => { e.stopPropagation(); onDropOnCard() }}
      onDoubleClick={() => { if (canRename) { setVal(item.label); setEditing(true) } }}
      title={canRename ? 'Double-click to rename · drag to move' : 'Drag to move'}
    >
      <span className="dnd-grip" aria-hidden>⠿</span>
      {editing ? (
        <input
          className="dnd-edit"
          autoFocus
          value={val}
          onChange={e => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') { setVal(item.label); setEditing(false) }
          }}
        />
      ) : (
        <span className="dnd-label">{item.label}</span>
      )}
      <button className="dnd-x" title="Delete" onClick={onDelete}>✕</button>
    </span>
  )
}
