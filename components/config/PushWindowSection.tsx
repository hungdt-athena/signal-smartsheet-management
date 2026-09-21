// components/config/PushWindowSection.tsx — how far back the push step looks
// for new games, one window per genre.
//
// The note under the heading is not decoration. "30 days" is ambiguous on its
// own — 30 days of what? — and the answer (release date, falling back to the
// day we first saw an undated game) is the difference between a reviewable
// queue and the 2,876-game back-catalogue flood of 2026-08-19. It is stated
// here, in the UI, and not only in the code.
'use client'
import { useCallback, useEffect, useState } from 'react'
import { BUCKETS, type Bucket } from '@/lib/buckets'
import { BUCKET_LABELS } from '@/components/RosterTable'
import {
  DEFAULT_PUSH_WINDOW, PUSH_WINDOWS, PUSH_WINDOW_NOTE,
  type PushWindow, type PushWindowConfig,
} from '@/lib/push-window'

export function PushWindowSection({ highlight = false }: { highlight?: boolean }) {
  const [windows, setWindows] = useState<PushWindowConfig | null>(null)
  const [canEdit, setCanEdit] = useState(false)
  const [saving, setSaving] = useState<Bucket | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/config/push-window', { cache: 'no-store' })
      if (!res.ok) return
      const json = await res.json()
      setWindows(json.windows ?? null)
      setCanEdit(json.canEdit === true)
    } catch { /* leave the section empty rather than break the page */ }
  }, [])

  useEffect(() => { load() }, [load])

  async function pick(bucket: Bucket, days: PushWindow) {
    if (windows?.[bucket] === days) return
    setSaving(bucket); setError(null)
    // Optimistic: the value is one of four, so there is nothing to lose by
    // showing it immediately and putting it back if the write fails.
    const before = windows
    setWindows(w => (w ? { ...w, [bucket]: days } : w))
    try {
      const res = await fetch('/api/config/push-window', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucket, days }),
      })
      if (!res.ok) { setWindows(before); setError('Could not save that window.'); return }
      const json = await res.json()
      if (json.windows) setWindows(json.windows)
    } catch {
      setWindows(before); setError('Could not reach the server.')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className={`card cfg-highlightable${highlight ? ' cfg-highlight' : ''}`} id="push-window">
      <div className="card-head">
        <span className="card-label">Push window</span>
        <span className="card-note">how far back each genre looks for new games</span>
      </div>

      <p className="pw-note">{PUSH_WINDOW_NOTE}</p>

      {!windows ? (
        <p className="pw-empty">Loading…</p>
      ) : (
        <table className="tbl pw-tbl">
          <thead>
            <tr>
              <th style={{ width: 120 }}>Genre</th>
              <th>Window</th>
            </tr>
          </thead>
          <tbody>
            {BUCKETS.map(b => (
              <tr key={b}>
                <td className="genre-name">{BUCKET_LABELS[b]}</td>
                <td>
                  <div className="wsteps" role="group" aria-label={`${BUCKET_LABELS[b]} push window`}>
                    {PUSH_WINDOWS.map(d => (
                      <button key={d} type="button" className="wstep"
                        aria-pressed={windows[b] === d}
                        disabled={!canEdit || saving === b}
                        onClick={() => pick(b, d)}>
                        {d}d
                      </button>
                    ))}
                  </div>
                  {windows[b] !== DEFAULT_PUSH_WINDOW && (
                    <span className="pw-changed">
                      not the {DEFAULT_PUSH_WINDOW}-day default
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && <p className="msg-err pw-msg">{error}</p>}
      {!canEdit && <p className="genre-note">Only an admin can change this.</p>}
    </div>
  )
}
