'use client'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ALL_ROUNDER_AXES, allRounderScore, DEFAULT_REPORT_CONFIG, type AxisName, type ReportConfig } from '@/lib/report-config'
import {
  Kpi, ColumnChart, RankBars, Donut, Heatmap, Funnel, Radar, HealthBars, StackedBars,
  LineChart, Scatter, BumpChart, Empty, fmt, CAT, InfoTip, Insight, type Bench,
} from '@/components/report/charts'

type View = 'week' | 'month' | 'quarter' | 'batch' | 'custom'
const RADAR_AXES = ['Volume', 'Consistency', 'Signal', 'Survival', 'Recording'] as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const pad2 = (n: number) => String(n).padStart(2, '0')
// today's Y/M/D in the report timezone (Asia/Ho_Chi_Minh, same as the server)
function vnToday(): { y: number; m: number; d: number } {
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date())
  const [y, m, d] = iso.split('-').map(Number)
  return { y, m, d }
}
// the bucket key for "now" in a given view - each view defaults to its current period
function currentKey(view: View): string {
  const { y, m, d } = vnToday()
  if (view === 'month') return `${y}-${pad2(m)}`
  if (view === 'quarter') return `${y}-Q${Math.ceil(m / 3)}`
  if (view === 'week') {
    // Monday of the current week, matching Postgres date_trunc('week')
    const dt = new Date(Date.UTC(y, m - 1, d))
    dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7))
    return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
  }
  return ''
}
// label a key the same way the API labels its dropdown options: period name
// + explicit start–end range (weeks follow the team's batch convention: named by
// the week's LAST day, so 27/7–2/8 = "W1 Aug")
function keyLabel(view: View, key: string): string {
  const dm = (dt: Date) => `${dt.getUTCDate()}/${dt.getUTCMonth() + 1}`
  const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0))
  if (view === 'week') {
    const [y, m, d] = key.split('-').map(Number)
    const start = new Date(Date.UTC(y, m - 1, d))
    const sun = new Date(Date.UTC(y, m - 1, d + 6))
    return `W${Math.ceil(sun.getUTCDate() / 7)} ${MONTHS[sun.getUTCMonth()]} ${sun.getUTCFullYear()} · ${dm(start)} – ${dm(sun)}`
  }
  if (view === 'month') { const [y, m] = key.split('-').map(Number); return `${MONTHS[m - 1]} ${y} · 1/${m} – ${dm(lastDay(y, m))}` }
  if (view === 'quarter') { const [y, q] = key.split('-Q').map(Number); const sm = (q - 1) * 3 + 1; return `Q${q} ${y} · 1/${sm} – ${dm(lastDay(y, sm + 2))}` }
  return key
}

interface Ev {
  key: string; name: string; title: string | null; assigned: number; evaluated: number; activeDays: number; throughput: number
  turnaround: number | null; signalRate: number; consistency: number
  shortlisted: number; priorityIV: number; insight: number; finalPriority: number; survivalRate: number
  linkDead: number; noted: number; noteRate: number
  recorded: number; rec5: number; rec20: number
  initialConclusions: Record<string, number>; finalConclusions: Record<string, number>
}

// Metric definitions shown in "?" tooltips - formula first, one line of context.
const F = ({ children }: { children: React.ReactNode }) => <span style={{ display: 'block', fontFamily: 'ui-monospace, monospace', fontSize: '11px', margin: '2px 0 5px', color: 'var(--text)' }}>{children}</span>
const TIP = {
  assigned: <><F>= count(games first assigned in window)</F>New intake only - a reassign or handover moves a game between people, it is not new work, so it is not counted again here.</>,
  assignedPerson: <><F>= count(games assigned to this person in window)</F>Includes games received via reassign/handover, so the column does not add up to the team Assigned total.</>,
  evaluated: <><F>= count(initial_conclusion ≠ ∅, ≠ Link_dead)</F>By evaluate date.</>,
  gppd: <><F>= Σ evaluated ÷ Σ active days</F>Weighted team velocity - heavy contributors move it.</>,
  throughput: <><F>= avg( evaluatedᵢ ÷ active daysᵢ )</F>Everyone weighs the same, part-timers not penalized.</>,
  turnaround: <><F>= avg( evaluate date − assigned date )</F>Rising = queues sitting.</>,
  survival: <><F>= shortlist ÷ evaluated</F>Shortlist = initial conclusion not bypass. Denominator is what they actually judged in this window, so the two numbers come from the same rows - a growing or shrinking queue no longer moves the rate.</>,
  signal: <><F>= (Priority IV + Insight) ÷ evaluated</F>Yield on what they judged, usually &lt;1% - watch the trend. Reads low on a fresh window: the final conclusion is stamped later by a moderator, so recent evaluations have not been judged yet.</>,
  finalPriority: <><F>= count(final ∈ {'{'}Priority IV, Insight{'}'})</F>Priority V not counted (team convention).</>,
  noteCoverage: <><F>= noted ÷ evaluated</F>Target ≥90%.</>,
  linkDead: <><F>= count(initial_conclusion = Link_dead)</F>Housekeeping volume, not pick quality.</>,
  perDay: (what: string) => <><F>= {what} ÷ active days</F>Active day = a day with ≥1 evaluation - schedule-fair.</>,
  backlog: <><F>= count(no evaluate date AND no conclusion)</F>Absolute stock - ignores the filter window. Rows imported already-evaluated are not stock.</>,
  netChange: <><F>= new games in − evaluated</F>Positive = stock grew this window.</>,
  recorded: <><F>= count(5min) + count(20min)</F>Matched by actual uploader.</>,
  consistency: <><F>= active days ÷ weekdays in window (Mon–Fri)</F>Weekend work counts into active days as a bonus; capped at 100%.</>,
  radar: <><F>axis = value ÷ team best × 100</F>Volume = games evaluated · Consistency = active days ÷ weekdays (weekend counts as bonus) · Signal & Survival = rates ÷ evaluated · Recording = videos. Every axis normalized to the best person.</>,
  allRounder: <><F>= 0.4×Volume + 0.6×avg(Consistency, Signal, Survival, Recording)×credibility</F>Axes are normalized to the team best. Credibility = min(1, their games ÷ median team games), so quality earned on a small sample counts proportionally - a light workload can no longer outrank sustained output on a lucky rate.</>,
}

// Quality orderings (user-defined weights). Initial: List_Idea is the strongest
// signal, Bypass the weakest; Link_dead is waste, appended last in gray.
// Final: Priority IV best … Bypass worst; Not Found excluded from the score.
const INIT_ORDER = ['List_Idea', 'Playtest & Bypass', 'Bypass']
const FINAL_ORDER = ['Priority IV', 'Insight', 'Watch List', 'Priority V', 'Theme/Art', 'Bypass']

// Stack keys: known weight order first, then anything else seen in the data, then extras.
function orderedKeys(rows: Array<Record<string, number>>, order: string[], tail: string[] = []): string[] {
  const seen = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k)
  const rest = Array.from(seen).filter((k) => !order.includes(k) && !tail.includes(k)).sort()
  return [...order.filter((k) => seen.has(k)), ...rest, ...tail.filter((k) => seen.has(k))]
}
interface Bundle {
  empty: boolean; canSeeTeam: boolean; view: View; category: string
  // from/to are the resolved window bounds (to is EXCLUSIVE); absent on batch / all-time
  window: { label: string; from?: string; to?: string; batch?: string }
  bucketUnit: 'day' | 'week' | 'month'
  options: { week: Opt[]; month: Opt[]; quarter: Opt[]; batch: Opt[] }
  teamTotals: { evaluators: number; totalAssigned: number; totalEvaluated: number; avgThroughput: number; personDayThroughput: number; avgTurnaround: number | null; signalRate: number; survivalRate: number; totalRecorded: number; linkDead: number; noteRate: number }
  funnel: { assigned: number; evaluated: number; shortlisted: number; priorityIV: number; insight: number; finalPriority: number }
  initialConclusions: Cnt[]; finalConclusions: Cnt[]
  series: Array<{ label: string; value: number; people: number }>
  metricSeries: Array<{ key: string; label: string; volume: number; assigned: number; evaluated: number; shortlisted: number; priorityIV: number; insight: number; finalPriority: number; signalRate: number; survivalRate: number }>
  heatmap: { periods: Array<{ key: string; label: string }>; rows: Array<{ name: string; cells: Record<string, number> }> }
  scoreRank: { periods: Array<{ key: string; label: string }>; rows: Array<{ name: string; cells: Record<string, number> }> }
  config: ReportConfig
  personSeries: Record<string, Array<{ key: string; label: string; assigned: number; evaluated: number; linkDead: number }>>
  videos: Record<string, Array<{ gameId: string; title: string | null; os: string | null; slot: string; batch: string | null; recordedOn: string | null; youtube: string | null }>>
  // person → 'YYYY-MM-DD' → initial conclusion → count (Link_dead excluded)
  dailyMix: Record<string, Record<string, Record<string, number>>>
  evaluators: Ev[]
  radar: Array<{ key: string; name: string; axes: Record<string, number> }>
  pipeline: null | {
    series: Array<{ key: string; label: string; newGames: number; evaluated: number; backlog: number; people: number }>
    current: { backlog: number; age: { a0: number; a1: number; a2: number; a3: number } }
    window: { newGames: number; evaluated: number }
    aging: AgeRow[]
    cleared: Array<AgeRow & { avgAge: number }>
  }
}
type Opt = { key: string; label: string }
type Cnt = { name: string; count: number }
type AgeRow = { key: string; label: string; a0: number; a1: number; a2: number; a3: number }

// Age bands for backlog / clearing mix. Order = stack order (fresh at the bottom).
const AGE_BANDS = [
  { k: 'a0' as const, label: '0–3d', color: '#1baf7a' },
  { k: 'a1' as const, label: '4–7d', color: '#eda100' },
  { k: 'a2' as const, label: '8–14d', color: '#eb6834' },
  { k: 'a3' as const, label: '15d+', color: '#e34948' },
]
const AGE_KEYS = AGE_BANDS.map((b) => b.label)
const AGE_COLORS = Object.fromEntries(AGE_BANDS.map((b) => [b.label, b.color]))
const ageParts = (r: { a0: number; a1: number; a2: number; a3: number }) =>
  Object.fromEntries(AGE_BANDS.map((b) => [b.label, r[b.k]]))
const ageTotal = (r: { a0: number; a1: number; a2: number; a3: number }) => r.a0 + r.a1 + r.a2 + r.a3

// Report is admin-only (nav + middleware + /api/report guard) - no evaluator variant.
const TABS = [
  { id: 'overview', label: 'Team Overview' },
  { id: 'leaderboard', label: 'Leaderboard' },
  { id: 'individual', label: 'Individual' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'config', label: 'Config' },
]

// Embedded as the "Performance" sub-tab of Team Operations. Internal tabs are
// plain state (the ?tab= URL param belongs to Team Ops).
export function ReportView() {
  return <Suspense><ReportInner /></Suspense>
}

