'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { saveDriveLink } from '@/lib/drive-link-client'

interface Item {
  id: number
  game_id: string
  title: string
  icon_url: string | null
  category: string
  genre: string | null
  batch: string
  evaluate_date: string | null
  // Set when the Drive auto-sync found a file for a title that different games share: it is
  // shown prefilled for the evaluator to check and confirm, never saved on its own.
  suggested_link: string | null
  suggested_name: string | null
  shared_with: number | null
}

const SAVED_FLASH_MS = 500
const DONE_CLOSE_MS = 2000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "07 Oct", read in Vietnam time like the rest of the app. A date that cannot be shown
// as one (unparseable, overflows once shifted, or a year no evaluation can have) is left
// out rather than rendered as "NaN undefined".
function shortDate(iso: string | null): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const d = new Date(t + 7 * 3600 * 1000)
  const year = d.getUTCFullYear()
  if (Number.isNaN(year) || year < 1970 || year > 2100) return null
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]}`
}

/** The list comes from the network: anything that is not the shape below is dropped
 *  instead of crashing the layout this prompt is mounted in. Optional fields fall back to null.
 *  A missing title is NOT a reason to drop: game_info.title can be NULL and that game still
 *  needs its demo link, so it is shown as "Untitled game". */
function toItem(raw: unknown): Item | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'number' || !Number.isFinite(r.id)) return null
  if (typeof r.category !== 'string' || typeof r.batch !== 'string') return null
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  return {
    id: r.id, game_id: str(r.game_id) ?? '', title: str(r.title)?.trim() ? (r.title as string) : 'Untitled game', icon_url: str(r.icon_url),
    category: r.category, genre: str(r.genre), batch: r.batch, evaluate_date: str(r.evaluate_date),
    suggested_link: str(r.suggested_link)?.trim() || null, suggested_name: str(r.suggested_name),
    shared_with: typeof r.shared_with === 'number' && Number.isFinite(r.shared_with) && r.shared_with > 0 ? r.shared_with : null,
  }
}

/** Only a web link gets an Open button: the value comes from a table, and `javascript:` must not
 *  become a clickable href. */
const isWebLink = (v: string) => /^https?:\/\//i.test(v)

function sharedNote(it: Item): string {
  if (it.shared_with == null) return 'Same title as other games'
  return `Same title as ${it.shared_with} other ${it.shared_with === 1 ? 'game' : 'games'}`
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Asks each evaluator, every time they open the app, to attach a demo link to their
 *  List_Idea games in the current batch that still have none.
 *
 *  It fetches once per mount. The layouts that host it persist across client-side
 *  navigation, so "once per mount" is "once per page load", which is the cadence wanted.
 *  The only way to close it is "Remind me later" (no Esc, no backdrop click, no X): it
 *  stays until the list is dealt with or explicitly put off to the next visit. */
export function MissingDemoPrompt() {
  const [items, setItems] = useState<Item[]>([])
  const [total, setTotal] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [values, setValues] = useState<Record<number, string>>({})
  const [saving, setSaving] = useState<Set<number>>(new Set())
  const [saved, setSaved] = useState<Set<number>>(new Set())
  const [failed, setFailed] = useState<Set<number>>(new Set())
  // Ids with a save in flight. A ref, because two clicks or Enters in the same tick both see
  // the same render's state: only a ref is updated in time to refuse the second one.
  const inFlight = useRef<Set<number>>(new Set())

  useEffect(() => {
    let cancelled = false
    fetch('/api/evaluations/missing-demo')
      .then(r => (r.ok ? r.json() : null))
      .then(body => {
        if (cancelled || !Array.isArray(body?.items)) return
        // One row per id: a repeated id would give two rows the same React key.
        const seen = new Set<number>()
        const valid = (body.items as unknown[]).map(toItem)
          .filter((i): i is Item => i !== null && !seen.has(i.id) && !!seen.add(i.id))
        if (valid.length === 0) return
        setItems(valid)
        setTotal(valid.length)
        setLoaded(true)
      })
      .catch(() => { /* a broken list is not worth nagging about */ })
    return () => { cancelled = true }
  }, [])

  const remaining = items.filter(i => !saved.has(i.id))
  const finished = loaded && total > 0 && remaining.length === 0

  useEffect(() => {
    if (!finished) return
    const t = setTimeout(() => setDismissed(true), DONE_CLOSE_MS)
    return () => clearTimeout(t)
  }, [finished])

  const sections = useMemo(() => {
    const out: { batch: string; rows: Item[] }[] = []
    for (const it of items) {
      const s = out.find(x => x.batch === it.batch)
      if (s) s.rows.push(it); else out.push({ batch: it.batch, rows: [it] })
    }
    return out
  }, [items])

  // What the input shows: what the evaluator typed, else the suggestion, else nothing.
  const valueOf = (it: Item) => values[it.id] ?? it.suggested_link ?? ''

  async function save(it: Item) {
    const v = valueOf(it).trim()
    if (!v || inFlight.current.has(it.id)) return
    inFlight.current.add(it.id)
    setSaving(s => new Set(s).add(it.id))
    setFailed(f => { const n = new Set(f); n.delete(it.id); return n })
    const ok = await saveDriveLink(it.id, v)
    inFlight.current.delete(it.id)
    setSaving(s => { const n = new Set(s); n.delete(it.id); return n })
    if (!ok) { setFailed(f => new Set(f).add(it.id)); return }
    setSaved(s => new Set(s).add(it.id))
    setTimeout(() => setItems(list => list.filter(x => x.id !== it.id)), SAVED_FLASH_MS)
  }

  if (!loaded || dismissed || total === 0) return null

  const doneCount = total - remaining.length
  const n = remaining.length

  return (
    <div className="modal-backdrop" data-testid="prompt-backdrop">
      <div className="modal mdp" role="dialog" aria-modal="true" aria-labelledby="mdp-title">
        {finished ? (
          <div className="mdp-done">
            <div className="mdp-done-ico" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
            </div>
            <h3 id="mdp-title">All demo links are in</h3>
            <p>No List Idea games are missing a demo link in the current batch.<br />This window closes by itself.</p>
          </div>
        ) : (
          <>
            <div className="modal-head mdp-head">
              <div className="mdp-ico" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
              </div>
              <div>
                <div className="modal-title" id="mdp-title">
                  {n} List Idea {n === 1 ? 'game still needs' : 'games still need'} a demo link
                </div>
                <p className="mdp-sub">
                  Games in the current batch. Fill what you can now; anything left shows again next time you open the app.
                </p>
              </div>
            </div>

            <div className="mdp-prog" aria-hidden="true"><i style={{ width: `${Math.round((doneCount / total) * 100)}%` }} /></div>

            <div className="mdp-body">
              {sections.map(sec => {
                const left = sec.rows.filter(r => !saved.has(r.id)).length
                return (
                  <section key={sec.batch} data-testid="batch-section">
                    <div className="mdp-batch">
                      <b>{sec.batch}</b>
                      <span className="badge success">Current batch</span>
                      <span className="mdp-n">{left} missing</span>
                    </div>
                    {sec.rows.map(r => {
                      const isSaved = saved.has(r.id)
                      const meta = [cap(r.category), r.genre, shortDate(r.evaluate_date) && `evaluated ${shortDate(r.evaluate_date)}`]
                        .filter(Boolean).join(' · ')
                      const value = valueOf(r)
                      // A suggestion the evaluator has not changed is confirmed, not typed.
                      const confirming = !!r.suggested_link && value.trim() === r.suggested_link
                      return (
                        <div key={r.id} data-row className={`mdp-row${isSaved ? ' mdp-ok' : ''}${r.suggested_link ? ' mdp-sug' : ''}`}>
                          <div className="mdp-icon" style={r.icon_url ? { backgroundImage: `url(${r.icon_url})` } : undefined} />
                          <div className="mdp-info">
                            <div className="mdp-t" title={r.title}>{r.title}</div>
                            <div className="mdp-m">{meta}</div>
                            {r.suggested_link && !isSaved && (
                              <div className="mdp-warn">
                                <b>{sharedNote(r)}.</b> Open the video and check it is this game.
                                {r.suggested_name && <span className="mdp-file" title={r.suggested_name}>File: {r.suggested_name}</span>}
                              </div>
                            )}
                          </div>
                          {isSaved ? (
                            <div className="mdp-okmsg">✓ Saved</div>
                          ) : (
                            <div className="mdp-edit">
                              <div className="mdp-in">
                                <input
                                  className="input"
                                  placeholder="Paste demo video link…"
                                  aria-label={`Demo link for ${r.title}`}
                                  value={value}
                                  disabled={saving.has(r.id)}
                                  onChange={e => setValues(v => ({ ...v, [r.id]: e.target.value }))}
                                  onKeyDown={e => { if (e.key === 'Enter') save(r) }}
                                />
                                {r.suggested_link && isWebLink(r.suggested_link) && (
                                  <a className="btn" href={r.suggested_link} target="_blank" rel="noopener noreferrer"
                                    aria-label={`Open suggested video for ${r.title}`}>Open ↗</a>
                                )}
                                <button className="btn btn-primary" onClick={() => save(r)}
                                  aria-label={`${confirming ? 'Confirm' : 'Save'} demo link for ${r.title}`}
                                  disabled={saving.has(r.id) || !value.trim()}>
                                  {saving.has(r.id) ? 'Saving…' : confirming ? 'Confirm' : 'Save'}
                                </button>
                              </div>
                              {failed.has(r.id) && <div className="mdp-err">Couldn&apos;t save, try again</div>}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </section>
                )
              })}
            </div>

            <div className="modal-foot mdp-foot">
              <span>{doneCount > 0 ? `${doneCount} of ${total} saved` : 'Shows again next time you open the app'}</span>
              <button className="btn" onClick={() => setDismissed(true)}>Remind me later</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
