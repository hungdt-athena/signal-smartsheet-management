'use client'
import { useMemo, useState } from 'react'
import { TrendTagsDialog } from './TrendTagsDialog'
import { TrendTagReview, type ReviewChange, type ReviewTag } from './TrendTagReview'

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
  /** The pending proposals in full, for the manager review rows. Empty for
   *  everyone else, who sees the same tags as plain chips. */
  review?: ReviewTag[]
  /** True for the manager tier: the waiting tags become reviewable rows. */
  canReview?: boolean
  /** Called with what a review action did, so the caller can apply it without
   *  re-reading the game. */
  onReviewed?: (change: ReviewChange) => void
}

// Trend values are catalog identifiers owned by Signal Sense, not prose, so they
// are set in the utility face wherever they appear — here and in the dialog.
const CHIP_LABEL: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 600, color: 'var(--faint)',
  textTransform: 'uppercase', letterSpacing: '0.04em',
}
const CHIP_ROW: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 5 }
const CHIP: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'baseline', gap: 5,
  padding: '4px 9px', borderRadius: 7, background: 'var(--surface-2)',
  border: '1px solid var(--border)', fontSize: 12, fontFamily: 'var(--num)',
}
const CHIP_SUB: React.CSSProperties = { fontSize: 10.5, color: 'var(--faint)', fontFamily: 'var(--font)' }

// Trends tagging for one game: a summary of what is tagged plus a button that
// opens the editor. Proposals only — nothing here reaches Signal Sense until an
// admin confirms in Evaluations > Tagging.
export function TrendTagsField({
  value, existing, options, subValues, onChange, disabled,
  optionsError, onRetryOptions, loadError, onRetryLoad,
  review, canReview, onReviewed,
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

      {/* A manager reviews the waiting tags here rather than going to the
          Tagging tab for the game they already have open. Everyone else sees
          them as chips: proposals, and nothing they can act on. */}
      {!loadError && canReview && (review?.length ?? 0) > 0 && (
        <div>
          <span style={CHIP_LABEL}>Waiting for review</span>
          <TrendTagReview
            tags={review ?? []}
            options={options}
            subValues={subValues}
            optionsError={optionsError}
            onReviewed={c => onReviewed?.(c)}
          />
        </div>
      )}

      {!loadError && !canReview && tags.length > 0 && (
        <div>
          <span style={CHIP_LABEL}>Waiting for review</span>
          <div style={CHIP_ROW}>
            {tags.map((t, i) => {
              const theirs = existingByValue.get(t.field_value)
              const sub = t.sub_value_id != null ? subName.get(t.sub_value_id) : null
              return (
                <span key={`${t.field_value}-${i}`}
                  style={{ ...CHIP, ...(theirs ? { borderColor: 'var(--warn)', background: 'var(--warn-weak)' } : null) }}
                  title={theirs ? 'Signal Sense already has this trend — the admin will see a duplicate or a conflict' : undefined}>
                  {t.field_value}
                  {sub && <span style={CHIP_SUB}>{sub}</span>}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {existing.length > 0 && (
        <div>
          <span style={CHIP_LABEL}>Already in Signal Sense</span>
          <div style={CHIP_ROW}>
            {existing.map(e => (
              <span key={e.field_value} style={CHIP}>
                {e.field_value}
                {e.sub_value_name && <span style={CHIP_SUB}>{e.sub_value_name}</span>}
              </span>
            ))}
          </div>
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
