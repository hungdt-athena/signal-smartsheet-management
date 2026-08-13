'use client'
import { useMemo, useState } from 'react'
import { TrendTagsDialog } from './TrendTagsDialog'

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

// Trends tagging for one game: a summary of what is tagged plus a button that
// opens the editor. Proposals only — nothing here reaches Signal Sense until an
// admin confirms in Evaluations > Tagging.
export function TrendTagsField({
  value, existing, options, subValues, onChange, disabled,
  optionsError, onRetryOptions, loadError, onRetryLoad,
}: Props) {
  const [open, setOpen] = useState(false)
  const tags = value || []
  // A failed load means what is on screen is not the saved set, so nothing here
  // is editable until it succeeds.
  const ro = disabled || !!loadError

  const subName = useMemo(
    () => new Map(subValues.map(s => [s.id, s.name])), [subValues])
  const existingByValue = useMemo(
    () => new Map(existing.map(e => [e.field_value, e])), [existing])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {loadError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="wf-hint">
            This game&apos;s tags failed to load — nothing is shown below and saving will leave
            the existing proposals untouched
          </span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onRetryLoad}>Retry</button>
        </div>
      )}

      {!loadError && tags.length > 0 && (
        <div>
          <span style={{ fontSize: 11, color: 'var(--faint)' }}>Pending</span>
          <ul className="wf-chips">
            {tags.map((t, i) => {
              const theirs = existingByValue.get(t.field_value)
              const sub = t.sub_value_id != null ? subName.get(t.sub_value_id) : null
              return (
                <li key={`${t.field_value}-${i}`} className="wf-chip"
                  title={theirs ? 'Already in Signal Sense — an admin will see this as a duplicate or a conflict' : undefined}>
                  <span>{t.field_value}</span>
                  {sub && <span style={{ fontSize: 11, color: 'var(--faint)' }}>· {sub}</span>}
                  {theirs && <span style={{ fontSize: 11, color: 'var(--warn, #b45309)' }}>· in SS</span>}
                </li>
              )
            })}
          </ul>
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

      {!loadError && tags.length === 0 && existing.length === 0 && (
        <span style={{ fontSize: 12, color: 'var(--faint)' }}>—</span>
      )}

      {!ro && (
        <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }}
          onClick={() => setOpen(true)}>
          {tags.length > 0 ? `Manage Trends Tags (${tags.length})` : 'Manage Trends Tags'}
        </button>
      )}

      {open && (
        <TrendTagsDialog
          value={tags}
          existing={existing}
          options={options}
          subValues={subValues}
          optionsError={optionsError}
          onRetryOptions={onRetryOptions}
          onSave={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
