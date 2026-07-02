'use client'
import { useEffect, useState } from 'react'
import type { YearMonth } from '@/components/DateFilter'
import { prettyConclusion } from '@/lib/buckets'

interface EvaluatorStats {
  evaluator: string
  total: number
  done: number
  pending: number
  drive_links: number
  conclusions: Record<string, number>
  platforms: Record<string, number>
}

const PLATFORM_LABELS: Record<string, string> = { ios: 'iOS', android: 'Android', unknown: '?' }

const CONCLUSION_COLORS: Record<string, string> = {
  'Bypass': 'error', 'M_ByPass': 'error', 'Skip': 'error', 'Link_dead': 'error',
  'Playtest & Bypass': 'error',
  'Good': 'success', 'Conclusion': 'success',
  'List_Idea': 'success', 'Priority I': 'success', 'Priority II': 'success',
  'Priority III: Watchlist for next phase': 'running',
  'Priority IV: Idea': 'running', 'Watchlist for next milestone': 'running',
  'Need deeper testing': 'running', 'Wait for PlayTest': 'running',
  'Check Market Data': 'running', 'Need Direction': 'running',
}

const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function todayVN() {
  const d = new Date(Date.now() + 7 * 3600 * 1000)
  return d.toISOString().slice(0, 10)
}

export function QuickStatsModal({ category, month, onClose }: {
  category: string
  month: YearMonth | null
  onClose: () => void
}) {
  const [tab, setTab] = useState<'overall' | 'evaluated'>('overall')
  const [evalDate, setEvalDate] = useState<string>(todayVN())
  const [rows, setRows] = useState<EvaluatorStats[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setRows([])
    const params = new URLSearchParams({ category, tab })
    if (tab === 'overall') {
      if (month) {
        params.set('year', String(month.year))
        params.set('month', String(month.month))
      }
    } else {
      if (evalDate) params.set('date', evalDate)
    }
    fetch(`/api/evaluations/quick-stats?${params}`)
      .then(r => r.json())
      .then(json => { if (!cancelled) setRows(json.data || []) })
      .catch(() => { /* ignore */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [category, month, tab, evalDate])

  const agg = rows.reduce(
    (a, r) => ({ total: a.total + r.total, done: a.done + r.done, drive: a.drive + r.drive_links }),
    { total: 0, done: 0, drive: 0 },
  )
  const aggPlatforms: Record<string, number> = {}
  for (const r of rows) {
    for (const [os, n] of Object.entries(r.platforms || {})) {
      aggPlatforms[os] = (aggPlatforms[os] || 0) + n
    }
  }
  const aggPlatformText = Object.entries(aggPlatforms)
    .sort((a, b) => b[1] - a[1])
    .map(([os, n]) => `${PLATFORM_LABELS[os] || os.toUpperCase()} ${n}`)
    .join(' · ')
  const maxTotal = Math.max(1, ...rows.map(r => r.total))

  function periodLabel() {
    if (tab === 'evaluated') return evalDate ? `evaluated ${evalDate}` : 'all evaluated'
    return month ? `${MONTH_NAMES[month.month]} ${month.year}` : 'all time'
  }

  return (
    <div className="eval-modal-backdrop" onClick={onClose}>
      <div className="eval-modal-container" onClick={e => e.stopPropagation()}
        style={{ padding: '20px 24px 24px', maxWidth: 800, width: '96vw', maxHeight: '90vh', overflowY: 'auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Quick Stats</h2>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: '4px 10px', fontSize: 12 }}>✕</button>
        </div>

        {/* Tabs + date picker */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 14, flexWrap: 'wrap' }}>
          {(['overall', 'evaluated'] as const).map(t => (
            <button key={t}
              onClick={() => setTab(t)}
              className={`seg-btn-premium${tab === t ? ' active' : ''}`}
              style={{ textTransform: 'capitalize' }}>
              {t}
            </button>
          ))}
          {tab === 'evaluated' && (
            <input
              type="date"
              value={evalDate}
              onChange={e => setEvalDate(e.target.value)}
              style={{
                marginLeft: 8, padding: '3px 10px', fontSize: 12, borderRadius: 6,
                border: '1px solid var(--border)', background: 'var(--surface-2)',
                color: 'var(--text)', cursor: 'pointer',
              }}
            />
          )}
        </div>

        {/* Summary line */}
        <p style={{ margin: '0 0 14px', fontSize: 12.5, color: 'var(--faint)' }}>
          {category} · {periodLabel()}
          {!loading && ` · ${agg.total} games · ${agg.done} done`}
          {!loading && tab === 'overall' && ` · ${agg.total - agg.done} pending`}
          {!loading && ` · ${agg.drive} drive links`}
          {!loading && aggPlatformText && ` · ${aggPlatformText}`}
        </p>

        {loading && <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--faint)', fontSize: 13 }}>Loading...</div>}
        {!loading && rows.length === 0 && (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--faint)', fontSize: 13 }}>No data for this period</div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map(r => {
            const pct = r.total > 0 ? Math.round((r.done / r.total) * 100) : 0
            const conclusionEntries = Object.entries(r.conclusions).sort((a, b) => b[1] - a[1])
            const platformEntries = Object.entries(r.platforms || {}).sort((a, b) => b[1] - a[1])
            return (
              <div key={r.evaluator} className="card" style={{ padding: '14px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{r.evaluator}</span>
                  <span style={{ fontSize: 12, color: 'var(--faint)' }}>
                    {r.total} games · <span style={{ color: 'var(--good, #16a34a)' }}>{r.done} done</span>
                    {tab === 'overall' && (
                      <>{' · '}<span style={{ color: r.pending > 0 ? 'var(--warn)' : 'var(--faint)' }}>{r.pending} pending</span></>
                    )}
                  </span>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
                    {platformEntries.map(([os, n]) => (
                      <span key={os} className="pill muted" style={{ padding: '1px 7px', fontSize: 10 }}>
                        {PLATFORM_LABELS[os] || os.toUpperCase()} {n}
                      </span>
                    ))}
                    {tab === 'overall' && (
                      <span style={{ fontSize: 12, fontWeight: 700, marginLeft: 4 }}>{pct}%</span>
                    )}
                  </span>
                </div>

                {tab === 'overall' && (
                  <div style={{ height: 8, borderRadius: 4, background: 'var(--surface-3)', overflow: 'hidden', width: `${Math.round((r.total / maxTotal) * 100)}%`, minWidth: 60, display: 'flex', marginBottom: 8 }}>
                    <div style={{ width: `${pct}%`, background: 'var(--accent)', borderRadius: 4 }} />
                  </div>
                )}

                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                  {conclusionEntries.map(([c, n]) => (
                    <span key={c} className={`badge ${CONCLUSION_COLORS[c] || 'neutral'}`} style={{ fontSize: 10.5 }}>
                      {prettyConclusion(c)} · {n}
                    </span>
                  ))}
                  {r.drive_links > 0 && (
                    <span className="badge neutral" style={{ fontSize: 10.5 }}>
                      Drive links · {r.drive_links}
                    </span>
                  )}
                  {conclusionEntries.length === 0 && r.drive_links === 0 && (
                    <span style={{ fontSize: 11.5, color: 'var(--faint)' }}>No conclusions yet</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
