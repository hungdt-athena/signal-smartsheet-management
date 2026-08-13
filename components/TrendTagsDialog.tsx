'use client'
import { useMemo, useState } from 'react'
import { TrendValuePicker } from './TrendValuePicker'
import type { TrendTag, ExistingTrendTag } from './TrendTagsField'

// A draft row. `field_value` is '' for a block the user added but has not filled
// in yet — those are dropped on Save rather than blocking it.
type Draft = { field_value: string; sub_value_id: number | null }

interface Props {
  value: TrendTag[]
  existing: ExistingTrendTag[]
  options: string[]
  subValues: { id: number; name: string }[]
  onSave: (next: TrendTag[]) => void
  onClose: () => void
  optionsError?: boolean
  onRetryOptions?: () => void
}

// Trends tagging popup, laid out like Signal Sense's own "Custom Field Tags"
// dialog so the two feel like one tool: a card per tag with Tag Name / Tag Value /
// Sub-Value, an "Add New Tag" affordance, and a tips box. Two deliberate
// differences: Tag Name is locked to Trends (this app tags nothing else), and one
// card holds exactly one value so each can carry its own sub-value — Signal
// Sense's multi-select shares one sub-value across a whole card.
//
// Save only commits to the evaluation form's state; the evaluation's own Save (or
// auto-save) is what persists it, same as every other field in that modal.
export function TrendTagsDialog({
  value, existing, options, subValues, onSave, onClose, optionsError, onRetryOptions,
}: Props) {
  const [draft, setDraft] = useState<Draft[]>(() =>
    value.length > 0 ? value.map(t => ({ ...t })) : [{ field_value: '', sub_value_id: null }])

  const existingByValue = useMemo(
    () => new Map(existing.map(e => [e.field_value, e])), [existing])

  const setRow = (i: number, patch: Partial<Draft>) =>
    setDraft(d => d.map((r, x) => (x === i ? { ...r, ...patch } : r)))
  const removeRow = (i: number) => setDraft(d => d.filter((_, x) => x !== i))
  const addRow = () => setDraft(d => [...d, { field_value: '', sub_value_id: null }])

  // Values already spoken for elsewhere in the draft, so the picker cannot
  // produce a duplicate the server would silently collapse.
  const takenBy = (i: number) =>
    new Set(draft.filter((_, x) => x !== i).map(r => r.field_value).filter(Boolean))

  const filled = draft.filter(r => r.field_value)
  const save = () => {
    onSave(filled.map(r => ({ field_value: r.field_value, sub_value_id: r.sub_value_id })))
    onClose()
  }

  return (
    // Nested above the evaluation modal (which sits at z-index 900).
    <div className="eval-modal-backdrop" style={{ zIndex: 950 }} onClick={onClose}>
      <div className="eval-modal-container" onClick={e => e.stopPropagation()}
        style={{ padding: '20px 24px 20px', maxWidth: 640, width: '96vw', maxHeight: '88vh', overflowY: 'auto' }}>

        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Trends Tags</h2>
            <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--faint)' }}>
              Tag this game with Trends values. Nothing reaches Signal Sense until an admin confirms.
            </p>
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: '4px 10px', fontSize: 12 }}>✕</button>
        </div>

        {existing.length > 0 && (
          <div style={{ marginTop: 14 }}>
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

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>
          {draft.map((r, i) => {
            const theirs = r.field_value ? existingByValue.get(r.field_value) : undefined
            return (
              <div key={i} style={{
                border: '1px solid var(--border, rgba(255,255,255,0.10))',
                borderRadius: 12, padding: 14,
                display: 'flex', flexDirection: 'column', gap: 10,
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <span className="label">Tag Name</span>
                    {/* Locked: this app only ever tags Trends. */}
                    <input className="input" value="Trends" readOnly disabled style={{ width: '100%' }} />
                  </div>
                  <button type="button" className="btn btn-sm btn-ghost" title="Remove this tag"
                    onClick={() => removeRow(i)}
                    style={{ color: 'var(--bad, #d23b3b)', borderColor: 'var(--bad, #d23b3b)' }}>✕</button>
                </div>

                <div>
                  <span className="label">Tag Value</span>
                  {optionsError ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="wf-hint">Trends list failed to load — not that this value doesn&apos;t exist</span>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={onRetryOptions}>Retry</button>
                    </div>
                  ) : (
                    <TrendValuePicker
                      options={options}
                      exclude={takenBy(i)}
                      onPick={v => setRow(i, { field_value: v })}
                      label={r.field_value || 'Enter tag value…'}
                      title={r.field_value ? 'Change this value' : 'Search Trends values'}
                      triggerClassName="input"
                    />
                  )}
                </div>

                <div>
                  <span className="label">Sub-Value <span style={{ color: 'var(--faint)', fontWeight: 400 }}>(optional)</span></span>
                  <select
                    className="input"
                    style={{ width: '100%' }}
                    value={r.sub_value_id ?? ''}
                    onChange={e => setRow(i, { sub_value_id: e.target.value ? Number(e.target.value) : null })}
                  >
                    <option value="">-- None --</option>
                    {subValues.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>

                {theirs && (
                  <span style={{ fontSize: 11, color: 'var(--warn, #b45309)' }}>
                    Already in Signal Sense{theirs.sub_value_name ? ` · ${theirs.sub_value_name}` : ''} — an admin
                    will see this as a duplicate{theirs.sub_value_name ? ' or a conflict' : ''}
                  </span>
                )}
              </div>
            )
          })}
        </div>

        <button type="button" onClick={addRow}
          style={{
            marginTop: 12, width: '100%', padding: '10px 0',
            border: '1px dashed var(--border, rgba(255,255,255,0.18))',
            borderRadius: 12, background: 'transparent',
            color: 'var(--accent)', fontSize: 13, cursor: 'pointer',
          }}>+ Add New Tag</button>

        <div style={{
          marginTop: 14, padding: 12, borderRadius: 12,
          border: '1px solid rgba(245, 130, 32, 0.22)', background: 'rgba(245, 130, 32, 0.07)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span aria-hidden>💡</span>
            <strong style={{ fontSize: 12.5 }}>Quick Tips:</strong>
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--faint)', lineHeight: 1.7 }}>
            <li>Pick from the existing Trends list — new values are created in Signal Sense by an admin</li>
            <li>Sub-Value says how this game relates to the trend: Change Theme or Gameplay Variant</li>
            <li>One tag per value; add another tag to give a different value its own Sub-Value</li>
          </ul>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <span style={{ fontSize: 11.5, color: 'var(--faint)', marginRight: 'auto' }}>
            {filled.length} tag{filled.length === 1 ? '' : 's'} · saved with the evaluation
          </span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  )
}
