'use client'
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import {
  Kpi, ColumnChart, RankBars, Donut, Heatmap, Funnel, Radar, HealthBars, StackedBars,
  Empty, fmt, CAT,
} from '@/components/report/charts'

type View = 'week' | 'month' | 'quarter' | 'batch' | 'custom'
const RADAR_AXES = ['Volume', 'Consistency', 'Signal', 'Survival', 'Recording'] as const

interface Ev {
  key: string; name: string; evaluated: number; activeDays: number; throughput: number
  turnaround: number | null; signalRate: number; consistency: number
  escalated: number; triaged: number; finalPriority: number; survivalRate: number
  recorded: number; rec5: number; rec20: number
  initialConclusions: Record<string, number>; finalConclusions: Record<string, number>
}
interface Bundle {
  empty: boolean; canSeeTeam: boolean; view: View; category: string
  window: { label: string }
  options: { week: Opt[]; month: Opt[]; quarter: Opt[]; batch: Opt[] }
  teamTotals: { evaluators: number; totalEvaluated: number; avgThroughput: number; avgTurnaround: number | null; signalRate: number; survivalRate: number; totalRecorded: number }
  funnel: { evaluated: number; escalated: number; triaged: number; finalPriority: number }
  initialConclusions: Cnt[]; finalConclusions: Cnt[]
  series: Array<{ label: string; value: number }>
  heatmap: { periods: Array<{ key: string; label: string }>; rows: Array<{ name: string; cells: Record<string, number> }> }
  evaluators: Ev[]
  radar: Array<{ key: string; name: string; axes: Record<string, number> }>
}
type Opt = { key: string; label: string }
type Cnt = { name: string; count: number }

const TABS_ADMIN = [
  { id: 'overview', label: 'Team Overview' },
  { id: 'leaderboard', label: 'Leaderboard' },
  { id: 'individual', label: 'Individual' },
  { id: 'compare', label: 'Compare' },
  { id: 'activity', label: 'Activity' },
]
const TABS_EVAL = [
  { id: 'overview', label: 'My Overview' },
  { id: 'individual', label: 'Deep Dive' },
  { id: 'activity', label: 'Activity' },
]

export default function ReportPage() {
  return <Suspense><ReportInner /></Suspense>
}

