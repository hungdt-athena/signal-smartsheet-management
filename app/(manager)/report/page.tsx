'use client'
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import {
  Kpi, ColumnChart, RankBars, Donut, Heatmap, Empty, fmt, CAT,
} from '@/components/report/charts'

type Domain = 'evaluation' | 'recording'
type Period = 'week' | 'month' | 'quarter' | 'overall'

interface EvalItem {
  key: string; name: string
  metrics: { games: number; activeDays: number; throughput: number; turnaround: number | null; priorityRate: number; consistency: number }
  conclusions: Record<string, number>
  series: Record<string, number>
}
interface Bundle {
  stale: boolean; domain: Domain; period: Period; category: string; canSeeTeam: boolean
  weeksInRange: number
  periods: Array<{ key: string; label: string }>
  teamSeries: Array<{ key: string; label: string; games: number; activeDays: number; turnaround: number | null; priorityCount: number }>
  teamTotals: { totalGames: number; activePeople: number; avgThroughput: number; avgTurnaround: number | null; priorityRate: number }
  teamTrend: number | null
  evaluators: EvalItem[]
  conclusions: Array<{ name: string; count: number }>
}

const TABS_ADMIN = [
  { id: 'overview', label: 'Team Overview' },
  { id: 'leaderboard', label: 'Leaderboard' },
  { id: 'individual', label: 'Individual' },
  { id: 'activity', label: 'Activity' },
]
const TABS_EVALUATOR = [
  { id: 'overview', label: 'My Overview' },
  { id: 'individual', label: 'Deep Dive' },
  { id: 'activity', label: 'Activity' },
]

export default function ReportPage() {
  return <Suspense><ReportInner /></Suspense>
}

