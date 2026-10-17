'use client'
import { useEffect, useState } from 'react'
import type { YearMonth } from '@/components/DateFilter'
import { prettyConclusion } from '@/lib/buckets'
import { conclusionBadgeClass } from '@/lib/conclusion-badge'
import { Modal } from '@/components/ui/Modal'
import { Seg } from '@/components/ui/Seg'
import { EmptyState, ErrorState } from '@/components/ui/States'

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
  const [failed, setFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)
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
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then(json => { if (!cancelled) setRows(json.data || []) })
      // A failed load says so, with a retry; it is never shown as "No data".
      .catch(() => { if (!cancelled) setFailed(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [category, month, tab, evalDate, reloadKey])

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
    <Modal title="Quick stats" width={800} onClose={onClose}
      sub={<>
        {category} · {periodLabel()}
        {!loading && !failed && ` · ${agg.total} games · ${agg.done} done`}
        {!loading && !failed && tab === 'overall' && ` · ${agg.total - agg.done} pending`}
        {!loading && !failed && ` · ${agg.drive} drive links`}
        {!loading && !failed && aggPlatformText && ` · ${aggPlatformText}`}
      </>}>

      {/* View switch + the day picker for "Evaluated" */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Seg ariaLabel="View" value={tab} onChange={setTab}
          options={[{ value: 'overall', label: 'Overall' }, { value: 'evaluated', label: 'Evaluated' }]} />
        {tab === 'evaluated' && (
          <input type="date" className="input" aria-label="Evaluated on" value={evalDate}
            onChange={e => setEvalDate(e.target.value)} style={{ width: 160 }} />
        )}
      </div>

      {loading && <div className="state-empty">Loading…</div>}
      {!loading && failed && <ErrorState onRetry={() => setReloadKey(k => k + 1)}>Could not load the stats.</ErrorState>}
      {!loading && !failed && rows.length === 0 && <EmptyState>No games in this period.</EmptyState>}

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
                  {r.total} games · <span style={{ color: 'var(--good)' }}>{r.done} done</span>
                  {tab === 'overall' && (
                    <>{' · '}<span style={{ color: r.pending > 0 ? 'var(--warn)' : 'var(--faint)' }}>{r.pending} pending</span></>
                  )}
                </span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
                  {platformEntries.map(([os, n]) => (
                    <span key={os} className="badge neutral">
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
                  <span key={c} className={`badge ${conclusionBadgeClass(c)}`}>
                    {prettyConclusion(c)} · {n}
                  </span>
                ))}
                {r.drive_links > 0 && (
                  <span className="badge neutral">
                    Drive links · {r.drive_links}
                  </span>
                )}
                {conclusionEntries.length === 0 && r.drive_links === 0 && (
                  <span style={{ fontSize: 12, color: 'var(--faint)' }}>No conclusions yet</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
