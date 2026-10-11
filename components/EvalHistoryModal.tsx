'use client'
import { createPortal } from 'react-dom'
import { prettyConclusion } from '@/lib/buckets'
import { conclusionBadgeClass } from '@/lib/conclusion-badge'
import { fmtClock, fmtDuration, groupByDay, summarize, type Change, type EventType, type HistoryEvent } from '@/lib/evaluation-history'

export interface EvalHistoryModalProps {
  events: HistoryEvent[] | null // null while loading
  logReady: boolean
  error: boolean
  onClose: () => void
  onRetry: () => void
}

const svg = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

// What each kind of event looks like in the rail. Paths are Lucide's.
const ICONS: Record<EventType, JSX.Element> = {
  save: <svg {...svg}><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>,
  final: <svg {...svg}><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><path d="M4 22v-7" /></svg>,
  record: <svg {...svg}><path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>,
  assign: <svg {...svg}><path d="M8 3 4 7l4 4" /><path d="M4 7h16" /><path d="M16 21l4-4-4-4" /><path d="M20 17H4" /></svg>,
  seed: <svg {...svg}><path d="M21 8v13H3V8" /><path d="M1 3h22v5H1z" /><path d="M10 12h4" /></svg>,
}

const Arrow = () => (
  <svg {...svg} width={13} height={13} style={{ color: 'var(--faint)' }}><path d="M5 12h14" /><path d="M12 5l7 7-7 7" /></svg>
)

function Chip({ value, kind }: { value: string | null; kind: Change['kind'] }) {
  if (kind === 'person') return <span className="name">{value ?? '—'}</span>
  if (value == null) return <span className="badge neutral">—</span>
  return <span className={`badge ${kind === 'final' ? 'neutral' : conclusionBadgeClass(value)}`}>{prettyConclusion(value)}</span>
}

function ChangeLine({ c }: { c: Change }) {
  return (
    <div className="hx-chg">
      {c.kind === 'final' && <span className="lbl">Final</span>}
      {c.from != null && <><Chip value={c.from} kind={c.kind} /><Arrow /></>}
      <Chip value={c.to} kind={c.kind} />
    </div>
  )
}

function Row({ e, last }: { e: HistoryEvent; last: boolean }) {
  return (
    <div className="hx-row" data-testid="history-row">
      <div className={`hx-ico ${e.type}`}>{ICONS[e.type]}</div>
      {!last && <span className="hx-rail" />}
      <div>
        <div className="hx-line"><span className="who">{e.who}</span> <span className="verb">{e.verb}</span></div>
        {e.changes.map((c, i) => <ChangeLine key={i} c={c} />)}
        {e.note && <div className="hx-note">{e.note}</div>}
      </div>
      <div className="hx-time">
        {fmtClock(e.at)}
        {e.seconds != null && (
          <div className="hx-dur" title="Time this game was open in the panel before this save">
            <svg {...svg} width={11} height={11}><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2" /><path d="M9 2h6" /></svg>
            {fmtDuration(e.seconds)}
          </div>
        )}
      </div>
    </div>
  )
}

function Skeleton() {
  return (
    <div role="status">
      <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Loading…</span>
      {[0, 1, 2, 3].map(i => (
        <div key={i} className="hx-row" aria-hidden="true">
          <div className="hx-ico" />
          <div><div className="hx-skel" style={{ width: '55%' }} /><div className="hx-skel" style={{ width: '35%', marginTop: 8 }} /></div>
          <div />
        </div>
      ))}
    </div>
  )
}

/** The panel's History: saves and hand-overs of one game as a timeline, newest first. */
export function EvalHistoryModal({ events, logReady, error, onClose, onRetry }: EvalHistoryModalProps) {
  if (typeof document === 'undefined') return null
  const sum = events && events.length > 0 ? summarize(events) : null

  let content
  if (error) {
    content = (
      <div className="hx-empty">
        <b>Could not load the history</b>
        <button className="btn btn-sm" onClick={onRetry}>Try again</button>
      </div>
    )
  } else if (events === null) {
    content = <Skeleton />
  } else if (events.length === 0) {
    content = (
      <div className="hx-empty">
        <b>{logReady ? 'No history yet.' : 'Saves are not logged yet.'}</b>
        <span style={{ fontSize: 13 }}>
          {logReady ? 'Saves and hand-overs of this game show up here.' : 'Hand-overs show up here; saves appear once the log is switched on.'}
        </span>
      </div>
    )
  } else {
    content = groupByDay(events).map(g => (
      <div key={g.key}>
        <div className="hx-day">{g.label}</div>
        {g.events.map((e, i) => <Row key={e.key} e={e} last={i === g.events.length - 1} />)}
      </div>
    ))
  }

  // Portalled like the Lightbox: the panel sits in an animated container that would trap
  // position: fixed. z-index: above the panel's backdrop (900), below the Lightbox (2000).
  return createPortal(
    <div className="modal-backdrop" style={{ zIndex: 1500 }} onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="eval-history-title"
        style={{ maxWidth: 600 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div style={{ display: 'grid', gap: 4 }}>
            <div className="modal-title" id="eval-history-title">History</div>
            {sum && (
              <div className="hx-sum">
                <span><b>{sum.events}</b> {sum.events === 1 ? 'event' : 'events'}</span>
                {sum.seconds > 0 && <span><b>{fmtDuration(sum.seconds)}</b> panel time</span>}
                {sum.people > 0 && <span><b>{sum.people}</b> {sum.people === 1 ? 'person' : 'people'}</span>}
              </div>
            )}
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body" style={{ gap: 0, paddingTop: 0, paddingBottom: 12 }}>{content}</div>
      </div>
    </div>,
    document.body,
  )
}
