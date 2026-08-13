'use client'
import { useMemo, useState } from 'react'

export interface TrendTag {
  field_value: string
  sub_value_id: number | null
}

export interface ExistingTrendTag {
  field_value: string
  sub_value_name: string | null
}

interface Props {
  value: TrendTag[]
  /** Trends tags this game already carries in Signal Sense (read-only). */
  existing: ExistingTrendTag[]
  /** Active Trends values; the only values that may be picked. */
  options: string[]
  subValues: { id: number; name: string }[]
  onChange: (next: TrendTag[]) => void
  disabled?: boolean
}

// Trends tagging for one game. Proposals only: nothing here reaches Signal Sense
// until an admin confirms in Evaluations > Tagging. New Trends values are never
// created from this app, so the combobox filters a fixed list.
export function TrendTagsField({ value, existing, options, subValues, onChange, disabled }: Props) {
  const tags = value || []
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')

  const taken = useMemo(() => new Set(tags.map(t => t.field_value)), [tags])
  const existingByValue = useMemo(
    () => new Map(existing.map(e => [e.field_value, e])), [existing])

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 1) return []
    return options.filter(o => o.toLowerCase().includes(q) && !taken.has(o)).slice(0, 12)
  }, [query, options, taken])

  const add = (fieldValue: string) => {
    onChange([...tags, { field_value: fieldValue, sub_value_id: null }])
    setQuery('')
    setAdding(false)
  }
  const remove = (i: number) => onChange(tags.filter((_, x) => x !== i))
  const setSub = (i: number, subId: number | null) =>
    onChange(tags.map((t, x) => (x === i ? { ...t, sub_value_id: subId } : t)))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {existing.length > 0 && (
        <div>
          <span style={{ fontSize: 11, color: 'var(--faint)' }}>Already in Signal Sense</span>
          <ul className="wf-chips">
            {existing.map(e => (
              <li key={e.field_value} className="wf-chip">
                <span>{e.field_value}</span>
                {e.sub_value_name && (
                  <span style={{ fontSize: 11, color: 'var(--faint)' }}>· {e.sub_value_name}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {tags.length === 0 && disabled && (
        <span style={{ fontSize: 12, color: 'var(--faint)' }}>—</span>
      )}

      {tags.map((t, i) => {
        const theirs = existingByValue.get(t.field_value)
        return (
          <div key={`${t.field_value}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span className="wf-chip" style={{ margin: 0 }}>
              <span>{t.field_value}</span>
              {!disabled && (
                <button type="button" title="Remove tag" onClick={() => remove(i)}>✕</button>
              )}
            </span>
            <select
              className="input"
              style={{ width: 170, fontSize: 12 }}
              value={t.sub_value_id ?? ''}
              disabled={disabled}
              onChange={e => setSub(i, e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">-- None --</option>
              {subValues.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {theirs && (
              <span style={{ fontSize: 11, color: 'var(--warn, #b45309)' }}>
                already in Signal Sense{theirs.sub_value_name ? ` · ${theirs.sub_value_name}` : ''}
              </span>
            )}
          </div>
        )
      })}

      {!disabled && (adding ? (
        <div className="wf-gamesearch" style={{ position: 'relative' }}>
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { setAdding(false); setQuery('') }
              if (e.key === 'Enter' && hits.length === 1) add(hits[0])
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
                  <button type="button" onClick={() => add(h)}>
                    <span className="wf-hit-title">{h}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <button type="button" className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }}
          onClick={() => setAdding(true)}>+ Add trend</button>
      ))}
    </div>
  )
}
