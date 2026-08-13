'use client'
import { useEffect, useMemo, useRef, useState } from 'react'

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
}

// The one Trends value combobox, shared by the evaluation modal's tag dialog and
// the admin review queue. Opening it shows the whole catalog to browse; typing
// filters it. New Trends values are never created from this app, so a query with
// no hits means no such active definition — never "type it in anyway".
export function TrendValuePicker({
  options, exclude, onPick, label, title, triggerClassName, triggerStyle, disabled, placeholder,
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // Browsable by default: an empty query lists the whole catalog.
  const hits = useMemo(() => {
    const pool = exclude?.size ? options.filter(o => !exclude.has(o)) : options
    const q = query.trim().toLowerCase()
    if (!q) return pool
    return pool.filter(o => o.toLowerCase().includes(q))
  }, [query, options, exclude])

  useEffect(() => { setActive(0) }, [query])

  // Keep the highlighted row in view while arrowing through a long catalog.
  useEffect(() => {
    if (!open) return
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) { setOpen(false); setQuery('') }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const pick = (v: string) => {
    setQuery('')
    setOpen(false)
    onPick(v)
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className={triggerClassName ?? 'btn btn-sm btn-ghost'}
        title={title}
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
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

      {open && (
        <div style={{
          position: 'absolute', zIndex: 30, top: 'calc(100% + 4px)', left: 0, right: 0,
          background: 'var(--surface)', border: '1px solid var(--border-strong)',
          borderRadius: 10, boxShadow: 'var(--shadow-md)', overflow: 'hidden',
        }}>
          <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
            <input
              autoFocus
              className="input"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setQuery('') }
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, hits.length - 1)) }
                if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
                if (e.key === 'Enter') { e.preventDefault(); if (hits[active]) pick(hits[active]) }
              }}
              placeholder="Search trends"
              style={{ width: '100%', fontSize: 13 }}
            />
          </div>

          {hits.length === 0 ? (
            <p style={{ margin: 0, padding: '12px 12px 14px', fontSize: 12, color: 'var(--faint)' }}>
              {query.trim()
                ? 'No trend matches that. New values are added in Signal Sense by an admin.'
                : 'No trends available.'}
            </p>
          ) : (
            <>
              <ul ref={listRef} style={{
                listStyle: 'none', margin: 0, padding: 4, maxHeight: 230, overflowY: 'auto',
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
                    >{h}</button>
                  </li>
                ))}
              </ul>
              <div style={{
                padding: '6px 10px', borderTop: '1px solid var(--border)',
                fontSize: 11, color: 'var(--faint)', background: 'var(--surface-2)',
              }}>
                {query.trim() ? `${hits.length} of ${options.length} trends` : `${hits.length} trends`}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
