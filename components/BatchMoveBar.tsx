'use client'
import { useRef, useState } from 'react'
import { StyledSelect } from '@/components/StyledSelect'
import { moveBatch, MAX_MOVE } from '@/lib/batch-move-client'
import { weekLabelOrder } from '@/lib/weekly-feedback'

export interface SelectedGame {
  id: number
  final_conclusion: string | null
  batch: string | null
  evaluate_date: string | null
}

/** The Report derives a batch's date window from its earliest evaluate_date, so a game
 *  evaluated longer ago than this stretches the window of the batch it moves into. */
const OLD_EVALUATION_DAYS = 8

const MSG_TOO_MANY = `You can move at most ${MAX_MOVE} games at a time. Select fewer.`
const MSG_NOTHING_MOVED = 'No games were moved. Reload the list and try again.'
const MSG_ALREADY_THERE = 'They are already in this batch.'

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
  // The list behind this bar can reload (category, sort) while a move is in flight; the
  // reload must use the callback of the render that is current when the move ends, not
  // the one captured when Confirm was clicked.
  const onMovedRef = useRef(onMoved)
  onMovedRef.current = onMoved

  const n = selected.length
  const locked = selected.filter(s => !!s.final_conclusion).length
  const tooMany = n > MAX_MOVE
  const alreadyThere = !!batch && n > 0 && selected.every(s => s.batch === batch)
  // Where the games are now, newest batch first, so the dialog always says something even
  // when no warning below applies.
  const counts = new Map<string, number>()
  for (const s of selected) if (s.batch) counts.set(s.batch, (counts.get(s.batch) ?? 0) + 1)
  const nowIn = Array.from(counts).sort((a, b) => weekLabelOrder(b[0]) - weekLabelOrder(a[0]))
    .map(([b, c]) => `${b} (${c})`)
  const noBatch = selected.filter(s => !s.batch).length
  if (noBatch > 0) nowIn.push(`no batch (${noBatch})`)
  const now = Date.now()
  const oldForward = batch ? selected.filter(s =>
    !!s.evaluate_date && now - Date.parse(s.evaluate_date) > OLD_EVALUATION_DAYS * 86_400_000 &&
    (!s.batch || weekLabelOrder(s.batch) < weekLabelOrder(batch))).length : 0

  async function confirm() {
    setBusy(true)
    setError(null)
    const res = await moveBatch(selected.map(s => s.id), batch)
    setBusy(false)
    if (!res.ok) { setError(`Couldn't move: ${res.error}`); return }
    // Nothing moved (the games are gone): closing quietly would look like success. A null
    // count is a 2xx whose body could not be read: the move happened, only the number is unknown.
    if (res.moved === 0) { setError(MSG_NOTHING_MOVED); return }
    setConfirming(false)
    onMovedRef.current(res.moved ?? 0)
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
        <button className="btn btn-primary btn-sm" disabled={!batch || n === 0 || tooMany || alreadyThere}
          onClick={() => { setError(null); setConfirming(true) }}>
          Move
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        {/* While the dialog is open the same message is shown inside it, not twice. */}
        {!confirming && tooMany && <span className="bmb-err">{MSG_TOO_MANY}</span>}
        {!confirming && !tooMany && alreadyThere && <span className="bmb-note">{MSG_ALREADY_THERE}</span>}
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
              <p className="bmb-from">Now in: {nowIn.join(', ')}</p>
              {locked > 0 && (
                <p className="bmb-note">
                  {locked} of them already {locked === 1 ? 'has' : 'have'} a final conclusion and will move too.
                </p>
              )}
              {oldForward > 0 && (
                <p className="bmb-note">
                  {oldForward} of them {oldForward === 1 ? 'was' : 'were'} evaluated more than {OLD_EVALUATION_DAYS} days ago.
                  {' '}Moving them to a newer batch can change the date range the Report uses for that batch.
                </p>
              )}
              {tooMany && <p className="bmb-err">{MSG_TOO_MANY}</p>}
              {error && <p className="bmb-err">{error}</p>}
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setConfirming(false)} disabled={busy}>Back</button>
              <button className="btn btn-primary" onClick={confirm} disabled={busy || n === 0 || tooMany}>
                {busy ? 'Moving…' : 'Confirm move'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
