'use client'
import { useMemo, useState } from 'react'

interface Props {
  /** Active Trends values; the only values that may be picked. */
  options: string[]
  /** Values already used in this context, hidden from the hit list. */
  exclude?: Set<string>
  onPick: (fieldValue: string) => void
  /** Text of the closed trigger button (a value to change, or "+ Add trend"). */
  label: string
  title?: string
  triggerClassName?: string
  disabled?: boolean
}

// The one Trends value typeahead, shared by the evaluation modal's tag field and
// the admin review queue. New Trends values are never created from this app, so
// it only ever filters a fixed list — a query with no hits means no such active
// definition, never "type it in anyway".
export function TrendValuePicker({ options, exclude, onPick, label, title, triggerClassName, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 1) return []
    return options.filter(o => o.toLowerCase().includes(q) && !exclude?.has(o)).slice(0, 12)
  }, [query, options, exclude])

  const pick = (v: string) => {
    setQuery('')
    setOpen(false)
    onPick(v)
  }

  if (!open) {
    return (
      <button
        type="button"
        className={triggerClassName ?? 'btn btn-sm btn-ghost'}
        title={title}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >{label}</button>
    )
  }

  return (
    <div className="wf-gamesearch" style={{ position: 'relative' }}>
      <input
        autoFocus
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') { setOpen(false); setQuery('') }
          if (e.key === 'Enter' && hits.length === 1) pick(hits[0])
        }}
        placeholder="Type to search Trends…"
        style={{ width: '100%' }}
      />
      {query.trim() && hits.length === 0 && (
        <span className="wf-hint">no matching Trends value — ask an admin to add it in Signal Sense</span>
      )}
      {hits.length > 0 && (
        <ul className="wf-hits" style={{ position: 'absolute', zIndex: 20, width: '100%' }}>
          {hits.map(h => (
            <li key={h}>
              <button type="button" onClick={() => pick(h)}>
                <span className="wf-hit-title">{h}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
