'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  /** Active Trends values; the only values that may be picked. */
  options: string[]
  /** Values already used in this context, hidden from the list. */
  exclude?: Set<string>
  onPick: (fieldValue: string) => void
  /** Text of the closed trigger (a value to change, or a placeholder). */
  label: string
  title?: string
  triggerClassName?: string
  triggerStyle?: React.CSSProperties
  disabled?: boolean
  /** Renders the trigger as a placeholder rather than a chosen value. */
  placeholder?: boolean
  /** Category groups (puzzle / arcade / simulation) each value is defined for, from
   *  `/api/trends/options`. Signal Sense stores this as `genre`; in this app a genre is
   *  a game's own genre, so the puzzle/arcade/simulation split is a category group. */
  categoryGroups?: Record<string, string[]>
  /** The category group of the game being tagged. With `categoryGroups`, the list
   *  opens on that group's trends only and "Show all category groups" widens it.
   *  Left out (or null when the game's group is unknown) the list is unfiltered. */
  categoryGroup?: string | null
}

interface MenuPos { top?: number; bottom?: number; left: number; width: number; maxHeight: number }

// The one Trends value combobox, shared by the evaluation modal's tag dialog and
// the admin review queue. Opening it lists the whole catalog to browse; typing
// filters it. New Trends values are never created from this app, so a query with
// no hits means no such active definition — never "type it in anyway".
//
// The menu is portalled to <body> with fixed positioning, like StyledSelect: both
// callers sit inside scrollable, overflow-clipped containers that would otherwise
// cut the list off.
export function TrendValuePicker({
  options, exclude, onPick, label, title, triggerClassName, triggerStyle, disabled, placeholder,
  categoryGroups, categoryGroup,
}: Props) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<MenuPos | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [showAll, setShowAll] = useState(false)

  // Narrowing needs both the game's category group and the map; without either there is
  // nothing to narrow by, and the list stays whole rather than guessing.
  const canFilter = !!categoryGroup && !!categoryGroups
  const filtering = canFilter && !showAll
  const inCategoryGroup = useCallback(
    (o: string) => !!categoryGroup && !!categoryGroups?.[o]?.includes(categoryGroup),
    [categoryGroup, categoryGroups],
  )

  // Browsable by default: an empty query lists the whole catalog -- or, for a
  // game with a known category group, that group's share of it.
  const scope = useMemo(() => (filtering ? options.filter(inCategoryGroup) : options), [filtering, options, inCategoryGroup])
  const hits = useMemo(() => {
    const pool = exclude?.size ? scope.filter(o => !exclude.has(o)) : scope
    const q = query.trim().toLowerCase()
    if (!q) return pool
    return pool.filter(o => o.toLowerCase().includes(q))
  }, [query, scope, exclude])

  const updatePos = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const spaceBelow = window.innerHeight - r.bottom
    const spaceAbove = r.top
    const flipUp = spaceBelow < 260 && spaceAbove > spaceBelow
    const width = Math.max(r.width, 240)
    setPos(flipUp
      ? { bottom: window.innerHeight - r.top + 5, left: r.left, width, maxHeight: Math.min(320, spaceAbove - 12) }
      : { top: r.bottom + 5, left: r.left, width, maxHeight: Math.min(320, spaceBelow - 12) })
  }, [])

  useEffect(() => {
    if (!open) return
    updatePos()
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false); setQuery('')
    }
    document.addEventListener('mousedown', onDocClick)
    window.addEventListener('scroll', updatePos, true)
    window.addEventListener('resize', updatePos)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      window.removeEventListener('scroll', updatePos, true)
      window.removeEventListener('resize', updatePos)
    }
  }, [open, updatePos])

  useEffect(() => { setActive(0) }, [query])

  // Keep the highlighted row in view while arrowing through a long catalog.
  useEffect(() => {
    if (!open) return
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const pick = (v: string) => {
    setQuery('')
    setOpen(false)
    onPick(v)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setQuery('') }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, hits.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
    if (e.key === 'Enter') { e.preventDefault(); if (hits[active]) pick(hits[active]) }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={triggerClassName ?? 'btn btn-sm btn-ghost'}
        title={title}
        disabled={disabled}
        aria-expanded={open}
        onClick={() => !disabled && setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8, width: '100%', textAlign: 'left', cursor: disabled ? 'default' : 'pointer',
          ...triggerStyle,
        }}
      >
        <span style={{
          fontFamily: placeholder ? undefined : 'var(--num)',
          color: placeholder ? 'var(--faint)' : undefined,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{label}</span>
        <span aria-hidden style={{ color: 'var(--faint)', fontSize: 10, flexShrink: 0 }}>▾</span>
      </button>

      {open && pos && createPortal(
        <div ref={menuRef} style={{
          position: 'fixed', zIndex: 1000,
          top: pos.top ?? 'auto', bottom: pos.bottom ?? 'auto', left: pos.left, width: pos.width,
          maxHeight: pos.maxHeight, display: 'flex', flexDirection: 'column',
          background: 'var(--surface)', border: '1px solid var(--border-strong)',
          borderRadius: 10, boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
        }}>
          <div style={{ padding: 8, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <input
              autoFocus
              className="input"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={onKey}
              placeholder="Search trends"
              style={{ width: '100%', fontSize: 13 }}
            />
            {canFilter && (
              <button
                type="button"
                onClick={() => { setShowAll(a => !a); setActive(0) }}
                style={{
                  marginTop: 6, padding: 0, border: 0, background: 'transparent',
                  color: 'var(--accent)', fontSize: 11.5, fontWeight: 500, cursor: 'pointer',
                }}
              >{showAll ? `Show ${categoryGroup} only` : 'Show all category groups'}</button>
            )}
          </div>

          {hits.length === 0 ? (
            <p style={{ margin: 0, padding: '12px 12px 14px', fontSize: 12, color: 'var(--faint)' }}>
              {filtering
                ? (query.trim()
                  ? `No ${categoryGroup} trend matches that. Try "Show all category groups".`
                  : `No ${categoryGroup} trends yet. Show all category groups to tag from another one.`)
                : (query.trim()
                  ? 'No trend matches that. New values are added in Signal Sense by an admin.'
                  : 'No trends available.')}
            </p>
          ) : (
            <>
              <ul ref={listRef} style={{
                listStyle: 'none', margin: 0, padding: 4, overflowY: 'auto', flex: 1,
              }}>
                {hits.map((h, i) => (
                  <li key={h}>
                    <button
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(h)}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left',
                        padding: '7px 9px', border: 0, borderRadius: 7, cursor: 'pointer',
                        fontFamily: 'var(--num)', fontSize: 12.5,
                        background: i === active ? 'var(--accent-weak)' : 'transparent',
                        color: i === active ? 'var(--accent-strong)' : 'var(--text)',
                      }}
                    >
                      <span>{h}</span>
                      {/* Only where it matters: a trend that is not this game's
                          category group, shown because the reader asked for everything. */}
                      {canFilter && !inCategoryGroup(h) && (
                        <span style={{
                          marginLeft: 8, fontFamily: 'var(--font)', fontSize: 10.5,
                          color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '0.04em',
                        }}>{(categoryGroups?.[h] ?? []).join(' / ') || 'no category group'}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              <div style={{
                padding: '6px 10px', borderTop: '1px solid var(--border)', flexShrink: 0,
                fontSize: 11, color: 'var(--faint)', background: 'var(--surface-2)',
              }}>
                {(() => {
                  const noun = filtering ? `${categoryGroup} trend${hits.length === 1 && !query.trim() ? '' : 's'}` : 'trends'
                  return query.trim() ? `${hits.length} of ${scope.length} ${noun}` : `${hits.length} ${noun}`
                })()}
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
