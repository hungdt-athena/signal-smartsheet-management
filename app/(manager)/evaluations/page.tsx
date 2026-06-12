'use client'
import { useState, useEffect, useCallback, useRef, useMemo, Suspense } from 'react'
import { useSession } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import { StyledSelect } from '@/components/StyledSelect'
import { MonthPicker } from '@/components/MonthPicker'
import type { YearMonth } from '@/components/MonthPicker'
import EvalDetailPanel from '@/components/EvalDetailPanel'
import { QuickStatsModal } from '@/components/QuickStatsModal'
import type { EvalDetail, EvalListItem } from '@/components/EvalDetailPanel'

interface Evaluation {
  id: number
  game_id: string
  category_group: string
  genre_1: string | null
  genre_2: string | null
  initial_evaluator: string | null
  final_evaluator: string | null
  assigned_date: string | null
  evaluate_date: string | null
  initial_note: string | null
  initial_conclusion: string | null
  drive_link: string | null
  imported_at: string
  title: string
  os: string
  app_link: string
  icon_url: string | null
  release_date: string | null
  publisher_name: string | null
}

const CONCLUSION_COLORS: Record<string, string> = {
  'Bypass': 'error', 'M_ByPass': 'error', 'Skip': 'error', 'Link_dead': 'error',
  'Good': 'success', 'Conclusion': 'success',
  'List_Idea': 'success', 'Priority I': 'success', 'Priority II': 'success',
  'Priority III: Watchlist for next phase': 'running',
  'Priority IV: Idea': 'running', 'Watchlist for next milestone': 'running',
  'Need deeper testing': 'running', 'Wait for PlayTest': 'running',
  'Check Market Data': 'running', 'Need Direction': 'running',
}

const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function conclusionBadge(c: string | null) {
  if (!c) return <span className="badge idle">Pending</span>
  return <span className={`badge ${CONCLUSION_COLORS[c] || 'neutral'}`}>{c}</span>
}

function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

const PAGE_SIZE = 200

// useSearchParams requires a Suspense boundary for static prerendering.
export default function EvaluationsPage() {
  return (
    <Suspense>
      <EvaluationsPageInner />
    </Suspense>
  )
}

