'use client'
import { useState } from 'react'
import { StyledSelect } from '@/components/StyledSelect'
import { moveBatch } from '@/lib/batch-move-client'

export interface SelectedGame { id: number; final_conclusion: string | null }

/** Bottom bar of Short List's select mode: pick a batch, Move, confirm.
 *  Moving a game that already has a final conclusion is allowed (ticking it means the
 *  manager wants it moved); the confirm dialog says how many such games are included,
 *  because batch is also the week the Record tab shows. */
export function BatchMoveBar({ selected, batchOptions, onCancel, onMoved }: {
  selected: SelectedGame[]
  batchOptions: string[]
  onCancel: () => void
  onMoved: (moved: number) => void
}) {
  const [batch, setBatch] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const n = selected.length
  const locked = selected.filter(s => !!s.final_conclusion).length

  async function confirm() {
    setBusy(true)
    setError(null)
    const res = await moveBatch(selected.map(s => s.id), batch)
    setBusy(false)
    if (!res.ok) { setError(`Couldn't move: ${res.error}`); return }
    setConfirming(false)
    onMoved(res.moved)
  }

  return (
    <>
      <div className="bmb" role="region" aria-label="Move games to another batch">
        <span className="bmb-count">{n} selected</span>
        <span className="bmb-label">Move to</span>
        <div style={{ width: 190 }}>
          <StyledSelect
            value={batch}
            onChange={setBatch}
            placeholder="Move to batch"
            options={batchOptions.map(b => ({ value: b, label: b }))}
          />
        </div>
        <button className="btn btn-primary btn-sm" disabled={!batch || n === 0}
          onClick={() => { setError(null); setConfirming(true) }}>
          Move
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>

      {confirming && (
        <div className="modal-backdrop">
          <div className="modal bmb-dialog" role="dialog" aria-modal="true" aria-labelledby="bmb-title">
            <div className="modal-head">
              <div className="modal-title" id="bmb-title" style={{ whiteSpace: 'normal' }}>
                Move {n} {n === 1 ? 'game' : 'games'} to {batch}?
              </div>
            </div>
            <div className="modal-body">
              {locked > 0 && (
                <p className="bmb-note">
                  {locked} of them already {locked === 1 ? 'has' : 'have'} a final conclusion and will move too.
                </p>
              )}
              {error && <p className="bmb-err">{error}</p>}
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setConfirming(false)} disabled={busy}>Back</button>
              <button className="btn btn-primary" onClick={confirm} disabled={busy}>
                {busy ? 'Moving…' : 'Confirm move'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
