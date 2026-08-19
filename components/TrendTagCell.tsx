'use client'
import type { CSSProperties } from 'react'

/** One Trends tag on a game, as served by GET /api/evaluations. Distinct from
 *  TrendTagsField's TrendTag (an editable proposal): this one is read-only and
 *  carries the resolved sub-value name plus where it stands.
 *  `pending` = proposed during playtest, not yet confirmed in Evaluations >
 *  Tagging, so it is NOT in Signal Sense yet. */
export interface GameTrendTag {
  field_value: string
  sub_value_name: string | null
  pending: boolean
}

// Trend values are catalog identifiers owned by Signal Sense, not prose, so they
// keep the utility face here too — same as TrendTagsField and its dialog.
const CHIP: CSSProperties = {
  display: 'inline-flex', alignItems: 'baseline', gap: 4,
  padding: '1px 6px', borderRadius: 6, background: 'var(--surface-2)',
  border: '1px solid var(--border)', fontSize: 11, fontFamily: 'var(--num)',
  whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
}
// Pending reads as an outline, not a filled chip: nothing has been written yet.
const CHIP_PENDING: CSSProperties = {
  background: 'transparent', borderStyle: 'dashed', color: 'var(--faint)', opacity: 0.7,
}
const CHIP_SUB: CSSProperties = { fontSize: 10, color: 'var(--faint)', fontFamily: 'var(--font)' }

/** Read-only Trends chips for a table cell. Confirmed tags are solid; pending
 *  proposals are dimmed and dashed, so a glance down the column separates "this
 *  game is tagged" from "someone suggested a tag". */
export function TrendTagCell({ tags, maxWidth = 200 }: {
  tags: GameTrendTag[] | null | undefined
  maxWidth?: number
}) {
  const list = tags || []
  if (list.length === 0) return <span style={{ fontSize: 12, color: 'var(--faint)' }}>—</span>

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxWidth }}>
      {list.map((t, i) => (
        <span
          key={`${t.field_value}-${i}`}
          style={t.pending ? { ...CHIP, ...CHIP_PENDING } : CHIP}
          title={t.pending
            ? `${t.field_value}${t.sub_value_name ? ` · ${t.sub_value_name}` : ''} — pending review, not in Signal Sense yet`
            : `${t.field_value}${t.sub_value_name ? ` · ${t.sub_value_name}` : ''}`}
        >
          {t.field_value}
          {t.sub_value_name && <span style={CHIP_SUB}>{t.sub_value_name}</span>}
        </span>
      ))}
    </div>
  )
}
