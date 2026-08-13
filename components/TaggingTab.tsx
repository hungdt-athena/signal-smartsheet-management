'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
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
}

const fmt = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: 'short', year: 'numeric' }) : '—'

// Written into Signal Sense → green; already there or deliberately left alone →
// muted; refused because the value is retired → red.
const RESULT_PILL: Record<string, string> = {
  inserted: 'on', enriched: 'on', overwritten: 'on',
  duplicate: 'muted', kept: 'muted', inactive: 'off',
}

// Admin review of Trends tags proposed during playtest. A tag only reaches
// Signal Sense's custom_field_values when it is confirmed here.
export function TaggingTab() {
  const [view, setView] = useState<'pending' | 'history'>('pending')
  return (
    <div className="page">
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
      {view === 'pending' ? <PendingView /> : <HistoryView />}
    </div>
  )
}

function PendingView() {
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
                  {g.title}
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

function HistoryView() {
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const limit = 50

  useEffect(() => {
    const qs = new URLSearchParams({ page: String(page), limit: String(limit) })
    if (from) qs.set('from', from)
    if (to) qs.set('to', to)
    fetch(`/api/playtest-tags/history?${qs}`)
      .then(r => r.ok ? r.json() : { rows: [], total: 0 })
      .then(d => { setRows(d.rows || []); setTotal(d.total || 0) })
      .catch(() => { setRows([]); setTotal(0) })
  }, [page, from, to])

  const pages = Math.max(1, Math.ceil(total / limit))

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
              value={from} onChange={e => { setFrom(e.target.value); setPage(1) }} />
          </div>
          <div className="field">
            <span className="label">To</span>
            <input className="input" type="date" style={{ width: 150 }}
              value={to} onChange={e => { setTo(e.target.value); setPage(1) }} />
          </div>
          {(from || to) && (
            <button className="btn btn-sm btn-ghost" onClick={() => { setFrom(''); setTo(''); setPage(1) }}>Clear</button>
          )}
        </div>
      </div>

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Game</th>
              <th>Trend</th>
              <th style={{ width: 130 }}>Sub-value</th>
              <th style={{ width: 110 }}>Proposed by</th>
              <th style={{ width: 105 }}>Proposed</th>
              <th style={{ width: 110 }}>Reviewed by</th>
              <th style={{ width: 105 }}>Reviewed</th>
              <th style={{ width: 105 }}>Result</th>
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
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      {r.icon_url && (
                        <img src={r.icon_url} alt="" width={26} height={26}
                          style={{ borderRadius: 6, flexShrink: 0, border: '1px solid var(--border)' }} />
                      )}
                      <span>
                        {r.title}
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
                <td>{r.tagged_by_name || '—'}</td>
                <td className="num" style={{ fontSize: 12, color: 'var(--muted)' }}>{fmt(r.tagged_at)}</td>
                <td>{r.confirmed_by_name || '—'}</td>
                <td className="num" style={{ fontSize: 12, color: 'var(--muted)' }}>{fmt(r.confirmed_at)}</td>
                <td>
                  <span className={`pill ${RESULT_PILL[r.sync_result ?? ''] ?? 'tag'}`} style={{ fontSize: 10 }}>
                    {r.sync_result || r.status}
                  </span>
                </td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 12 }}>
          <button className="btn btn-sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Prev</button>
          <span style={{ fontSize: 12, color: 'var(--faint)', fontVariantNumeric: 'tabular-nums' }}>{page} / {pages}</span>
          <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</button>
        </div>
      )}
    </div>
  )
}
