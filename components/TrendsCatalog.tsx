'use client'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { parseMarkdownLite, type Inline } from '@/lib/markdown-lite'
import type { EvalListItem } from './EvalDetailPanel'
import { StyledSelect } from './StyledSelect'
import { Modal } from './ui/Modal'
import { FilterBar, FilterSpacer, ClearFilters, FilterCount } from './ui/FilterBar'
import { SearchInput } from './ui/SearchInput'
import { EmptyState, ErrorState, SkeletonRows } from './ui/States'
import { useUrlState, useSetUrlParams } from '@/lib/use-url-state'
import { fmtDateVN } from '@/lib/format-date'

/** URL key of the Tagging tab's category group filter. Lives here because both
 *  this listing and TaggingTab (which imports this file) clear it. */
export const CATEGORY_KEY = 'bucket'

/** One trend as the listing shows it. Counts are games, not proposals. */
interface TrendRow {
  value: string
  total: number
  last30: number
  lastTaggedAt: string | null
  hasInstruction: boolean
  /** Category groups the trend is defined for. */
  categoryGroups: string[]
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

const SORTS: { value: Sort; label: string }[] = [
  { value: 'last30', label: 'Busiest 30 days' },
  { value: 'total', label: 'Most games' },
  { value: 'recent', label: 'Recently tagged' },
  { value: 'name', label: 'A–Z' },
]
const isSort = (v: string): v is Sort => SORTS.some(s => s.value === v)

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
    <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text)' }}>
      {blocks.map((b, i) => {
        if (b.kind === 'heading') return (
          <p key={i} style={{
            margin: i === 0 ? '0 0 6px' : '12px 0 6px',
            fontWeight: 600, fontSize: 13, color: 'var(--muted)',
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
  const [reloadKey, setReloadKey] = useState(0)

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
  }, [trend.value, reloadKey])

  // The panel's prev/next walks the games shown here, so the reader stays inside
  // the trend they opened rather than the whole system.
  const list = useMemo<EvalListItem[]>(
    () => games.map(g => ({ game_id: g.game_id, title: g.title })), [games])

  return (
    <Modal title={trend.value} width={640} onClose={onClose}
      sub={<>
        {num(trend.total)} game{trend.total === 1 ? '' : 's'} tagged
        {trend.last30 > 0 ? `, ${trend.last30} in the last 30 days` : ''}
        {trend.lastTaggedAt ? `. Last on ${fmtDateVN(trend.lastTaggedAt)}` : ''}
      </>}>
      {loading && <p style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</p>}
      {failed && <ErrorState onRetry={() => setReloadKey(k => k + 1)}>Could not load this trend.</ErrorState>}

      {!loading && !failed && (
        <>
          {instruction
            ? <div style={{ marginBottom: 16 }}><Instruction md={instruction} /></div>
            : (
              <p style={{ fontSize: 13, color: 'var(--faint)', marginBottom: 16 }}>
                No description written for this trend yet.
              </p>
            )}

          <span className="card-label" style={{ fontSize: 12 }}>Recently tagged</span>
          <div className="tbl-wrap" style={{ marginTop: 8, maxHeight: 320, overflowY: 'auto' }}>
            <table className="tbl tbl-sticky">
              <thead>
                <tr>
                  <th>Game</th>
                  <th style={{ width: 130 }}>Sub-value</th>
                  <th style={{ width: 116 }}>Tagged</th>
                </tr>
              </thead>
              <tbody>
                {games.length === 0 && (
                  <tr><td colSpan={3}><EmptyState>No game carries this trend yet.</EmptyState></td></tr>
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
                    <td style={{ fontFamily: 'var(--num)', fontSize: 12, color: 'var(--faint)' }}>
                      {fmtDateVN(g.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  )
}

// Every Trends value an evaluator may pick, with how much it is being used.
// Read-only: definitions belong to Signal Sense, this view only makes them
// findable — and shows which of them the team is actually tagging.
export function TrendsCatalog({ onOpenGame, categoryGroup = 'all', lead }: {
  onOpenGame: (gameId: string, list: EvalListItem[]) => void
  /** The tab's Category group filter: 'all', or one group to narrow the listing to. */
  categoryGroup?: string
  /** The tab's category group control, put first in this view's filter bar. */
  lead?: ReactNode
}) {
  const [trends, setTrends] = useState<TrendRow[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  // Search and sort live in the URL. The box keeps its own text while typing and
  // writes to the URL once the typing pauses, so each key press is not a navigation.
  const [qParam, setQParam] = useUrlState('q', '')
  const [q, setQ] = useState(qParam)
  const [sortParam, setSort] = useUrlState('sort', 'last30')
  const sort: Sort = isSort(sortParam) ? sortParam : 'last30'
  const setUrlParams = useSetUrlParams()
  const [open, setOpen] = useState<TrendRow | null>(null)

  // The URL changed under the box (Clear filters, Back): follow it. Our own
  // debounced write is skipped, or text typed after it would be overwritten.
  const written = useRef(qParam)
  useEffect(() => {
    if (qParam === written.current) return
    written.current = qParam
    setQ(qParam)
  }, [qParam])
  useEffect(() => {
    if (q === written.current) return
    const t = setTimeout(() => { written.current = q; setQParam(q) }, 300)
    return () => clearTimeout(t)
  }, [q, setQParam])

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
  // The category-group filter is local too: each row already says which groups define it.
  const inCategoryGroup = useMemo(
    () => (categoryGroup === 'all' ? trends : trends.filter(t => (t.categoryGroups ?? []).includes(categoryGroup))),
    [trends, categoryGroup],
  )
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const rows = needle ? inCategoryGroup.filter(t => t.value.toLowerCase().includes(needle)) : inCategoryGroup.slice()
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
  }, [inCategoryGroup, q, sort])

  // Sort is not a filter, so Clear filters leaves it alone.
  const filtered = categoryGroup !== 'all' || q.trim() !== ''
  const clearFilters = () => { setQ(''); setUrlParams({ [CATEGORY_KEY]: null, q: null }) }

  return (
    <>
      <FilterBar>
        {lead}
        <SearchInput value={q} onChange={setQ} placeholder="Search trends" />
        <FilterSpacer />
        <ClearFilters visible={filtered} onClear={clearFilters} />
        <FilterCount loading={loading} shown={shown.length} total={trends.length} noun="trends" />
        <div style={{ width: 170 }}>
          <StyledSelect ariaLabel="Sort" value={sort} onChange={setSort} options={SORTS} />
        </div>
      </FilterBar>

      <div className="card">
        {failed ? (
          <ErrorState onRetry={load}>Could not load the trends.</ErrorState>
        ) : (
          <div className="tbl-wrap tag-scroll">
            <table className="tbl tbl-sticky">
              <thead>
                <tr>
                  <th>Trend</th>
                  <th className="tnum" style={{ width: 110 }}>Last 30 days</th>
                  <th className="tnum" style={{ width: 110 }}>Total games</th>
                  <th style={{ width: 130 }}>Last tagged</th>
                </tr>
              </thead>
              <tbody>
                {loading && trends.length === 0 && <SkeletonRows widths={[200, 40, 40, 80]} />}
                {!loading && shown.length === 0 && (
                  <tr><td colSpan={4}>
                    <EmptyState action={filtered ? { label: 'Clear filters', onClick: clearFilters } : undefined}>
                      {q ? `No trend matches “${q}”.` : categoryGroup === 'all' ? 'No trends defined.' : `No ${categoryGroup} trends defined yet.`}
                    </EmptyState>
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
                    <td className="num tnum">{num(t.last30)}</td>
                    <td className="num tnum">{num(t.total)}</td>
                    <td style={{ fontFamily: 'var(--num)', fontSize: 12, color: 'var(--faint)' }}>
                      {fmtDateVN(t.lastTaggedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {open && (
          <TrendPanel trend={open} onClose={() => setOpen(null)}
            onOpenGame={(gameId, list) => { setOpen(null); onOpenGame(gameId, list) }} />
        )}
      </div>
    </>
  )
}