function EvaluationsPageInner() {
  const { data: session } = useSession()
  const searchParams = useSearchParams()
  const role = session?.user?.role
  const userName = session?.user?.name || ''

  const category = searchParams.get('cat') || 'puzzle'

  const [data, setData] = useState<Evaluation[]>([])
  const [total, setTotal] = useState(0)
  const [conclusionOptions, setConclusionOptions] = useState<string[]>([])
  const [evaluatorOptions, setEvaluatorOptions] = useState<string[]>([])
  const [availableMonths, setAvailableMonths] = useState<YearMonth[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)

  const [filterEvaluator, setFilterEvaluator] = useState('')
  const [filterConclusion, setFilterConclusion] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterMonth, setFilterMonth] = useState<YearMonth | null>(null)
  // First load sends month=auto; the server resolves the default month
  // (current month, falling back to latest with data) and echoes it back.
  const [autoMonth, setAutoMonth] = useState(true)
  const suppressFetchRef = useRef(false)
  const fetchSeqRef = useRef(0)

  const [search, setSearch] = useState('')
  const [showQuickStats, setShowQuickStats] = useState(false)
  const [detailGameId, setDetailGameId] = useState<string | null>(null)
  const [detailList, setDetailList] = useState<EvalListItem[]>([])
  const [activeGameId, setActiveGameId] = useState<string | null>(null)
  const activeRowRef = useRef<HTMLTableRowElement | null>(null)

  const [apiStats, setApiStats] = useState({ total: 0, evaluated: 0, pending: 0 })
  const stats = useMemo(() => ({
    totalCount: apiStats.total,
    evaluatedCount: apiStats.evaluated,
    pendingCount: apiStats.pending,
    percent: apiStats.total > 0 ? Math.round((apiStats.evaluated / apiStats.total) * 100) : 0,
  }), [apiStats])

  const pageRef = useRef(1)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const fetchPage = useCallback(async (page: number, append: boolean) => {
    const seq = ++fetchSeqRef.current
    if (append) setLoadingMore(true); else setLoading(true)
    try {
      const params = new URLSearchParams({ category, page: String(page), limit: String(PAGE_SIZE) })
      const isManager = role === 'admin' || role === 'moderator'
      if (!isManager) {
        if (userName) params.set('evaluator', userName)
      } else if (filterEvaluator) {
        params.set('evaluator', filterEvaluator)
      }
      if (filterConclusion) params.set('conclusion', filterConclusion)
      if (filterStatus) params.set('status', filterStatus)
      if (autoMonth) {
        params.set('month', 'auto')
      } else if (filterMonth) {
        params.set('year', String(filterMonth.year))
        params.set('month', String(filterMonth.month))
      }
      const res = await fetch(`/api/evaluations?${params}`)
      const json = await res.json()
      if (seq !== fetchSeqRef.current) return // stale response; a newer fetch owns the state
      const rows = json.data || []
      if (append) {
        setData(prev => [...prev, ...rows])
      } else {
        setData(rows)
      }
      if (json.total !== undefined) setTotal(json.total)
      if (json.stats) setApiStats(json.stats)
      if (json.available_conclusions) setConclusionOptions(json.available_conclusions)
      if (json.available_evaluators) setEvaluatorOptions(json.available_evaluators)
      if (json.available_months) setAvailableMonths(json.available_months)
      if (autoMonth && json.applied_month !== undefined) {
        // Lock in the server-resolved month: the picker shows it and all
        // later fetches use explicit params instead of re-resolving auto.
        const ap = json.applied_month as YearMonth | null
        suppressFetchRef.current = true
        setAutoMonth(false)
        setFilterMonth(ap)
      }
      setHasMore(rows.length === PAGE_SIZE)
    } catch { /* ignore */ }
    setLoading(false)
    setLoadingMore(false)
  }, [category, filterEvaluator, filterConclusion, filterStatus, filterMonth, autoMonth, role, userName])

  useEffect(() => {
    if (suppressFetchRef.current) {
      suppressFetchRef.current = false
      return
    }
    pageRef.current = 1
    fetchPage(1, false)
  }, [fetchPage])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore && !loading && !loadingMore) {
        pageRef.current += 1
        fetchPage(pageRef.current, true)
      }
    }, { rootMargin: '200px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loading, loadingMore, fetchPage])

  const filtered = useMemo(() => {
    if (!search.trim()) return data
    const q = search.toLowerCase()
    return data.filter(d => d.title.toLowerCase().includes(q) || d.game_id.toLowerCase().includes(q))
  }, [data, search])

  // Server-provided full list for the category (ignores month + pagination);
  // fall back to deriving from loaded rows until the first page-1 response lands.
  const evaluators = evaluatorOptions.length > 0
    ? evaluatorOptions
    : Array.from(new Set(data.map(d => d.initial_evaluator).filter(Boolean) as string[]))

  const openDetail = (gameId: string) => {
    const list = filtered.map(d => ({ game_id: d.game_id, title: d.title }))
    setDetailList(list)
    setDetailGameId(gameId)
    setActiveGameId(gameId)
  }

  const handleNavigate = (gameId: string) => {
    setActiveGameId(gameId)
  }

  const handleClose = () => {
    setDetailGameId(null)
    // activeGameId remains set so the row stays highlighted after close
    // Scroll the highlighted row into view
    setTimeout(() => {
      activeRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 50)
  }

  return (
    <div className="page" style={{ paddingBottom: 16, height: '100vh', boxSizing: 'border-box', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h1 className="h-title">Evaluations</h1>
          <p className="h-sub">
            {total} games · {category}
            {filterMonth ? ` · ${MONTH_NAMES[filterMonth.month]} ${filterMonth.year}` : ''}
            {role !== 'admin' && role !== 'moderator' && userName ? ` · ${userName}` : ''}
          </p>
        </div>
      </div>

      {/* Summary Stats Widgets */}
      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label">Total Games</span>
          <div className="stat-val">{stats.totalCount}</div>
          <span className="stat-subtext">Listed in database</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Evaluated</span>
          <div className="stat-val">
            {stats.evaluatedCount}
            <span className="pill success" style={{ fontSize: 10, padding: '2px 6px', marginLeft: 8 }}>{stats.percent}%</span>
          </div>
          <span className="stat-subtext">Completed reviews</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Pending</span>
          <div className="stat-val" style={{ color: stats.pendingCount > 0 ? 'var(--warn)' : 'var(--text)' }}>
            {stats.pendingCount}
          </div>
          <span className="stat-subtext">Awaiting evaluation</span>
        </div>
        <div className="stat-card" role="button" tabIndex={0}
          onClick={() => setShowQuickStats(true)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setShowQuickStats(true) }}
          style={{ cursor: 'pointer' }}>
          <span className="stat-label">Quick Stats</span>
          <div className="stat-val" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--accent)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="20" x2="18" y2="10" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="6" y1="20" x2="6" y2="14" />
            </svg>
            View
          </div>
          <span className="stat-subtext">Per-evaluator breakdown</span>
        </div>
      </div>

      {/* Filters */}
      <div className="filter-row" style={{ position: 'relative', zIndex: 30 }}>
        <div className="search-wrap">
          <span className="search-icon-abs">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
          </span>
          <input className="search-input" placeholder="Search games..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>

        <MonthPicker
          available={availableMonths}
          value={filterMonth}
          onChange={v => { setAutoMonth(false); setFilterMonth(v) }}
        />

        <div className="seg-wrapper">
          {[
            { value: '', label: 'All' },
            { value: 'pending', label: 'Pending' },
            { value: 'done', label: 'Done' },
          ].map(s => (
            <button key={s.value} className={`seg-btn-premium${filterStatus === s.value ? ' active' : ''}`}
              onClick={() => setFilterStatus(s.value)}>
              {s.label}
            </button>
          ))}
        </div>

        {(role === 'admin' || role === 'moderator') && (
          <div style={{ width: 180 }}>
            <StyledSelect
              value={filterEvaluator}
              onChange={setFilterEvaluator}
              placeholder="All evaluators"
              options={[{ value: '', label: 'All evaluators' }, ...evaluators.map(e => ({ value: e, label: e }))]}
            />
          </div>
        )}

        <div style={{ width: 220 }}>
          <StyledSelect
            value={filterConclusion}
            onChange={setFilterConclusion}
            placeholder="All conclusions"
            options={[{ value: '', label: 'All conclusions' }, ...conclusionOptions.map(c => ({ value: c, label: c }))]}
          />
        </div>

        <span className="sync" style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600 }}>{loading ? 'Loading...' : `${filtered.length}${search ? ` / ${total}` : ''} results`}</span>
      </div>

      {/* Table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="tbl-wrap" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <table className="tbl">
            <thead style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface)', boxShadow: '0 1px 0 var(--border)' }}>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th>Game</th>
                <th>Initial</th>
                <th>Final</th>
                <th>Assigned</th>
                <th>Note</th>
                <th>Conclusion</th>
                <th>Evaluated</th>
                <th>Drive</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && !loading && (
                <tr><td colSpan={9} className="empty">{search ? 'No games match your search' : 'No evaluations found'}</td></tr>
              )}
              {filtered.map((ev, idx) => {
                const genres = [ev.genre_1, ev.genre_2].filter(Boolean) as string[]
                const isActive = ev.game_id === activeGameId
                return (
                  <tr key={ev.id}
                    ref={isActive ? activeRowRef : null}
                    className={`tbl-row-premium${isActive ? ' tbl-row-active' : ''}`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => openDetail(ev.game_id)}>
                    <td className="num" style={{ color: 'var(--faint)', fontSize: 12 }}>
                      {idx + 1}
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 220 }}>
                        {ev.icon_url ? (
                          <img src={ev.icon_url} alt="" width={32} height={32}
                            style={{ borderRadius: 7, flexShrink: 0 }} />
                        ) : (
                          <div style={{ width: 32, height: 32, borderRadius: 7, background: 'var(--surface-3)', flexShrink: 0 }} />
                        )}
                        <div style={{ minWidth: 0 }}>
                          <div className="cell-name" style={{ fontSize: 13, lineHeight: 1.3 }}>{ev.title}</div>
                          <div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
                            <span className="pill muted" style={{ padding: '1px 6px', fontSize: 10 }}>
                              {ev.os?.toUpperCase()}
                            </span>
                            {genres.map(g => (
                              <span key={g} className="pill tag" style={{ padding: '1px 6px', fontSize: 10 }}>
                                {g}
                              </span>
                            ))}
                          </div>
                          {ev.publisher_name && (
                            <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {ev.publisher_name}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', color: ev.initial_evaluator ? 'var(--text)' : 'var(--faint)' }}>
                      {ev.initial_evaluator || '—'}
                    </td>
                    <td style={{ fontSize: 12.5, whiteSpace: 'nowrap', color: ev.final_evaluator ? 'var(--text)' : 'var(--faint)' }}>
                      {ev.final_evaluator || '—'}
                    </td>
                    <td className="num" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                      {fmtDate(ev.assigned_date)}
                    </td>
                    <td>
                      <div style={{ fontSize: 12, color: ev.initial_note ? 'var(--text)' : 'var(--faint)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ev.initial_note || '—'}
                      </div>
                    </td>
                    <td>{conclusionBadge(ev.initial_conclusion)}</td>
                    <td className="num" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                      {fmtDate(ev.evaluate_date)}
                    </td>
                    <td>
                      {ev.drive_link ? (
                        <a href={ev.drive_link} target="_blank" rel="noopener"
                          onClick={e => e.stopPropagation()}
                          className="drive-btn">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="23 7 16 12 23 17 23 7" />
                            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                          </svg>
                          Video
                        </a>
                      ) : (
                        <span style={{ fontSize: 12, color: 'var(--faint)' }}>—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div ref={sentinelRef} style={{ height: 1 }} />
          {loadingMore && (
            <div style={{ textAlign: 'center', padding: '12px 0', fontSize: 12, color: 'var(--faint)' }}>
              Loading more...
            </div>
          )}
        </div>
      </div>

      {/* Quick Stats Modal */}
      {showQuickStats && (
        <QuickStatsModal
          category={category}
          month={filterMonth}
          onClose={() => setShowQuickStats(false)}
        />
      )}

      {/* Detail Modal */}
      {detailGameId && (
        <div className="eval-modal-backdrop" onClick={handleClose}>
          <div className="eval-modal-container" onClick={e => e.stopPropagation()}
            style={{ padding: '20px 24px 24px' }}>
            <EvalDetailPanel
              initialGameId={detailGameId}
              gameList={detailList}
              role={role}
              userName={userName}
              onClose={handleClose}
              onNavigate={handleNavigate}
              onSaved={(fresh: EvalDetail) => {
                setData(prev => prev.map(d => d.game_id === fresh.game_id
                  ? { ...d, initial_conclusion: fresh.initial_conclusion, initial_note: fresh.initial_note, evaluate_date: fresh.evaluate_date, drive_link: fresh.drive_link }
                  : d
                ))
              }}
            />
          </div>
        </div>
      )}

    </div>
  )
}
