'use client'
import { useRef, useState } from 'react'
import { StyledSelect } from '@/components/StyledSelect'
import { moveBatch, MAX_MOVE } from '@/lib/batch-move-client'
import { weekLabelOrder } from '@/lib/weekly-feedback'
import { toast } from '@/lib/toast'
import { fmtDateTimeVN } from '@/lib/format-date'
import { finalConclusionStyle } from '@/lib/conclusion-badge'
import { Modal } from '@/components/ui/Modal'

export interface SelectedGame {
  id: number
  final_conclusion: string | null
  batch: string | null
  evaluate_date: string | null
  /** Shown in the confirm dialog's list; callers that have no title still work. */
  title?: string | null
  icon_url?: string | null
}

/** The Report derives a batch's date window from its earliest evaluate_date, so a game
 *  evaluated longer ago than this stretches the window of the batch it moves into. */
const OLD_EVALUATION_DAYS = 8

/** dd/MM/yy - HH:mm in Vietnam time, like the rest of the app; null for a missing or bad date. */
function evaluatedAt(iso: string | null): string | null {
  const at = fmtDateTimeVN(iso)
  return at === '—' ? null : at
}

const MSG_TOO_MANY = `You can move at most ${MAX_MOVE} games at a time. Select fewer.`
const MSG_NOTHING_MOVED = 'No games were moved. Reload the list and try again.'
const MSG_ALREADY_THERE = 'They are already in this batch.'

const gamesWord = (k: number) => `${k} ${k === 1 ? 'game' : 'games'}`

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
    toast.success(res.moved ? `Moved ${gamesWord(res.moved)} to ${batch}` : `Moved to ${batch}`)
    onMovedRef.current(res.moved ?? 0)
  }

  // Errors from the move stay inside the dialog: it stays open so the manager can try
  // again or cancel, and the reason sits next to the button that failed.
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
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!batch || n === 0 || tooMany || alreadyThere}
          onClick={() => { setError(null); setConfirming(true) }}>
          Move
        </button>
        {/* While the dialog is open the same message is shown inside it, not twice. */}
        {!confirming && tooMany && <span className="bmb-err">{MSG_TOO_MANY}</span>}
        {!confirming && !tooMany && alreadyThere && <span className="bmb-note">{MSG_ALREADY_THERE}</span>}
      </div>

      {confirming && (
        <Modal
          title={`Move ${gamesWord(n)} to ${batch}?`}
          width={440}
          busy={busy}
          onClose={() => setConfirming(false)}
          footer={<>
            <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={confirm} disabled={busy || n === 0 || tooMany}>
              {busy ? 'Moving…' : `Move ${gamesWord(n)}`}
            </button>
          </>}
        >
          <ul className="bmb-list" aria-label="Games to move">
            {selected.map(g => (
              <li key={g.id} className="bmb-row" data-move-row>
                <div className="bmb-icon" style={g.icon_url ? { backgroundImage: `url(${g.icon_url})` } : undefined} />
                <div className="bmb-info">
                  <div className="bmb-t" title={g.title?.trim() || undefined}>{g.title?.trim() || 'Untitled game'}</div>
                  <div className="bmb-m">
                    {evaluatedAt(g.evaluate_date) ? `Evaluated ${evaluatedAt(g.evaluate_date)}` : 'Not evaluated yet'}
                    {g.final_conclusion && (
                      <span className="badge" style={{ background: finalConclusionStyle(g.final_conclusion).bg, color: finalConclusionStyle(g.final_conclusion).color }}>
                        {g.final_conclusion}
                      </span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
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
          {error && <p className="bmb-err" role="alert">{error}</p>}
        </Modal>
      )}
    </>
  )
}
