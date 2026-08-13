'use client'
import { useCallback, useEffect, useState } from 'react'

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

// Admin review of Trends tags proposed during playtest. A tag only reaches
// Signal Sense's custom_field_values when it is confirmed here.
export function TaggingTab() {
  const [view, setView] = useState<'pending' | 'history'>('pending')
  return (
    <div>
      <h1 className="h-title">Tagging</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className={`btn btn-sm ${view === 'pending' ? 'btn-primary' : ''}`} onClick={() => setView('pending')}>Pending</button>
        <button className={`btn btn-sm ${view === 'history' ? 'btn-primary' : ''}`} onClick={() => setView('history')}>History</button>
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

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/playtest-tags/pending')
      const d = r.ok ? await r.json() : { games: [] }
      setGames(d.games || [])
    } catch { setGames([]) }
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

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
        setMsg(`${g.title}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`)
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

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--faint)' }}>Loading...</div>
  if (games.length === 0) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--faint)' }}>No tags waiting for review.</div>

  const cleanCount = games.filter(g => !g.tags.some(t => t.conflict)).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {msg && <div style={{ fontSize: 12, color: 'var(--faint)' }}>{msg}</div>}
      {cleanCount > 1 && (
        <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={confirmClean}>
          Confirm all {cleanCount} games without conflicts
        </button>
      )}
      {games.map(g => (
        <div key={g.game_id} className="card" style={{ margin: 0 }}>
          <div className="card-head">
            <span className="card-label">
              {g.icon_url && <img src={g.icon_url} alt="" width={20} height={20} style={{ verticalAlign: 'middle', marginRight: 6, borderRadius: 4 }} />}
              {g.title}
            </span>
            <span style={{ fontSize: 12, color: 'var(--faint)' }}>
              {g.publisher_name || '—'} · {g.initial_evaluator || 'unassigned'}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0' }}>
            {g.tags.map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
                <strong>{t.field_value}</strong>
                <span style={{ color: 'var(--faint)' }}>{t.sub_value_name || 'no sub-value'}</span>
                <span style={{ color: 'var(--faint)', fontSize: 11 }}>
                  by {t.tagged_by_name || 'unknown'} · {fmt(t.tagged_at)}
                </span>
                {t.conflict && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--warn, #b45309)' }}>
                    <input type="checkbox" checked={overwrite.has(t.id)} onChange={() => toggleOverwrite(t.id)} />
                    Signal Sense has {t.their_sub_value_name} — check to overwrite, otherwise this tag is rejected
                  </label>
                )}
                <button className="btn btn-sm btn-ghost" onClick={() => rejectTag(t.id)}>✕</button>
              </div>
            ))}
          </div>
          <button className="btn btn-primary btn-sm" disabled={busy === g.game_id} onClick={() => confirmGame(g)}>
            {busy === g.game_id ? 'Confirming...' : 'Confirm game'}
          </button>
        </div>
      ))}
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

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, fontSize: 12 }}>
        <label>From <input className="input" type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(1) }} /></label>
        <label>To <input className="input" type="date" value={to} onChange={e => { setTo(e.target.value); setPage(1) }} /></label>
        <span style={{ color: 'var(--faint)' }}>{total} rows</span>
      </div>
      <table className="table" style={{ fontSize: 13 }}>
        <thead>
          <tr>
            <th>Game</th><th>Trend</th><th>Sub-value</th><th>Tagged by</th>
            <th>Tagged</th><th>Confirmed by</th><th>Confirmed</th><th>Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td>{r.title}</td>
              <td>{r.field_value}</td>
              <td>{r.sub_value_name || '—'}</td>
              <td>{r.tagged_by_name || '—'}</td>
              <td>{fmt(r.tagged_at)}</td>
              <td>{r.confirmed_by_name || '—'}</td>
              <td>{fmt(r.confirmed_at)}</td>
              <td>{r.sync_result || r.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && (
        <div style={{ padding: 30, textAlign: 'center', color: 'var(--faint)' }}>Nothing confirmed or rejected yet.</div>
      )}
      {pages > 1 && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 10 }}>
          <button className="btn btn-sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Prev</button>
          <span style={{ fontSize: 12, alignSelf: 'center' }}>{page} / {pages}</span>
          <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</button>
        </div>
      )}
    </div>
  )
}
