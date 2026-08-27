'use client'
import { useMemo, useState } from 'react'
import { TrendValuePicker } from './TrendValuePicker'
import { ExistingTrendTags, type ExistingTagChange, type ExistingTrendTag } from './ExistingTrendTags'
import type { TrendTag } from './TrendTagsField'

// A draft row. `field_value` is '' for a row the user added but has not filled in
// yet — those are dropped on Save rather than blocking it.
type Draft = { field_value: string; sub_value_id: number | null }

interface Props {
  gameId: string
  value: TrendTag[]
  existing: ExistingTrendTag[]
  /** True for the manager tier: the tags already in Signal Sense become live
   *  here too, not only in the field behind this dialog. */
  canEditExisting?: boolean
  onExistingChanged?: (change: ExistingTagChange) => void
  options: string[]
  subValues: { id: number; name: string }[]
  onSave: (next: TrendTag[]) => void
  onClose: () => void
  optionsError?: boolean
  onRetryOptions?: () => void
}

// Trends tagging popup for one game. Tag name is not shown: this app tags nothing
// but Trends, so a locked field for it is noise. Each row is one value plus its
// own optional sub-value — Signal Sense shares one sub-value across a multi-select
// card, which cannot express "this trend by theme, that one by gameplay".
//
// Save commits to the evaluation form's state; the evaluation's own Save (or
// auto-save) persists it, exactly like every other field in that modal.
export function TrendTagsDialog({
  gameId, value, existing, options, subValues, onSave, onClose, optionsError, onRetryOptions,
  canEditExisting, onExistingChanged,
}: Props) {
  const [draft, setDraft] = useState<Draft[]>(() =>
    value.length > 0 ? value.map(t => ({ ...t })) : [{ field_value: '', sub_value_id: null }])

  const existingByValue = useMemo(
    () => new Map(existing.map(e => [e.field_value, e])), [existing])

  const setRow = (i: number, patch: Partial<Draft>) =>
    setDraft(d => d.map((r, x) => (x === i ? { ...r, ...patch } : r)))
  const removeRow = (i: number) => setDraft(d => d.filter((_, x) => x !== i))
  const addRow = () => setDraft(d => [...d, { field_value: '', sub_value_id: null }])

  // Values spoken for elsewhere in the draft, so the picker cannot produce a
  // duplicate the server would silently collapse.
  const takenBy = (i: number) =>
    new Set(draft.filter((_, x) => x !== i).map(r => r.field_value).filter(Boolean))

  const filled = draft.filter(r => r.field_value)
  const save = () => {
    onSave(filled.map(r => ({ field_value: r.field_value, sub_value_id: r.sub_value_id })))
    onClose()
  }

  return (
    // Nested above the evaluation modal, which sits at z-index 900. No scrim: a
    // second layer of dimming made the evaluation modal read as another container
    // behind this one. The layer stays to catch click-outside, so it must be
    // transparent rather than absent. Shadow and a real border do the separating
    // — the shared container's border is a white alpha that vanishes on this
    // light theme, which is invisible against the white panel behind it.
    <div className="eval-modal-backdrop"
      style={{ zIndex: 950, background: 'transparent', backdropFilter: 'none' }}
      onClick={onClose}>
      <div className="eval-modal-container" onClick={e => e.stopPropagation()}
        style={{
          maxWidth: 560, width: '94vw', maxHeight: '86vh',
          display: 'flex', flexDirection: 'column',
          border: '1px solid var(--border-strong)',
          boxShadow: '0 30px 70px rgba(20, 24, 40, 0.28)',
        }}>

        <header style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          gap: 12, padding: '18px 20px 14px', borderBottom: '1px solid var(--border)',
        }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650, letterSpacing: '-0.01em' }}>Trends tags</h2>
            <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--muted)' }}>
              An admin reviews these before they reach Signal Sense.
            </p>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} title="Close">✕</button>
        </header>

        <div style={{ padding: '14px 20px', overflowY: 'auto', flex: 1 }}>
          <section style={{ marginBottom: existing.length > 0 ? 16 : 0 }}>
            <ExistingTrendTags
              gameId={gameId}
              tags={existing}
              subValues={subValues}
              canEdit={!!canEditExisting}
              onChanged={c => onExistingChanged?.(c)}
            />
          </section>

          {optionsError ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: 12,
              borderRadius: 10, background: 'var(--bad-weak)', border: '1px solid var(--bad)',
            }}>
              <span style={{ fontSize: 12.5, color: 'var(--text)' }}>
                The trends list didn&apos;t load, so there&apos;s nothing to pick from yet.
              </span>
              <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={onRetryOptions}>
                Try again
              </button>
            </div>
          ) : (
            <>
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 168px 30px', gap: 8,
                fontSize: 11, fontWeight: 600, color: 'var(--faint)',
                textTransform: 'uppercase', letterSpacing: '0.04em', padding: '0 0 6px',
              }}>
                <span>Trend</span>
                <span>Sub-value</span>
                <span />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {draft.map((r, i) => {
                  const theirs = r.field_value ? existingByValue.get(r.field_value) : undefined
                  return (
                    <div key={i}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 168px 30px', gap: 8, alignItems: 'center' }}>
                        <TrendValuePicker
                          options={options}
                          exclude={takenBy(i)}
                          onPick={v => setRow(i, { field_value: v })}
                          label={r.field_value || 'Pick a trend'}
                          placeholder={!r.field_value}
                          title={r.field_value ? 'Change this trend' : 'Browse or search trends'}
                          triggerClassName="input"
                          triggerStyle={{ fontSize: 13 }}
                        />
                        <select
                          className="input"
                          style={{ fontSize: 13 }}
                          value={r.sub_value_id ?? ''}
                          onChange={e => setRow(i, { sub_value_id: e.target.value ? Number(e.target.value) : null })}
                        >
                          <option value="">None</option>
                          {subValues.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                        <button type="button" className="btn btn-sm btn-ghost"
                          onClick={() => removeRow(i)} title="Remove this trend"
                          style={{ padding: '6px 0', justifyContent: 'center', color: 'var(--faint)' }}>✕</button>
                      </div>
                      {theirs && (
                        <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--warn)' }}>
                          Signal Sense already has this
                          {theirs.sub_value_name ? ` as ${theirs.sub_value_name}` : ' without a sub-value'} —
                          the admin will see a {theirs.sub_value_name ? 'conflict' : 'duplicate'}.
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>

              <button type="button" onClick={addRow}
                style={{
                  marginTop: 10, width: '100%', padding: '9px 0',
                  border: '1px dashed var(--border-strong)', borderRadius: 9,
                  background: 'transparent', color: 'var(--accent)',
                  fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
                }}>+ Add another trend</button>

              <p style={{ margin: '14px 0 0', fontSize: 11.5, color: 'var(--faint)', lineHeight: 1.6 }}>
                Pick from the {options.length} trends already in Signal Sense — an admin adds new ones there.
                Sub-value says how this game relates to the trend.
              </p>
            </>
          )}
        </div>

        <footer style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px 20px 16px', borderTop: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 11.5, color: 'var(--faint)', marginRight: 'auto' }}>
            {filled.length} tag{filled.length === 1 ? '' : 's'} · saved with the evaluation
          </span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save}>Save</button>
        </footer>
      </div>
    </div>
  )
}
