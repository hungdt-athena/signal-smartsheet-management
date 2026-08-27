'use client'
import { useState } from 'react'

/** A Trends tag this game already carries in Signal Sense, as
 *  `GET /api/playtest-tags` returns it. `created_by` is Signal Sense's own
 *  `users(id)`, so it names whoever tagged it over there -- including tags this
 *  app never proposed, which a manager may now still change. */
export interface ExistingTrendTag {
  field_value: string
  sub_value_name: string | null
  sub_value_id?: number | null
  created_by?: string | null
  created_by_name?: string | null
}

/** What an edit did, in enough detail that the caller can apply it without
 *  re-reading the game -- the same contract the review pills use. */
export type ExistingTagChange =
  | { kind: 'removed'; field_value: string }
  | { kind: 'sub_value'; field_value: string; sub_value_id: number | null; sub_value_name: string | null }

/** Fold an edit back into the list the caller holds, so the section reflects
 *  what just happened without another read of the game. Keyed on the value,
 *  which is the tag's identity in Signal Sense. */
export function applyExistingChange(
  tags: ExistingTrendTag[], change: ExistingTagChange,
): ExistingTrendTag[] {
  if (change.kind === 'removed') return tags.filter(t => t.field_value !== change.field_value)
  return tags.map(t => (t.field_value === change.field_value
    ? { ...t, sub_value_id: change.sub_value_id, sub_value_name: change.sub_value_name }
    : t))
}

interface Props {
  gameId: string
  tags: ExistingTrendTag[]
  subValues: { id: number; name: string }[]
  /** True for the manager tier. False leaves the chips exactly as they were:
   *  a summary, and nothing anyone can act on. */
  canEdit: boolean
  onChanged: (change: ExistingTagChange) => void
}

/** The system account this app syncs under. Not a person, so not worth naming. */
const SYNC_USER = 'playtest_sync'

const LABEL: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 600, color: 'var(--faint)',
  textTransform: 'uppercase', letterSpacing: '0.04em',
}
const CHIP: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '4px 9px', borderRadius: 7, background: 'var(--surface-2)',
  border: '1px solid var(--border)', fontSize: 12, fontFamily: 'var(--num)',
}
const CHIP_EDITABLE: React.CSSProperties = { ...CHIP, padding: '3px 4px 3px 9px' }
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

/** Which panel a chip has open. `null` = just the chip. */
type Open = 'sub' | 'remove'

// The Trends tags a game already has in Signal Sense.
//
// For everyone else this is what it always was: a read-only summary, there so
// nobody re-proposes a tag that is already in place. For the manager tier the
// chips are live -- the sub-value can be moved and the tag can be taken out,
// straight into Signal Sense, no proposal step.
//
// That is deliberately blunter than the review pills next to it, which decide
// what an evaluator proposed. These tags are already in the other app; there is
// nothing to approve, only to correct. What keeps it safe is that a removal has
// to be confirmed on a second click, and that both actions are recorded on both
// sides -- Signal Sense's change log and this app's Tagging > History.
//
// Rendered by both TrendTagsField and the Manage Trends Tags dialog, from one
// component: two copies of a destructive control is two chances to drift.
export function ExistingTrendTags({ gameId, tags, subValues, canEdit, onChanged }: Props) {
  const [open, setOpen] = useState<string | null>(null)
  const [mode, setMode] = useState<Open>('sub')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (tags.length === 0) return null

  const openPanel = (value: string, next: Open) => {
    setError(null)
    if (open === value && mode === next) { setOpen(null); return }
    setOpen(value); setMode(next)
  }

  const send = async (
    tag: ExistingTrendTag,
    init: RequestInit,
    change: ExistingTagChange,
  ) => {
    setBusy(tag.field_value)
    setError(null)
    try {
      const res = await fetch('/api/playtest-tags/existing', {
        ...init, headers: { 'Content-Type': 'application/json' },
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError((body as { error?: string }).error || 'That did not go through — nothing was changed.')
        return
      }
      setOpen(null)
      onChanged(change)
    } catch {
      setError('That did not go through — nothing was changed.')
    } finally {
      setBusy(null)
    }
  }

  const remove = (tag: ExistingTrendTag) => send(tag, {
    method: 'DELETE',
    body: JSON.stringify({ gameId, fieldValue: tag.field_value }),
  }, { kind: 'removed', field_value: tag.field_value })

  const setSubValue = (tag: ExistingTrendTag, subValueId: number | null) => send(tag, {
    method: 'PATCH',
    body: JSON.stringify({ gameId, fieldValue: tag.field_value, subValueId }),
  }, {
    kind: 'sub_value',
    field_value: tag.field_value,
    sub_value_id: subValueId,
    sub_value_name: subValues.find(s => s.id === subValueId)?.name ?? null,
  })

  return (
    <div>
      <span style={LABEL}>Already in Signal Sense</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 5 }}>
        {error && <div className="wf-hint" style={{ color: 'var(--danger)', width: '100%' }}>{error}</div>}

        {tags.map(t => {
          const working = busy === t.field_value
          const panel = open === t.field_value ? mode : null
          // Named only when a person did it: the sync account is this app itself.
          const author = t.created_by && t.created_by !== SYNC_USER ? t.created_by_name : null

          if (!canEdit) {
            return (
              <span key={t.field_value} style={CHIP}>
                {t.field_value}
                {t.sub_value_name && <span style={SUB}>{t.sub_value_name}</span>}
              </span>
            )
          }

          return (
            <div key={t.field_value} style={{ width: panel ? '100%' : 'auto' }}>
              <span style={{ ...CHIP_EDITABLE, opacity: working ? 0.5 : 1 }}>
                {t.field_value}
                {t.sub_value_name && <span style={SUB}>{t.sub_value_name}</span>}
                {author && <span style={{ ...SUB, fontStyle: 'italic' }}>· {author}</span>}
                <button type="button" disabled={working}
                  title="Change the sub-value in Signal Sense"
                  aria-label={`Change the sub-value of ${t.field_value}`}
                  style={{ ...ICON, color: 'var(--faint)' }}
                  onClick={() => openPanel(t.field_value, 'sub')}>✎</button>
                <button type="button" disabled={working}
                  title="Take this tag out of Signal Sense"
                  aria-label={`Remove ${t.field_value} from Signal Sense`}
                  style={{ ...ICON, color: 'var(--faint)' }}
                  onClick={() => openPanel(t.field_value, 'remove')}>✕</button>
              </span>

              {panel === 'sub' && (
                <div style={PANEL}>
                  <select
                    className="input" style={CTL} disabled={working}
                    value={t.sub_value_id ?? ''}
                    aria-label={`Sub-value for ${t.field_value}`}
                    onChange={e => setSubValue(t, e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">None</option>
                    {subValues.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <span className="wf-hint">
                    Saved into Signal Sense as you pick — this tag is already live over there.
                  </span>
                  <button type="button" className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }}
                    disabled={working} onClick={() => setOpen(null)}>Done</button>
                </div>
              )}

              {panel === 'remove' && (
                <div style={PANEL}>
                  <span style={{ fontSize: 12, color: 'var(--warn)' }}>
                    Remove <strong>{t.field_value}</strong> from Signal Sense?
                    {author ? ` ${author} tagged it there.` : ''} The removal is recorded in
                    both apps&apos; history.
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="button" className="btn btn-sm btn-primary" disabled={working}
                      onClick={() => remove(t)}>Remove</button>
                    <button type="button" className="btn btn-sm btn-ghost" disabled={working}
                      onClick={() => setOpen(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
