'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import EvalDetailPanel, { type EvalListItem } from './EvalDetailPanel'
import { TrendValuePicker } from './TrendValuePicker'

interface PendingRow {
  id: number
  field_value: string
  sub_value_id: number | null
  sub_value_name: string | null
  tagged_by_name: string | null
  tagged_at: string
  their_sub_value_id: number | null
  their_sub_value_name: string | null
  conflict: boolean
}

interface PendingGame {
  game_id: string
  title: string
  publisher_name: string | null
  icon_url: string | null
  initial_evaluator: string | null
  tags: PendingRow[]
}

interface HistoryRow {
  id: number
  game_id: string
  title: string
  icon_url: string | null
  field_value: string
  sub_value_name: string | null
  tagged_by_name: string | null
  tagged_at: string
  confirmed_by_name: string | null
  confirmed_at: string | null
  status: string
  sync_result: string | null
  removed_at: string | null
  /** Email of the admin who removed it, or 'signal_sense' when the reconcile
   *  sweep found it gone rather than someone removing it from here. */
  removed_by: string | null
  removed_by_name: string | null
  /** Read live: is the tag in custom_field_values right now? */
  in_signal_sense: boolean
  /** Did playtest_sync create that row? Only then may this app remove it. */
  ours: boolean | null
  /** Latest sub-value overwrite made in Signal Sense after our confirm. The row
   *  still exists in that case, so only the change log reveals it. */
  sub_changed_at: string | null
  sub_changed_from: string | null
  sub_changed_to: string | null
  sub_changed_by: string | null
}

const fmt = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: 'short', year: 'numeric' }) : '—'

// Today and the first of this month as YYYY-MM-DD in UTC+7, the only timezone
// this dashboard reckons dates in. en-CA formats as ISO, which is what a
// <input type="date"> and the API's ?from/?to expect.
const todayLocal = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' })
const monthStartLocal = () => `${todayLocal().slice(0, 7)}-01`

// Written into Signal Sense → green; already there or deliberately left alone →
// muted; refused because the value is retired → red.
const RESULT_PILL: Record<string, string> = {
  inserted: 'on', enriched: 'on', overwritten: 'on',
  duplicate: 'muted', kept: 'muted', inactive: 'off',
}

/** Opens a game's evaluation panel. Both views pass the games they are showing,
 *  so the panel's prev/next walks the list the admin is looking at. */
type OpenGame = (gameId: string, list: EvalListItem[]) => void

// A game title that opens its evaluation panel — the tag says which trend, the
// panel says what the game is and who evaluated it.
function GameButton({ title, gameId, onOpen, list }: {
  title: string; gameId: string; onOpen: OpenGame; list: EvalListItem[]
}) {
  return (
    <button type="button" onClick={() => onOpen(gameId, list)}
      title="Open the evaluation"
      style={{
        border: 0, background: 'none', padding: 0, cursor: 'pointer',
        font: 'inherit', color: 'var(--accent)', textAlign: 'left',
      }}>{title}</button>
  )
}

