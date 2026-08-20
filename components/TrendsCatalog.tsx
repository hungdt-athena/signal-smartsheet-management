'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { parseMarkdownLite, type Inline } from '@/lib/markdown-lite'
import type { EvalListItem } from './EvalDetailPanel'

/** One trend as the listing shows it. Counts are games, not proposals. */
interface TrendRow {
  value: string
  total: number
  last30: number
  lastTaggedAt: string | null
  hasInstruction: boolean
}

/** A game carrying the trend, newest tag first. */
interface TrendGame {
  game_id: string
  title: string
  icon_url: string | null
  sub_value_name: string | null
  created_at: string
}

type Sort = 'last30' | 'total' | 'recent' | 'name'

const SORTS: { key: Sort; label: string }[] = [
  { key: 'last30', label: 'Busiest 30 days' },
  { key: 'total', label: 'Most games' },
  { key: 'recent', label: 'Recently tagged' },
  { key: 'name', label: 'A–Z' },
]

const fmt = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: 'short', year: 'numeric' }) : '—'

const num = (n: number) => (n === 0 ? '—' : n.toLocaleString('en-US'))

// Bold runs inside one markdown line.
function Text({ parts }: { parts: Inline[] }) {
  return <>{parts.map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : <span key={i}>{p.text}</span>))}</>
}

// The trend's own guidance from Signal Sense, rendered as text nodes rather than
// injected HTML — this app displays that field, it does not own it.
function Instruction({ md }: { md: string }) {
  const blocks = useMemo(() => parseMarkdownLite(md), [md])
  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text)' }}>
      {blocks.map((b, i) => {
        if (b.kind === 'heading') return (
          <p key={i} style={{
            margin: i === 0 ? '0 0 6px' : '12px 0 6px',
            fontWeight: 600, fontSize: b.level <= 2 ? 13 : 12.5, color: 'var(--muted)',
          }}><Text parts={b.text} /></p>
        )
        if (b.kind === 'list') return (
          <ul key={i} style={{ margin: '0 0 8px', paddingLeft: 18 }}>
            {b.items.map((it, j) => <li key={j} style={{ marginBottom: 2 }}><Text parts={it} /></li>)}
          </ul>
        )
        return <p key={i} style={{ margin: '0 0 8px' }}><Text parts={b.text} /></p>
      })}
    </div>
  )
}