function ReportInner() {
  const sp = useSearchParams()
  const router = useRouter()
  const { data: session } = useSession()
  const role = session?.user?.role
  const isManager = role === 'admin' || role === 'moderator'
  const myName = session?.user?.name || ''

  const tab = sp.get('tab') || 'overview'
  const [domain, setDomain] = useState<Domain>('evaluation')
  const [period, setPeriod] = useState<Period>('week')
  const [category, setCategory] = useState('all')

  const [data, setData] = useState<Bundle | null>(null)
  const [loading, setLoading] = useState(true)
  const [rebuilding, setRebuilding] = useState(false)
  const [err, setErr] = useState('')

  const tabs = isManager ? TABS_ADMIN : TABS_EVALUATOR

  const fetchData = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const p = new URLSearchParams({ domain, period, category })
      const res = await fetch(`/api/report?${p}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load')
    } finally { setLoading(false) }
  }, [domain, period, category])

  useEffect(() => { fetchData() }, [fetchData])

  const rebuild = async () => {
    setRebuilding(true)
    try {
      const res = await fetch('/api/cron/report-rollup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'all' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await fetchData()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Rebuild failed')
    } finally { setRebuilding(false) }
  }

  const setTab = (id: string) => {
    const p = new URLSearchParams(sp.toString()); p.set('tab', id)
    router.push(`/report?${p}`)
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h-title">Report</h1>
          <p className="h-sub">Evaluator performance · objective metrics · {domain === 'evaluation' ? 'initial evaluation' : 'record video'}</p>
        </div>
        {isManager && (
          <div className="head-actions">
            <button className="btn btn-sm" onClick={rebuild} disabled={rebuilding}>
              {rebuilding ? 'Rebuilding…' : '↻ Rebuild data'}
            </button>
          </div>
        )}
      </div>

      {/* Filter bar */}
      <div className="rp-filters card">
        <Seg label="Domain" value={domain} onChange={(v) => setDomain(v as Domain)}
          options={[['evaluation', 'Evaluation'], ['recording', 'Recording']]} />
        <Seg label="Period" value={period} onChange={(v) => setPeriod(v as Period)}
          options={[['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'], ['overall', 'Overall']]} />
        <Seg label="Category" value={category} onChange={setCategory}
          options={[['all', 'All'], ['puzzle', 'Puzzle'], ['arcade', 'Arcade'], ['simulation', 'Sim']]} />
      </div>

      {/* Sub-tab nav */}
      <div className="rp-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={'rp-tab' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {err && <div className="card" style={{ color: 'var(--bad)' }}>Error: {err}</div>}
      {loading && <div className="card"><Empty text="Loading…" /></div>}

      {!loading && data && data.stale && (
        <div className="card">
          <Empty text={isManager ? 'No report data yet. Click “Rebuild data” to compute it.' : 'No report data yet.'} />
        </div>
      )}

      {!loading && data && !data.stale && (
        <>
          {tab === 'overview' && <Overview d={data} isManager={isManager} />}
          {tab === 'leaderboard' && isManager && <Leaderboard d={data} />}
          {tab === 'individual' && <Individual d={data} isManager={isManager} myName={myName} />}
          {tab === 'activity' && <Activity d={data} />}
        </>
      )}
    </div>
  )
}

// ---------------- sub-tab views ----------------

function Overview({ d, isManager }: { d: Bundle; isManager: boolean }) {
  const t = d.teamTotals
  const volSeries = d.teamSeries.map((s) => ({ label: s.label, value: s.games }))
  const topVolume = d.evaluators.slice(0, 8).map((e) => ({ name: e.name, value: e.metrics.games }))
  return (
    <>
      <div className="rp-kpi-row">
        <Kpi label="Total games" value={fmt.int(t.totalGames)} sub="in range" trend={d.teamTrend} hi />
        <Kpi label={isManager ? 'Active people' : 'Active weeks'} value={isManager ? fmt.int(t.activePeople) : fmt.int(d.weeksInRange)} sub={isManager ? 'evaluators' : 'weeks'} />
        <Kpi label="Avg throughput" value={fmt.dec(t.avgThroughput)} sub="games / active day" />
        <Kpi label="Avg turnaround" value={fmt.days(t.avgTurnaround)} sub="assign → done" />
        {d.domain === 'evaluation' && <Kpi label="Priority rate" value={fmt.pct(t.priorityRate)} sub="Priority conclusions" />}
      </div>

      <div className="grid-2">
        <Card label={`Volume by ${d.period}`} note="games tested per period">
          <ColumnChart data={volSeries} />
          <ReadNote>Taller = more work that period. Look for a steady bar height (disciplined pace) vs. spikes-and-gaps (binge testing).</ReadNote>
        </Card>
        <Card label={d.domain === 'evaluation' ? 'Conclusion distribution' : 'Recording split'} note="share of outcomes">
          <Donut data={d.conclusions} />
          <ReadNote>{d.domain === 'evaluation' ? 'A healthy mix has a visible Priority slice — pure Bypass means aggressive filtering with little signal found.' : '5min vs 20min recording mix across the team.'}</ReadNote>
        </Card>
      </div>

      {isManager && (
        <Card label="Top by volume" note="who tested the most">
          <RankBars rows={topVolume} unit="games" color={CAT[0]} />
        </Card>
      )}
    </>
  )
}

function Leaderboard({ d }: { d: Bundle }) {
  const byVolume = d.evaluators.map((e) => ({ name: e.name, value: e.metrics.games }))
  const byThroughput = [...d.evaluators].filter((e) => e.metrics.games > 0)
    .sort((a, b) => b.metrics.throughput - a.metrics.throughput).map((e) => ({ name: e.name, value: e.metrics.throughput }))
  // Turnaround: lower is better → rank ascending.
  const byTurnaround = d.evaluators.filter((e) => e.metrics.turnaround != null)
    .sort((a, b) => (a.metrics.turnaround! - b.metrics.turnaround!)).map((e) => ({ name: e.name, value: e.metrics.turnaround! }))
  const byConsistency = [...d.evaluators].sort((a, b) => b.metrics.consistency - a.metrics.consistency)
    .map((e) => ({ name: e.name, value: e.metrics.consistency }))
  const byPriority = [...d.evaluators].filter((e) => e.metrics.games > 0)
    .sort((a, b) => b.metrics.priorityRate - a.metrics.priorityRate).map((e) => ({ name: e.name, value: e.metrics.priorityRate }))
  return (
    <div className="grid-2">
      <Card label="Volume" note="games tested"><RankBars rows={byVolume} unit="games" color={CAT[0]} /></Card>
      <Card label="Throughput" note="games / active day"><RankBars rows={byThroughput} color={CAT[1]} format={(v) => fmt.dec(v)} /></Card>
      <Card label="Turnaround (fastest first)" note="days assign → done"><RankBars rows={byTurnaround} color={CAT[2]} format={(v) => `${v.toFixed(1)}d`} /></Card>
      <Card label="Consistency" note="active days / range"><RankBars rows={byConsistency} color={CAT[3]} format={fmt.pct} /></Card>
      {d.domain === 'evaluation' && (
        <Card label="Priority rate" note="% Priority conclusions"><RankBars rows={byPriority} color={CAT[4]} format={fmt.pct} /></Card>
      )}
    </div>
  )
}

function Individual({ d, isManager, myName }: { d: Bundle; isManager: boolean; myName: string }) {
  const [selKey, setSelKey] = useState<string>('')
  const selected = useMemo(() => {
    if (d.evaluators.length === 0) return null
    if (!isManager) return d.evaluators.find((e) => e.key === myName.toLowerCase()) || d.evaluators[0]
    return d.evaluators.find((e) => e.key === selKey) || d.evaluators[0]
  }, [d.evaluators, selKey, isManager, myName])

  if (!selected) return <div className="card"><Empty /></div>
  const m = selected.metrics
  const series = d.periods.map((p) => ({ label: p.label, value: selected.series[p.key] || 0 }))
  const conclusions = Object.entries(selected.conclusions).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)

  return (
    <>
      {isManager && (
        <div className="rp-people">
          {d.evaluators.map((e) => (
            <button key={e.key} className={'rp-chip' + (e.key === selected.key ? ' active' : '')} onClick={() => setSelKey(e.key)}>
              {e.name} <span className="rp-chip-n">{e.metrics.games}</span>
            </button>
          ))}
        </div>
      )}
      <div className="rp-kpi-row">
        <Kpi label="Games" value={fmt.int(m.games)} hi />
        <Kpi label="Throughput" value={fmt.dec(m.throughput)} sub="games / active day" />
        <Kpi label="Turnaround" value={fmt.days(m.turnaround)} sub="assign → done" />
        <Kpi label="Consistency" value={fmt.pct(m.consistency)} sub="active days / range" />
        {d.domain === 'evaluation' && <Kpi label="Priority rate" value={fmt.pct(m.priorityRate)} />}
      </div>
      <div className="grid-2">
        <Card label={`${selected.name} — volume by ${d.period}`} note="games per period">
          <ColumnChart data={series} color={CAT[0]} />
        </Card>
        <Card label={d.domain === 'evaluation' ? 'Conclusion mix' : 'Recording split'} note="their outcomes">
          <Donut data={conclusions} />
        </Card>
      </div>
    </>
  )
}

function Activity({ d }: { d: Bundle }) {
  const rows = d.evaluators.map((e) => ({ name: e.name, cells: e.series }))
  return (
    <Card label="Activity heatmap" note={`games per ${d.period} · person × period`}>
      <Heatmap periods={d.periods} rows={rows} />
      <ReadNote>Darker = more games that period. Solid consistent rows = working every period; empty cells = skipped. Compare period-over-period to spot who is accelerating vs. slowing.</ReadNote>
    </Card>
  )
}

// ---------------- small shared bits ----------------

function Card({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-head"><span className="card-label">{label}</span>{note && <span className="card-note">{note}</span>}</div>
      {children}
    </div>
  )
}

function ReadNote({ children }: { children: React.ReactNode }) {
  return <p className="rp-readnote">{children}</p>
}

function Seg({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]>
}) {
  return (
    <div className="rp-seg-group">
      <span className="rp-seg-label">{label}</span>
      <div className="seg">
        {options.map(([v, l]) => (
          <button key={v} className={'rp-seg-btn' + (value === v ? ' active' : '')} onClick={() => onChange(v)}>{l}</button>
        ))}
      </div>
    </div>
  )
}
