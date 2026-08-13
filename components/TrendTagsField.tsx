'use client'
import { useMemo } from 'react'
import { TrendValuePicker } from './TrendValuePicker'

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
  /** True when the Trends catalog failed to load — must read as a load failure,
   * never as "no trends exist" or "no matches". */
  optionsError?: boolean
  /** Re-fetches the Trends catalog. Only meaningful when `optionsError` is true. */
  onRetryOptions?: () => void
  /** True when THIS GAME's tags could not be loaded. The list on screen is then
   * not the saved list, so the field must say so and stay read-only: saving must
   * never replace pending proposals with a set the user never saw. */
  loadError?: boolean
  /** Re-fetches this game's tags. Only meaningful when `loadError` is true. */
  onRetryLoad?: () => void
}

// Trends tagging for one game. Proposals only: nothing here reaches Signal Sense
// until an admin confirms in Evaluations > Tagging. New Trends values are never
// created from this app, so the combobox filters a fixed list.
export function TrendTagsField({ value, existing, options, subValues, onChange, disabled, optionsError, onRetryOptions, loadError, onRetryLoad }: Props) {
  const tags = value || []
  // A failed load means what is on screen is not the saved set, so nothing here
  // is editable until it succeeds.
  const ro = disabled || !!loadError

  const taken = useMemo(() => new Set(tags.map(t => t.field_value)), [tags])
  const existingByValue = useMemo(
    () => new Map(existing.map(e => [e.field_value, e])), [existing])

  const add = (fieldValue: string) => {
    onChange([...tags, { field_value: fieldValue, sub_value_id: null }])
  }
  const remove = (i: number) => onChange(tags.filter((_, x) => x !== i))
  const setSub = (i: number, subId: number | null) =>
    onChange(tags.map((t, x) => (x === i ? { ...t, sub_value_id: subId } : t)))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {loadError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="wf-hint">
            This game&apos;s tags failed to load — the list below is not what is saved, so it
            is read-only and saving will leave the existing proposals untouched
          </span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onRetryLoad}>Retry</button>
        </div>
      )}

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

      {tags.length === 0 && ro && !loadError && (
        <span style={{ fontSize: 12, color: 'var(--faint)' }}>—</span>
      )}

      {tags.map((t, i) => {
        const theirs = existingByValue.get(t.field_value)
        return (
          <div key={`${t.field_value}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span className="wf-chip" style={{ margin: 0 }}>
              <span>{t.field_value}</span>
              {!ro && (
                <button type="button" title="Remove tag" onClick={() => remove(i)}>✕</button>
              )}
            </span>
            <select
              className="input"
              style={{ width: 170, fontSize: 12 }}
              value={t.sub_value_id ?? ''}
              disabled={ro}
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

      {!ro && optionsError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="wf-hint">Trends list failed to load — not that this value doesn&apos;t exist</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onRetryOptions}>Retry</button>
        </div>
      )}

      {!ro && !optionsError && (
        <div style={{ alignSelf: 'flex-start', minWidth: 220 }}>
          <TrendValuePicker options={options} exclude={taken} onPick={add} label="+ Add trend" />
        </div>
      )}
    </div>
  )
}
