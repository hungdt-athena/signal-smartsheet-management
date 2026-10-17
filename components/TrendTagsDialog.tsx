'use client'
import { useLayoutEffect, useMemo, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { IconX } from '@/components/ui/SearchInput'
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
  /** Category groups each trend is defined for, and this game's category group:
   *  the picker opens on that group's trends. */
  categoryGroups?: Record<string, string[]>
  categoryGroup?: string | null
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
  gameId, value, existing, options, categoryGroups, categoryGroup, subValues, onSave, onClose, optionsError, onRetryOptions,
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

  // The evaluation panel underneath listens on window for Esc and ←/→. Modal closes on
  // Esc and marks it handled, so the panel leaves it alone. The arrows are claimed here
  // (capture phase, marked handled) so they do not switch to another game behind this
  // dialog. Keys typed into a field are left to the field, as the panel already ignores
  // them; Esc typed into one (the trend search) is marked handled too, so it closes the
  // search list and not the whole dialog with the draft in it.
  // A layout effect, not a passive one: it must be on window before Modal's listener,
  // which a passive effect would not be (Modal is the child, its effects run first).
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const t = e.target
      const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
      if (e.key === 'Escape') { if (typing) e.preventDefault(); return }
      if (typing || t instanceof HTMLSelectElement) return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const filled = draft.filter(r => r.field_value)
  const save = () => {
    onSave(filled.map(r => ({ field_value: r.field_value, sub_value_id: r.sub_value_id })))
    onClose()
  }

  // Nested above the evaluation panel (z-index 900), below the picker's list (1000).
  // The look (no scrim, real border, deep shadow) lives in app/styles/panel.css.
  return (
    <Modal title="Trends tags" sub="An admin reviews these before they reach Signal Sense."
      onClose={onClose} width={560} zIndex={950} className="trend-dialog"
      footer={<>
        <span style={{ fontSize: 12, color: 'var(--faint)', marginRight: 'auto' }}>
          {filled.length} tag{filled.length === 1 ? '' : 's'} · saved with the evaluation
        </span>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}>Save</button>
      </>}>
      <div>
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
            <span style={{ fontSize: 13, color: 'var(--text)' }}>
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
                        categoryGroups={categoryGroups}
                        categoryGroup={categoryGroup}
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
                        aria-label="Sub-value"
                        value={r.sub_value_id ?? ''}
                        onChange={e => setRow(i, { sub_value_id: e.target.value ? Number(e.target.value) : null })}
                      >
                        <option value="">None</option>
                        {subValues.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                      <button type="button" className="x-btn"
                        onClick={() => removeRow(i)} title="Remove this trend" aria-label="Remove this trend">
                        <IconX size={14} />
                      </button>
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

            <button type="button" className="btn btn-sm btn-link" onClick={addRow}
              style={{ marginTop: 10 }}>+ Add another trend</button>

            <p style={{ margin: '14px 0 0', fontSize: 12, color: 'var(--faint)', lineHeight: 1.6 }}>
              Pick from the {options.length} trends already in Signal Sense — an admin adds new ones there.
              {categoryGroup && categoryGroups ? ` The list opens on ${categoryGroup} trends.` : ''}
              Sub-value says how this game relates to the trend.
            </p>
          </>
        )}
      </div>
    </Modal>
  )
}
