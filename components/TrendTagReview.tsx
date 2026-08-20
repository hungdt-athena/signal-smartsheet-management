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

/** What a review action did, in enough detail that the caller can apply it to
 *  its own state without re-reading the game. Re-reading is what made this feel
 *  slow: a round trip per click, for a change already described by the response
 *  to that click.
 *
 *  `landed` says the tag reached Signal Sense (inserted, enriched, overwritten,
 *  or already there) rather than being rejected or dropped as inactive. */
export type ReviewChange =
  | { kind: 'resolved'; tag: ReviewTag; landed: boolean }
  /** `previous` is the value before the edit: an edit can rename the trend, and
   *  the caller's own list is keyed on the value, not the id. */
  | { kind: 'edited'; previous: string; tag: ReviewTag }

interface Props {
  tags: ReviewTag[]
  options: string[]
  subValues: { id: number; name: string }[]
  /** True when the Trends catalog failed to load: a tag can still be confirmed
   *  or rejected, it just cannot be corrected first. */
  optionsError?: boolean
  onReviewed: (change: ReviewChange) => void
}

/** Sync outcomes that mean the tag is in Signal Sense now. */
const LANDED = new Set(['inserted', 'duplicate', 'enriched', 'overwritten'])

const PILL: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '3px 4px 3px 9px', borderRadius: 7, background: 'var(--surface-2)',
  border: '1px solid var(--border)', fontSize: 12, fontFamily: 'var(--num)',
}
const SUB: React.CSSProperties = { fontSize: 10.5, color: 'var(--faint)', fontFamily: 'var(--font)' }
const ICON: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 20, height: 20, padding: 0, borderRadius: 5, lineHeight: 1,
  border: '1px solid transparent', background: 'transparent', cursor: 'pointer',
  fontSize: 12, fontWeight: 700,
}
const PANEL: React.CSSProperties = {
  marginTop: 6, padding: 10, borderRadius: 8,
  border: '1px solid var(--border)', background: 'var(--surface)',
  display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 460,
}
const CTL: React.CSSProperties = { fontSize: 12.5, padding: '6px 9px', width: '100%' }

/** Which panel a pill has open. `null` = just the pill. */
type Open = 'confirm' | 'options' | 'edit'