// What one trend means and which games carry it. Opened from the listing; a game
// clicked here hands off to the evaluation panel the tab already owns.
function TrendPanel({ trend, onClose, onOpenGame }: {
  trend: TrendRow
  onClose: () => void
  onOpenGame: (gameId: string, list: EvalListItem[]) => void
}) {
  const [instruction, setInstruction] = useState<string | null>(null)
  const [games, setGames] = useState<TrendGame[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    setLoading(true); setFailed(false)
    fetch(`/api/trends/detail?value=${encodeURIComponent(trend.value)}`)
      .then(r => { if (!r.ok) throw new Error('failed'); return r.json() })
      .then(d => {
        if (!live) return
        setInstruction(d.instruction ?? null)
        setGames((d.games || []) as TrendGame[])
      })
      .catch(() => { if (live) setFailed(true) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [trend.value])

  // The panel's prev/next walks the games shown here, so the reader stays inside
  // the trend they opened rather than the whole system.
  const list = useMemo<EvalListItem[]>(
    () => games.map(g => ({ game_id: g.game_id, title: g.title })), [games])

  return (
    <div className="eval-modal-backdrop" onClick={onClose}>
      <div className="eval-modal-container" onClick={e => e.stopPropagation()}
        style={{ padding: '20px 24px 24px', maxWidth: 640 }}>
        <div className="card-head" style={{ alignItems: 'flex-start' }}>
          <div>
            <span className="card-label" style={{ fontSize: 15 }}>{trend.value}</span>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--faint)' }}>
              {num(trend.total)} game{trend.total === 1 ? '' : 's'} tagged
              {trend.last30 > 0 ? `, ${trend.last30} in the last 30 days` : ''}
              {trend.lastTaggedAt ? ` — last on ${fmt(trend.lastTaggedAt)}` : ''}
            </p>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose}>Close</button>
        </div>

        {loading && <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>Loading…</p>}
        {failed && <p style={{ fontSize: 12.5, color: 'var(--bad)' }}>Could not load this trend.</p>}

        {!loading && !failed && (
          <>
            {instruction
              ? <div style={{ marginBottom: 16 }}><Instruction md={instruction} /></div>
              : (
                <p style={{ fontSize: 12.5, color: 'var(--faint)', marginBottom: 16 }}>
                  No description written for this trend yet.
                </p>
              )}

            <span className="card-label" style={{ fontSize: 12 }}>Recently tagged</span>
            <div className="tbl-wrap" style={{ marginTop: 8, maxHeight: 320, overflowY: 'auto' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Game</th>
                    <th style={{ width: 130 }}>Sub-value</th>
                    <th style={{ width: 116 }}>Tagged</th>
                  </tr>
                </thead>
                <tbody>
                  {games.length === 0 && (
                    <tr><td colSpan={3} className="empty">No game carries this trend yet.</td></tr>
                  )}
                  {games.map(g => (
                    <tr key={g.game_id}>
                      <td className="cell-name">
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          {g.icon_url && (
                            <img src={g.icon_url} alt="" width={24} height={24}
                              style={{ borderRadius: 6, flexShrink: 0, border: '1px solid var(--border)' }} />
                          )}
                          <button type="button" title="Open the evaluation"
                            onClick={() => onOpenGame(g.game_id, list)}
                            style={{
                              border: 0, background: 'none', padding: 0, cursor: 'pointer',
                              font: 'inherit', color: 'var(--accent)', textAlign: 'left',
                            }}>{g.title}</button>
                        </span>
                      </td>
                      <td style={{ color: g.sub_value_name ? undefined : 'var(--faint)' }}>
                        {g.sub_value_name || '—'}
                      </td>
                      <td style={{ fontFamily: 'var(--num)', fontSize: 11.5, color: 'var(--faint)' }}>
                        {fmt(g.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// Every Trends value an evaluator may pick, with how much it is being used.
// Read-only: definitions belong to Signal Sense, this view only makes them
// findable — and shows which of them the team is actually tagging.
export function TrendsCatalog({ onOpenGame }: {
  onOpenGame: (gameId: string, list: EvalListItem[]) => void
}) {
  const [trends, setTrends] = useState<TrendRow[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<Sort>('last30')
  const [open, setOpen] = useState<TrendRow | null>(null)

  const load = useCallback(() => {
    setLoading(true); setFailed(false)
    fetch('/api/trends/catalog')
      .then(r => { if (!r.ok) throw new Error('failed'); return r.json() })
      .then(d => setTrends((d.trends || []) as TrendRow[]))
      .catch(() => setFailed(true))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  // All ~351 trends arrive at once, so searching and re-sorting stay local —
  // no request between typing a letter and seeing the list narrow.
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const rows = needle ? trends.filter(t => t.value.toLowerCase().includes(needle)) : trends.slice()
    const byName = (a: TrendRow, b: TrendRow) => a.value.localeCompare(b.value)
    rows.sort((a, b) => {
      switch (sort) {
        case 'total': return b.total - a.total || byName(a, b)
        case 'recent': return (b.lastTaggedAt || '').localeCompare(a.lastTaggedAt || '') || byName(a, b)
        case 'name': return byName(a, b)
        default: return b.last30 - a.last30 || b.total - a.total || byName(a, b)
      }
    })
    return rows
  }, [trends, q, sort])

  return (
    <div className="card">
      <div className="card-head" style={{ alignItems: 'flex-end' }}>
        <span className="card-label">
          Trends
          <span style={{ color: 'var(--faint)', fontWeight: 400, marginLeft: 8 }}>
            {q ? `${shown.length} of ${trends.length}` : trends.length}
          </span>
        </span>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
          <div className="field">
            <span className="label">Search</span>
            <input className="input" style={{ width: 200 }} placeholder="Search trends"
              value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <div className="field">
            <span className="label" id="trend-sort-label">Sort</span>
            <select className="input" style={{ width: 170 }} aria-labelledby="trend-sort-label"
              value={sort} onChange={e => setSort(e.target.value as Sort)}>
              {SORTS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>
        </div>
      </div>

      {failed && (
        <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--bad)' }}>
          Could not load the trends.{' '}
          <button className="btn btn-sm btn-ghost" onClick={load}>Retry</button>
        </p>
      )}

      <div className="tbl-wrap tag-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th>Trend</th>
              <th style={{ width: 110 }}>Last 30 days</th>
              <th style={{ width: 110 }}>Total games</th>
              <th style={{ width: 130 }}>Last tagged</th>
            </tr>
          </thead>
          <tbody>
            {!loading && shown.length === 0 && (
              <tr><td colSpan={4} className="empty">
                {q ? `No trend matches “${q}”.` : 'No trends defined.'}
              </td></tr>
            )}
            {shown.map(t => (
              <tr key={t.value}>
                <td className="cell-name">
                  <button type="button" title="See what this trend means and which games carry it"
                    onClick={() => setOpen(t)}
                    style={{
                      border: 0, background: 'none', padding: 0, cursor: 'pointer',
                      font: 'inherit', color: 'var(--accent)', textAlign: 'left',
                    }}>{t.value}</button>
                </td>
                <td className="num">{num(t.last30)}</td>
                <td className="num">{num(t.total)}</td>
                <td style={{ fontFamily: 'var(--num)', fontSize: 11.5, color: 'var(--faint)' }}>
                  {fmt(t.lastTaggedAt)}
                </td>
              </tr>
            ))}
            {loading && (
              <tr><td colSpan={4} className="tag-sentinel">Loading…</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {open && (
        <TrendPanel trend={open} onClose={() => setOpen(null)}
          onOpenGame={(gameId, list) => { setOpen(null); onOpenGame(gameId, list) }} />
      )}
    </div>
  )
}
