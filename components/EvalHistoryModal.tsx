'use client'
import { createPortal } from 'react-dom'
import type { HistoryEvent } from '@/lib/evaluation-history'

// dd/MM/YY - hh:mm in Asia/Ho_Chi_Minh, the same shape as the panel's timestamps.
function fmtAt(iso: string) {
  const dt = new Date(iso)
  const day = dt.toLocaleDateString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: '2-digit' })
  const time = dt.toLocaleTimeString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false })
  return `${day} - ${time}`
}

export interface EvalHistoryModalProps {
  events: HistoryEvent[] | null // null while loading
  logReady: boolean
  error: boolean
  onClose: () => void
}

/** The panel's History list: saves and hand-overs of one game, newest first. */
export function EvalHistoryModal({ events, logReady, error, onClose }: EvalHistoryModalProps) {
  if (typeof document === 'undefined') return null
  // Portalled like the Lightbox: the panel sits in an animated container that would trap
  // position: fixed. z-index: above the panel's backdrop (900), below the Lightbox (2000).
  return createPortal(
    <div className="modal-backdrop" style={{ zIndex: 1500 }} onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="eval-history-title"
        style={{ maxWidth: 620 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title" id="eval-history-title">History</div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body" style={{ gap: 0, paddingTop: 8, paddingBottom: 8 }}>
          {error ? (
            <p style={{ fontSize: 13, color: 'var(--bad)', margin: '12px 0' }}>Could not load the history. Try again.</p>
          ) : events === null ? (
            <p style={{ fontSize: 13, color: 'var(--faint)', margin: '12px 0' }}>Loading…</p>
          ) : events.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--faint)', margin: '12px 0' }}>
              {logReady ? 'No history yet.' : 'Saves are not logged yet.'}
            </p>
          ) : (
            events.map((e, i) => (
              <div key={e.key} data-testid="history-row" style={{
                display: 'grid', gridTemplateColumns: '112px 1fr auto', gap: '2px 12px', alignItems: 'baseline',
                padding: '10px 0', borderTop: i === 0 ? 'none' : '1px solid var(--border)',
              }}>
                <span style={{ fontSize: 11.5, color: 'var(--faint)', fontVariantNumeric: 'tabular-nums' }}>{fmtAt(e.at)}</span>
                <span style={{ fontSize: 13 }}>
                  <b style={{ fontWeight: 600 }}>{e.action}</b>
                  <span style={{ color: 'var(--muted)' }}> · {e.who}</span>
                </span>
                <span style={{ fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}
                  title={e.time ? 'Time this game was open in the panel before this save' : undefined}>
                  {e.time ? `⏱ ${e.time}` : ''}
                </span>
                <span />
                <span style={{ fontSize: 12.5, color: 'var(--text)', gridColumn: '2 / 4' }}>{e.detail}</span>
                {e.note && (
                  <>
                    <span />
                    <span style={{ fontSize: 11.5, color: 'var(--faint)', gridColumn: '2 / 4' }}>{e.note}</span>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