function ReportInner() {
  const sp = useSearchParams(); const router = useRouter()
  const { data: session } = useSession()
  const role = session?.user?.role
  const isManager = role === 'admin' || role === 'moderator'
  const myName = session?.user?.name || ''

  const tab = sp.get('tab') || 'overview'
  const [view, setView] = useState<View>('month')
  const [selKey, setSelKey] = useState('')     // adaptive bucket key ('' = all)
  const [from, setFrom] = useState(''); const [to, setTo] = useState('')
  const [category, setCategory] = useState('all')

  const [data, setData] = useState<Bundle | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const tabs = isManager ? TABS_ADMIN : TABS_EVAL

  const fetchData = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const p = new URLSearchParams({ view, category })
      if (view === 'custom') { if (from) p.set('from', from); if (to) p.set('to', to) }
      else if (selKey) p.set('key', selKey)
      const res = await fetch(`/api/report?${p}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setLoading(false) }
  }, [view, selKey, from, to, category])

  useEffect(() => { fetchData() }, [fetchData])

  const setTab = (id: string) => { const p = new URLSearchParams(sp.toString()); p.set('tab', id); router.push(`/report?${p}`) }
  const changeView = (v: string) => { setView(v as View); setSelKey('') }

  const optList: Opt[] = data ? (data.options[view as 'week' | 'month' | 'quarter' | 'batch'] || []) : []

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h-title">Report</h1>
          <p className="h-sub">Evaluator performance · initial evaluation, recording & shortlist funnel {data && <>· <b>{data.window.label}</b></>}</p>
        </div>
        <div className="head-actions">
          <button className="btn btn-sm" onClick={fetchData} disabled={loading}>{loading ? 'Loading…' : '↻ Refresh'}</button>
        </div>
      </div>

      {/* Filter bar: view lens + adaptive picker + category */}
      <div className="rp-filters card">
        <Seg label="View by" value={view} onChange={changeView}
          options={[['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'], ['batch', 'Batch'], ['custom', 'Custom']]} />
        {view === 'custom' ? (
          <div className="rp-seg-group">
            <span className="rp-seg-label">Range</span>
            <input type="date" className="rp-date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <span style={{ color: 'var(--faint)' }}>→</span>
            <input type="date" className="rp-date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        ) : (
          <div className="rp-seg-group">
            <span className="rp-seg-label">{view === 'batch' ? 'Batch' : view === 'week' ? 'Week' : view === 'quarter' ? 'Quarter' : 'Month'}</span>
            <select className="rp-select" value={selKey} onChange={(e) => setSelKey(e.target.value)}>
              <option value="">{view === 'batch' ? 'All batches' : 'All time'}</option>
              {optList.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
        )}
        <div className="rp-filter-spacer" />
        <Seg label="Category" value={category} onChange={setCategory}
          options={[['all', 'All'], ['puzzle', 'Puzzle'], ['arcade', 'Arcade'], ['simulation', 'Sim']]} />
      </div>

      <div className="rp-tabs">
        {tabs.map((t) => <button key={t.id} className={'rp-tab' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>

      {err && !data && <div className="card" style={{ color: 'var(--bad)' }}>Couldn’t load report: {err}. The database may be waking up — try Refresh.</div>}
      {err && data && <div className="rp-stale-note">Couldn’t refresh ({err}) — showing last loaded data.</div>}
      {loading && !data && <div className="card"><Empty text="Loading…" /></div>}
      {!loading && data && data.empty && <div className="card"><Empty text="No data for this selection." /></div>}

      {!loading && data && !data.empty && (
        <>
          {tab === 'overview' && <Overview d={data} isManager={isManager} />}
          {tab === 'leaderboard' && isManager && <Leaderboard d={data} />}
          {tab === 'individual' && <Individual d={data} isManager={isManager} myName={myName} />}
          {tab === 'compare' && isManager && <Compare d={data} />}
          {tab === 'activity' && <Activity d={data} />}
        </>
      )}
    </div>
  )
}

/* ---------------- Team Overview ---------------- */
function Overview({ d, isManager }: { d: Bundle; isManager: boolean }) {
  const t = d.teamTotals
  const funnelStages = [
    { label: 'Evaluated', value: d.funnel.evaluated },
    { label: 'Escalated (not bypass)', value: d.funnel.escalated },
    { label: 'Triaged / shortlisted', value: d.funnel.triaged },
    { label: 'Final Priority', value: d.funnel.finalPriority },
  ]
  const health = [
    { label: 'Signal rate', value: fmt.pct(t.signalRate), pct: t.signalRate * 100 * 4, status: band(t.signalRate, 0.06, 0.12) },
    { label: 'Survival (escalation → final priority)', value: fmt.pct(t.survivalRate), pct: t.survivalRate * 100, status: band(t.survivalRate, 0.1, 0.25) },
    { label: 'Avg throughput', value: fmt.dec(t.avgThroughput) + ' /day', pct: Math.min(100, t.avgThroughput), status: 'good' as const },
    { label: 'Active evaluators', value: String(t.evaluators), pct: 100, status: 'good' as const },
  ]
  const topConcl = d.initialConclusions.slice(0, 5).map((c) => c.name)
  const stackRows = d.evaluators.filter((e) => e.evaluated > 0).slice(0, 10)
    .map((e) => ({ name: e.name, parts: e.initialConclusions }))
  return (
    <>
      <div className="rp-kpi-row">
        <Kpi label="Games evaluated" value={fmt.int(t.totalEvaluated)} sub={d.window.label} hi />
        <Kpi label="Avg throughput" value={fmt.dec(t.avgThroughput)} sub="games / active day" />
        <Kpi label="Avg turnaround" value={fmt.days(t.avgTurnaround)} sub="assign → evaluate" />
        <Kpi label="Signal rate" value={fmt.pct(t.signalRate)} sub="escalated, not bypassed" />
        <Kpi label="Survival rate" value={fmt.pct(t.survivalRate)} sub="escalation → final priority" />
      </div>

      <div className="rp-section-title">Shortlist funnel & team health</div>
      <div className="rp-grid-2-1">
        <Card label="Shortlist funnel" note="how picks convert to final priority">
          <Funnel stages={funnelStages} />
          <ReadNote>The drop-offs show pick quality: many escalations but few reaching <b>Final Priority</b> = loose filtering; a healthy funnel keeps a meaningful share converting at each step.</ReadNote>
        </Card>
        <Card label="Team health" note="leading indicators">
          <HealthBars rows={health} />
        </Card>
      </div>

      <Card label={`Volume over time`} note="games evaluated per bucket">
        <ColumnChart data={d.series} />
      </Card>

      <div className="rp-grid-2">
        <Card label="Initial conclusions" note="what evaluators decided">
          <Donut data={d.initialConclusions} />
        </Card>
        <Card label="Final conclusions" note="moderator outcomes on shortlisted games">
          {d.finalConclusions.length ? <Donut data={d.finalConclusions} /> : <Empty text="No final conclusions in this window" />}
        </Card>
      </div>

      {isManager && (
        <Card label="Conclusions by evaluator" note="filtering style · top 10 by volume">
          <StackedBars rows={stackRows} keys={topConcl} />
          <ReadNote>Tall bars = high volume. The color mix is their filtering style — a visible non-Bypass share means they surface signal, not just gatekeep.</ReadNote>
        </Card>
      )}
    </>
  )
}

/* ---------------- Leaderboard ---------------- */
function Leaderboard({ d }: { d: Bundle }) {
  const ev = d.evaluators
  const rank = (f: (e: Ev) => number, filter = true) =>
    [...ev].filter((e) => !filter || e.evaluated > 0).sort((a, b) => f(b) - f(a)).map((e) => ({ name: e.name, value: f(e) }))
  const byTurn = ev.filter((e) => e.turnaround != null).sort((a, b) => a.turnaround! - b.turnaround!).map((e) => ({ name: e.name, value: e.turnaround! }))
  const byRec = [...ev].filter((e) => e.recorded > 0).sort((a, b) => b.recorded - a.recorded).map((e) => ({ name: e.name, value: e.recorded }))
  return (
    <div className="rp-grid-2">
      <Card label="Volume" note="games evaluated"><RankBars rows={rank((e) => e.evaluated)} unit="games" color={CAT[0]} /></Card>
      <Card label="Throughput" note="games / active day"><RankBars rows={rank((e) => e.throughput)} color={CAT[1]} format={(v) => fmt.dec(v)} /></Card>
      <Card label="Turnaround (fastest first)" note="days assign → evaluate"><RankBars rows={byTurn} color={CAT[2]} format={(v) => `${v.toFixed(1)}d`} /></Card>
      <Card label="Signal rate" note="% escalated (not bypassed)"><RankBars rows={rank((e) => e.signalRate)} color={CAT[4]} format={fmt.pct} /></Card>
      <Card label="Survival rate" note="escalation → final priority"><RankBars rows={rank((e) => e.survivalRate)} color={CAT[3]} format={fmt.pct} /></Card>
      <Card label="Recording" note="videos recorded (5/20min)">{byRec.length ? <RankBars rows={byRec} unit="rec" color={CAT[7]} /> : <Empty text="No recordings in this window" />}</Card>
    </div>
  )
}

/* ---------------- Individual ---------------- */
function Individual({ d, isManager, myName }: { d: Bundle; isManager: boolean; myName: string }) {
  const [selKey, setSel] = useState('')
  const selected = useMemo(() => {
    if (!d.evaluators.length) return null
    if (!isManager) return d.evaluators.find((e) => e.key === myName.toLowerCase()) || d.evaluators[0]
    return d.evaluators.find((e) => e.key === selKey) || d.evaluators[0]
  }, [d.evaluators, selKey, isManager, myName])
  if (!selected) return <div className="card"><Empty /></div>
  const e = selected
  const rad = d.radar.find((r) => r.key === e.key)
  const radarValues = rad ? RADAR_AXES.map((a) => rad.axes[a] || 0) : RADAR_AXES.map(() => 0)
  const initC = Object.entries(e.initialConclusions).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  const finC = Object.entries(e.finalConclusions).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  const funnelStages = [
    { label: 'Evaluated', value: e.evaluated },
    { label: 'Escalated', value: e.escalated },
    { label: 'Triaged', value: e.triaged },
    { label: 'Final Priority', value: e.finalPriority },
  ]
  return (
    <>
      {isManager && (
        <div className="rp-people">
          {d.evaluators.map((x) => (
            <button key={x.key} className={'rp-chip' + (x.key === e.key ? ' active' : '')} onClick={() => setSel(x.key)}>
              {x.name} <span className="rp-chip-n">{x.evaluated || x.recorded}</span>
            </button>
          ))}
        </div>
      )}
      <div className="rp-kpi-row">
        <Kpi label="Evaluated" value={fmt.int(e.evaluated)} hi />
        <Kpi label="Throughput" value={fmt.dec(e.throughput)} sub="games / active day" />
        <Kpi label="Turnaround" value={fmt.days(e.turnaround)} sub="assign → evaluate" />
        <Kpi label="Signal rate" value={fmt.pct(e.signalRate)} sub="escalated" />
        <Kpi label="Survival" value={fmt.pct(e.survivalRate)} sub="→ final priority" />
        <Kpi label="Recorded" value={fmt.int(e.recorded)} sub={`${e.rec5} × 5min · ${e.rec20} × 20min`} />
      </div>
      <div className="rp-grid-2-1">
        <Card label={`${e.name} — performance shape`} note="5 axes, normalized to team best">
          <Radar axes={[...RADAR_AXES]} series={[{ name: e.name, values: radarValues }]} />
          <ReadNote>A balanced polygon = well-rounded. Spiky = imbalanced (e.g. high Volume, low Survival = tests a lot but few picks hold up).</ReadNote>
        </Card>
        <Card label="Pick funnel" note="evaluated → final priority">
          <Funnel stages={funnelStages} />
        </Card>
      </div>
      <div className="rp-grid-2">
        <Card label="Initial conclusion mix" note="their filtering">{initC.length ? <Donut data={initC} /> : <Empty />}</Card>
        <Card label="Final outcomes" note="how their picks were judged">{finC.length ? <Donut data={finC} /> : <Empty text="None reached final conclusion" />}</Card>
      </div>
    </>
  )
}

/* ---------------- Compare (radar overlay + all-rounder ranking) ---------------- */
function Compare({ d }: { d: Bundle }) {
  const top = d.radar.slice(0, 8)
  const series = top.map((r, i) => ({ name: r.name, values: RADAR_AXES.map((a) => r.axes[a] || 0), color: CAT[i % CAT.length] }))
  // all-rounder = mean of the 5 normalized axes
  const allRound = d.radar
    .map((r) => ({ name: r.name, value: RADAR_AXES.reduce((s, a) => s + (r.axes[a] || 0), 0) / RADAR_AXES.length }))
    .sort((a, b) => b.value - a.value)
  return (
    <div className="rp-grid-2-1">
      <Card label="Performance radar — top evaluators" note="5 axes · normalized to team best">
        <Radar axes={[...RADAR_AXES]} series={series} size={320} />
        <ReadNote>Each polygon is one evaluator across Volume · Consistency · Signal · Survival · Recording. Larger, more balanced = stronger all-rounder. Hover a legend name to isolate it.</ReadNote>
      </Card>
      <Card label="All-rounder score" note="avg of 5 normalized axes">
        <RankBars rows={allRound} color={CAT[4]} format={(v) => fmt.dec(v, 0)} />
        <ReadNote>A single balance score: high only when someone is strong across <b>all</b> dimensions, not just volume. Use it to spot well-rounded evaluators vs. one-trick specialists.</ReadNote>
      </Card>
    </div>
  )
}

/* ---------------- Activity heatmap ---------------- */
function Activity({ d }: { d: Bundle }) {
  return (
    <Card label="Activity heatmap" note="games evaluated · person × period">
      <Heatmap periods={d.heatmap.periods} rows={d.heatmap.rows} />
      <ReadNote>Darker = more games that period. Solid rows = working every period; gaps = idle stretches. Spot who is accelerating vs. slowing.</ReadNote>
    </Card>
  )
}

/* ---------------- shared bits ---------------- */
function band(v: number, warn: number, good: number): 'good' | 'warn' | 'bad' {
  return v >= good ? 'good' : v >= warn ? 'warn' : 'bad'
}
function Card({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-head"><span className="card-label">{label}</span>{note && <span className="card-note">{note}</span>}</div>
      {children}
    </div>
  )
}
function ReadNote({ children }: { children: React.ReactNode }) { return <p className="rp-readnote">{children}</p> }
function Seg({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <div className="rp-seg-group">
      <span className="rp-seg-label">{label}</span>
      <div className="seg">
        {options.map(([v, l]) => <button key={v} className={'rp-seg-btn' + (value === v ? ' active' : '')} onClick={() => onChange(v)}>{l}</button>)}
      </div>
    </div>
  )
}