// Admin review of Trends tags proposed during playtest. A tag only reaches
// Signal Sense's custom_field_values when it is confirmed here.
export function TaggingTab() {
  const [view, setView] = useState<'pending' | 'history'>('pending')
  const [detail, setDetail] = useState<{ gameId: string; list: EvalListItem[] } | null>(null)
  const { data: session } = useSession()
  const role = session?.user?.role
  const userName = session?.user?.name || ''

  const openGame: OpenGame = (gameId, list) => setDetail({ gameId, list })

  return (
    <div className="page tag-page">
      <div className="page-head">
        <div>
          <h1 className="h-title">Tagging</h1>
          <p className="h-sub">Trends proposed while playtesting. Confirming writes them into Signal Sense.</p>
        </div>
        <div className="seg">
          <button className={'seg-btn' + (view === 'pending' ? ' active' : '')} onClick={() => setView('pending')}>Pending</button>
          <button className={'seg-btn' + (view === 'history' ? ' active' : '')} onClick={() => setView('history')}>History</button>
        </div>
      </div>

      {view === 'pending' ? <PendingView onOpenGame={openGame} /> : <HistoryView onOpenGame={openGame} />}

      {detail && (
        <div className="eval-modal-backdrop" onClick={() => setDetail(null)}>
          <div className="eval-modal-container" onClick={e => e.stopPropagation()}
            style={{ padding: '20px 24px 24px' }}>
            <EvalDetailPanel
              initialGameId={detail.gameId}
              gameList={detail.list}
              role={role}
              userName={userName}
              hideRecordSections={false}
              onClose={() => setDetail(null)}
              onNavigate={gameId => setDetail(d => (d ? { ...d, gameId } : d))}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function PendingView({ onOpenGame }: { onOpenGame: OpenGame }) {
  const [games, setGames] = useState<PendingGame[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [overwrite, setOverwrite] = useState<Set<number>>(new Set())
  const [msg, setMsg] = useState<string | null>(null)
  // Catalog for the inline value/sub-value editors. A failed load leaves the
  // rows readable but not editable, rather than offering an empty picker.
  const [options, setOptions] = useState<string[]>([])
  const [subValues, setSubValues] = useState<{ id: number; name: string }[]>([])
  const [optionsError, setOptionsError] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/playtest-tags/pending')
      const d = r.ok ? await r.json() : { games: [] }
      setGames(d.games || [])
    } catch { setGames([]) }
    setLoading(false)
  }, [])

  const loadOptions = useCallback(() => {
    setOptionsError(false)
    fetch('/api/trends/options')
      .then(r => { if (!r.ok) throw new Error('failed'); return r.json() })
      .then(d => { setOptions(d.values || []); setSubValues(d.subValues || []) })
      .catch(() => { setOptionsError(true) })
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => { loadOptions() }, [loadOptions])

  // Correct one pending proposal in place. Reloads on success so the conflict
  // flag and the Signal Sense comparison are recomputed server-side rather than
  // guessed here.
  const patchTag = async (id: number, patch: { field_value?: string; sub_value_id?: number | null }) => {
    setEditing(id)
    try {
      const r = await fetch(`/api/playtest-tags/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setMsg(d.error || 'Could not update that tag'); return }
      setMsg(null)
      await load()
    } catch { setMsg('Network error') }
    finally { setEditing(null) }
  }

  const toggleOverwrite = (id: number) => setOverwrite(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  // Returns whether the confirm succeeded, so batch callers can report the
  // truth instead of assuming every game in a batch went through.
  const confirmGame = async (g: PendingGame): Promise<boolean> => {
    setBusy(g.game_id)
    let ok = false
    try {
      const ids = g.tags.map(t => t.id).filter(id => overwrite.has(id))
      const r = await fetch('/api/playtest-tags/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game_id: g.game_id, overwrite: ids }),
      })
      const d = await r.json()
      if (!r.ok) setMsg(d.error || 'Confirm failed')
      else {
        ok = true
        const counts = (d.results || []).reduce((acc: Record<string, number>, x: { result: string }) => {
          acc[x.result] = (acc[x.result] || 0) + 1
          return acc
        }, {})
        // `skipped` names the tags that did not reach Signal Sense (retired
        // value, or the row moved underneath us) so a summary line like
        // "1 inactive" is actionable rather than cryptic.
        const skipped = (d.skipped || []) as { field_value: string; reason: string }[]
        const detail = skipped.length
          ? ` — not written: ${skipped.map(s => `${s.field_value} (${s.reason})`).join('; ')}`
          : ''
        setMsg(`${g.title}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}${detail}`)
      }
      // Clear any overwrite selections for this game's tags now that they're resolved,
      // so a stale checked id can't leak into a later confirm for a different game.
      setOverwrite(prev => {
        const next = new Set(prev)
        for (const t of g.tags) next.delete(t.id)
        return next
      })
      await load()
    } catch { setMsg('Network error') }
    setBusy(null)
    return ok
  }

  const rejectTag = async (id: number) => {
    try {
      const r = await fetch('/api/playtest-tags/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      })
      if (!r.ok) { setMsg('Reject failed'); return }
      await load()
    } catch { setMsg('Network error') }
  }

  const confirmClean = async () => {
    const clean = games.filter(g => !g.tags.some(t => t.conflict))
    // Sequential on purpose: each confirmGame() call sets/clears the shared
    // `busy`/`msg` state and reloads, so per-game msg text would otherwise be
    // clobbered and only the last game's summary would remain visible.
    // confirmGame() swallows its own errors (network/HTTP) rather than
    // throwing, so a mid-loop failure still lets the remaining games run;
    // track each outcome so the final message reflects reality rather than
    // asserting success regardless of what actually happened.
    let succeeded = 0
    for (const g of clean) {
      if (await confirmGame(g)) succeeded++
    }
    if (clean.length > 1) {
      setMsg(succeeded === clean.length
        ? `Confirmed ${clean.length} games without conflicts`
        : `Confirmed ${succeeded} of ${clean.length} games (${clean.length - succeeded} failed)`)
    }
  }

  if (loading) return <div className="card"><p className="empty">Loading…</p></div>
  if (games.length === 0) {
    return (
      <div className="card">
        <p className="empty">
          Nothing waiting for review. Trends tagged during playtest show up here.
        </p>
      </div>
    )
  }

  const cleanCount = games.filter(g => !g.tags.some(t => t.conflict)).length
  const tagCount = games.reduce((n, g) => n + g.tags.length, 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          {tagCount} tag{tagCount === 1 ? '' : 's'} across {games.length} game{games.length === 1 ? '' : 's'}
        </span>
        {cleanCount > 1 && (
          <button className="btn btn-sm" onClick={confirmClean}>
            Confirm {cleanCount} games without conflicts
          </button>
        )}
      </div>

      {optionsError && (
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' }}>
          <span style={{ fontSize: 12.5, color: 'var(--warn)' }}>
            The trends list didn&apos;t load, so tags can be confirmed or rejected but not edited.
          </span>
          <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={loadOptions}>Try again</button>
        </div>
      )}

      {msg && <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>{msg}</p>}

      {games.map(g => {
        const conflicts = g.tags.filter(t => t.conflict).length
        return (
          <div key={g.game_id} className="card">
            <div className="card-head" style={{ alignItems: 'center', marginBottom: 10 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                {g.icon_url && (
                  <img src={g.icon_url} alt="" width={26} height={26}
                    style={{ borderRadius: 6, flexShrink: 0, border: '1px solid var(--border)' }} />
                )}
                <span style={{ fontSize: 14.5, fontWeight: 650, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <GameButton title={g.title} gameId={g.game_id} onOpen={onOpenGame}
                    list={games.map(x => ({ game_id: x.game_id, title: x.title }))} />
                </span>
                {conflicts > 0 && (
                  <span className="pill off" style={{ fontSize: 10, flexShrink: 0 }}>
                    {conflicts} conflict{conflicts === 1 ? '' : 's'}
                  </span>
                )}
              </span>
              <span style={{ fontSize: 12, color: 'var(--faint)', whiteSpace: 'nowrap' }}>
                {g.publisher_name || '—'} · {g.initial_evaluator || 'unassigned'}
              </span>
            </div>

            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Trend</th>
                    <th style={{ width: 180 }}>Sub-value</th>
                    <th style={{ width: 190 }}>Proposed by</th>
                    <th>In Signal Sense</th>
                    <th style={{ width: 44 }} />
                  </tr>
                </thead>
                <tbody>
                  {g.tags.map(t => (
                    <tr key={t.id}>
                      <td style={{ minWidth: 200 }}>
                        {optionsError ? (
                          <span className="num">{t.field_value}</span>
                        ) : (
                          <TrendValuePicker
                            options={options}
                            exclude={new Set(g.tags.map(x => x.field_value))}
                            label={t.field_value}
                            title="Change the trend value"
                            triggerClassName="input"
                            triggerStyle={{ fontSize: 12.5, padding: '6px 9px' }}
                            disabled={editing === t.id || busy === g.game_id}
                            onPick={v => patchTag(t.id, { field_value: v })}
                          />
                        )}
                      </td>
                      <td>
                        {optionsError ? (
                          <span style={{ color: 'var(--faint)' }}>{t.sub_value_name || 'None'}</span>
                        ) : (
                          <select
                            className="input"
                            style={{ fontSize: 12.5, padding: '6px 9px' }}
                            value={t.sub_value_id ?? ''}
                            disabled={editing === t.id || busy === g.game_id}
                            onChange={e => patchTag(t.id, { sub_value_id: e.target.value ? Number(e.target.value) : null })}
                          >
                            <option value="">None</option>
                            {subValues.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>
                        )}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {t.tagged_by_name || 'unknown'}
                        <span style={{ color: 'var(--faint)' }}> · {fmt(t.tagged_at)}</span>
                      </td>
                      <td>
                        {t.conflict ? (
                          <label style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 6, fontSize: 11.5, color: 'var(--warn)', cursor: 'pointer' }}>
                            <input type="checkbox" checked={overwrite.has(t.id)} onChange={() => toggleOverwrite(t.id)}
                              style={{ marginTop: 2 }} />
                            <span>
                              Has <strong>{t.their_sub_value_name}</strong> — tick to overwrite,
                              otherwise this tag is rejected
                            </span>
                          </label>
                        ) : t.their_sub_value_id !== null || t.their_sub_value_name ? (
                          <span style={{ fontSize: 11.5, color: 'var(--faint)' }}>
                            already tagged{t.their_sub_value_name ? ` · ${t.their_sub_value_name}` : ''}
                          </span>
                        ) : (
                          <span style={{ fontSize: 11.5, color: 'var(--faint)' }}>new</span>
                        )}
                      </td>
                      <td>
                        <button className="btn btn-sm btn-ghost" title="Reject this tag"
                          onClick={() => rejectTag(t.id)}
                          style={{ color: 'var(--faint)' }}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
              <button className="btn btn-primary btn-sm" disabled={busy === g.game_id} onClick={() => confirmGame(g)}>
                {busy === g.game_id ? 'Confirming…' : 'Confirm game'}
              </button>
              <span style={{ fontSize: 11.5, color: 'var(--faint)' }}>
                Writes {g.tags.length} tag{g.tags.length === 1 ? '' : 's'} into Signal Sense
                {conflicts > 0 && ` · ${conflicts} conflict${conflicts === 1 ? '' : 's'} rejected unless ticked`}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function HistoryView({ onOpenGame }: { onOpenGame: OpenGame }) {
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  // Defaults to this month: the queue is reviewed continuously, so the useful
  // question is "what did we do lately", not "everything ever".
  const [from, setFrom] = useState(monthStartLocal)
  const [to, setTo] = useState(todayLocal)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [loading, setLoading] = useState(false)
  const sentinelRef = useRef<HTMLTableRowElement>(null)
  const limit = 50

  // One page at a time, appended. `append` distinguishes "next page" from a
  // fresh read after the filters changed, which must replace what is on screen.
  const fetchPage = useCallback(async (p: number, append: boolean) => {
    const qs = new URLSearchParams({ page: String(p), limit: String(limit) })
    if (from) qs.set('from', from)
    if (to) qs.set('to', to)
    setLoading(true)
    try {
      const r = await fetch(`/api/playtest-tags/history?${qs}`)
      const d = r.ok ? await r.json() : { rows: [], total: 0 }
      const next = (d.rows || []) as HistoryRow[]
      if (append && next.length === 0) {
        // An empty page while total still claims more would leave the observer
        // asking forever. Trust what actually arrived and stop.
        setRows(prev => { setTotal(prev.length); return prev })
      } else {
        setRows(prev => (append ? [...prev, ...next] : next))
        setTotal(d.total || 0)
      }
      setPage(p)
    } catch {
      if (!append) { setRows([]); setTotal(0) }
    }
    setLoading(false)
  }, [from, to])

  // Sweep for tags deleted in Signal Sense, then read. Signal Sense keeps no
  // deletion log of its own, so this is the only chance to notice, and the sweep
  // has to finish first or the first paint would miss the stamps it writes.
  //
  // Keyed on reloadKey alone: a date tweak or a scroll must not re-run a
  // database sweep, and this leaves the first page load to this effect rather
  // than the filter one below.
  useEffect(() => {
    let live = true
    fetch('/api/playtest-tags/reconcile', { method: 'POST' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (live && d?.removed > 0) setMsg(`${d.removed} tag${d.removed === 1 ? '' : 's'} no longer in Signal Sense — recorded as removed.`) })
      .catch(() => {})
      .finally(() => { if (live) void fetchPage(1, false) })
    return () => { live = false }
    // fetchPage is intentionally omitted: including it would re-sweep on every
    // date change, and the filter effect below already handles those.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey])

  // Filter changes re-read from page 1 without sweeping. Skipped on mount, where
  // the sweep effect above does the first read.
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return }
    void fetchPage(1, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to])

  // Two-click confirm, the same shape as the evaluation panel's Clear all. This
  // deletes a row out of Signal Sense's table, so a stray click must not do it.
  const askRemove = (r: HistoryRow) => {
    if (confirmRemove !== r.id) {
      setConfirmRemove(r.id)
      setTimeout(() => setConfirmRemove(c => (c === r.id ? null : c)), 4000)
      return
    }
    setConfirmRemove(null)
    void removeTag(r)
  }

  const removeTag = async (r: HistoryRow) => {
    setBusy(r.id)
    try {
      const res = await fetch('/api/playtest-tags/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: r.id }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) setMsg(d.error || 'Could not remove that tag')
      else setMsg(d.outcome === 'deleted'
        ? `Removed ${r.field_value} from Signal Sense.`
        : `${r.field_value} was already gone from Signal Sense — recorded as removed.`)
      setReloadKey(k => k + 1)
    } catch { setMsg('Network error') }
    setBusy(null)
  }

  const hasMore = rows.length < total

  // Load the next page when the sentinel row scrolls into the list's viewport.
  // `root` is the scrolling card, not the window — the observer would never fire
  // against the window since the list scrolls inside its own box.
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore || loading) return
    const io = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) void fetchPage(page + 1, true)
    }, { root: el.closest('.tag-scroll'), rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, loading, page, fetchPage])

  // One Game cell per game, spanning its tags. Rows arrive newest-first, so a
  // game's group takes the position of its most recent tag and keeps that order
  // inside — grouping must not reshuffle the page into a different sort.
  const groups = useMemo(() => {
    const byGame = new Map<string, HistoryRow[]>()
    for (const r of rows) {
      const g = byGame.get(r.game_id)
      if (g) g.push(r)
      else byGame.set(r.game_id, [r])
    }
    return Array.from(byGame, ([game_id, gameRows]) => ({ game_id, rows: gameRows }))
  }, [rows])

  // One entry per game on this page, so the panel's prev/next walks the games
  // the admin is looking at rather than every game in the system.
  const gameList = useMemo<EvalListItem[]>(
    () => groups.map(g => ({ game_id: g.game_id, title: g.rows[0].title })), [groups])

  return (
    <div className="card">
      <div className="card-head" style={{ alignItems: 'flex-end' }}>
        <span className="card-label">
          Reviewed
          <span style={{ color: 'var(--faint)', fontWeight: 400, marginLeft: 8 }}>{total}</span>
        </span>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
          <div className="field">
            <span className="label">From</span>
            <input className="input" type="date" style={{ width: 150 }}
              value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <span className="label">To</span>
            <input className="input" type="date" style={{ width: 150 }}
              value={to} onChange={e => setTo(e.target.value)} />
          </div>
          {/* The range starts at this month, so "Clear" would be a lie — name what
              each button actually selects. */}
          {(from || to) && (
            <button className="btn btn-sm btn-ghost" onClick={() => { setFrom(''); setTo('') }}>All time</button>
          )}
          {(from !== monthStartLocal() || to !== todayLocal()) && (
            <button className="btn btn-sm btn-ghost"
              onClick={() => { setFrom(monthStartLocal()); setTo(todayLocal()) }}>This month</button>
          )}
        </div>
      </div>

      {msg && <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--muted)' }}>{msg}</p>}

      <div className="tbl-wrap tag-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 172 }}>Game</th>
              <th style={{ width: 150 }}>Trend</th>
              <th style={{ width: 116 }}>Sub-value</th>
              <th style={{ width: 116 }}>Proposed</th>
              <th style={{ width: 116 }}>Reviewed</th>
              <th style={{ width: 96 }}>Result</th>
              <th>Note</th>
              <th style={{ width: 84 }} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={8} className="empty">Nothing reviewed yet.</td></tr>
            )}
            {groups.map(g => g.rows.map((r, i) => (
              <tr key={r.id}>
                {i === 0 && (
                  <td className="cell-name" rowSpan={g.rows.length}
                    style={{ verticalAlign: 'top', borderRight: '1px solid var(--border)' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 8 }}>
                      {r.icon_url && (
                        <img src={r.icon_url} alt="" width={24} height={24}
                          style={{ borderRadius: 6, flexShrink: 0, border: '1px solid var(--border)' }} />
                      )}
                      <span style={{ minWidth: 0 }}>
                        <GameButton title={r.title} gameId={r.game_id} onOpen={onOpenGame} list={gameList} />
                        {g.rows.length > 1 && (
                          <span style={{ display: 'block', fontSize: 11, fontWeight: 400, color: 'var(--faint)' }}>
                            {g.rows.length} tags
                          </span>
                        )}
                      </span>
                    </span>
                  </td>
                )}
                <td className="num">{r.field_value}</td>
                <td style={{ color: r.sub_value_name ? undefined : 'var(--faint)' }}>{r.sub_value_name || '—'}</td>
                <td>
                  {r.tagged_by_name || '—'}
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--faint)', fontFamily: 'var(--num)' }}>
                    {fmt(r.tagged_at)}
                  </span>
                </td>
                <td>
                  {r.confirmed_by_name || '—'}
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--faint)', fontFamily: 'var(--num)' }}>
                    {fmt(r.confirmed_at)}
                  </span>
                </td>
                <td>
                  <span className={`pill ${r.removed_at ? 'off' : RESULT_PILL[r.sync_result ?? ''] ?? 'tag'}`} style={{ fontSize: 10 }}>
                    {r.removed_at ? 'removed' : (r.sync_result || r.status)}
                  </span>
                </td>
                {/* What happened to the tag after it was reviewed. Empty for a tag
                    still sitting in Signal Sense exactly as it was synced. */}
                <td style={{ fontSize: 11.5, lineHeight: 1.5 }}>
                  {r.removed_at && (
                    <span style={{ display: 'block', color: 'var(--muted)' }}>
                      was {r.sync_result || r.status}, removed {fmt(r.removed_at)}
                      {r.removed_by === 'signal_sense'
                        ? ' in Signal Sense'
                        : r.removed_by_name ? ` by ${r.removed_by_name}` : ''}
                    </span>
                  )}
                  {r.sub_changed_at && (
                    <span style={{ display: 'block', color: 'var(--warn)' }}>
                      sub-value now {r.sub_changed_to || 'None'}
                      {r.sub_changed_from ? ` (was ${r.sub_changed_from})` : ''}, {fmt(r.sub_changed_at)}
                      {r.sub_changed_by ? ` by ${r.sub_changed_by}` : ''}
                    </span>
                  )}
                  {!r.removed_at && !r.sub_changed_at && (
                    <span style={{ color: 'var(--faint)' }}>—</span>
                  )}
                </td>
                <td>
                  {r.status === 'synced' && r.in_signal_sense && (
                    r.ours ? (
                      <button className="btn btn-sm btn-ghost" disabled={busy === r.id}
                        title={confirmRemove === r.id
                          ? `Deletes ${r.field_value} from Signal Sense — click again to confirm`
                          : 'Delete this tag from Signal Sense and record the removal'}
                        onClick={() => askRemove(r)}
                        style={confirmRemove === r.id
                          ? { color: 'var(--bad)', borderColor: 'var(--bad)', background: 'var(--bad-weak)', fontWeight: 600 }
                          : { color: 'var(--bad)' }}>
                        {busy === r.id ? '…' : confirmRemove === r.id ? 'Confirm?' : 'Remove'}
                      </button>
                    ) : (
                      <span style={{ fontSize: 10.5, color: 'var(--faint)' }} title="playtest sync did not create this row, so it cannot be removed from here">
                        added in Signal Sense
                      </span>
                    )
                  )}
                </td>
              </tr>
            )))}
            {/* Watched by the observer above: crossing into view loads the next
                page. Kept inside the table so it scrolls with the rows. */}
            {(hasMore || loading) && (
              <tr ref={sentinelRef}>
                <td colSpan={8} className="tag-sentinel">
                  {loading ? 'Loading…' : `${rows.length} of ${total} — scroll for more`}
                </td>
              </tr>
            )}
            {!hasMore && !loading && rows.length > 0 && (
              <tr><td colSpan={8} className="tag-sentinel">All {total} shown</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