// Reviewing a proposal without leaving the game it was made on.
//
// The pill is the tag; the two icons are the whole decision. ✓ confirms it
// outright -- the common case, one click. ✕ opens the rest: reject it, or edit
// it and leave it pending for another look.
//
// A conflict cannot be one click: confirming it means overwriting a sub-value
// Signal Sense already has, so ✓ opens a panel that says whose value is at stake
// before anything is written.
//
// Every action here goes through the review endpoints, never the evaluation
// form's save. So the record stays split the way the History view reads it:
// proposed by the evaluator, reviewed by whoever pressed these buttons, with the
// original snapshotted the first time an edit moves the tag.
export function TrendTagReview({ tags, options, subValues, optionsError, onReviewed }: Props) {
  const [busy, setBusy] = useState<Set<number>>(new Set())
  const [open, setOpen] = useState<Record<number, Open>>({})
  const [notes, setNotes] = useState<Record<number, string>>({})
  const [error, setError] = useState<string | null>(null)

  const used = tags.map(t => t.field_value)
  const setOpenFor = (id: number, next: Open | null) =>
    setOpen(prev => {
      const copy = { ...prev }
      if (next) copy[id] = next; else delete copy[id]
      return copy
    })

  /** Runs one review call and turns its response into a ReviewChange. */
  const run = async (
    t: ReviewTag,
    work: () => Promise<Response>,
    read: (body: Record<string, unknown>) => ReviewChange,
  ) => {
    setBusy(prev => new Set(prev).add(t.id))
    setError(null)
    try {
      const res = await work()
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError((body as { error?: string }).error || 'That did not go through — nothing was changed.')
        return
      }
      const change = read(body as Record<string, unknown>)
      if (change.kind === 'resolved') setOpenFor(t.id, null)
      onReviewed(change)
    } catch {
      setError('That did not go through — nothing was changed.')
    } finally {
      setBusy(prev => { const next = new Set(prev); next.delete(t.id); return next })
    }
  }

  const patch = (t: ReviewTag, body: { field_value?: string; sub_value_id?: number | null }) =>
    run(t, () => fetch(`/api/playtest-tags/${t.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), res => ({
      kind: 'edited',
      previous: t.field_value,
      // PATCH answers with the row re-read the way the queue reads it. Merged
      // over the old one because its fallback path (the row was resolved between
      // the write and the read-back) answers with the bare columns.
      tag: { ...t, ...(res.tag as Partial<ReviewTag> | undefined) },
    }))

  const confirm = (t: ReviewTag, overwrite: boolean) =>
    run(t, () => fetch('/api/playtest-tags/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        game_id: t.game_id, ids: [t.id],
        overwrite: overwrite ? [t.id] : [],
        notes: notes[t.id] ? { [t.id]: notes[t.id] } : {},
      }),
    }), res => {
      const results = (res.results as { id: number; result: string }[] | undefined) ?? []
      const mine = results.find(r => r.id === t.id)
      return { kind: 'resolved', tag: t, landed: !!mine && LANDED.has(mine.result) }
    })

  const reject = (t: ReviewTag) =>
    run(t, () => fetch('/api/playtest-tags/reject', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [t.id], notes: notes[t.id] ? { [t.id]: notes[t.id] } : {} }),
    }), () => ({ kind: 'resolved', tag: t, landed: false }))

  const noteBox = (t: ReviewTag, working: boolean) => (
    <input
      className="input" style={CTL} placeholder="Note to the evaluator — optional" maxLength={500}
      value={notes[t.id] || ''} disabled={working}
      aria-label={`Note to the evaluator about ${t.field_value}`}
      onChange={e => setNotes(prev => ({ ...prev, [t.id]: e.target.value }))}
    />
  )

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 5 }}>
      {error && (
        <div className="wf-hint" style={{ color: 'var(--danger)', width: '100%' }}>{error}</div>
      )}
      {tags.map(t => {
        const working = busy.has(t.id)
        const panel = open[t.id]
        return (
          <div key={t.id} style={{ width: panel ? '100%' : 'auto' }}>
            <span style={{ ...PILL, opacity: working ? 0.5 : 1, ...(t.conflict ? { borderColor: 'var(--warn)', background: 'var(--warn-weak)' } : null) }}>
              {t.field_value}
              {t.sub_value_name && <span style={SUB}>{t.sub_value_name}</span>}
              <span style={{ ...SUB, fontStyle: 'italic' }}>· {t.tagged_by_name || t.tagged_by}</span>
              <button type="button" disabled={working}
                title={t.conflict ? 'Review this conflict' : 'Confirm — sync into Signal Sense'}
                aria-label={`Confirm ${t.field_value}`}
                style={{ ...ICON, color: 'var(--ok, #2e9e6b)' }}
                onClick={() => (t.conflict ? setOpenFor(t.id, 'confirm') : confirm(t, false))}>✓</button>
              <button type="button" disabled={working}
                title="Reject or edit this tag"
                aria-label={`Reject or edit ${t.field_value}`}
                style={{ ...ICON, color: 'var(--faint)' }}
                onClick={() => setOpenFor(t.id, panel === 'options' || panel === 'edit' ? null : 'options')}>✕</button>
            </span>

            {panel === 'confirm' && (
              <div style={PANEL}>
                <span style={{ fontSize: 12, color: 'var(--warn)' }}>
                  Signal Sense already has <strong>{t.field_value}</strong> with{' '}
                  <strong>{t.their_sub_value_name}</strong>. Confirming replaces it with{' '}
                  <strong>{t.sub_value_name || 'no sub-value'}</strong>.
                </span>
                {noteBox(t, working)}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="btn btn-sm btn-primary" disabled={working}
                    onClick={() => confirm(t, true)}>Confirm and overwrite</button>
                  <button type="button" className="btn btn-sm btn-ghost" disabled={working}
                    onClick={() => setOpenFor(t.id, null)}>Cancel</button>
                </div>
              </div>
            )}

            {panel === 'options' && (
              <div style={PANEL}>
                {noteBox(t, working)}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="btn btn-sm" disabled={working}
                    onClick={() => reject(t)}>Reject</button>
                  <button type="button" className="btn btn-sm" disabled={working || optionsError}
                    title={optionsError ? 'The Trends catalog failed to load' : 'Correct this tag and leave it pending'}
                    onClick={() => setOpenFor(t.id, 'edit')}>Edit</button>
                  <button type="button" className="btn btn-sm btn-ghost" disabled={working}
                    onClick={() => setOpenFor(t.id, null)}>Cancel</button>
                </div>
              </div>
            )}

            {panel === 'edit' && (
              <div style={PANEL}>
                {/* Edits save on pick, one field at a time, and the tag stays
                    pending: correcting a tag is not the same as approving it. */}
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
                <select
                  className="input" style={CTL} value={t.sub_value_id ?? ''} disabled={working}
                  aria-label={`Sub-value for ${t.field_value}`}
                  onChange={e => patch(t, { sub_value_id: e.target.value ? Number(e.target.value) : null })}
                >
                  <option value="">None</option>
                  {subValues.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <span className="wf-hint">
                  Saved as you pick. The evaluator keeps the credit; History shows them what you
                  changed.
                </span>
                <button type="button" className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }}
                  disabled={working} onClick={() => setOpenFor(t.id, null)}>Done</button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