function ReportInner() {
  const [tab, setTab] = useState('overview')
  const [view, setView] = useState<View>('week')
  const [selKey, setSelKey] = useState(() => currentKey('week'))  // adaptive bucket key ('' = all); defaults to the current period
  const [from, setFrom] = useState(''); const [to, setTo] = useState('')
  const [category, setCategory] = useState('all')
  const [title, setTitle] = useState('all')  // job classification lens (dashboard_users.title)

  const [data, setData] = useState<Bundle | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const fetchData = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const p = new URLSearchParams({ view, category })
      if (title !== 'all') p.set('title', title)
      if (view === 'custom') { if (from) p.set('from', from); if (to) p.set('to', to) }
      else if (selKey) p.set('key', selKey)
      const res = await fetch(`/api/report?${p}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setLoading(false) }
  }, [view, selKey, from, to, category, title])

  useEffect(() => { fetchData() }, [fetchData])

  // Switching the lens defaults its bucket to "now": this week / this month /
  // this quarter / latest batch. Custom pre-fills the current month so the page
  // never silently flips back to all-time.
  const changeView = (v: string) => {
    const nv = v as View
    setView(nv)
    if (nv === 'batch') setSelKey(data?.options.batch[0]?.key || '')
    else if (nv === 'custom') {
      setSelKey('')
      if (!from && !to) {
        const { y, m, d } = vnToday()
        setFrom(`${y}-${pad2(m)}-01`); setTo(`${y}-${pad2(m)}-${pad2(d)}`)
      }
    } else setSelKey(currentKey(nv))
  }

  const optList: Opt[] = data ? (data.options[view as 'week' | 'month' | 'quarter' | 'batch'] || []) : []
  // current period may not have data yet - surface it in the dropdown anyway
  const optListShown: Opt[] = selKey && view !== 'batch' && view !== 'custom' && !optList.some((o) => o.key === selKey)
    ? [{ key: selKey, label: keyLabel(view, selKey) }, ...optList] : optList

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h-title">Performance</h1>
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
              {optListShown.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
        )}
        <div className="rp-filter-spacer" />
        <Seg label="Title" value={title} onChange={setTitle}
          options={[['all', 'All'], ['fulltime', 'Fulltime'], ['freelancer', 'Freelancer']]} />
        <Seg label="Category" value={category} onChange={setCategory}
          options={[['all', 'All'], ['puzzle', 'Puzzle'], ['arcade', 'Arcade'], ['simulation', 'Sim']]} />
      </div>

      <div className="rp-tabs">
        {TABS.map((t) => <button key={t.id} className={'rp-tab' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>

      {err && !data && <div className="card" style={{ color: 'var(--bad)' }}>Couldn’t load report: {err}. The database may be waking up - try Refresh.</div>}
      {err && data && <div className="rp-stale-note">Couldn’t refresh ({err}) - showing last loaded data.</div>}
      {loading && !data && <div className="card"><Empty text="Loading…" /></div>}
      {!loading && data && data.empty && <div className="card"><Empty text="No data for this selection." /></div>}

      {!loading && data && !data.empty && (
        <>
          {tab === 'overview' && <Overview d={data} />}
          {tab === 'leaderboard' && <Leaderboard d={data} />}
          {tab === 'individual' && <Individual d={data} />}
          {tab === 'pipeline' && <Pipeline d={data} />}
          {tab === 'config' && <ConfigTab d={data} onSaved={fetchData} />}
        </>
      )}
    </div>
  )
}

/* ---------------- Team Overview ---------------- */
function Overview({ d }: { d: Bundle }) {
  const t = d.teamTotals
  const funnelStages = [
    { label: 'Assigned', value: d.funnel.assigned },
    { label: 'Evaluated', value: d.funnel.evaluated },
    { label: 'Shortlist', value: d.funnel.shortlisted },
    { label: 'Final Priority', value: d.funnel.finalPriority, parts: [
      { label: 'Priority IV', value: d.funnel.priorityIV, color: CAT[4] },
      { label: 'Insight', value: d.funnel.insight, color: CAT[6] },
    ] },
  ]
  // Health gauges are read against a benchmark: the target sits at 66% of the track,
  // so a full-looking bar always means "at or above target" regardless of the metric's
  // natural magnitude (survival ~8%, signal ~1.5%, throughput ~100/day).
  // Day buckets show the exact headcount that day; coarser buckets show the average
  // per active day (a week's distinct-people count would overstate daily capacity).
  const peopleName = d.bucketUnit === 'day' ? 'Evaluators active' : 'Avg evaluators / day'
  // Compare the last two buckets that actually produced evaluations. Taking the
  // final two blindly reads today's partial bucket (often 0 evaluated → rate 0) as
  // a collapse. Filter follows the rate denominator, which is `evaluated`.
  const msAll = d.metricSeries || []
  const rated = msAll.filter((m) => m.evaluated > 0)
  const last = rated[rated.length - 1], prevB = rated[rated.length - 2]
  const gauge = (v: number, target: number) => Math.min(100, (v / target) * 66)
  const SURV_T = 0.08, SIG_T = 0.015, TPUT_T = 100
  const health = [
    {
      label: 'Survival (evaluated → shortlist)', value: fmt.pct(t.survivalRate),
      detail: `${fmt.int(d.funnel.shortlisted)} shortlisted of ${fmt.int(d.funnel.assigned)} assigned`,
      pct: gauge(t.survivalRate, SURV_T), target: 66, targetLabel: `target ${fmt.pct(SURV_T)}`,
      delta: last && prevB ? (last.survivalRate - prevB.survivalRate) * 100 : null, deltaLabel: 'pts vs prev bucket',
      status: band(t.survivalRate, 0.04, SURV_T),
    },
    {
      label: 'Signal (evaluated → final priority)', value: fmt.pct(t.signalRate),
      detail: `${fmt.int(d.funnel.finalPriority)} final priority of ${fmt.int(d.funnel.assigned)} assigned`,
      pct: gauge(t.signalRate, SIG_T), target: 66, targetLabel: `target ${fmt.pct(SIG_T)}`,
      delta: last && prevB ? (last.signalRate - prevB.signalRate) * 100 : null, deltaLabel: 'pts vs prev bucket',
      status: band(t.signalRate, 0.005, SIG_T),
    },
    {
      label: 'Team velocity', value: fmt.dec(t.personDayThroughput) + ' /person/day',
      detail: `${fmt.int(t.totalEvaluated)} evaluated · ${fmt.dec(t.avgThroughput)} avg per person`,
      pct: gauge(t.personDayThroughput, TPUT_T), target: 66, targetLabel: `target ${TPUT_T}/day`,
      status: band(t.personDayThroughput, TPUT_T * 0.6, TPUT_T),
    },
    {
      label: 'Note coverage', value: fmt.pct(t.noteRate),
      detail: `${fmt.int(d.funnel.evaluated)} evaluated · ${fmt.int(Math.round(t.noteRate * d.funnel.evaluated))} with a note`,
      pct: gauge(t.noteRate, 0.9), target: 66, targetLabel: 'target 90%',
      status: band(t.noteRate, 0.75, 0.9),
    },
    {
      label: 'Active evaluators', value: String(t.evaluators),
      detail: `${fmt.int(d.evaluators.length)} on the roster this window`,
      pct: d.evaluators.length ? (t.evaluators / d.evaluators.length) * 100 : 0,
      status: band(d.evaluators.length ? t.evaluators / d.evaluators.length : 0, 0.6, 0.85),
    },
  ]
  const active = d.evaluators.filter((e) => e.evaluated > 0)
  // Initial mix stack: weight order (List_Idea > P&B > Bypass) + Link_dead in gray.
  const initRows = active.slice(0, 12).map((e) => ({ name: e.name, parts: { ...e.initialConclusions, ...(e.linkDead ? { Link_dead: e.linkDead } : {}) } }))
  const initKeys = orderedKeys(initRows.map((r) => r.parts), INIT_ORDER, ['Link_dead'])
  // Picks → final outcomes stack: weight order P-IV…Bypass, Not Found appended (excluded from score).
  const finRows = active.filter((e) => Object.keys(e.finalConclusions).length > 0).map((e) => ({ name: e.name, parts: e.finalConclusions }))
  const finKeys = orderedKeys(finRows.map((r) => r.parts), FINAL_ORDER, ['Not Found'])

  // time-series derivations for trends & sparklines
  const ms = d.metricSeries || []
  const pts = (f: (m: Bundle['metricSeries'][number]) => number) => ms.map((m) => ({ label: m.label, value: f(m) }))
  const volSpark = ms.map((m) => m.volume)
  const sigSpark = ms.map((m) => Math.round(m.signalRate * 1000))
  const survSpark = ms.map((m) => Math.round(m.survivalRate * 1000))
  const fpSpark = ms.map((m) => m.finalPriority)
  const pipelineSeries = [
    { name: 'Assigned', color: CAT[5], points: pts((m) => m.assigned) },
    { name: 'Evaluated', color: CAT[0], points: pts((m) => m.evaluated) },
    { name: 'Shortlist', color: CAT[2], points: pts((m) => m.shortlisted) },
    { name: 'Final Priority', color: CAT[4], points: pts((m) => m.finalPriority) },
  ]
  const rateSeries = [
    { name: 'Survival rate %', color: CAT[3], points: pts((m) => m.survivalRate * 100) },
    { name: 'Signal rate %', color: CAT[1], points: pts((m) => m.signalRate * 100) },
  ]
  // ---- per-chart actionable derivations ----
  // funnel: which single step loses the most, proportionally
  const fnStages = [
    { from: 'Evaluated', to: 'Shortlist', a: d.funnel.evaluated, b: d.funnel.shortlisted },
    { from: 'Shortlist', to: 'Final Priority', a: d.funnel.shortlisted, b: d.funnel.finalPriority },
  ].filter((s) => s.a > 0)
  const worstStep = fnStages.sort((x, y) => x.b / x.a - y.b / y.a)[0]
  // health: the metric furthest below its own target
  const gapRows = health.filter((h) => h.target != null).map((h) => ({ label: h.label, short: 66 - Math.min(66, h.pct) }))
  const worstHealth = gapRows.sort((a, b) => b.short - a.short)[0]
  // rates: direction across the buckets that actually received work
  const rateFirst = rated[0], rateLast = rated[rated.length - 1]
  const survDir = rateFirst && rateLast ? (rateLast.survivalRate - rateFirst.survivalRate) * 100 : 0
  // volume vs headcount: is a volume drop explained by fewer people?
  const vs = d.series
  const vFirst = vs[0], vLast = vs[vs.length - 1]
  const volDrop = vFirst && vLast && vFirst.value > 0 ? (vLast.value - vFirst.value) / vFirst.value : 0
  const headDrop = vFirst && vLast && vFirst.people > 0 ? (vLast.people - vFirst.people) / vFirst.people : 0
  // stacked bars: the most and least aggressive gatekeeper
  const bypassShare = (e: Ev) => {
    const tot = Object.values(e.initialConclusions).reduce((s, n) => s + n, 0)
    return tot > 0 ? (e.initialConclusions['Bypass'] || 0) / tot : 0
  }
  const gatekeepers = active.filter((e) => e.evaluated >= 50).sort((a, b) => bypassShare(b) - bypassShare(a))
  const holdUp = (e: Ev) => {
    const tot = Object.values(e.finalConclusions).reduce((s, n) => s + n, 0)
    return tot > 0 ? ((e.finalConclusions['Priority IV'] || 0) + (e.finalConclusions['Insight'] || 0)) / tot : 0
  }
  const finPeople = active.filter((e) => Object.values(e.finalConclusions).reduce((s, n) => s + n, 0) >= 5)
    .sort((a, b) => holdUp(b) - holdUp(a))

  // data-driven callouts for this window
  const f = d.funnel
  const worstNote = active.filter((x) => x.evaluated >= 50).sort((a, b) => a.noteRate - b.noteRate)[0]
  const insights: React.ReactNode[] = []
  if (f.assigned > 0 && f.evaluated < f.assigned * 0.8) insights.push(
    <Insight key="behind" level="warn"><span><b>Intake is outpacing evaluation:</b> {fmt.int(f.assigned)} assigned vs {fmt.int(f.evaluated)} evaluated ({fmt.pct(f.evaluated / f.assigned)} cleared) → expect backlog growth; rebalance assignments or add capacity.</span></Insight>)
  if (f.assigned > 0 && f.evaluated > f.assigned * 1.2) insights.push(
    <Insight key="burn" level="good"><span><b>Burning down backlog:</b> the team evaluated {fmt.int(f.evaluated)} vs only {fmt.int(f.assigned)} newly assigned - older queue is being cleared.</span></Insight>)
  if (f.evaluated > 0 && t.noteRate < 0.9) insights.push(
    <Insight key="note" level="warn"><span><b>Note coverage {fmt.pct(t.noteRate)}</b> (target ≥90%){worstNote && worstNote.noteRate < 0.9 ? <> - lowest: <b>{worstNote.name}</b> at {fmt.pct(worstNote.noteRate)}</> : null} → remind evaluators that unexplained conclusions can&apos;t be audited.</span></Insight>)
  if (f.shortlisted > 0 && f.finalPriority === 0) insights.push(
    <Insight key="notriage" level="info"><span><b>No shortlisted game has reached Final Priority yet</b> in this window ({fmt.int(f.shortlisted)} waiting) - check whether moderators have triaged the shortlist.</span></Insight>)
  return (
    <>
      <Guide title="Team Overview - is the pipeline flowing and are picks holding up?"
        read={[
          <span key="1"><b>KPI row</b>: volume first (Assigned, Evaluated, velocity), then quality (Survival, Signal, Final priority). Hover the <b>?</b> on any KPI for its definition. Sparklines = trend inside the window.</span>,
          <span key="2"><b>Pipeline over time</b>: red (Assigned) above blue (Evaluated) = load building; the gap down to Shortlist/Final Priority is the filter doing its job.</span>,
          <span key="3"><b>Shortlist funnel</b>: the shape only narrows; the final band splits <b>Priority IV</b> (violet) vs <b>Insight</b> (teal).</span>,
          <span key="4"><b>Stacked bars</b>: each evaluator&apos;s conclusion mix - more purple (List_Idea) = more signal surfaced.</span>,
        ]}
        act={[
          <span key="1"><b>Assigned ≫ Evaluated</b> → rebalance assignments or add evaluator capacity before backlog compounds.</span>,
          <span key="2"><b>Survival dropping week-over-week</b> → what&apos;s being pushed in is getting worse: revisit the push filters (scraper window / types).</span>,
          <span key="3"><b>Final Priority = 0 all window</b> → moderators may not have triaged - nudge the shortlist review.</span>,
          <span key="4"><b>Note coverage &lt; 90%</b> → require a note at least for every List_Idea.</span>,
        ]} />
      <div className="rp-kpi-row rp-kpi-row-dense">
        <Kpi label="Assigned" value={fmt.int(t.totalAssigned)} sub={`new intake · ${d.window.label}`} tip={TIP.assigned} />
        <Kpi label="Games evaluated" value={fmt.int(t.totalEvaluated)} sub={d.window.label} hi spark={volSpark} tip={TIP.evaluated} />
        <Kpi label="Games / person / day" value={fmt.dec(t.personDayThroughput)} sub="team velocity, per active day" tip={TIP.gppd} />
        <Kpi label="Avg throughput" value={fmt.dec(t.avgThroughput)} sub="games / active day" tip={TIP.throughput} />
        <Kpi label="Avg turnaround" value={fmt.days(t.avgTurnaround)} sub="assign → evaluate" tip={TIP.turnaround} />
        <Kpi label="Survival rate" value={fmt.pct(t.survivalRate)} sub={`${fmt.int(d.funnel.shortlisted)} of ${fmt.int(d.funnel.evaluated)} evaluated`} spark={survSpark} sparkColor={CAT[3]} tip={TIP.survival} />
        <Kpi label="Signal rate" value={fmt.pct(t.signalRate)} sub={`${fmt.int(d.funnel.finalPriority)} of ${fmt.int(d.funnel.evaluated)} evaluated`} spark={sigSpark} sparkColor={CAT[1]} tip={TIP.signal} />
        <Kpi label="Final priority" value={fmt.int(d.funnel.finalPriority)} sub={`${fmt.int(d.funnel.priorityIV)} Priority IV · ${fmt.int(d.funnel.insight)} Insight`} spark={fpSpark} sparkColor={CAT[4]} tip={TIP.finalPriority} />
        <Kpi label="Note coverage" value={fmt.pct(t.noteRate)} sub={`${fmt.int(Math.round(t.noteRate * d.funnel.evaluated))} of ${fmt.int(d.funnel.evaluated)} evaluated`} tip={TIP.noteCoverage} />
      </div>
      {insights}

      <Card label="Pipeline over time" note="assigned → evaluated → shortlist → final priority per bucket"
        tip={<><F>per bucket: assigned by first-assign date · others by evaluate_date</F>Assigned counts new intake only - reassign/handover is not new work. Final Priority = Priority IV + Insight.</>}>
        <LineChart series={pipelineSeries} area />
        <ReadNote><b>Evaluated</b> → <b>Shortlist</b> gap = filtering; gap down to <b>Final Priority</b> = pick quality.</ReadNote>
        {f.assigned > 0 && (f.evaluated < f.assigned * 0.8
          ? <Act>Evaluation is running {fmt.pct(1 - f.evaluated / f.assigned)} behind intake this window → move {fmt.int(f.assigned - f.evaluated)} games off the slowest queues before the gap compounds into next week.</Act>
          : <Act>The team cleared {fmt.int(f.evaluated)} against {fmt.int(f.assigned)} new games → there is headroom to raise the push volume rather than leave evaluators waiting on supply.</Act>)}
      </Card>

      <div className="rp-section-title">Shortlist funnel & team health</div>
      <div className="rp-grid-2-1">
        <Card label="Shortlist funnel" note="assigned → evaluated → shortlist → final priority"
          tip={<><F>shortlist = initial ≠ bypass · final = Priority IV + Insight</F>Each bar shows conversion from the previous step.</>}>
          <Funnel stages={funnelStages} />
          <ReadNote>Watch conversion per step - the final band splits <b>Priority IV</b> (violet) vs <b>Insight</b> (teal).</ReadNote>
          {worstStep && (
            <Act>The narrowest neck is <b>{worstStep.from} → {worstStep.to}</b> ({fmt.pct(worstStep.b / worstStep.a)} through) → that is where to spend review time; widening any other step just pushes more games into this one.</Act>
          )}
        </Card>
        <Card label="Team health" note="leading indicators"
          tip={<><F>survival = shortlist ÷ evaluated · signal = final ÷ evaluated</F>Throughput = avg games/active day · Active = evaluators with ≥1 evaluation.</>}>
          <HealthBars rows={health} />
          {worstHealth && worstHealth.short > 6 && (
            <Act><b>{worstHealth.label.split(' (')[0]}</b> is the furthest below target → fix that one before tuning anything else on this card; the rest are at or near benchmark.</Act>
          )}
        </Card>
      </div>

      <div className="rp-grid-2">
        <Card label="Quality rates over time" note="survival & signal %, per bucket"
          tip={<><F>survival = shortlist ÷ evaluated · signal = final priority ÷ evaluated</F>Both computed per bucket, on the games evaluated in that bucket - so the line reads pick quality, not how much intake happened to land that week.</>}>
          {ms.length >= 2 ? <LineChart series={rateSeries} format={(v) => `${v.toFixed(1)}%`} /> : <Empty text="Need more than one period" />}
          {rated.length >= 2 && (Math.abs(survDir) >= 2
            ? <Act>Survival moved {survDir > 0 ? 'up' : 'down'} {Math.abs(survDir).toFixed(1)} points across this window ({fmt.pct(rateFirst.survivalRate)} → {fmt.pct(rateLast.survivalRate)}) → {survDir > 0 ? 'find out what changed in the push filters and keep it' : 'two candidates now that the rate is measured on what was judged: the pushed games got worse (check scraper window and source types) or the bypass bar quietly got stricter - ask before assuming either'}.</Act>
            : <Act>Survival is flat around {fmt.pct(rateLast.survivalRate)} → source quality and the bypass bar are both holding steady, so any change in output this window came from capacity, not from what was pushed or how it was judged.</Act>)}
        </Card>
        <Card label="Volume over time" note={`games evaluated per bucket · ${peopleName.toLowerCase()}`}
          tip={<><F>= count(evaluated) per bucket</F>{d.bucketUnit === 'day'
            ? 'The dashed line is how many evaluators logged work that day.'
            : 'The dashed line is the average evaluators working per active day inside the bucket, rounded up - not the distinct people across the whole bucket.'}</>}>
          <ColumnChart data={d.series} line={{ name: peopleName, values: d.series.map((s) => s.people), color: CAT[3] }} />
          <ReadNote>Volume falling while the line holds = throughput problem; both falling = coverage problem.</ReadNote>
          {vs.length >= 2 && volDrop < -0.15 && (
            <Act>Volume fell {fmt.pct(Math.abs(volDrop))} from the first to the last bucket while headcount {headDrop < -0.1 ? `fell ${fmt.pct(Math.abs(headDrop))} too → this is a coverage gap: check leave and handovers` : 'held → this is a throughput problem, not a staffing one: look at queue supply and blocked games'}.</Act>
          )}
          {vs.length >= 2 && volDrop >= -0.15 && (
            <Act>Output is holding at ~{fmt.int(vLast.value)} per bucket with {vLast.people} {vLast.people === 1 ? 'evaluator' : 'evaluators'} working → keep the current roster; the constraint is upstream supply, not people.</Act>
          )}
        </Card>
      </div>

      <div className="rp-grid-2">
        <Card label="Initial conclusions" note="what evaluators decided"
          tip={<><F>= distribution of initial_conclusion (Link_dead excluded)</F></>}>
          <Donut data={d.initialConclusions} />
        </Card>
        <Card label="Final conclusions" note="moderator outcomes on shortlisted games"
          tip={<><F>= distribution of final_conclusion</F>Only shortlisted games get one.</>}>
          {d.finalConclusions.length ? <Donut data={d.finalConclusions} /> : <Empty text="No final conclusions in this window" />}
        </Card>
      </div>

      <div className="rp-section-title">Output quality - initial → final</div>
      <Card label="Initial conclusions by evaluator" note="quality order: List_Idea › Playtest & Bypass › Bypass · gray = Link_dead"
        tip={<><F>bar = one evaluator · segment = count per conclusion</F>Hover a segment for exact counts.</>}>
        <StackedBars rows={initRows} keys={initKeys} />
        <ReadNote>Purple (<b>List_Idea</b>) = signal, red (<b>Bypass</b>) = gatekeeping, gray = dead links caught.</ReadNote>
        {gatekeepers.length >= 2 && bypassShare(gatekeepers[0]) - bypassShare(gatekeepers[gatekeepers.length - 1]) > 0.15 && (
          <Act><b>{gatekeepers[0].name}</b> bypasses {fmt.pct(bypassShare(gatekeepers[0]))} of their games vs <b>{gatekeepers[gatekeepers.length - 1].name}</b> at {fmt.pct(bypassShare(gatekeepers[gatekeepers.length - 1]))} → run one calibration pass on the same 20 games with both; a spread this wide means the bar is personal, not shared.</Act>
        )}
      </Card>
      <Card label="Their picks → final outcomes" note="quality order: Priority IV › Insight › Watch List › Priority V › Theme/Art › Bypass"
        tip={<><F>bar = games one evaluator shortlisted · segment = moderator verdict</F>Hover a segment for exact counts.</>}>
        {finRows.length ? <StackedBars rows={finRows} keys={finKeys} /> : <Empty text="No picks reached final conclusion in this window" />}
        <ReadNote>How the moderator judged each evaluator&apos;s shortlist - violet/teal = picks that held up.</ReadNote>
        {finPeople.length >= 2 && (
          <Act><b>{finPeople[0].name}</b>&apos;s picks hold up best ({fmt.pct(holdUp(finPeople[0]))} reach Priority IV or Insight) vs <b>{finPeople[finPeople.length - 1].name}</b> at {fmt.pct(holdUp(finPeople[finPeople.length - 1]))} → have the top evaluator walk the bottom one through five of their own shortlisted games.</Act>
        )}
      </Card>
    </>
  )
}

/* ---------------- Leaderboard (absorbs the old Compare + Activity tabs) ---------------- */
// One place to answer "who is doing well": the rank boards, the two movement charts,
// the cadence heatmap and the side-by-side comparison all read the same people over
// the same window, so splitting them across three tabs only hid the comparison.
function Leaderboard({ d }: { d: Bundle }) {
  const ev = d.evaluators
  // `sub` carries the counts behind a ratio: a leaderboard of bare percentages hides
  // that the top row may be 3-of-20 while the second is 180-of-1,500.
  const rank = (f: (e: Ev) => number, sub?: (e: Ev) => string, filter = true) =>
    [...ev].filter((e) => !filter || e.evaluated > 0).sort((a, b) => f(b) - f(a))
      .map((e) => ({ name: e.name, value: f(e), sub: sub?.(e) }))
  const byTurn = ev.filter((e) => e.turnaround != null).sort((a, b) => a.turnaround! - b.turnaround!).map((e) => ({ name: e.name, value: e.turnaround! }))
  const byRec = [...ev].filter((e) => e.recorded > 0).sort((a, b) => b.recorded - a.recorded).map((e) => ({ name: e.name, value: e.recorded }))
  const canBump = d.heatmap.periods.length >= 2
  // callouts: concentration + outliers
  const activeLb = ev.filter((e) => e.evaluated > 0)
  const totalEval = activeLb.reduce((s, e) => s + e.evaluated, 0)
  const top = activeLb[0]
  const teamTa = d.teamTotals.avgTurnaround
  const slow = teamTa != null ? activeLb.filter((e) => e.turnaround != null && e.turnaround > teamTa * 2 && e.evaluated >= 50) : []
  // ---- comparison block (was the Compare tab) ----
  const radarTop = d.radar.slice(0, 8)
  const radarSeries = radarTop.map((r, i) => ({ name: r.name, values: RADAR_AXES.map((a) => r.axes[a] || 0), color: CAT[i % CAT.length] }))
  // All-rounder score. The plain mean of the 5 axes let a low-volume evaluator
  // outrank a high-volume one: rates computed over 30 games swing wildly and cost
  // only one axis, so a lucky small sample beat sustained output. Two corrections:
  //   1. Axis weights (Config tab, Volume-heavy by default) instead of a flat mean.
  //   2. Every axis except Volume is scaled by a CREDIBILITY factor
  //      = min(1, evaluated ÷ median team volume) - a half-median sample keeps half
  //      its quality credit. Volume itself is never discounted (it is the evidence).
  const volumes = activeLb.map((x) => x.evaluated).sort((a, b) => a - b)
  const medianVol = volumes.length ? volumes[Math.floor(volumes.length / 2)] : 0
  const W = d.config.weights
  const QUALITY_AXES = RADAR_AXES.filter((a) => a !== 'Volume')
  const qualityW = QUALITY_AXES.reduce((s, a) => s + (W[a] || 0), 0)
  const allRound = d.radar
    .map((r) => {
      const evd = ev.find((x) => x.key === r.key)
      const evc = evd?.evaluated || 0
      const cred = d.config.credibility ? (medianVol > 0 ? Math.min(1, evc / medianVol) : 1) : 1
      // weighted mean of the non-Volume axes, for the "grinder" callout below
      const quality = qualityW > 0 ? QUALITY_AXES.reduce((s, a) => s + (r.axes[a] || 0) * (W[a] || 0), 0) / qualityW : 0
      return {
        name: r.name, evaluated: evc, volumeAxis: r.axes['Volume'] || 0, qualityAxis: quality,
        value: allRounderScore(r.axes, W, cred),
        sub: `${fmt.int(evc)} games${d.config.credibility ? ` · cred ${Math.round(cred * 100)}%` : ''}`,
      }
    })
    .sort((a, b) => b.value - a.value)
  // volume-rich but quality-poor: lots of games, weak on the other axes
  const grinder = allRound.find((r) => r.volumeAxis >= 60 && r.qualityAxis < 40)
  // spikiest radar = biggest spread between a person's best and worst axis
  const spread = (r: Bundle['radar'][number]) => {
    const vals = RADAR_AXES.map((a) => r.axes[a] || 0)
    return Math.max(...vals) - Math.min(...vals)
  }
  const spiky = [...radarTop].sort((a, b) => spread(b) - spread(a))[0]
  const spikyWeak = spiky ? RADAR_AXES.reduce((w, a) => ((spiky.axes[a] || 0) < (spiky.axes[w] || 0) ? a : w), RADAR_AXES[0]) : null
  // scatter: volume (x) vs survival rate (y), bubble = throughput
  const scatterPts = activeLb.map((e, i) => ({ name: e.name, x: e.evaluated, y: e.survivalRate * 100, size: Math.max(1, e.throughput), color: CAT[i % CAT.length] }))
  const meanVol = activeLb.length ? activeLb.reduce((s, e) => s + e.evaluated, 0) / activeLb.length : 0
  const meanSurv = activeLb.length ? activeLb.reduce((s, e) => s + e.survivalRate, 0) / activeLb.length : 0
  const fastLowSignal = activeLb.filter((e) => e.evaluated > meanVol && e.survivalRate < meanSurv)
    .sort((a, b) => a.survivalRate - b.survivalRate)[0]

  // ---- movement (was Activity): rank at the first vs the last period ----
  const movers = (rows: Bundle['heatmap']['rows'], periods: Bundle['heatmap']['periods']) => {
    if (periods.length < 2) return null
    const rankAt = (pk: string) => {
      const present = rows.filter((r) => (r.cells[pk] || 0) > 0).sort((a, b) => (b.cells[pk] || 0) - (a.cells[pk] || 0))
      return new Map(present.map((r, i) => [r.name, i + 1]))
    }
    const first = rankAt(periods[0].key), lastR = rankAt(periods[periods.length - 1].key)
    const deltas = rows
      .filter((r) => first.has(r.name) && lastR.has(r.name))
      .map((r) => ({ name: r.name, delta: first.get(r.name)! - lastR.get(r.name)!, to: lastR.get(r.name)! }))
      .sort((a, b) => b.delta - a.delta)
    if (!deltas.length) return null
    return { up: deltas[0], down: deltas[deltas.length - 1] }
  }
  const volMove = movers(d.heatmap.rows, d.heatmap.periods)
  const scoreMove = movers(d.scoreRank.rows, d.scoreRank.periods)
  // cadence gaps: who has the most empty buckets in the heatmap
  const idle = d.heatmap.rows
    .map((r) => ({ name: r.name, gaps: d.heatmap.periods.filter((p) => !(r.cells[p.key] || 0)).length }))
    .sort((a, b) => b.gaps - a.gaps)[0]

  const lbInsights: React.ReactNode[] = []
  if (top && totalEval > 0 && top.evaluated / totalEval > 0.4 && activeLb.length >= 3) lbInsights.push(
    <Insight key="conc" level="info"><span><b>Output is concentrated:</b> {top.name} did {fmt.pct(top.evaluated / totalEval)} of all evaluations - great output, but a single point of failure if they&apos;re out.</span></Insight>)
  if (slow.length) lbInsights.push(
    <Insight key="slow" level="warn"><span><b>Turnaround outlier{slow.length > 1 ? 's' : ''}:</b> {slow.map((e) => `${e.name} (${e.turnaround!.toFixed(1)}d)`).join(', ')} - over 2× the team average ({teamTa!.toFixed(1)}d) → check if their queue is overloaded or blocked.</span></Insight>)
  return (
    <>
      <Guide title="Leaderboard - who produces, does it hold up, and who is moving?"
        read={[
          <span key="1"><b>Volume / Throughput</b> = quantity; <b>Survival / Signal / Final priority</b> = quality. Never judge one without the other.</span>,
          <span key="2"><b>Volume movement</b> ranks by games evaluated per {d.bucketUnit === 'month' ? 'month' : d.bucketUnit === 'week' ? 'week' : 'day'}; <b>Rank movement</b> ranks by the all-rounder score, so someone can climb by improving quality without touching their volume.</span>,
          <span key="3"><b>Radar + all-rounder</b>: shape and single score for the same five axes. <b>Heatmap</b>: cadence - a solid row is steady, holes are idle stretches.</span>,
          <span key="4"><b>Turnaround</b> ranks fastest first - it measures how long assignments sit, not how fast someone plays.</span>,
        ]}
        act={[
          <span key="1"><b>High volume + near-zero Survival</b> → spot-check their bypasses: are real signals being thrown away?</span>,
          <span key="2"><b>Turnaround &gt; 2× team average</b> → their queue is stuck: rebalance or unblock.</span>,
          <span key="3"><b>Falling several periods in a row</b> → check workload, handover, or motivation early - not after the month closes.</span>,
          <span key="4"><b>Spiky radar</b> (one long axis) → assign work that exercises the short axes, or accept the specialization deliberately.</span>,
        ]} />
      {lbInsights}

      <div className="rp-section-title">Comparison</div>
      <div className="rp-grid-2-1">
        <Card label="Performance radar - top evaluators" note="5 axes · normalized to team best" tip={TIP.radar}>
          <Radar axes={[...RADAR_AXES]} series={radarSeries} size={320} />
          <ReadNote>Larger, more balanced polygon = stronger all-rounder. Hover a name to isolate.</ReadNote>
          {spiky && spikyWeak && spread(spiky) >= 45 && (
            <Act><b>{spiky.name}</b> is the most lopsided ({Math.round(spread(spiky))} points between their best and worst axis, weakest on <b>{spikyWeak}</b>) → either route work that exercises {spikyWeak.toLowerCase()} to them, or record the specialization so nobody reads the gap as underperformance.</Act>
          )}
        </Card>
        <Card label="All-rounder score" note="volume-weighted, quality discounted by sample size" tip={TIP.allRounder}>
          <RankBars rows={allRound} color={CAT[4]} format={(v) => fmt.dec(v, 0)} />
          <ReadNote>Volume is 40% of the score; the quality axes are scaled by how much work backs them, so a small sample cannot outrank sustained output.</ReadNote>
          {grinder
            ? <Act><b>{grinder.name}</b> scores {fmt.dec(grinder.volumeAxis, 0)} on volume but only {fmt.dec(grinder.qualityAxis, 0)} on the quality axes → review a sample of their calls before rewarding throughput alone.</Act>
            : allRound.length >= 2 && <Act>Top score is <b>{allRound[0].name}</b> at {fmt.dec(allRound[0].value, 0)} vs {fmt.dec(allRound[allRound.length - 1].value, 0)} at the bottom → pair the bottom of this list with the top for one calibration session.</Act>}
        </Card>
      </div>
      <Card label="Volume vs survival rate" note="x = games evaluated · y = survival % (evaluated → shortlist) · bubble = throughput"
        tip={<><F>x = evaluated · y = shortlist ÷ evaluated · bubble = games ÷ active day</F></>}>
        {scatterPts.length ? <Scatter points={scatterPts} xLabel="Volume" yLabel="Survival %"
          xFormat={(v) => fmt.int(v)} yFormat={(v) => `${Math.round(v)}%`} /> : <Empty />}
        <ReadNote>Top-right = high volume <i>and</i> high signal. Bottom-right = fast but almost all bypassed.</ReadNote>
        {fastLowSignal && (
          <Act><b>{fastLowSignal.name}</b> sits bottom-right: {fmt.int(fastLowSignal.evaluated)} games (above the {fmt.int(meanVol)} average) at {fmt.pct(fastLowSignal.survivalRate)} survival (team {fmt.pct(meanSurv)}) → sample 20 of their bypasses before assuming the speed is free.</Act>
        )}
      </Card>

      <div className="rp-section-title">Movement &amp; cadence</div>
      {canBump && (
        <Card label="Volume movement" note={`rank by games evaluated, per ${d.heatmap.periods.length > 1 ? 'period' : 'period'}`}
          tip={<><F>rank = position by games evaluated, per period</F>1 = most games that period. Periods here are finer than the trend charts: day for a week/month/batch window, week for a quarter.</>}>
          <BumpChart periods={d.heatmap.periods} rows={d.heatmap.rows} />
          <ReadNote>Rank 1 = most games. Rising lines = pulling ahead of peers, not just of their own past.</ReadNote>
          {volMove && (volMove.up.delta > 0 || volMove.down.delta < 0) && (
            <Act>
              {volMove.up.delta > 0 && <><b>{volMove.up.name}</b> climbed {volMove.up.delta} place{volMove.up.delta > 1 ? 's' : ''} to #{volMove.up.to}. </>}
              {volMove.down.delta < 0 && <><b>{volMove.down.name}</b> dropped {Math.abs(volMove.down.delta)} to #{volMove.down.to} → ask them today whether it is queue supply or availability; a slide caught late is a month of lost output.</>}
            </Act>
          )}
        </Card>
      )}
      {canBump && (
        <Card label="Rank movement" note="rank by all-rounder score, per period"
          tip={<><F>score = 0.4×Volume + 0.6×avg(Signal, Survival)×credibility, normalized within each period</F>Consistency and Recording are dropped at this grain - inside one day/week bucket active-days is degenerate and recording is too sparse to rank on.</>}>
          <BumpChart periods={d.scoreRank.periods} rows={d.scoreRank.rows} />
          <ReadNote>Unlike volume movement, someone climbs here by finding more signal per assigned game, not by grinding more of them.</ReadNote>
          {scoreMove && (scoreMove.up.delta > 0 || scoreMove.down.delta < 0) && (
            <Act>
              {scoreMove.up.delta > 0 && <><b>{scoreMove.up.name}</b> gained {scoreMove.up.delta} place{scoreMove.up.delta > 1 ? 's' : ''} on quality-adjusted rank → ask what changed and make it the team default. </>}
              {scoreMove.down.delta < 0 && <><b>{scoreMove.down.name}</b> lost {Math.abs(scoreMove.down.delta)}; compare against volume movement above - falling here but flat there means the output held while the picks got weaker.</>}
            </Act>
          )}
        </Card>
      )}
      <Card label="Activity heatmap" note="games evaluated · person × period"
        tip={<><F>cell = count(evaluated) for that person, that period</F>Day cells for a week/month/batch window, week cells for a quarter.</>}>
        <Heatmap periods={d.heatmap.periods} rows={d.heatmap.rows} />
        <ReadNote>Darker = more games. Gaps in a row = idle stretches.</ReadNote>
        {idle && idle.gaps > 0 && (
          <Act><b>{idle.name}</b> has {idle.gaps} empty {idle.gaps === 1 ? 'period' : 'periods'} of {d.heatmap.periods.length} → confirm leave vs a stalled queue, and hand their backlog over if it is the latter.</Act>
        )}
      </Card>

      <div className="rp-section-title">Rank boards</div>
      <div className="rp-grid-2">
      <Card label="Volume" note="games evaluated" tip={TIP.evaluated}><RankBars rows={rank((e) => e.evaluated)} unit="games" color={CAT[0]} /></Card>
      <Card label="Throughput" note="games / active day" tip={TIP.perDay('games evaluated')}><RankBars rows={rank((e) => e.throughput, (e) => `${fmt.int(e.evaluated)} in ${e.activeDays}d`)} color={CAT[1]} format={(v) => fmt.dec(v)} /></Card>
      <Card label="Turnaround (fastest first)" note="days assign → evaluate" tip={TIP.turnaround}><RankBars rows={byTurn} color={CAT[2]} format={(v) => `${v.toFixed(1)}d`} /></Card>
      <Card label="Survival rate" note="evaluated → shortlist" tip={TIP.survival}><RankBars rows={rank((e) => e.survivalRate, (e) => `${fmt.int(e.shortlisted)} of ${fmt.int(e.evaluated)}`)} color={CAT[3]} format={fmt.pct} /></Card>
      <Card label="Signal rate" note="evaluated → final priority (Priority IV + Insight)" tip={TIP.signal}><RankBars rows={rank((e) => e.signalRate, (e) => `${fmt.int(e.finalPriority)} of ${fmt.int(e.evaluated)}`)} color={CAT[4]} format={fmt.pct} /></Card>
      <Card label="Final priority" note="Priority IV + Insight picks" tip={TIP.finalPriority}><RankBars rows={rank((e) => e.finalPriority, (e) => `${fmt.int(e.priorityIV)} P-IV · ${fmt.int(e.insight)} Insight`)} unit="games" color={CAT[6]} /></Card>
      <Card label="Note coverage" note="% evaluations with a note" tip={TIP.noteCoverage}><RankBars rows={rank((e) => e.noteRate, (e) => `${fmt.int(e.noted)} of ${fmt.int(e.evaluated)}`)} color={CAT[5]} format={fmt.pct} /></Card>
      <Card label="Recording" note="videos recorded (5/20min)" tip={TIP.recorded}>{byRec.length ? <RankBars rows={byRec} unit="rec" color={CAT[7]} /> : <Empty text="No recordings in this window" />}</Card>
      </div>
    </>
  )
}

/* ---------------- Individual ---------------- */
// Team benchmarks for the Individual tab. Each bench uses the SAME formula as the
// person's own number so the two are directly comparable:
//   counts  → average over the people who actually did that kind of work in the
//             window (dragging in idle rows would fake a low bar)
//   rates   → weighted team rate (total ÷ total), not a mean of per-person means,
//             so a heavy contributor moves the bar as much as their volume says
// Denominators mirror the per-person ones (evaluated for survival/signal, active
// person-days for throughput and the per-day tempo metrics).
function teamBench(evs: Ev[]) {
  const sum = (f: (e: Ev) => number) => evs.reduce((s, e) => s + f(e), 0)
  const avgOf = (f: (e: Ev) => number, active: (e: Ev) => boolean) => {
    const xs = evs.filter(active)
    return xs.length ? xs.reduce((s, e) => s + f(e), 0) / xs.length : 0
  }
  const worked = (e: Ev) => e.evaluated > 0
  const activeDays = sum((e) => e.activeDays)
  const evaluated = sum((e) => e.evaluated)
  const tas = evs.map((e) => e.turnaround).filter((t): t is number => t != null)
  // Deliberately NOT benchmarked (user call): the conclusion-mix donuts, Recorded and
  // Link dead. Recording is assigned work, not something an evaluator competes on, and
  // dead links are source quality - a team average there invites the wrong conclusion.
  return {
    assigned: avgOf((e) => e.assigned, (e) => e.assigned > 0),
    evaluated: avgOf((e) => e.evaluated, worked),
    throughput: activeDays > 0 ? evaluated / activeDays : 0,
    turnaround: tas.length ? tas.reduce((a, b) => a + b, 0) / tas.length : null,
    survivalRate: evaluated > 0 ? sum((e) => e.shortlisted) / evaluated : 0,
    signalRate: evaluated > 0 ? sum((e) => e.finalPriority) / evaluated : 0,
    noteRate: evaluated > 0 ? sum((e) => e.noted) / evaluated : 0,
    perDay: (c: string) => (activeDays > 0 ? sum((e) => e.initialConclusions[c] || 0) / activeDays : 0),
  }
}
// Anything inside ±5% of the team reads as "on par" - narrower than that is noise
// on a window this small, and colouring it green/red invites false coaching.
const BENCH_DEADZONE = 0.05
// dir = which direction is better; 'flat' = no better/worse (mix & tempo metrics)
function vsTeam(value: number | null, bench: number | null, format: (n: number) => string, dir: 'up' | 'down' | 'flat'): Bench | null {
  if (value == null || bench == null || !isFinite(bench)) return null
  const delta = bench > 0 ? (value - bench) / bench : null
  let tone: Bench['tone'] = 'flat'
  if (delta != null && dir !== 'flat' && Math.abs(delta) >= BENCH_DEADZONE) {
    tone = (delta > 0) === (dir === 'up') ? 'good' : 'bad'
  }
  return { text: `team ${format(bench)}`, delta, tone }
}
/* Daily breakdown: one row per calendar DAY, plain numbers, no chart. The three
   named conclusions are the ones the team steers by; anything else the Config tab
   allows is folded into "Other" (hover it for the split). Video counts come from
   the recording queue rows (confirmed date + slot), so this panel and the queue
   card below can never disagree. */
const DAILY_COLS = ['Bypass', 'Playtest & Bypass', 'List_Idea'] as const
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// Longest span we will enumerate day-by-day. Past this (a wide custom range) the
// table falls back to days that actually have activity - a 400-row table of mostly
// zeros is not a breakdown, and the caller says so on screen.
const DAILY_MAX_DAYS = 120

function dailyRows(mix: Record<string, Record<string, number>>, vids: Bundle['videos'][string], win: Bundle['window']) {
  const rec5: Record<string, number> = {}
  const rec20: Record<string, number> = {}
  for (const v of vids) {
    if (!v.recordedOn) continue
    const t = v.slot === '20min' ? rec20 : rec5
    t[v.recordedOn] = (t[v.recordedOn] || 0) + 1
  }
  // day axis: every day in the window when we know its bounds (so idle days show as
  // zeros), otherwise only the days with something on them
  let days: string[] = []
  let filled = false
  if (win.from && win.to) {
    const start = new Date(win.from + 'T00:00:00Z')
    const end = new Date(win.to + 'T00:00:00Z')
    const span = Math.round((end.getTime() - start.getTime()) / 86400000)
    if (span > 0 && span <= DAILY_MAX_DAYS) {
      filled = true
      for (const dt = new Date(start); dt < end; dt.setUTCDate(dt.getUTCDate() + 1)) days.push(dt.toISOString().slice(0, 10))
    }
  }
  if (!filled) {
    days = Array.from(new Set([...Object.keys(mix), ...Object.keys(rec5), ...Object.keys(rec20)])).sort()
  }
  const rows = days.map((day) => {
    const m = mix[day] || {}
    const named = DAILY_COLS.map((c) => m[c] || 0)
    const otherEntries = Object.entries(m).filter(([c]) => !DAILY_COLS.includes(c as typeof DAILY_COLS[number]))
    const other = otherEntries.reduce((s, [, n]) => s + n, 0)
    const dow = new Date(day + 'T00:00:00Z').getUTCDay()
    return {
      day, dow, named, other,
      otherTitle: otherEntries.map(([c, n]) => `${c}: ${n}`).join(' · '),
      evaluated: named.reduce((a, b) => a + b, 0) + other,
      r5: rec5[day] || 0, r20: rec20[day] || 0,
    }
  })
  return { rows, filled }
}

function DailyBreakdown({ person, mix, vids, win, onClose }: {
  person: string
  mix: Record<string, Record<string, number>>
  vids: Bundle['videos'][string]
  win: Bundle['window']
  onClose: () => void
}) {
  useEffect(() => {
    const h = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  const { rows, filled } = dailyRows(mix, vids, win)
  const hasOther = rows.some((r) => r.other > 0)
  const tot = rows.reduce((a, r) => ({
    named: a.named.map((n, i) => n + r.named[i]),
    other: a.other + r.other, evaluated: a.evaluated + r.evaluated, r5: a.r5 + r.r5, r20: a.r20 + r.r20,
  }), { named: DAILY_COLS.map(() => 0), other: 0, evaluated: 0, r5: 0, r20: 0 })
  const workedDays = rows.filter((r) => r.evaluated > 0 || r.r5 > 0 || r.r20 > 0).length
  // '·' instead of 0 so the eye lands on the days that actually have numbers
  const num = (n: number, key: string, title?: string) => <td key={key} className={n ? '' : 'zero'} title={title}>{n || '·'}</td>
  return (
    <div className="rp-modal-backdrop" onClick={onClose}>
      <div className="rp-modal card rp-daily-modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <span className="card-label">{person} - daily breakdown</span>
          <span className="card-head-right">
            <span className="card-note">{win.label} · {workedDays} active {workedDays === 1 ? 'day' : 'days'} of {rows.length}</span>
            <button className="rp-expand" onClick={onClose} aria-label="Close" title="Close (Esc)">✕</button>
          </span>
        </div>
        <div className="rp-daily-wrap">
          <table className="rp-daily">
            <thead>
              <tr>
                <th className="l">Day</th>
                <th>Bypass</th>
                <th>P&amp;B</th>
                <th>List_Idea</th>
                {hasOther && <th>Other</th>}
                <th className="sep">Evaluated</th>
                <th>5min</th>
                <th>20min</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.day} className={(r.dow === 0 || r.dow === 6 ? 'we' : '') + (r.evaluated || r.r5 || r.r20 ? '' : ' idle')}>
                  <td className="l">{DAY_NAMES[r.dow]} {r.day.slice(8)}/{r.day.slice(5, 7)}</td>
                  {r.named.map((n, i) => num(n, 'c' + i))}
                  {hasOther && num(r.other, 'other', r.otherTitle || undefined)}
                  <td className="sep strong">{r.evaluated || '·'}</td>
                  {num(r.r5, 'r5')}
                  {num(r.r20, 'r20')}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="l">Total</td>
                {tot.named.map((n, i) => <td key={i}>{n}</td>)}
                {hasOther && <td>{tot.other}</td>}
                <td className="sep">{tot.evaluated}</td>
                <td>{tot.r5}</td>
                <td>{tot.r20}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <ReadNote>
          Conclusions are counted on <b>evaluate date</b>, videos on the date the recording was <b>confirmed</b> in the Record tab - so a video can land on a different day than the evaluation. <b>Evaluated</b> excludes dead links, same as everywhere else in this report.
          {!filled && <> Only days with activity are listed here (the window is too wide to enumerate every calendar day).</>}
          {filled && <> Every day in the window is listed; dimmed rows are days with no activity, shaded rows are weekends.</>}
        </ReadNote>
      </div>
    </div>
  )
}

function Individual({ d }: { d: Bundle }) {
  const [selKey, setSel] = useState('')
  const [daily, setDaily] = useState(false)
  const selected = useMemo(() => {
    if (!d.evaluators.length) return null
    return d.evaluators.find((e) => e.key === selKey) || d.evaluators[0]
  }, [d.evaluators, selKey])
  if (!selected) return <div className="card"><Empty /></div>
  const e = selected
  const rad = d.radar.find((r) => r.key === e.key)
  const radarValues = rad ? RADAR_AXES.map((a) => rad.axes[a] || 0) : RADAR_AXES.map(() => 0)
  // raw counterpart of each normalized axis, printed under the axis caption
  const radarRaw = [fmt.int(e.evaluated), fmt.pct(e.consistency), fmt.pct(e.signalRate), fmt.pct(e.survivalRate), fmt.int(e.recorded)]
  const initC = Object.entries(e.initialConclusions).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  const finC = Object.entries(e.finalConclusions).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  const funnelStages = [
    { label: 'Assigned', value: e.assigned },
    { label: 'Evaluated', value: e.evaluated },
    { label: 'Shortlist', value: e.shortlisted },
    { label: 'Final Priority', value: e.finalPriority, parts: [
      { label: 'Priority IV', value: e.priorityIV, color: CAT[4] },
      { label: 'Insight', value: e.insight, color: CAT[6] },
    ] },
  ]
  // per-conclusion daily rates, same denominator as Throughput (active days)
  const perDay = (c: string) => e.activeDays > 0 ? (e.initialConclusions[c] || 0) / e.activeDays : 0
  // personal activity per bucket: assigned / evaluated / link dead
  const ps = d.personSeries?.[e.key] || []
  const vids = d.videos?.[e.key] || []
  const personSpark = ps.map((p) => p.evaluated)
  const actSeries = [
    { name: 'Assigned', color: CAT[5], points: ps.map((p) => ({ label: p.label, value: p.assigned })) },
    { name: 'Evaluated', color: CAT[0], points: ps.map((p) => ({ label: p.label, value: p.evaluated })) },
    { name: 'Link dead', color: '#94a3b8', points: ps.map((p) => ({ label: p.label, value: p.linkDead })) },
  ]
  // ---- per-chart actionable derivations for this person ----
  const weakAxis = rad ? RADAR_AXES.reduce((w, a) => ((rad.axes[a] || 0) < (rad.axes[w] || 0) ? a : w), RADAR_AXES[0]) : null
  const strongAxis = rad ? RADAR_AXES.reduce((w, a) => ((rad.axes[a] || 0) > (rad.axes[w] || 0) ? a : w), RADAR_AXES[0]) : null
  // weakest funnel step, compared against the team's own rate for that step
  const tf = d.funnel
  const pSteps = [
    { from: 'Evaluated', to: 'Shortlist', a: e.evaluated, b: e.shortlisted, team: tf.evaluated > 0 ? tf.shortlisted / tf.evaluated : 0 },
    { from: 'Shortlist', to: 'Final Priority', a: e.shortlisted, b: e.finalPriority, team: tf.shortlisted > 0 ? tf.finalPriority / tf.shortlisted : 0 },
  ].filter((s) => s.a > 0)
  const pWorstStep = pSteps.sort((x, y) => x.b / x.a - y.b / y.a)[0]
  const psTotals = ps.length ? ps.reduce((acc, p) => ({ assigned: acc.assigned + p.assigned, evaluated: acc.evaluated + p.evaluated }), { assigned: 0, evaluated: 0 }) : null
  // Recording status and the YouTube link are written by two different steps - the
  // manual Confirm in the Record tab vs the upload sync - so they drift apart.
  const mismatch = {
    pendingWithLink: vids.filter((v) => !v.recordedOn && v.youtube).length,
    recordedNoLink: vids.filter((v) => v.recordedOn && !v.youtube).length,
    get total() { return this.pendingWithLink + this.recordedNoLink },
  }

  // person-level callouts for this window
  const deadShare = e.evaluated + e.linkDead > 0 ? e.linkDead / (e.evaluated + e.linkDead) : 0
  const t = d.teamTotals
  // ---- team benchmarks: only meaningful with someone to compare against ----
  const tb = teamBench(d.evaluators)
  const multi = d.evaluators.length >= 2
  // `ok` gates metrics whose own denominator is empty for this person: a rate over
  // zero assigned (or a recording count for someone who records nothing) is not a
  // 100% shortfall, it is "not applicable" - showing it red would be a false signal.
  const cmp = (value: number | null, bench: number | null, format: (n: number) => string, dir: 'up' | 'down' | 'flat', ok = true): Bench | null =>
    multi && ok ? vsTeam(value, bench, format, dir) : null
  const hasAssigned = e.assigned > 0
  const hasDays = e.activeDays > 0
  const pInsights: React.ReactNode[] = []
  if (e.assigned > 0 && e.evaluated === 0) pInsights.push(
    <Insight key="idle" level="bad"><span><b>{e.name} hasn&apos;t evaluated anything this window</b> despite {fmt.int(e.assigned)} assigned → check availability or reassign the queue.</span></Insight>)
  else if (e.assigned > 0 && e.evaluated < e.assigned * 0.8) pInsights.push(
    <Insight key="behind" level="warn"><span><b>Falling behind:</b> {fmt.int(e.assigned)} assigned vs {fmt.int(e.evaluated)} evaluated ({fmt.pct(e.evaluated / e.assigned)} cleared) → their queue is growing; rebalance if it persists.</span></Insight>)
  if (e.evaluated >= 100 && t.survivalRate > 0 && e.survivalRate < t.survivalRate * 0.5) pInsights.push(
    <Insight key="lowsurv" level="warn"><span><b>Shortlist rate {fmt.pct(e.survivalRate)}</b> - under half the team&apos;s {fmt.pct(t.survivalRate)} → review a sample of their bypasses together (calibration), or their assignments are low-quality sources.</span></Insight>)
  if (e.evaluated > 0 && e.noteRate < 0.9) pInsights.push(
    <Insight key="note" level="warn"><span><b>Note coverage {fmt.pct(e.noteRate)}</b> (target ≥90%) → ask for a note on every non-bypass at minimum.</span></Insight>)
  if (deadShare > 0.08) pInsights.push(
    <Insight key="dead" level="info"><span><b>{fmt.pct(deadShare)} of their throughput is dead links</b> ({fmt.int(e.linkDead)} games) - that&apos;s source quality, not their filtering; volume numbers undercount their effort.</span></Insight>)
  return (
    <>
      <Guide title="Individual - one evaluator's workload, tempo and pick quality"
        read={[
          <span key="1"><b>Chips</b> switch person - every card below re-renders for them.</span>,
          <span key="1b"><b>Most KPIs carry a &quot;team ...&quot; line</b>: the team&apos;s number on the same metric and the gap in %. Green/red only appears past ±5% and only where one direction is genuinely better - Assigned and the per-day mix are gray because more or less is not automatically better, and Recorded, Link dead and the two mix donuts carry no team number at all (assigned work and source quality, not something to rank people on).</span>,
          <span key="2"><b>Activity over time</b>: red (Assigned) above blue (Evaluated) = work piling up on them; blue above red = clearing older queue. Gray = dead links.</span>,
          <span key="3"><b>Bypass / P&amp;B / List_Idea per day</b>: filtering tempo, divided by their active days - compare mix, not just totals.</span>,
          <span key="4"><b>Radar + funnel</b>: a balanced polygon and a funnel that converts = healthy; big volume with a flat funnel = fast but low-signal.</span>,
        ]}
        act={[
          <span key="1"><b>Assigned ≫ Evaluated</b> → reassign part of their queue before it compounds.</span>,
          <span key="2"><b>Survival far below team</b> → calibration session on a sample of their bypasses.</span>,
          <span key="3"><b>List_Idea/day ≈ 0 while others find signal</b> → pair-review; maybe their category slice is dry, maybe the bar is too high.</span>,
        ]} />
      <div className="rp-people">
        {d.evaluators.map((x) => (
          <button key={x.key} className={'rp-chip' + (x.key === e.key ? ' active' : '')} onClick={() => { setSel(x.key); setDaily(false) }}>
            {x.name}{x.title && <span className="rp-chip-title">{x.title}</span>} <span className="rp-chip-n">{x.evaluated || x.recorded}</span>
          </button>
        ))}
        <button className="rp-daily-btn" onClick={() => setDaily(true)}
          title={`Day-by-day numbers for ${e.name}: Bypass · Playtest & Bypass · List_Idea · 5min & 20min videos`}>
          ▦ Daily breakdown
        </button>
      </div>
      {daily && (
        <DailyBreakdown person={e.name} mix={d.dailyMix?.[e.key] || {}} vids={vids} win={d.window} onClose={() => setDaily(false)} />
      )}
      <div className="rp-kpi-row rp-kpi-row-dense">
        <Kpi label="Assigned" value={fmt.int(e.assigned)} sub="games on their plate" tip={TIP.assignedPerson}
          bench={cmp(e.assigned, tb.assigned, fmt.int, 'flat', hasAssigned)} />
        <Kpi label="Evaluated" value={fmt.int(e.evaluated)} hi spark={personSpark.length >= 2 ? personSpark : undefined} tip={TIP.evaluated}
          bench={cmp(e.evaluated, tb.evaluated, fmt.int, 'up')} />
        <Kpi label="Throughput" value={fmt.dec(e.throughput)} sub="games / active day" tip={TIP.perDay('Games evaluated')}
          bench={cmp(e.throughput, tb.throughput, (n) => fmt.dec(n), 'up', hasDays)} />
        <Kpi label="Turnaround" value={fmt.days(e.turnaround)} sub="assign → evaluate" tip={TIP.turnaround}
          bench={cmp(e.turnaround, tb.turnaround, (n) => fmt.days(n), 'down')} />
        <Kpi label="Survival rate" value={fmt.pct(e.survivalRate)} sub={`${fmt.int(e.shortlisted)} of ${fmt.int(e.evaluated)} evaluated`} tip={TIP.survival}
          bench={cmp(e.survivalRate, tb.survivalRate, fmt.pct, 'up', e.evaluated > 0)} />
        <Kpi label="Signal rate" value={fmt.pct(e.signalRate)} sub={`${fmt.int(e.finalPriority)} of ${fmt.int(e.evaluated)} evaluated`} tip={TIP.signal}
          bench={cmp(e.signalRate, tb.signalRate, fmt.pct, 'up', e.evaluated > 0)} />
        <Kpi label="Bypass / day" value={fmt.dec(perDay('Bypass'))} sub={`${fmt.int(e.initialConclusions['Bypass'] || 0)} total`} tip={TIP.perDay('Bypass')}
          bench={cmp(perDay('Bypass'), tb.perDay('Bypass'), (n) => fmt.dec(n), 'flat', hasDays)} />
        <Kpi label="P&B / day" value={fmt.dec(perDay('Playtest & Bypass'))} sub={`${fmt.int(e.initialConclusions['Playtest & Bypass'] || 0)} playtest & bypass`} tip={TIP.perDay('Playtest & Bypass')}
          bench={cmp(perDay('Playtest & Bypass'), tb.perDay('Playtest & Bypass'), (n) => fmt.dec(n), 'flat', hasDays)} />
        <Kpi label="List_Idea / day" value={fmt.dec(perDay('List_Idea'))} sub={`${fmt.int(e.initialConclusions['List_Idea'] || 0)} total`} tip={TIP.perDay('List_Idea')}
          bench={cmp(perDay('List_Idea'), tb.perDay('List_Idea'), (n) => fmt.dec(n), 'flat', hasDays)} />
        <Kpi label="Note coverage" value={fmt.pct(e.noteRate)} sub={`${fmt.int(e.noted)} of ${fmt.int(e.evaluated)} evaluated`} tip={TIP.noteCoverage}
          bench={cmp(e.noteRate, tb.noteRate, fmt.pct, 'up', e.evaluated > 0)} />
        <Kpi label="Link dead" value={fmt.int(e.linkDead)} sub="dead links caught" tip={TIP.linkDead} />
        <Kpi label="Recorded" value={fmt.int(e.recorded)} sub={`${e.rec5} × 5min · ${e.rec20} × 20min`} tip={TIP.recorded} />
      </div>
      {pInsights}
      <div className="rp-grid-2-1">
        <Card label={`${e.name} - performance shape`} note="5 axes, normalized to team best · raw value under each axis" tip={TIP.radar}>
          <Radar axes={[...RADAR_AXES]} series={[{ name: e.name, values: radarValues }]} axisRaw={radarRaw} size={260} />
          <ReadNote>Balanced polygon = well-rounded; spiky = imbalanced. The number under each axis is the real value behind the normalized shape.</ReadNote>
          {weakAxis && (
            <Act>Their shortest axis is <b>{weakAxis}</b> ({rad?.axes[weakAxis] ?? 0} vs 100 for the team best){strongAxis ? <>, their longest is <b>{strongAxis}</b></> : null} → set one concrete target on {weakAxis.toLowerCase()} for the next window rather than asking for &quot;more overall&quot;.</Act>
          )}
        </Card>
        <Card label="Pick funnel" note="assigned → final priority (Priority IV + Insight)"
          tip={<><F>shortlist = initial ≠ bypass · final = Priority IV + Insight</F></>}>
          <Funnel stages={funnelStages} />
          {pWorstStep && (
            <Act>They lose the most at <b>{pWorstStep.from} → {pWorstStep.to}</b> ({fmt.pct(pWorstStep.b / pWorstStep.a)} through, team {fmt.pct(pWorstStep.team)}) → {pWorstStep.b / pWorstStep.a < pWorstStep.team ? 'review that step with them specifically' : 'this step is ahead of the team, so coach elsewhere'}.</Act>
          )}
        </Card>
      </div>
      {ps.length >= 2 && (
        <Card label={`${e.name} - activity over time`} note="assigned · evaluated · link dead per bucket"
          tip={<><F>assigned by assigned_date · evaluated & link dead by evaluate_date</F>Buckets = union of both axes.</>}>
          <LineChart series={actSeries} area />
          <ReadNote>Red above blue = work piling up; blue above red = clearing older queue. Gray = dead links.</ReadNote>
          {psTotals && (
            <Act>{psTotals.assigned > psTotals.evaluated * 1.15
              ? <>They took {fmt.int(psTotals.assigned)} and cleared {fmt.int(psTotals.evaluated)} across these buckets → move {fmt.int(psTotals.assigned - psTotals.evaluated)} games to someone with slack now, not at the end of the window.</>
              : <>They cleared {fmt.int(psTotals.evaluated)} against {fmt.int(psTotals.assigned)} assigned → their queue is keeping up, so they can absorb more of the next push.</>}</Act>
          )}
        </Card>
      )}
      <Card label={`${e.name} - recording queue`} note="videos assigned & recorded in this window · pending always shown"
        tip={<><F>rows where they are the 5min/20min assignee</F>Status is the manual <b>Confirm</b> in the Record tab (record_confirmed_at); the link is whatever the YouTube sync wrote back. They are stamped by different steps, so they can disagree - mismatches are flagged.</>}>
        <VideoQueue vids={vids} />
        {mismatch.total > 0 && (
          <Act>
            {mismatch.pendingWithLink > 0 && <><b>{mismatch.pendingWithLink}</b> row{mismatch.pendingWithLink > 1 ? 's are' : ' is'} still <i>Pending</i> but already {mismatch.pendingWithLink > 1 ? 'have' : 'has'} a YouTube link - the video exists, nobody pressed Confirm in the Record tab. </>}
            {mismatch.recordedNoLink > 0 && <><b>{mismatch.recordedNoLink}</b> row{mismatch.recordedNoLink > 1 ? 's were' : ' was'} confirmed <i>Recorded</i> with no link - either the upload never happened or the YouTube sync missed it. </>}
            → reconcile these before reading the recording numbers; the two states are stamped by different steps and neither corrects the other.
          </Act>
        )}
      </Card>
      <div className="rp-grid-2">
        <Card label="Initial conclusion mix" note="their filtering" tip={<><F>= distribution of their initial_conclusion</F></>}>{initC.length ? <Donut data={initC} /> : <Empty />}</Card>
        <Card label="Final outcomes" note="how their picks were judged" tip={<><F>= final_conclusion on games they shortlisted</F></>}>{finC.length ? <Donut data={finC} /> : <Empty text="None reached final conclusion" />}</Card>
      </div>
    </>
  )
}

/* ---------------- Config: who counts + how the all-rounder is weighted ---------------- */
// Persisted team-wide in app_config (key 'report_config'), not per browser: these
// choices define what the numbers MEAN, so two admins must never read the same tab
// and see different rankings. Saving invalidates the API's bundle cache.
function ConfigTab({ d, onSaved }: { d: Bundle; onSaved: () => void }) {
  const [roster, setRoster] = useState<Array<{ key: string; name: string }>>([])
  const [excluded, setExcluded] = useState<string[]>(d.config.excluded)
  const [weights, setWeights] = useState<Record<AxisName, number>>(d.config.weights)
  const [credibility, setCredibility] = useState(d.config.credibility)
  const [state, setState] = useState<'idle' | 'loading' | 'saving' | 'saved' | 'error'>('loading')

  useEffect(() => {
    let alive = true
    fetch('/api/report/config').then((r) => r.json()).then((j) => {
      if (!alive) return
      setRoster(j.roster || [])
      if (j.config) { setExcluded(j.config.excluded); setWeights(j.config.weights); setCredibility(j.config.credibility) }
      setState('idle')
    }).catch(() => alive && setState('error'))
    return () => { alive = false }
  }, [])

  const total = ALL_ROUNDER_AXES.reduce((s, a) => s + (weights[a] || 0), 0) || 1
  const dirty = JSON.stringify({ excluded: [...excluded].sort(), weights, credibility })
    !== JSON.stringify({ excluded: [...d.config.excluded].sort(), weights: d.config.weights, credibility: d.config.credibility })

  const save = async () => {
    setState('saving')
    try {
      const res = await fetch('/api/report/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ excluded, weights, credibility }),
      })
      if (!res.ok) throw new Error(String(res.status))
      setState('saved')
      onSaved()
    } catch { setState('error') }
  }
  const toggle = (k: string) => setExcluded((x) => x.includes(k) ? x.filter((v) => v !== k) : [...x, k])
  const included = roster.filter((r) => !excluded.includes(r.key)).length

  return (
    <>
      <Guide title="Config - who is measured, and what &quot;good&quot; weighs"
        read={[
          <span key="1"><b>Included evaluators</b>: unticking someone removes them from every stat, chart and denominator on all tabs - not just the lists. Use it for people who are on the roster but should not be measured this cycle.</span>,
          <span key="2"><b>All-rounder weights</b>: the relative pull of each axis. Numbers are relative, so 40/15/15/15/15 and 8/3/3/3/3 behave the same - the share next to each row is what actually applies.</span>,
          <span key="3"><b>Credibility</b> scales every axis except Volume by min(1, their games ÷ median team games), so quality earned on a small sample counts proportionally.</span>,
        ]}
        act={[
          <span key="1">Changing weights <b>re-ranks the All-rounder board and the Rank movement chart</b> for everyone - agree on it with the team before saving.</span>,
          <span key="2">Untick a recorder-only or trial account instead of mentally discounting them every time you read the Leaderboard.</span>,
          <span key="3">Turn credibility off only when comparing people with similar workloads; with it off, a 30-game sample ranks on equal footing with a 700-game one.</span>,
        ]} />
      <div className="rp-grid-2-1">
        <Card label="Included evaluators" note={`${included} of ${roster.length} counted in every stat`}
          tip={<><F>roster = evaluator_roster (list_type = &apos;initial&apos;)</F>Unticking removes the person from the report only. It does not change assignment, the roster itself, or their access.</>}>
          {state === 'loading' ? <Empty text="Loading roster…" /> : roster.length === 0 ? <Empty text="No initial evaluators on the roster" /> : (
            <div className="rp-cfg-list">
              {roster.map((r) => {
                const on = !excluded.includes(r.key)
                const games = d.evaluators.find((e) => e.key === r.key)?.evaluated ?? 0
                return (
                  <label key={r.key} className={'rp-cfg-row' + (on ? '' : ' off')}>
                    <input type="checkbox" checked={on} onChange={() => toggle(r.key)} />
                    <span className="rp-cfg-name">{r.name}</span>
                    <span className="rp-cfg-meta">{fmt.int(games)} games this window</span>
                  </label>
                )
              })}
            </div>
          )}
          <ReadNote>Excluding someone changes team totals and every rate that divides by them - the numbers on other tabs will move.</ReadNote>
        </Card>
        <Card label="All-rounder weights" note="relative pull of each axis"
          tip={TIP.allRounder}>
          <div className="rp-cfg-list">
            {ALL_ROUNDER_AXES.map((a) => (
              <div key={a} className="rp-cfg-w">
                <span className="rp-cfg-name">{a}</span>
                <input type="range" min={0} max={100} step={5} value={weights[a] ?? 0}
                  onChange={(e2) => setWeights((w) => ({ ...w, [a]: Number(e2.target.value) }))} />
                <span className="rp-cfg-share">{Math.round(((weights[a] || 0) / total) * 100)}%</span>
              </div>
            ))}
          </div>
          <label className="rp-cfg-row" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={credibility} onChange={() => setCredibility((v) => !v)} />
            <span className="rp-cfg-name">Credibility discount</span>
            <span className="rp-cfg-meta">scale non-Volume axes by sample size</span>
          </label>
          <div className="rp-cfg-actions">
            <button className="btn btn-sm btn-primary" onClick={save} disabled={!dirty || state === 'saving'}>
              {state === 'saving' ? 'Saving…' : 'Save settings'}
            </button>
            <button className="btn btn-sm" onClick={() => { setWeights(DEFAULT_REPORT_CONFIG.weights); setCredibility(true) }}>Reset to defaults</button>
            <span className="rp-cfg-state">
              {state === 'error' ? <b style={{ color: 'var(--bad)' }}>Save failed</b>
                : state === 'saved' && !dirty ? 'Saved - all tabs recomputed'
                : dirty ? 'Unsaved changes' : 'Up to date'}
            </span>
          </div>
        </Card>
      </div>
      <Card label="Preview - all-rounder with these weights" note="live, before saving"
        tip={<><F>same formula as the Leaderboard board, using the sliders above</F>Recomputed as you drag; nothing is stored until you press Save.</>}>
        <RankBars color={CAT[4]} format={(v) => fmt.dec(v, 0)}
          rows={d.radar.filter((r) => !excluded.includes(r.key)).map((r) => {
            const evc = d.evaluators.find((x) => x.key === r.key)?.evaluated || 0
            const vols = d.evaluators.filter((x) => x.evaluated > 0 && !excluded.includes(x.key)).map((x) => x.evaluated).sort((a, b) => a - b)
            const med = vols.length ? vols[Math.floor(vols.length / 2)] : 0
            const cred = credibility ? (med > 0 ? Math.min(1, evc / med) : 1) : 1
            return { name: r.name, value: allRounderScore(r.axes, weights, cred), sub: `${fmt.int(evc)} games` }
          }).sort((a, b) => b.value - a.value)} />
        <ReadNote>Axis values still come from the current window and are normalized to the team best, so this preview moves when the filter bar changes too.</ReadNote>
      </Card>
    </>
  )
}

/* ---------------- recording queue table (5 rows tall, scrolls for more) ---------------- */
// The queue can run to dozens of rows and used to push every card below it off the
// screen. It now shows five and grows as you scroll: the data is already in the
// bundle, so "loading" is just rendering the next slice - no extra requests.
const VQ_PAGE = 5
function VideoQueue({ vids }: { vids: Bundle['videos'][string] }) {
  const [shown, setShown] = useState(VQ_PAGE)
  const boxRef = useRef<HTMLDivElement>(null)
  // reset the window when the selected person changes
  useEffect(() => { setShown(VQ_PAGE); if (boxRef.current) boxRef.current.scrollTop = 0 }, [vids])
  if (!vids.length) return <Empty text="No recording assignments in this window" />
  const onScroll = () => {
    const el = boxRef.current
    if (!el) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) setShown((n) => Math.min(n + VQ_PAGE, vids.length))
  }
  const rows = vids.slice(0, shown)
  return (
    <>
      <div className="rp-vid-wrap rp-vid-scroll" ref={boxRef} onScroll={onScroll}>
        <table className="rp-vidtable">
          <thead><tr><th>#</th><th>Game</th><th>Slot</th><th>Batch</th><th>Status</th><th>Link</th></tr></thead>
          <tbody>
            {rows.map((v, i) => {
              // flag the two states that disagree, so a wrong number is visible in place
              const odd = (!v.recordedOn && v.youtube) ? 'Uploaded but never confirmed'
                : (v.recordedOn && !v.youtube) ? 'Confirmed but no link' : null
              return (
                <tr key={`${v.gameId}-${v.slot}`} className={odd ? 'rp-vid-odd' : undefined}>
                  <td className="rp-vid-i">{i + 1}</td>
                  <td className="rp-vid-game">{v.title || v.gameId}{v.os && <span className="rp-vid-os"> · {v.os}</span>}
                    {odd && <span className="rp-vid-flag" title={odd}>!</span>}</td>
                  <td>{v.slot}</td>
                  <td>{v.batch || '-'}</td>
                  <td>{v.recordedOn
                    ? <span className="rp-vid-done">Recorded {v.recordedOn.split('-').reverse().slice(0, 2).map(Number).join('/')}</span>
                    : <span className="rp-vid-pending">Pending</span>}</td>
                  <td>{v.youtube ? <a href={v.youtube} target="_blank" rel="noreferrer">YouTube ↗</a> : '-'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="rp-vid-foot">
        {shown < vids.length ? (
          <>
            Showing {shown} of {vids.length} - scroll the list for more
            {/* the box is exactly five rows tall, so when exactly five are rendered
                there is nothing to scroll; this keeps the list reachable either way */}
            <button className="rp-vid-more" onClick={() => setShown((n) => Math.min(n + VQ_PAGE, vids.length))}>
              show {Math.min(VQ_PAGE, vids.length - shown)} more
            </button>
          </>
        ) : <>All {vids.length} rows shown</>}
      </div>
    </>
  )
}

/* ---------------- Pipeline (game flow: new vs evaluated vs backlog) ---------------- */
function Pipeline({ d }: { d: Bundle }) {
  const p = d.pipeline
  if (!p) return <div className="card"><Empty text="Pipeline needs a time axis - switch View by to Week, Month, Quarter or Custom (a batch has no date range)." /></div>
  if (!p.series.length) return <div className="card"><Empty text="No pipeline activity in this window." /></div>
  const net = p.window.newGames - p.window.evaluated
  const pts = (f: (r: NonNullable<Bundle['pipeline']>['series'][number]) => number) =>
    p.series.map((r) => ({ label: r.label, value: f(r) }))
  const flowSeries = [
    { name: 'New games in', color: CAT[0], points: pts((r) => r.newGames) },
    { name: 'Evaluated', color: CAT[2], points: pts((r) => r.evaluated) },
    // own axis: headcount is single digits next to counts in the hundreds
    { name: 'Evaluators active', color: CAT[4], axis: 'right' as const, dashed: true, points: pts((r) => r.people) },
  ]
  const backlogSeries = [{ name: 'Backlog', color: CAT[3], points: pts((r) => r.backlog) }]
  const backlogSpark = p.series.map((r) => r.backlog)
  // pace estimate: buckets to clear the current stock at this window's clearing rate
  const perBucket = p.series.length ? p.window.evaluated / p.series.length : 0
  const pipeInsights: React.ReactNode[] = []
  if (net > 0) pipeInsights.push(
    <Insight key="grow" level="warn"><span><b>Backlog grew by {fmt.int(net)}</b> this window ({fmt.int(p.window.newGames)} in vs {fmt.int(p.window.evaluated)} evaluated) → throttle intake (push filters) or add evaluation capacity.</span></Insight>)
  if (net < 0) pipeInsights.push(
    <Insight key="shrink" level="good"><span><b>Backlog shrank by {fmt.int(-net)}</b> this window - evaluation is outpacing intake.</span></Insight>)
  const unitName = d.bucketUnit === 'day' ? 'day' : d.bucketUnit === 'week' ? 'week' : 'month'
  const avgPeople = p.series.length ? p.series.reduce((s, r) => s + r.people, 0) / p.series.length : 0
  if (perBucket > 0 && p.current.backlog > 0) pipeInsights.push(
    <Insight key="pace" level="info"><span>
      <b>Time to clear ≈ {fmt.dec(p.current.backlog / perBucket, 1)} {unitName}s</b> - hypothetical: assumes intake stops today, so read it as &ldquo;the stock weighs this many {unitName}s of work&rdquo;, not as a forecast.
      <F>pace = {fmt.int(p.window.evaluated)} evaluated ÷ {p.series.length} {unitName}{p.series.length > 1 ? 's' : ''} in window = {fmt.int(perBucket)}/{unitName}</F>
      <F>time to clear = {fmt.int(p.current.backlog)} backlog ÷ {fmt.int(perBucket)} = {fmt.dec(p.current.backlog / perBucket, 1)} {unitName}s</F>
      {avgPeople > 0 && <>That pace came from ~{fmt.dec(avgPeople, 1)} evaluators active per {unitName} (~{fmt.int(perBucket / avgPeople)} games each). </>}
      The last {unitName} is usually still in progress, which drags the pace down - the estimate is conservative.
    </span></Insight>)
  const oldStock = p.current.age.a2 + p.current.age.a3
  const clearedTot = p.cleared.reduce((s, r) => s + ageTotal(r), 0)
  const clearedOld = p.cleared.reduce((s, r) => s + r.a2 + r.a3, 0)
  // bucket avgAge is per-bucket, so weight it by that bucket's cleared count
  const avgWait = clearedTot ? p.cleared.reduce((s, r) => s + r.avgAge * ageTotal(r), 0) / clearedTot : null
  if (p.current.backlog > 0) pipeInsights.push(
    <Insight key="age" level={oldStock / p.current.backlog > 0.5 ? 'warn' : 'info'}><span>
      <b>{fmt.pct(oldStock / p.current.backlog)} of the stock is 8 days or older</b> ({fmt.int(oldStock)} of {fmt.int(p.current.backlog)}), while <b>{fmt.pct(clearedTot ? clearedOld / clearedTot : 0)}</b> of what the team cleared this window was that old.
      {clearedTot > 0 && clearedOld / clearedTot < oldStock / p.current.backlog
        ? ' Clearing skews fresher than the stock → the old tail is growing; pull aged games to the front of the queue.'
        : ' Clearing is at least as old as the stock → the tail is being worked down.'}
    </span></Insight>)
  return (
    <>
      <Guide title="Pipeline - is the game stock flowing or piling up?"
        read={[
          <span key="1"><b>Backlog now</b> = games pushed but not yet evaluated - an absolute stock, unaffected by the filter window.</span>,
          <span key="2"><b>Flow - in vs out</b>: blue above orange = intake outpacing evaluation; the crossing point is break-even.</span>,
          <span key="3"><b>Backlog over time</b>: the slope is the story - how fast the stock grows or burns, cumulative over all history.</span>,
        ]}
        act={[
          <span key="1"><b>New games above Evaluated for 2+ buckets</b> → tighten push eligibility or add capacity before the stock compounds.</span>,
          <span key="2"><b>Backlog flat while evaluators are at capacity</b> → the pipeline is balanced; change nothing.</span>,
          <span key="3"><b>Backlog spikes right after a push</b> → stagger pushes across the week instead of one bulk drop.</span>,
        ]} />
      <div className="rp-kpi-row">
        <Kpi label="Backlog now" value={fmt.int(p.current.backlog)} sub="pushed, not yet evaluated" hi spark={backlogSpark.length >= 2 ? backlogSpark : undefined} sparkColor={CAT[3]} tip={TIP.backlog} />
        <Kpi label="New games" value={fmt.int(p.window.newGames)} sub={`entered pipeline · ${d.window.label}`} tip={<>Games inserted into the evaluation pipeline in this window (by import date). Counts every game - including Shortcut-attributed ones - because this tab measures games, not people.</>} />
        <Kpi label="Evaluated" value={fmt.int(p.window.evaluated)} sub={`cleared · ${d.window.label}`} tip={TIP.evaluated} />
        <Kpi label="Net change" value={(net > 0 ? '+' : '') + fmt.int(net)} sub={net > 0 ? 'backlog growing' : net < 0 ? 'backlog shrinking' : 'flat'} tip={TIP.netChange} />
        <Kpi label="Aged stock" value={fmt.int(oldStock)} sub={`${fmt.pct(p.current.backlog ? oldStock / p.current.backlog : 0)} of backlog is 8d+`}
          tip={<><F>= backlog rows where today − import day &gt; 7</F>The tail. Bands: 0–3d {fmt.int(p.current.age.a0)} · 4–7d {fmt.int(p.current.age.a1)} · 8–14d {fmt.int(p.current.age.a2)} · 15d+ {fmt.int(p.current.age.a3)}.</>} />
        <Kpi label="Avg wait" value={avgWait == null ? '-' : `${fmt.dec(avgWait, 1)}d`} sub={`import → evaluate · ${d.window.label}`}
          tip={<><F>= Σ (evaluate day − import day) ÷ games evaluated, in window</F>How long a game sits before someone evaluates it. Rising = queue discipline slipping.</>} />
      </div>
      {pipeInsights}
      <Card label="Flow - in vs out" note="new games in, games evaluated, and people working, per bucket"
        tip={<><F>in = count(imported_at) · out = count(evaluate_date), per bucket</F><F>evaluators active = distinct rostered evaluators with ≥1 evaluation that bucket</F>Flow counts games (Shortcut rows included); headcount counts rostered people only, on its own right-hand axis.</>}>
        <LineChart series={flowSeries} area rightLabel="people" rightFormat={(v) => fmt.int(v)} />
        <ReadNote><b>New games in</b> above <b>Evaluated</b> = falling behind; crossing = break-even. Compare the dashed <b>Evaluators active</b> line: output falling while headcount holds is a throughput problem, both falling together is just coverage.</ReadNote>
        <Act>{net > 0
          ? <>Intake beat output by {fmt.int(net)} games this window → either cut the next push by that much or add a {unitName} of capacity; the gap does not close on its own.</>
          : <>Output beat intake by {fmt.int(Math.abs(net))} games → the team has slack, so raise push eligibility rather than let evaluators run dry.</>}</Act>
      </Card>
      <Card label="Backlog over time" note="games pushed but not yet evaluated, end of each bucket"
        tip={<><F>backlog = Σ in − Σ out, cumulative over all history</F>Rows that arrived already evaluated (backfills) leave the stock on their import day.</>}>
        {p.series.length >= 2 ? <LineChart series={backlogSeries} area /> : <Empty text="Need more than one period" />}
        <ReadNote>Cumulative stock (not reset per window) - the slope is the pace.</ReadNote>
        {perBucket > 0 && p.current.backlog > 0 && (
          <Act>At this window&apos;s pace the stock is {fmt.dec(p.current.backlog / perBucket, 1)} {unitName}s of work → {p.current.backlog / perBucket > 5 ? 'stop pushing until it is under 5, or the aged tail will keep growing' : 'the stock is within a working week: keep the current push rate'}.</Act>
        )}
      </Card>
      <div className="rp-grid-2">
        <Card label="Backlog by age" note="how old the games still waiting are, end of each bucket"
          tip={<><F>age = bucket end day − import day, for games still unevaluated</F>Same stock as &ldquo;Backlog over time&rdquo;, split into bands instead of one total.</>}>
          {p.aging.length ? <StackedBars rows={p.aging.map((r) => ({ name: r.label, parts: ageParts(r) }))} keys={AGE_KEYS} colors={AGE_COLORS} unit="that bucket's" /> : <Empty />}
          <ReadNote>Red/orange growing while the total is flat = the tail is rotting, not clearing.</ReadNote>
          {p.current.backlog > 0 && (
            <Act>{fmt.int(p.current.age.a3)} games have waited 15+ days → pull those to the front of the next assign run; they are the ones whose store data goes stale.</Act>
          )}
        </Card>
        <Card label="Cleared - old vs new" note="age of each game at the moment it was evaluated"
          tip={<><F>age = evaluate day − import day, for games evaluated in the bucket</F>Shows whether the team eats fresh pushes or works the aged queue.</>}>
          {p.cleared.length ? <StackedBars rows={p.cleared.map((r) => ({ name: r.label, parts: ageParts(r) }))} keys={AGE_KEYS} colors={AGE_COLORS} unit="that bucket's" /> : <Empty />}
          <ReadNote>All green = only fresh pushes are being eaten; aged games never leave the queue.</ReadNote>
          {clearedTot > 0 && p.current.backlog > 0 && (
            <Act>{clearedOld / clearedTot < oldStock / p.current.backlog
              ? <>Clearing skews fresher ({fmt.pct(clearedOld / clearedTot)} old) than the stock ({fmt.pct(oldStock / p.current.backlog)} old) → assign aged games explicitly next run, or the tail never moves.</>
              : <>Clearing is at least as old as the stock → the current assign order is already working the tail down; no change needed.</>}</Act>
          )}
        </Card>
      </div>
    </>
  )
}

/* ---------------- shared bits ---------------- */
function band(v: number, warn: number, good: number): 'good' | 'warn' | 'bad' {
  return v >= good ? 'good' : v >= warn ? 'warn' : 'bad'
}
function Card({ label, note, tip, children }: { label: string; note?: string; tip?: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open])
  const head = (expanded: boolean) => (
    <div className="card-head">
      <span className="card-label">{label}{tip && <InfoTip title={label}>{tip}</InfoTip>}</span>
      <span className="card-head-right">
        {note && <span className="card-note" title={note}>{note}</span>}
        <button className="rp-expand" onClick={() => setOpen(!expanded)}
          aria-label={expanded ? 'Close' : 'Expand'} title={expanded ? 'Close (Esc)' : 'Expand'}>
          {expanded ? '✕' : '⤢'}
        </button>
      </span>
    </div>
  )
  return (
    <>
      <div className="card">
        {head(false)}
        {children}
      </div>
      {open && (
        <div className="rp-modal-backdrop" onClick={() => setOpen(false)}>
          <div className="rp-modal card" onClick={(e) => e.stopPropagation()}>
            {head(true)}
            {children}
          </div>
        </div>
      )}
    </>
  )
}

/* Per-tab usage guide: what each element means + what to do when it looks off.
   Modeled after "How to read / Actions" review-dashboard panels. */
function Guide({ title, read, act }: { title: string; read: React.ReactNode[]; act: React.ReactNode[] }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="card rp-guide">
      <div className="rp-guide-head">
        <span className="rp-guide-kicker">How to use</span>
        <span className="rp-guide-title">{title}</span>
        <button className="rp-guide-toggle" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</button>
      </div>
      {open && (
        <>
          <div className="read">
            <div className="rp-guide-col-title read">◎ How to read</div>
            <ul>{read.map((r, i) => <li key={i}>{r}</li>)}</ul>
          </div>
          <div className="act">
            <div className="rp-guide-col-title act">⚡ Actions</div>
            <ul>{act.map((a, i) => <li key={i}>{a}</li>)}</ul>
          </div>
        </>
      )}
    </div>
  )
}
function ReadNote({ children }: { children: React.ReactNode }) { return <p className="rp-readnote">{children}</p> }
// Per-chart actionable line: what THIS window's data says to do, computed from the
// numbers on screen. ReadNote explains how to read a chart in general; Act names the
// move. Charts that are pure counts (donuts, rank boards) get no Act - there is
// nothing to decide from a tally alone.
function Act({ children }: { children: React.ReactNode }) { return <p className="rp-act"><span className="rp-act-tag">Act</span>{children}</p> }
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
