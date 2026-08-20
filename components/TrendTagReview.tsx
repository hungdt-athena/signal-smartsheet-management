'use client'
import { useState } from 'react'
import { TrendValuePicker } from './TrendValuePicker'

/** One pending proposal, as `GET /api/playtest-tags` returns it (the shape
 *  `lib/playtest-tags-queue.ts` produces, so `conflict` is the same verdict the
 *  admin queue shows). */
export interface ReviewTag {
  id: number
  game_id: string
  field_value: string
  sub_value_id: number | null
  sub_value_name: string | null
  tagged_by: string
  tagged_by_name: string | null
  their_sub_value_name: string | null
  conflict: boolean
}

interface Props {
  tags: ReviewTag[]
  options: string[]
  subValues: { id: number; name: string }[]
  /** True when the Trends catalog failed to load: the row still resolves, it
   *  just cannot be corrected first. */
  optionsError?: boolean
  /** Called after a tag leaves the pending set, with the value that left, so the
   *  caller can drop it from the editable list instead of re-proposing it on the
   *  next save. */
  onReviewed: (fieldValue: string) => void
}

const ROW: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'minmax(0,1.1fr) minmax(0,1fr) minmax(0,1.2fr) auto',
  gap: 8, alignItems: 'start',
  padding: '8px 0', borderTop: '1px solid var(--border)',
}
const CTL: React.CSSProperties = { fontSize: 12.5, padding: '6px 9px', width: '100%' }
const META: React.CSSProperties = { fontSize: 11, color: 'var(--faint)', display: 'block', marginTop: 3 }

// Reviewing a proposal without leaving the game it was made on.
//
// The same three decisions the Tagging queue offers -- correct it, confirm it,
// reject it -- against the same endpoints. They fire on click rather than
// waiting for the form's Save: a tag should not sit unreviewed because someone
// closed a modal without saving, and the evaluation form's own fields have
// nothing to do with this one.
export function TrendTagReview({ tags, options, subValues, optionsError, onReviewed }: Props) {
  const [busy, setBusy] = useState<Set<number>>(new Set())
  const [notes, setNotes] = useState<Record<number, string>>({})
  const [overwrite, setOverwrite] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const used = tags.map(t => t.field_value)

  const run = async (t: ReviewTag, work: () => Promise<Response>, done: 'left' | 'stays') => {
    setBusy(prev => new Set(prev).add(t.id))
    setError(null)
    try {
      const res = await work()
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error || 'That did not go through — nothing was changed.')
        return
      }
      onReviewed(done === 'left' ? t.field_value : '')
    } catch {
      setError('That did not go through — nothing was changed.')
    } finally {
      setBusy(prev => { const next = new Set(prev); next.delete(t.id); return next })
    }
  }

  const patch = (t: ReviewTag, body: { field_value?: string; sub_value_id?: number | null }) =>
    run(t, () => fetch(`/api/playtest-tags/${t.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), 'stays')

  const confirm = (t: ReviewTag) =>
    run(t, () => fetch('/api/playtest-tags/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        game_id: t.game_id, ids: [t.id],
        overwrite: overwrite.has(t.id) ? [t.id] : [],
        notes: notes[t.id] ? { [t.id]: notes[t.id] } : {},
      }),
    }), 'left')

  const reject = (t: ReviewTag) =>
    run(t, () => fetch('/api/playtest-tags/reject', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [t.id], notes: notes[t.id] ? { [t.id]: notes[t.id] } : {} }),
    }), 'left')

  return (
    <div>
      {error && <div className="wf-hint" style={{ color: 'var(--danger)', marginBottom: 4 }}>{error}</div>}
      {tags.map(t => {
        const working = busy.has(t.id)
        return (
          <div key={t.id} style={{ ...ROW, opacity: working ? 0.5 : 1 }}>
            <div>
              {optionsError ? (
                <span className="num" style={{ fontSize: 12.5 }}>{t.field_value}</span>
              ) : (
                <TrendValuePicker
                  options={options}
                  exclude={new Set(used.filter(v => v !== t.field_value))}
                  label={t.field_value}
                  title="Change the trend value"
                  triggerClassName="input"
                  triggerStyle={CTL}
                  disabled={working}
                  onPick={v => patch(t, { field_value: v })}
                />
              )}
              <span style={META}>proposed by {t.tagged_by_name || t.tagged_by}</span>
            </div>

            <div>
              {optionsError ? (
                <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>{t.sub_value_name || 'None'}</span>
              ) : (
                <select
                  className="input" style={CTL} value={t.sub_value_id ?? ''} disabled={working}
                  aria-label={`Sub-value for ${t.field_value}`}
                  onChange={e => patch(t, { sub_value_id: e.target.value ? Number(e.target.value) : null })}
                >
                  <option value="">None</option>
                  {subValues.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              )}
              {/* A conflict changes what Confirm does to this row, so it belongs
                  on the row: Signal Sense's sub-value stands unless this is
                  ticked, and the tag is rejected instead. */}
              {t.conflict && (
                <label style={{ display: 'flex', gap: 6, marginTop: 5, fontSize: 11, color: 'var(--warn)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={overwrite.has(t.id)} disabled={working}
                    aria-label={`Overwrite ${t.their_sub_value_name} on ${t.field_value}`}
                    onChange={() => setOverwrite(prev => {
                      const next = new Set(prev)
                      if (!next.delete(t.id)) next.add(t.id)
                      return next
                    })} />
                  <span>Signal Sense has <strong>{t.their_sub_value_name}</strong> — tick to overwrite</span>
                </label>
              )}
            </div>

            <input
              className="input" style={CTL} placeholder="Optional — why" maxLength={500}
              value={notes[t.id] || ''} disabled={working}
              aria-label={`Note to the evaluator about ${t.field_value}`}
              onChange={e => setNotes(prev => ({ ...prev, [t.id]: e.target.value }))}
            />

            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" className="btn btn-sm btn-primary" disabled={working}
                onClick={() => confirm(t)}>Confirm</button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={working}
                title="Reject this tag" style={{ color: 'var(--faint)' }}
                onClick={() => reject(t)}>Reject</button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
