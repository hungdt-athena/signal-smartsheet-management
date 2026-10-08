'use client'
import { useEffect, useMemo, useState } from 'react'
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
}

const SAVED_FLASH_MS = 500
const DONE_CLOSE_MS = 2000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "07 Oct", read in Vietnam time like the rest of the app.
function shortDate(iso: string | null): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const d = new Date(t + 7 * 3600 * 1000)
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]}`
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

  useEffect(() => {
    let cancelled = false
    fetch('/api/evaluations/missing-demo')
      .then(r => (r.ok ? r.json() : null))
      .then(body => {
        if (cancelled || !body?.items) return
        setItems(body.items)
        setTotal(body.items.length)
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

  async function save(it: Item) {
    const v = (values[it.id] ?? '').trim()
    if (!v) return
    setSaving(s => new Set(s).add(it.id))
    setFailed(f => { const n = new Set(f); n.delete(it.id); return n })
    const ok = await saveDriveLink(it.id, v)
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
                      return (
                        <div key={r.id} data-row className={`mdp-row${isSaved ? ' mdp-ok' : ''}`}>
                          <div className="mdp-icon" style={r.icon_url ? { backgroundImage: `url(${r.icon_url})` } : undefined} />
                          <div className="mdp-info">
                            <div className="mdp-t" title={r.title}>{r.title}</div>
                            <div className="mdp-m">{meta}</div>
                          </div>
                          {isSaved ? (
                            <div className="mdp-okmsg">✓ Saved</div>
                          ) : (
                            <div className="mdp-edit">
                              <div className="mdp-in">
                                <input
                                  className="input"
                                  placeholder="Paste demo video link…"
                                  value={values[r.id] ?? ''}
                                  disabled={saving.has(r.id)}
                                  onChange={e => setValues(v => ({ ...v, [r.id]: e.target.value }))}
                                  onKeyDown={e => { if (e.key === 'Enter') save(r) }}
                                />
                                <button className="btn btn-primary" onClick={() => save(r)}
                                  disabled={saving.has(r.id) || !(values[r.id] ?? '').trim()}>
                                  {saving.has(r.id) ? 'Saving…' : 'Save'}
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
