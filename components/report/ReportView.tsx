'use client'
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ALL_ROUNDER_AXES, allRounderScore, DEFAULT_REPORT_CONFIG, type AxisName, type ReportConfig } from '@/lib/report-config'
import {
  Kpi, RankBars, Heatmap, Funnel, Radar, HealthBars, StackedBars, ColumnChart, DivergingBars, QueueBars,
  LineChart, Scatter, SortTable, Empty, fmt, CAT, InfoTip, conclusionColor,
  type Bench, type SortCol,
} from '@/components/report/charts'
import type { BenchStats } from '@/lib/report'
import { isBucket } from '@/lib/buckets'

type View = 'week' | 'month' | 'quarter' | 'year' | 'batch' | 'custom'
const RADAR_AXES = ['Volume', 'Consistency', 'Signal', 'Survival', 'Recording'] as const
// The axis keys above have to stay 'Signal'/'Survival' - they index the `axes` map the
// API sends and the all-rounder weights in lib/report-config.ts. What the reader sees
// is the lexicon's own word for each: this is the ONLY place that translation happens.
const AXIS_LABEL: Record<string, string> = {
  Volume: 'Volume', Consistency: 'Consistency', Signal: 'Hit rate', Survival: 'Shortlist rate', Recording: 'Recording',
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const pad2 = (n: number) => String(n).padStart(2, '0')
// today in the report timezone (Asia/Ho_Chi_Minh, same as the server), as YYYY-MM-DD
function vnTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date())
}
function vnToday(): { y: number; m: number; d: number } {
  const [y, m, d] = vnTodayIso().split('-').map(Number)
  return { y, m, d }
}
// "8–14 Sep" for the range chip. `to` is exclusive, so the last day shown is to−1.
// Empty when the window is open-ended (all time / batch), where a date range would be
// a guess.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const addDays = (iso: string, n: number) => {
  const dt = new Date(`${iso}T00:00:00Z`)
  dt.setUTCDate(dt.getUTCDate() + n)
  return dt.toISOString().slice(0, 10)
}
function rangeText(from?: string | null, to?: string | null): string {
  if (!from || !to) return ''
  const a = new Date(`${from}T00:00:00Z`)
  const b = new Date(`${to}T00:00:00Z`)
  b.setUTCDate(b.getUTCDate() - 1)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return ''
  const day = (dt: Date) => dt.getUTCDate()
  const mon = (dt: Date) => MON[dt.getUTCMonth()]
  if (a.getTime() === b.getTime()) return `${day(a)} ${mon(a)}`
  return a.getUTCMonth() === b.getUTCMonth()
    ? `${day(a)}–${day(b)} ${mon(b)}`
    : `${day(a)} ${mon(a)} – ${day(b)} ${mon(b)}`
}
// the bucket key for "now" in a given view - each view defaults to its current period
// The noun for the SELECTION - as opposed to `bucketUnit` / `activityUnit`, which name
// a chart's cells. All-time and batch windows carry no from/to and leave `view` at
// whatever the segmented control last held, so reading `view` alone printed "20 games
// this week" across an all-time report.
// When a game has been on the SAME desk too long. Defined once because three tabs read
// it - Overview names the people holding stale work, the Leaderboard flags their bars,
// and Individual fires its own backlog action - and three copies of a threshold is three
// chances for the tabs to flag different people off the same data.
//
// Both gates always, never one: 40 stale games is noise on a team judging thousands a
// month, and 90% of a ten-game pile is still nine games. The day count itself is not
// here - it is the Rescue panel's admin-editable `app_config` threshold, carried on
// the payload as `staleDays`, so the report and Team Ops → Rescue never flag different
// people off two different definitions of "stale".
const STALE = { min: 60, share: 0.25 }

// The one place `d.staleDays` is read. Everything downstream calls this rather than
// touching the field directly, so a payload that omits it (an old fixture, a route
// that has not caught up) degrades to a number instead of `undefined` silently
// propagating into every sentence that names it.
//
// The fallback is 14 because that is `DEFAULT_RESCUE_CONFIG.staleDays` - the value the
// Rescue panel itself runs on when app_config has nothing saved, so the two screens
// still agree. It is deliberately NOT a chart age band (0-3 / 4-7 / 8-14 / 15+): a band
// is a ruler and `staleDays` is a threshold, and neither is ever derived from the other.
function staleDays(d: Bundle): number {
  return d.staleDays ?? 14
}

/* The Category segment this report is being read on, as a query parameter for a Team
   Ops link. Only when it names one bucket: on "All" there is no single scan to point
   the panel at, so nothing is passed and the panel keeps its own default rather than
   opening on a genre the sentence never mentioned.

   A category selects a VIEW, which is why it may travel in a URL at all. No Rescue
   SETTING ever may: POST /api/operations/rescue persists whatever config it is handed,
   so a link carrying `staleDays` would rewrite the admin's saved thresholds by being
   clicked. */
function catParam(d: Bundle): string {
  return isBucket(d.category) ? `&cat=${d.category}` : ''
}

function windowNoun(d: Bundle): string {
  if (d.window.batch) return 'batch'
  if (!d.window.from) return 'window'
  return d.view === 'week' ? 'week' : d.view === 'month' ? 'month'
    : d.view === 'quarter' ? 'quarter' : d.view === 'year' ? 'year' : 'window'
}

function currentKey(view: View): string {
  const { y, m, d } = vnToday()
  if (view === 'month') return `${y}-${pad2(m)}`
  if (view === 'quarter') return `${y}-Q${Math.ceil(m / 3)}`
  if (view === 'year') return `${y}`
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
  if (view === 'year') return `${key} · 1/1 – 31/12`
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
const F = ({ children }: { children: React.ReactNode }) => <span className="rp-formula">{children}</span>
const TIP = {
  assigned: <><F>= count(games first assigned in window)</F>Counts a game the first time it reaches anyone. A reassign or a handover moves a game between people, so it does not add to this.</>,
  assignedPerson: <><F>= count(games assigned to this person in window)</F>Includes games received via reassign/handover, so the column does not add up to the team Assigned total.</>,
  evaluated: <><F>= count(initial_conclusion ≠ ∅, ≠ Link_dead)</F>Counted on the day the evaluation was saved.</>,
  gppd: <><F>= Σ evaluated ÷ calendar days in the window</F>How fast the backlog actually drains, which is the number “days to clear” is computed from. Calendar days, not working days: the backlog does not pause at the weekend. The per-evaluator version of this - games on a day someone worked - is on the Leaderboard, where every row is a person.</>,
  turnaround: <><F>= avg( evaluate date − assigned date )</F>How long a game sits with someone before they judge it. When it climbs, the backlog grows.</>,
  survival: <><F>= shortlist ÷ evaluated</F>Shortlist means the initial conclusion was anything other than bypass. Both halves count the same games, the ones judged in this window, so the size of the backlog behind them leaves the rate alone.</>,
  signal: <><F>= (Priority IV + Insight) ÷ evaluated</F>How much of what they judged turned into a real pick. It usually sits under 1%, so the trend matters more than the number. A window that just opened reads low, because a moderator stamps the final conclusion days after the evaluation.</>,
  finalPriority: <><F>= count(final ∈ {'{'}Priority IV, Insight{'}'})</F>Priority V is left out, by the team&apos;s own convention.</>,
  noteCoverage: <><F>= noted ÷ evaluated</F>The team&apos;s rule is 90%. A conclusion with no note cannot be audited afterwards.</>,
  linkDead: <><F>= count(initial_conclusion = Link_dead)</F>Housekeeping. It measures the state of the source links, so it says nothing about how well someone picks.</>,
  perDay: (what: string) => <><F>= {what} ÷ active days</F>An active day is a day with at least one evaluation, so a four-day week is not read as a slow one.</>,
  backlog: <><F>= count(no evaluate date AND no conclusion)</F>Every game still waiting, across all history. The window filter does not reach it. Games that arrived already evaluated never enter the stock.</>,
  personBacklog: <><F>= count(backlog games assigned to this person)</F>Their slice of the same total the Backlog number on Overview counts, so every evaluator&apos;s slice adds up to it. The window filter does not reach it - this is a snapshot of right now.<br />Age is counted from the day the game was <b>assigned to them</b>, not from when it was imported the way Overview&apos;s &ldquo;Backlog by age&rdquo; counts it. The question here is how long it has been on this desk, and a reassign or handover restarts that clock on purpose - the same clock &ldquo;Days waiting&rdquo; uses. So the two agree on the total and can differ on the age split.</>,
  recorded: <><F>= count(5min) + count(20min)</F>Credited to whoever actually uploaded the video, taken from the upload sheet.</>,
  radar: <><F>axis = value ÷ team best × 100</F>Volume = games evaluated · Consistency = active days ÷ weekdays (weekend counts as bonus) · Hit rate & Shortlist rate = rates ÷ evaluated · Recording = videos. Every axis normalized to the best person.</>,
  // Named "all-rounder score" until the redesign: one word of jargon that had to be
  // translated before the number could be read. The formula is unchanged.
  overall: <><F>= 0.4×Volume + 0.6×avg(Consistency, Hit rate, Shortlist rate, Recording)×sample weight</F>How much someone did, at 40%, and how well, at 60%. The quality half is scaled by sample weight, so 35 games on a good run cannot outrank 700 steady ones. Volume itself is never discounted. On each axis the team&apos;s best scores 100.</>,
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
  // The trend charts' x axis. The heatmap is drawn on a deliberately finer grain,
  // which is `activityUnit` - the two are not interchangeable, and naming the cells
  // of one with the noun of the other is how "13 of 13 weeks" got printed over a grid
  // of 13 days.
  bucketUnit: 'day' | 'week' | 'month'
  activityUnit: 'day' | 'week' | 'month'
  options: { week: Opt[]; month: Opt[]; quarter: Opt[]; year: Opt[]; batch: Opt[] }
  teamTotals: { evaluators: number; totalAssigned: number; totalEvaluated: number; avgThroughput: number; personDayThroughput: number; avgTurnaround: number | null; signalRate: number; survivalRate: number; totalRecorded: number; linkDead: number; noteRate: number }
  // Team benchmarks for the Individual "vs team" lines. Computed server-side (see
  // lib/report.ts) because an evaluator's bundle carries no other person's row.
  bench: BenchStats
  // What the team did in the 90 days BEFORE this window - the reference the Team
  // health gauges are read against. Null when the window has no "before" (all-time,
  // batch) or nothing was evaluated then.
  baseline: null | { from: string; to: string; days: number; evaluated: number; survivalRate: number; signalRate: number; noteRate: number; personDayThroughput: number }
  // The PREVIOUS week/month/quarter, on the grain the filter bar is set to. This is
  // what the KPI row's comparison badges read against, so "+12%" on a month view
  // means "against last month" and not against a 90-day average nobody selected.
  // Null on all-time and batch, which have no "the one before".
  //
  // `activeDays` is optional: `refQuery` (see app/api/report/route.ts) only spreads it
  // in for a SCOPED request (one evaluator's own report), reusing the same active-day
  // expression the per-evaluator `active_days` column uses, filtered to that person.
  // An unscoped (manager) request's `prev` never carries it - there is no single
  // person to count - so Individual's `rhythm` act (a contractor's own active-day
  // count against their own last window) still has nothing to read there and, per
  // Law 6 (no fallback act), simply never fires for a manager's view rather than
  // comparing this person's days against the team's and calling it "their".
  prev: null | { from: string; to: string; label: string; evaluated: number; survivalRate: number; signalRate: number; personDayThroughput: number; activeDays?: number }
  // The waiting pile as it stands RIGHT NOW: every pushed game with no evaluation yet,
  // across all history, in the selected category. The one figure on this tab no window
  // reaches - which is exactly why it is not inside `pipeline`, whose contents all need
  // a time axis and are therefore null on batch view.
  stock: { backlog: number; age: { a0: number; a1: number; a2: number; a3: number } }
  // Who the unevaluated backlog is sitting with, as of NOW (never window-sliced - it
  // is the same stock as Overview's Backlog KPI and sums to the same total). Age
  // bands are days since `assigned_date`, i.e. how long THIS person has held it.
  backlogBy: Array<{ key: string; name: string; n: number; a0: number; a1: number; a2: number; a3: number; oldest: number; stale: number }>
  // The Rescue panel's own threshold (app_config, admin-editable, default 14) - the
  // ONE definition of "stale" on this payload. `backlogBy[].stale` is computed
  // server-side against this same number, never against the age bands above.
  staleDays: number
  // That person's own games past `staleDays`, for an evaluator reading their own
  // report. Null when the request is not scoped to one evaluator (an admin's view).
  selfStale: number | null
  // The Rescue panel's own scan, carried here so the Report can point at the same
  // numbers Team Ops → Rescue would move. Null for a non-manager.
  rescue: null | {
    staleDays: number
    sources: Array<{ name: string; stale: number; movable: number }>
    receivers: Array<{ name: string; pending: number; evaluatedRecent: number }>
    movableTotal: number
  }
  // Per person, per bucket: what they FINISHED (by how old it was when they judged it)
  // against what only got OLDER on their desk. Both sides count events, so both are
  // addable across buckets - see the card's tooltip. Clock is the assign date.
  personMoves: Record<string, Array<{
    key: string; label: string
    cleared: [number, number, number, number]
    aged: [number, number, number]
  }>>
  // set for an evaluator reading their own report; null for admins
  self: string | null
  funnel: { assigned: number; evaluated: number; shortlisted: number; priorityIV: number; insight: number; finalPriority: number }
  initialConclusions: Cnt[]; finalConclusions: Cnt[]
  series: Array<{ label: string; value: number; people: number }>
  metricSeries: Array<{ key: string; label: string; volume: number; assigned: number; evaluated: number; shortlisted: number; priorityIV: number; insight: number; finalPriority: number; personDays: number; signalRate: number; survivalRate: number }>
  heatmap: { periods: Array<{ key: string; label: string }>; rows: Array<{ name: string; cells: Record<string, number> }> }
  config: ReportConfig
  personSeries: Record<string, Array<{ key: string; label: string; assigned: number; evaluated: number; shortlisted: number; linkDead: number }>>
  videos: Record<string, Array<{ gameId: string; title: string | null; os: string | null; slot: string; batch: string | null; recordedOn: string | null; confirmedOn: string | null; youtube: string | null }>>
  // person → 'YYYY-MM-DD' → initial conclusion → count (Link_dead excluded)
  dailyMix: Record<string, Record<string, Record<string, number>>>
  evaluators: Ev[]
  radar: Array<{ key: string; name: string; axes: Record<string, number> }>
  pipeline: null | {
    series: Array<{ key: string; label: string; newGames: number; evaluated: number; backlog: number; people: number }>
    current: { backlog: number; age: { a0: number; a1: number; a2: number; a3: number } }
    window: { newGames: number; evaluated: number }
    // per bucket: the stock's age bands, plus how long that stock had been waiting
    aging: Array<AgeRow & { waiting: number; medAge: number; p90Age: number; maxAge: number }>
    cleared: Array<AgeRow & { avgAge: number }>
    // intake split by importer (game_info.type) per bucket, + each source's outcome
    sources: Array<{ key: string; label: string; parts: Record<string, number> }>
    sourceYield: Array<{ src: string; n: number; evaluated: number; shortlisted: number; finalPriority: number }>
    // games that crossed into an older band during each bucket, by the band they
    // crossed INTO - the mirror of `cleared`, which counts what was finished
    aged: Array<{ key: string; label: string; parts: Record<string, number> }>
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
const ageKeysSum = (parts: Record<string, number>) => AGE_KEYS.reduce((s, k) => s + (parts[k] || 0), 0)
// The API keys the ageing buckets by band code (a1/a2/a3); every chart here keys by
// the band's label, so that both halves of the diverging bar share one colour map.
const agedParts = (parts: Record<string, number>) =>
  Object.fromEntries(AGE_BANDS.map((b) => [b.label, parts[b.k] || 0]))
// A game only ever crosses INTO 4-7d, 8-14d or 15d+; 0-3d is where it arrives.
const AGED_KEYS = AGE_BANDS.slice(1).map((b) => b.label)

// Admins get every tab. An evaluator gets Individual ONLY, scoped to themselves -
// enforced in three places that must stay in sync: the nav/middleware gate on
// /team-ops?tab=performance, the payload stripping in /api/report, and this list.
// Pipeline was folded into Overview: both tabs answered "is the work flowing?" off
// the same numbers, and splitting them meant the backlog charts sat one click away
// from the flow chart that explains them.
const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'leaderboard', label: 'Leaderboard' },
  { id: 'individual', label: 'Individual' },
  { id: 'config', label: 'Config' },
]
const SELF_TABS = TABS.filter((t) => t.id === 'individual')

// Embedded as the "Performance" sub-tab of Team Operations. Internal tabs are
// plain state (the ?tab= URL param belongs to Team Ops).
export function ReportView() {
  return <Suspense><ReportInner /></Suspense>
}

function ReportInner() {
  const sp = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  // '' = not chosen yet; the landing tab depends on the role, which only the payload
  // knows (Team Overview for an admin, Individual for an evaluator). `?rtab=` lets an
  // action elsewhere on the page link straight into a tab - it is our own param, never
  // `?tab=`, which Team Ops already owns for picking this whole sub-page.
  const [tab, setTabState] = useState(sp.get('rtab') || '')
  // A one-shot focus key for a card an action links to. Read once on mount and then
  // cleared from STATE, not the URL: clearing the URL would fight the browser's back
  // button, and leaving it live in state would re-flash the card on every re-render.
  // Leaderboard's Games-per-day column is the first consumer (Task 8); it clears this
  // via `onConsumeFocus` once it has taken its own one-shot copy into local state.
  const [focusOnce, setFocusOnce] = useState(sp.get('focus') || '')

  const setTab = (id: string) => {
    setTabState(id)
    const next = new URLSearchParams(sp.toString())
    next.set('rtab', id)
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }
  // Batch is the landing view: it is the unit the team actually plans in, and the
  // server resolves an empty key to the newest batch, so the first paint is the current
  // batch rather than an all-time scan.
  const [view, setView] = useState<View>('batch')
  const [selKey, setSelKey] = useState('')  // adaptive bucket key; on batch '' = newest, 'all' = every batch
  const [from, setFrom] = useState(''); const [to, setTo] = useState('')
  const [category, setCategory] = useState('puzzle')
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

  // The batch the server resolved an empty key to. It is DISPLAYED, never stored:
  // writing it into `selKey` would change the fetch's dependencies and pull the whole
  // bundle down a second time, which is exactly the round-trip resolving it on the
  // server was meant to save.
  const shownKey = view === 'batch' && !selKey ? (data?.window.batch || '') : selKey

  // Switching the lens defaults its bucket to "now": this week / this month /
  // this quarter / latest batch. Custom pre-fills the current month so the page
  // never silently flips back to all-time.
  const changeView = (v: string) => {
    const nv = v as View
    setView(nv)
    if (nv === 'batch') setSelKey('')
    else if (nv === 'custom') {
      setSelKey('')
      if (!from && !to) {
        const { y, m, d } = vnToday()
        setFrom(`${y}-${pad2(m)}-01`); setTo(`${y}-${pad2(m)}-${pad2(d)}`)
      }
    } else setSelKey(currentKey(nv))
  }

  // The payload decides what this user may see - not the client. Until it arrives we
  // show the self-only view, so an evaluator never sees a team tab flash.
  const teamView = !!data?.canSeeTeam
  const tabs = teamView ? TABS : SELF_TABS
  const activeTab = tabs.some((t) => t.id === tab) ? tab : (teamView ? 'overview' : 'individual')

  const optList: Opt[] = data ? (data.options[view as 'week' | 'month' | 'quarter' | 'year' | 'batch'] || []) : []
  // current period may not have data yet - surface it in the dropdown anyway
  const optListShown: Opt[] = shownKey && view !== 'batch' && view !== 'custom' && !optList.some((o) => o.key === shownKey)
    ? [{ key: shownKey, label: keyLabel(view, shownKey) }, ...optList] : optList

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h-title">Performance</h1>
          <p className="h-sub">{teamView
            ? <>Evaluator performance · initial evaluation, recording &amp; shortlist funnel</>
            : <>Your performance · initial evaluation, recording &amp; pick quality, compared with the team average</>}
            {data && <> · <b>{data.window.label}</b>
              {rangeText(data.window.from, data.window.to) && <> · {rangeText(data.window.from, data.window.to)}</>}</>}</p>
        </div>
        <div className="head-actions">
          <button className="btn btn-sm" onClick={fetchData} disabled={loading}>{loading ? 'Loading…' : '↻ Refresh'}</button>
        </div>
      </div>

      {/* Filter bar: view lens + adaptive picker + category */}
      <div className="rp-filters card">
        <Seg label="View by" value={view} onChange={changeView}
          options={[['batch', 'Batch'], ['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year'], ['custom', 'Custom']]} />
        {view === 'custom' ? (
          <div className="rp-seg-group">
            <span className="rp-seg-label">Range</span>
            <input type="date" className="rp-date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <span style={{ color: 'var(--faint)' }}>→</span>
            <input type="date" className="rp-date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        ) : (
          <div className="rp-seg-group">
            <span className="rp-seg-label"
              /* A week is named for the month holding its LAST day, so "W1 Sep" starts
                 on 31 Aug. That is not a rounding slip - it is the convention the team's
                 own batch labels use: the batch called "W1 Sep, 2026" covers 27/8-9/9.
                 Naming the report's weeks any other way would put the Week picker and
                 the Batch picker a week out of step with each other. */
              title={view === 'week' ? 'A week is named for the month its last day falls in, matching the team\u2019s batch labels - so W1 Sep runs 31/8 \u2013 6/9. Each option shows its exact dates.' : undefined}>
              {view === 'batch' ? 'Batch' : view === 'week' ? 'Week' : view === 'quarter' ? 'Quarter' : view === 'year' ? 'Year' : 'Month'}</span>
            <select className="rp-select" value={shownKey} onChange={(e) => setSelKey(e.target.value)}>
              {/* On batch an empty key means "the newest one", which the SERVER resolves
                  so landing here costs one request rather than two. Asking for every
                  batch is therefore an explicit value, not the absence of one. */}
              <option value={view === 'batch' ? 'all' : ''}>{view === 'batch' ? 'All batches' : 'All time'}</option>
              {optListShown.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
        )}
        <div className="rp-filter-spacer" />
        {teamView && <Seg label="Title" value={title} onChange={setTitle}
          options={[['all', 'All'], ['fulltime', 'Fulltime'], ['freelancer', 'Freelancer']]} />}
        <Seg label="Category" value={category} onChange={setCategory}
          options={[['puzzle', 'Puzzle'], ['arcade', 'Arcade'], ['simulation', 'Sim'], ['all', 'All']]} />
      </div>

      {tabs.length > 1 && (
        <div className="rp-tabs">
          {tabs.map((t) => <button key={t.id} className={'rp-tab' + (activeTab === t.id ? ' active' : '')} onClick={() => setTab(t.id)}>{t.label}</button>)}
        </div>
      )}

      {err && !data && <div className="card" style={{ color: 'var(--bad)' }}>Couldn’t load report: {err}. The database may be waking up - try Refresh.</div>}
      {err && data && <div className="rp-stale-note">Couldn’t refresh ({err}) - showing last loaded data.</div>}
      {loading && !data && <div className="card"><Empty text="Loading…" /></div>}
      {!loading && data && data.empty && <div className="card"><Empty text={teamView ? 'No data for this selection.' : 'You have no evaluations or recordings in this window.'} /></div>}

      {!loading && data && !data.empty && (
        <>
          {activeTab === 'overview' && <Overview d={data} />}
          {activeTab === 'leaderboard' && <Leaderboard d={data} focusOnce={focusOnce}
            onConsumeFocus={() => setFocusOnce('')} />}
          {activeTab === 'individual' && <Individual d={data} />}
          {activeTab === 'config' && <ConfigTab d={data} onSaved={fetchData} />}
        </>
      )}
    </div>
  )
}
/* ---------------- Overview (absorbs the old Pipeline tab) ---------------- */
// Read in three tiers, none of them folded away: one sentence and four numbers say
// whether anything is wrong, at most three action lines say what to do about it, and
// every chart below is the evidence for those lines. Pipeline used to answer the same
// question one click away, off the same numbers - its charts now sit under the flow
// chart that explains them.

// Thresholds that decide whether an action line prints AT ALL. An "Act" under every
// chart is the same as no Act anywhere, so a line only appears when a number crosses
// one of these; a healthy window shows the charts and says nothing.
// TODO: move into report_config (Config tab) next to the Overall score weights, so the
// team can retune them without a deploy.
// Every action here is a call on the team's own throughput or judgement. None of them
// says "push fewer games": intake is set upstream by the genre filter, and a report
// that answers a capacity problem by shrinking the input teaches the reader to look
// away from the thing they can actually move.
const T = {
  intakeGap: 0.15,      // |in − out| ÷ in before the flow counts as out of balance
  agedShare: 0.35,      // share of the waiting stock that is 8 days or older
  clearDays: 5,         // days of work the backlog may hold before it needs a call
  healthShortPts: 10,   // how far below its own baseline a gauge must sit to matter
}
/* The four questions this tab answers. Every chip, every KPI the chips point at, and
   every action carries one of these, so a reader can follow one problem from the
   sentence at the top to the thing they are being asked to do about it without having
   to work out which is which. Growth/Speed/Age are the backlog; Quality is how well the
   games that DO get judged are judged - it has no chip, because the sentence at the top
   is about the backlog, but its two actions still have to say what they are about. */
const TOPIC = {
  growth: 'Growth',
  speed: 'Speed',
  age: 'Age',
  quality: 'Quality',
} as const
type Topic = keyof typeof TOPIC

/* The kicker on a Leaderboard or Individual card. Those two tabs group their actions
   by `fam`, an internal identifier, and both used to print `a.fam.toUpperCase()` - so
   the reader met CAL, REC and COVER, which are not words, on the branch whose whole
   point is one vocabulary across three tabs. Overview never did: it has always mapped
   its `topic` through TOPIC, and this is the same translation for the other two.
   `speed` reads "Speed" rather than a fourth word for the same idea, because that is
   what the Overview chip and KPI above it already call the pace.

   The lexicon gate (__tests__/components/report-lexicon.test.tsx) greps this file's
   SOURCE, so it cannot see an identifier being upper-cased at render time. Every fam
   in use must therefore have a row here - the map is exhaustive over the `fam:` values
   in this file, and `fam` is typed `string`, so a new family that forgets one falls
   back to the identifier and reads exactly as wrong as CAL did. */
const FAM_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  cal: 'Calibration',
  cover: 'Coverage',
  output: 'Output',
  picks: 'Picks',
  rec: 'Recording',
  rhythm: 'Rhythm',
  speed: 'Speed',
}
const famLabel = (f: string) => FAM_LABEL[f] ?? f.toUpperCase()

// Sources are `game_info.type` - the importer that found the game. The suffix is
// noise on a chart legend. A couple of importers go by a different name to the team
// than the one the scraper writes, and the chart is read by the team.
const SRC_LABEL: Record<string, string> = { 'appranking-scraper': 'insight-track' }
const srcName = (s: string) => SRC_LABEL[s] ?? s.replace(/-scraper$/, '')

export type DoAct = {
  sev: number
  key: string
  kicker: string                       // TOPIC[topic] on Overview, the family on the others
  // What the kicker button promises when you hover it. The kicker's only other
  // affordance is a four-letter uppercase word, so without this nothing on screen says
  // it is a control at all - it was lost when three copies of this block were folded
  // into one, and a button nobody knows to press is the same as no button.
  kickerTitle?: string
  do: React.ReactNode
  why: React.ReactNode
  payoff?: React.ReactNode             // what the reader gets, in days or a date
  cta?: { label: string; href?: string; onClick?: () => void }
  onKicker?: () => void
}

/* Sorts worst-first, keeps at most one line per topic, and caps at three. Pulled out
   of `DoBlock` so a caller can rank its own actions - to decide, for example, which
   lines get an "Or" prefix - and then hand DoBlock the already-ranked list. Idempotent:
   ranking a ranked list is a no-op, and the sort is stable so equal-severity actions
   keep the order their tab pushed them in.

   The per-topic cap lives HERE rather than in the conditions that build the list. It
   used to be an `if / else if` between the two `age` actions, which held right up until
   one of them was made independent - and then "Move 926 stale games off three desks"
   and "Drop the 4,200 games past 15 days" could print side by side, two lines largely
   about the same games, eating two of the three slots.

   `topic` is optional on purpose: the Leaderboard and Individual tabs group their
   actions by `fam`, not by topic, so their lists come through untouched. Dedupe runs
   BEFORE the slice, or a second line on one topic could starve a third topic of the
   last slot. */
export function rankActs<T extends { sev: number; topic?: string }>(acts: T[]): T[] {
  const seen = new Set<string>()
  return [...acts]
    .sort((a, b) => b.sev - a.sev)
    .filter((a) => {
      if (!a.topic) return true
      if (seen.has(a.topic)) return false
      seen.add(a.topic)
      return true
    })
    .slice(0, 3)
}

/* One block, three cards, used by every tab. It replaces three near-identical copies
   of the same JSX, which is how the three tabs drifted apart in the first place.
   Sorting and the cap of three live HERE (via `rankActs`) so no tab can quietly raise
   its own limit. `payoff` and `cta` are optional because a contractor's card has no
   operation to offer - see law 4: a button must be something the reader is allowed to
   run. */
export function DoBlock({ acts }: { acts: DoAct[] }) {
  const shown = rankActs(acts)
  if (!shown.length) return null
  return (
    <div className="rp-do-block">
      <span className="rp-mix-label">Do this</span>
      {/* The column count follows the number of cards. A fixed `repeat(3, 1fr)` left a
          lone action - the common case on Individual - as a third-width card with two
          thirds of the row blank.

          Severity picks each card's colour, in three tiers. It used to be two: `sev: 0`
          is the one good-news line on the whole report (Individual's `up`), and it fell
          through to the amber warning tint, which printed "Keep the change you made
          this week" as a caution, on the one tab a contractor ever sees. */}
      <div className={`rp-do-grid n${Math.min(3, shown.length)}`}>
        {shown.map((a) => (
          <div className={'rp-do' + (a.sev >= 3 ? ' urgent' : a.sev === 0 ? ' good' : '')} key={a.key}>
            {a.onKicker
              ? <button type="button" className="rp-do-topic" onClick={a.onKicker} title={a.kickerTitle}>{a.kicker}</button>
              : <span className="rp-do-topic as-text">{a.kicker}</span>}
            <span className="rp-do-line">{a.do}</span>
            <span className="rp-do-why">{a.why}</span>
            {(a.payoff || a.cta) && (
              <div className="rp-do-foot">
                {a.payoff && <span className="rp-do-payoff">{a.payoff}</span>}
                {a.cta && (a.cta.href
                  ? <a className="rp-do-cta" href={a.cta.href}>{a.cta.label}</a>
                  : <button type="button" className="rp-do-cta" onClick={a.cta.onClick}>{a.cta.label}</button>)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function Overview({ d }: { d: Bundle }) {
  const bannerRef = useRef<HTMLDivElement>(null)
  const sd = staleDays(d)
  const t = d.teamTotals
  const p = d.pipeline
  const f = d.funnel
  const ms = d.metricSeries || []
  const rated = ms.filter((m) => m.evaluated > 0)
  const last = rated[rated.length - 1], prevB = rated[rated.length - 2]
  const unitName = d.bucketUnit === 'day' ? 'day' : d.bucketUnit === 'week' ? 'week' : 'month'
  // The bucket and the window are different nouns, and mixing them printed "Backlog
  // +1,413 this day" for a week viewed by day. Buckets are the chart's x axis;
  // everything that talks about the selection uses this.
  const winName = windowNoun(d)
  const pts =(fn: (m: Bundle['metricSeries'][number]) => number) => ms.map((m) => ({ label: m.label, value: fn(m) }))
  // The default view is the CURRENT week/month, so its last bucket is a day that has
  // not finished yet. A sparkline ending on it makes the KPI's derived trend read a
  // half-done day as a collapse or a jump (+9,133% on a Sunday morning), so flow
  // sparks stop at the last complete bucket. Stock is exempt: the backlog line is a
  // running total, and today's value is the true one.
  const partialTail = !d.window.to || d.window.to > vnTodayIso()
  const done = <V,>(a: V[]) => (partialTail && a.length > 1 ? a.slice(0, -1) : a)

  // ---- flow: what came in against what went out ----
  const inTotal = p ? p.window.newGames : f.assigned
  const outTotal = p ? p.window.evaluated : f.evaluated
  const net = inTotal - outTotal
  const gap = inTotal > 0 ? net / inTotal : 0
  // From `d.stock`, not `p.current`: identical numbers, but present on every view. The
  // pipeline carries its own copy for the charts that plot it over time.
  const stockAge = d.stock?.age ?? p?.current.age ?? { a0: 0, a1: 0, a2: 0, a3: 0 }
  const stock = d.stock?.backlog ?? p?.current.backlog ?? 0
  const oldStock = stockAge.a2 + stockAge.a3
  const agedShare = stock > 0 ? oldStock / stock : 0
  // Clearing pace in games per CALENDAR day, and what the stock therefore weighs in
  // days of work. Days, not buckets: "26 days to clear" is a number anyone can act on,
  // where "5.2 weeks of work" needs the reader to know how long a bucket is. The
  // window's tail is clamped to today, or the current week reads its pace across seven
  // days when only three have happened.
  const elapsedDays = (() => {
    if (!d.window.from) return 0
    const today = vnTodayIso()
    const end = d.window.to && d.window.to <= today ? d.window.to : addDays(today, 1)
    return Math.max(1, Math.round((Date.parse(end) - Date.parse(d.window.from)) / 86400000))
  })()
  /* Games the TEAM clears per calendar day. This is the only "games per day" on the
     tab now. It used to sit beside `teamTotals.personDayThroughput` - games per
     evaluator on a day they worked - under the same three words, so the tab printed
     "105.7 games per day" directly under a chip saying "497 games/day" and left the
     reader to work out that they were different quantities. Per-evaluator is a
     question about people, so it belongs on Leaderboard, where every row is a person.
     Same rule the spec already applied when it folded two throughput averages into
     one: two numbers measuring the same thing, differing only in weighting, with
     nothing on screen saying so, is worse than one. */
  const perDay = elapsedDays > 0 ? outTotal / elapsedDays : 0
  // Enough precision to be useful at both ends: 497 needs none, 8.4 needs one.
  const perDayFmt = (v: number) => (v >= 100 ? fmt.int(v) : fmt.dec(v))
  // The same pace over the window the filter bar is comparing against.
  const prevDays = d.prev?.from && d.prev?.to
    ? Math.max(1, Math.round((Date.parse(d.prev.to) - Date.parse(d.prev.from)) / 86400000)) : 0
  const prevPerDay = d.prev && prevDays > 0 ? d.prev.evaluated / prevDays : 0
  const refDays = d.baseline?.days ?? 0
  const refPerDay = d.baseline && refDays > 0 ? d.baseline.evaluated / refDays : 0
  const daysToClear = perDay > 0 && stock > 0 ? stock / perDay : null
  // person-days needed to bring the stock down to `clearDays` of work, on top of
  // keeping up with intake. The ONE per-person quantity left on this tab, and it is
  // not a metric - it is the unit the ask is made in. You add people, so "add 98
  // person-days" is actionable where "add 3 team-days" is not.
  const overStock = daysToClear != null ? Math.max(0, stock - T.clearDays * perDay) : 0
  const catchUpPersonDays = t.personDayThroughput > 0 ? overStock / t.personDayThroughput : 0

  /* The capacity ask, said the way it would be filled. Person-days is the honest unit
     of the arithmetic and a useless one to act on: "add 1,153 person-days" was the line
     the team was shown, and nobody hires a person-day. Converted to "about N more people
     for M weeks" against the headcount actually working, the same number either reads as
     a plan or reads as obviously impossible - and when it is impossible, that IS the
     finding, so the line still prints rather than hiding behind a threshold. */
  // The team size every per-person sentence on this tab divides by. Hoisted out of
  // `peopleAsk` because the catch-up line needs the SAME divisor: two lines in one
  // block disagreeing about how many people there are is the fastest way to make the
  // reader distrust both. `t.evaluators` is who actually judged something this window,
  // which is the only headcount the pace was measured over.
  const heads = Math.max(1, t.evaluators || 1)
  const peopleAsk = (() => {
    const weeks = Math.max(1, Math.round(catchUpPersonDays / (heads * 5)))
    const extra = Math.max(1, Math.round(catchUpPersonDays / (weeks * 5)))
    const forLong = weeks === 1 ? 'a week' : weeks === 4 ? 'a month' : `${weeks} weeks`
    return <><b>{extra === 1 ? 'one more person' : `${fmt.int(extra)} more people`}</b> for {forLong}</>
  })()

  // ---- team health, read against the trailing 90 days instead of a made-up target ----
  // Fallback when the window has no "before" (all-time / batch): the average of its
  // own buckets. Stated in the marker label either way, so the bar never implies a
  // benchmark it does not have.
  const avgOf = (fn: (m: Bundle['metricSeries'][number]) => number) =>
    rated.length ? rated.reduce((s, m) => s + fn(m), 0) / rated.length : 0
  const bl = d.baseline
  const refNote = bl ? `avg of prev ${bl.days}d` : `avg of the ${rated.length} ${unitName}s shown`
  // ---- the comparison the FILTER BAR asked for, which is not the health threshold ----
  // Team health reads against a trailing 90 days on purpose: it is a standing bar the
  // team set itself, and it should not move just because the reader picked a different
  // month. The KPI row is the opposite job - somebody selected "month", so the only
  // comparison that answers them is last month. Two different questions, two
  // references, and each one now says which it is on screen.
  //
  // No fallback. On all-time and batch there IS no previous period, and the old
  // fallback - the average of the buckets on screen - compares a window against
  // itself. A comparison that cannot be made does not print one.
  const pv = d.prev
  const kpiRef = { survival: pv?.survivalRate ?? 0, velocity: pv?.personDayThroughput ?? 0 }
  const kpiRefNote = pv?.label ?? ''
  // One precision for the rate and the figure it is compared with - see `pctPair`.
  const [srVal, srFmt] = pctPair(t.survivalRate, kpiRef.survival > 0 ? kpiRef.survival : null)
  const ref = {
    survival: bl ? bl.survivalRate : avgOf((m) => m.survivalRate),
    signal: bl ? bl.signalRate : avgOf((m) => m.signalRate),
    // The team's own clearing pace over the trailing baseline, in the same unit the
    // KPI and the SPEED chip use. It was games-per-evaluator-per-day, which made the
    // gauge the one place on the tab still measuring people.
    velocity: refPerDay || (elapsedDays > 0 && rated.length
      ? rated.reduce((s, m) => s + m.evaluated, 0) / elapsedDays : 0),
  }
  // The target marker sits at 66% of the track, so "bar reaches the notch" always
  // means "at the reference", whatever the metric's natural magnitude.
  const gauge = (v: number, r: number) => (r > 0 ? Math.min(100, (v / r) * 66) : 0)
  // Against a reference the team set itself, equal IS the pass mark - but a couple of
  // points either way is noise, not a regression.
  const vsRef = (v: number, r: number) => (r > 0 ? band(v / r, 0.8, 0.95) : 'good' as const)
  const health = [
    {
      label: 'Shortlist rate', value: fmt.pct(t.survivalRate),
      // denominator is `evaluated` - it must match the ratio in `value`, not
      // `assigned`, which counts new intake and is a different scope entirely
      detail: `${fmt.int(f.shortlisted)} shortlisted of ${fmt.int(f.evaluated)} evaluated`,
      pct: gauge(t.survivalRate, ref.survival), target: 66, targetLabel: `${refNote} ${fmt.pct(ref.survival)}`,
      spark: rated.length >= 2 ? rated.map((m) => Math.round(m.survivalRate * 1000)) : undefined,
      delta: last && prevB ? (last.survivalRate - prevB.survivalRate) * 100 : null, deltaLabel: `pts vs prev ${unitName}`,
      status: vsRef(t.survivalRate, ref.survival),
    },
    {
      label: 'Hit rate', value: fmt.pct(t.signalRate),
      detail: `${fmt.int(f.finalPriority)} final priority of ${fmt.int(f.evaluated)} evaluated`,
      pct: gauge(t.signalRate, ref.signal), target: 66, targetLabel: `${refNote} ${fmt.pct(ref.signal)}`,
      spark: rated.length >= 2 ? rated.map((m) => Math.round(m.signalRate * 1000)) : undefined,
      delta: last && prevB ? (last.signalRate - prevB.signalRate) * 100 : null, deltaLabel: `pts vs prev ${unitName}`,
      status: vsRef(t.signalRate, ref.signal),
    },
    {
      // One velocity number on this tab, and it is the TEAM's. The per-evaluator
      // version moved to Leaderboard, where every row is a person and the question
      // "per person" is the one being asked. Here it only ever competed with the
      // team pace for the same three words.
      label: 'Games per day', value: perDayFmt(perDay),
      detail: `cleared per day, whole team · ${fmt.int(outTotal)} ÷ ${fmt.int(elapsedDays || 1)} days`,
      pct: gauge(perDay, ref.velocity), target: 66, targetLabel: `${refNote} ${perDayFmt(ref.velocity)}`,
      status: vsRef(perDay, ref.velocity),
    },
    // Note coverage used to sit here against a 90% policy. Writing a note is enforced
    // in the evaluation form now, so the gauge only ever reads ~100% and spends a row
    // saying nothing. It comes back when note QUALITY can be scored rather than
    // counted; until then it lives on Leaderboard and Individual, where the per-person
    // number still separates people.
    {
      label: 'Evaluators active', value: String(t.evaluators),
      detail: p && p.series.length
        ? `${fmt.dec(p.series.reduce((s, r) => s + r.people, 0) / p.series.length)} active per ${unitName} on average`
        : `${fmt.int(d.evaluators.length)} on the roster this window`,
      pct: d.evaluators.length ? (t.evaluators / d.evaluators.length) * 100 : 0,
      spark: p && p.series.length >= 2 ? p.series.map((r) => r.people) : undefined,
      status: band(d.evaluators.length ? t.evaluators / d.evaluators.length : 0, 0.6, 0.85),
    },
  ]
  // How far a gauge sits below its own baseline, in track points. Only the pace gauge
  // is read this way now. The quality gauges used to feed an action of their own -
  // "re-judge a sample of 20 bypassed games" - and that is a verdict on how people
  // judge, which this tab is not allowed to make: see law 3 and the `acts` list below.
  // The gauges still print; what was removed is the instruction, not the reading.
  const shortOf = (label: string) => {
    const h = health.find((x) => x.label === label)
    return h && h.target != null ? 66 - Math.min(66, h.pct) : 0
  }
  const paceShort = shortOf('Games per day')

  // ---- funnel: starts at Evaluated. Assigned counts new intake only - a different
  // scope than Evaluated, which also clears older backlog - so stacking it here
  // produced conversions over 100%. It lives in the flow chart instead. ----
  const funnelStages = [
    { label: 'Evaluated', value: f.evaluated },
    { label: 'Shortlist', value: f.shortlisted },
    { label: 'Final Priority', value: f.finalPriority, parts: [
      { label: 'Priority IV', value: f.priorityIV, color: CAT[4] },
      { label: 'Insight', value: f.insight, color: CAT[6] },
    ] },
  ]
  const fnStages = [
    { from: 'Evaluated', to: 'Shortlist', a: f.evaluated, b: f.shortlisted },
    { from: 'Shortlist', to: 'Final Priority', a: f.shortlisted, b: f.finalPriority },
  ].filter((s) => s.a > 0)
  const worstStep = [...fnStages].sort((x, y) => x.b / x.a - y.b / y.a)[0]

  // ---- charts over time ----
  const rateSeries = [
    { name: 'Shortlist rate %', color: CAT[3], points: pts((m) => m.survivalRate * 100) },
    { name: 'Hit rate %', color: CAT[1], points: pts((m) => m.signalRate * 100) },
  ]
  // Flow AND stock in one chart: they are two halves of one sentence, and the stock
  // is just the running total of the gap between the other two lines. Backlog rides
  // the right-hand axis - it is an absolute stock in the thousands next to daily flow
  // in the hundreds, and sharing a scale would flatten the flow lines to nothing.
  // All three count games, so all three share one axis. The backlog line sits far
  // above the flow lines and that gap is the reading: a week's work is a fraction of
  // what is already waiting. It skips the area fill, which would bury the other two.
  const flowSeries = p
    ? [
        { name: 'New games in', color: CAT[0], points: p.series.map((r) => ({ label: r.label, value: r.newGames })) },
        { name: 'Evaluated', color: CAT[2], points: p.series.map((r) => ({ label: r.label, value: r.evaluated })) },
        { name: 'Backlog', color: CAT[3], dashed: true, area: false, points: p.series.map((r) => ({ label: r.label, value: r.backlog })) },
      ]
    : [
        { name: 'Assigned', color: CAT[5], points: pts((m) => m.assigned) },
        { name: 'Evaluated', color: CAT[0], points: pts((m) => m.evaluated) },
      ]
  // Shortlist-rate drift across the window used to be computed here, first half
  // against last, to fire a "re-judge a sample" action. That action is gone (law 3 -
  // how well a named team judges is the Leaderboard's question), and a number computed
  // for nothing is a number the next reader has to work out the purpose of.

  // ---- intake by source ----
  const srcTotals = p?.sourceYield ?? []
  const srcIn = srcTotals.reduce((s, r) => s + r.n, 0)
  const srcKeys = srcTotals.map((r) => srcName(r.src))
  const srcColors = Object.fromEntries(srcKeys.map((k, i) => [k, CAT[i % CAT.length]]))
  const srcRows = (p?.sources ?? []).map((b) => ({
    name: b.label,
    parts: Object.fromEntries(Object.entries(b.parts).map(([k, v]) => [srcName(k), v])),
  }))
  // Volume only. The card used to carry each source's shortlist rate and pick count,
  // and an action that turned a source off when it produced none - which is a judgement
  // about the push filter, upstream of anything this team does with the games it is
  // given. The question here is "where did the intake come from", and that is one
  // number per source.
  const srcLegend = srcTotals.filter((r) => srcIn > 0 && r.n / srcIn >= 0.01)
    .map((r) => ({ name: srcName(r.src), n: r.n, share: r.n / srcIn }))
  const srcRest = srcTotals.length - srcLegend.length
  const srcRestN = srcIn - srcLegend.reduce((s, r) => s + r.n, 0)

  // ---- clearing mix ----
  const clearedTot = p ? p.cleared.reduce((s, r) => s + ageTotal(r), 0) : 0
  const clearedOld = p ? p.cleared.reduce((s, r) => s + r.a2 + r.a3, 0) : 0
  const clearedOldShare = clearedTot ? clearedOld / clearedTot : 0
  const avgWait = p && clearedTot ? p.cleared.reduce((s, r) => s + r.avgAge * ageTotal(r), 0) / clearedTot : null
  const tailGrowing = clearedTot > 0 && stock > 0 && clearedOldShare < agedShare

  // ---- who was actually working, per bucket ----
  // Stops at the last COMPLETE bucket. "People who have worked today" is 0 at 08:40,
  // and a zero column next to a full one reads as the whole team being out rather than
  // as the morning not being over. The flow lines keep their partial bucket because a
  // running count of games is true as far as it goes; a headcount is not.
  const peopleCols = p ? done(p.series.map((r) => ({ label: r.label, value: r.people }))) : []
  const peopleLow = peopleCols.length >= 2 ? peopleCols.reduce((a, b) => (b.value < a.value ? b : a)) : null
  const peopleHigh = peopleCols.length ? Math.max(...peopleCols.map((r) => r.value)) : 0

  // ---- how long the backlog has been waiting ----
  // The chart stays a four-band stack so it reads as a PAIR with "Cleared - old vs
  // new" beside it: same bands, same colours, left is what is waiting and right is
  // what got done. A version of this drawn in days (median / p90 / oldest) broke that
  // pairing - the two cards no longer shared a unit - so the age numbers live in the
  // note underneath instead, where they say the one thing band heights cannot.
  const aging = p?.aging ?? []
  const ageFirst = aging[0], ageLast = aging[aging.length - 1]
  // ---- judged against aged, per bucket ----
  // Two event streams on one time axis. `cleared` is work finished, keyed by how old
  // each game was when it was judged; `aged` is work that only got older, keyed by the
  // band it crossed into. Both count events, so a game appears at most once in each.
  const agedBy = new Map((p?.aged ?? []).map((r) => [r.label, agedParts(r.parts)]))
  const divRows = (p?.cleared ?? []).map((r) => ({
    name: r.label, right: ageParts(r), left: agedBy.get(r.label) || {},
  }))
  // buckets where nothing was judged still had games ageing through them
  for (const a of p?.aged ?? []) if (!divRows.some((r) => r.name === a.label)) divRows.push({ name: a.label, right: {}, left: agedParts(a.parts) })
  const agedTot = (p?.aged ?? []).reduce((s, r) => s + ageKeysSum(agedParts(r.parts)), 0)
  const rotted = (p?.aged ?? []).reduce((s, r) => s + (r.parts.a3 || 0), 0)
  // Stale work CREATED is the count crossing into 8-14d or 15d+, which is the only thing
  // comparable with stale work cleared. An earlier version weighed all-ages-cleared
  // against crossings-into-15d+ and printed "stale work is being cleared faster" over a
  // window where the 8+ day backlog grew by 600.
  const agedIntoOld = (p?.aged ?? []).reduce((s, r) => s + (r.parts.a2 || 0) + (r.parts.a3 || 0), 0)
  const divInsight = agedTot > 0
    ? <>{fmt.int(clearedTot)} judged this {winName} against {fmt.int(agedTot)} that crossed into an older band{rotted > 0 && <>, {fmt.int(rotted)} of them past 15 days</>}. On the 8+ day backlog alone: {fmt.int(clearedOld)} cleared, {fmt.int(agedIntoOld)} created &ndash; <b>the stale backlog is {clearedOld >= agedIntoOld ? 'shrinking' : 'growing'}</b>.</>
    : <>Nothing crossed into a new stale band this {winName}.</>

  const ageInsight = ageFirst && ageLast && aging.length >= 2
    ? ageLast.medAge > ageFirst.medAge
      ? <>Median wait went {ageFirst.medAge}d → <b>{ageLast.medAge}d</b> across the window, and the slowest tenth is at <b>{ageLast.p90Age}d</b>: games are being added to the backlog faster than the middle of it moves.</>
      : ageLast.medAge < ageFirst.medAge
        ? <>Median wait came down {ageFirst.medAge}d → <b>{ageLast.medAge}d</b>, with the slowest tenth at <b>{ageLast.p90Age}d</b>.</>
        : <>Median wait held at <b>{ageLast.medAge}d</b>, with the slowest tenth at <b>{ageLast.p90Age}d</b> and the oldest game at {ageLast.maxAge}d.</>
    : 'Needs more than one bucket to show a trend.'

  // ---- every action on the tab, in one list ----
  // Three rules, and they only hold if the list is built in ONE place: a line prints
  // only when a number crosses a threshold above; at most three print, worst first;
  // each names one move. The old layout hung an "Act" under every chart, including
  // the ones saying "output is holding, keep the current roster" - so the page always
  // had eight actions and therefore none. Cards keep their ReadNote, which explains
  // how to read the chart; that is not the same thing as telling you to do something.
  // Each action is a move and the numbers behind it, in that order and on separate
  // lines. Written as one paragraph, the verb ended up in the middle of the sentence
  // and a reader had to parse the evidence to find out what they were being asked to
  // do. `do` is the instruction; `why` is the evidence, set smaller.
  //
  // Three families, and each one can contribute at most a line: SPEED (is the team
  // clearing fast enough), QUALITY (is what it clears worth anything), AGE (is the
  // oldest work being left behind). A family per line keeps the cap of three from
  // filling up with three versions of the same complaint.
  // `topic` is what ties this line back to the sentence and the chips at the top of the
  // tab. It is required, not optional: an action with no topic is a link missing from
  // that chain, and the reader has to re-derive which of the four problems it answers.
  //
  // LAW 7. Rebalancing, raising the pace, buying people and dropping work are four ways
  // out of the SAME problem, and they cost the team four very different things: nothing,
  // effort, money, and the work itself. They are pushed in that order and rank stably,
  // so the reader always meets the free answer before the expensive one - the tab used
  // to lead with "add 4 more people" over a week where 926 games could have been moved
  // between desks for nothing. Every remedy after the first opens with "Or", which is
  // why the opening verb is stored apart from the rest of the sentence: "Add 4 more
  // people" has to become "Or add 4 more people", and a rendered node cannot be
  // lower-cased. `family` is what makes two lines alternatives; a diagnosis and a
  // moderator gate are not alternatives to anything and carry none.
  //
  // LAW 3. This tab may name a person as the COORDINATE of some games - "926 games are
  // sitting with X, Y and Z" - and never as a judgement of that person. That is why
  // there is no quality action here any more: "re-judge a sample of 20 bypassed games"
  // is a verdict on how the team judges, and it belongs on the Leaderboard, where every
  // row is a person and the comparison is the whole point. `notriage` stays, because
  // work stuck at a moderator gate is a fact about the flow, not about anybody.
  type Act = {
    sev: number; key: string; topic: Topic
    lead: string                 // the opening verb, capitalised; lower-cased after "Or"
    rest: React.ReactNode        // the rest of the instruction
    why: React.ReactNode         // the evidence, 150 characters at the very most
    payoff?: React.ReactNode     // what the reader gets, in days or a date
    cta?: DoAct['cta']
    family?: 'backlog'           // set on remedies for the same problem - see law 7
    priciest?: boolean           // says so out loud when a cheaper remedy printed above
  }
  const acts: Act[] = []

  // -- age, the free remedy: the games and the people both already exist --
  // The numbers come from the Rescue scan itself, so this sentence and the panel the
  // button opens are the same measurement. They used to be two: the report named a
  // hard-coded 8 days while Rescue ran on the admin's configured 14.
  const rb = d.rescue
  const rbSources = rb?.sources ?? []
  const rbRecv = rb?.receivers ?? []
  const canRebalance = !!rb && rbSources.length > 0 && rbRecv.length > 0 && rb.movableTotal >= STALE.min
  if (rb && canRebalance) {
    const top = rbSources.slice(0, 3)
    const names = top.length === 1 ? top[0].name
      : `${top.slice(0, -1).map((s2) => s2.name).join(', ')} and ${top[top.length - 1].name}`
    const moving = top.reduce((s2, x) => s2 + x.movable, 0)
    // `stale`, not `movableTotal`. They are different populations: `movable` excludes
    // the games inside the Rescue panel's cool-down window, so a sentence saying "N
    // games past 8 days" built from `movableTotal` prints a smaller number than the
    // stale column of the very panel the button opens.
    const staleHeld = rbSources.reduce((s2, x) => s2 + x.stale, 0)
    const recvShare = Math.min(rbRecv.length, heads) / heads
    const movedDays = perDay > 0 && recvShare > 0 ? moving / (perDay * recvShare) : null
    acts.push({
      sev: 3, key: 'rebalance', topic: 'age', family: 'backlog',
      lead: 'Move',
      // NOT "with a clear desk". `classifyRoster` gates a receiver on STALE work, not
      // on pending work, so on a real roster those people were holding 404 and 332
      // games each - and a claim the table underneath disproves is the first thing a
      // manager checks. "Rescue would hand them to" is also the only phrasing that
      // stays true when `receiverMaxStale` is raised off its default of 0 (it is
      // admin-editable up to 100), where "nothing stale" quietly becomes false.
      //
      // "the top 3 of 5" for the same reason `holders` below carries it: three names
      // over a `why` counting five people and a bigger total is three numbers that do
      // not reconcile, and reconciling them is the first thing a manager does.
      rest: <>{fmt.int(moving)} stale games from {names}{rbSources.length > top.length ? <>, the top {top.length} of {rbSources.length},</> : null} to the {rbRecv.length === 1 ? 'one person' : `${rbRecv.length} people`} Rescue would hand them to</>,
      why: <>{rbSources.length === 1 ? 'One person holds' : `${rbSources.length} people hold`} {fmt.int(staleHeld)} games past {rb.staleDays} days. {rbRecv.length === 1 ? `One other passes Rescue's receiver check and is still judging.` : `${rbRecv.length} others pass Rescue's receiver check and are still judging.`}</>,
      // The moved games measured against the people who will actually eat them: the
      // receivers' share of the team's pace. The WHOLE team's pace would say the stale
      // work is gone in a fraction of the time, on the assumption that everybody drops
      // what they are holding - and `evaluatedRecent` arrives with no window attached,
      // so a real per-receiver rate cannot be computed from it either.
      // Scoped to the games this line actually moves. With more than three holders the
      // rest stay where they are, so "stale games gone" would be false; the number the
      // reader is being shown is the one in the instruction directly above.
      // No payoff at all when there is no pace to divide by (all-time and All batches
      // have no window to measure one over). The fallback was the bare fragment
      // "Nobody added", which under a green arrow reads as a sentence that lost its
      // beginning rather than as what the reader gets.
      payoff: movedDays != null
        ? <>Those {fmt.int(moving)} are gone in {fmt.dec(movedDays)} days, with nobody added</>
        : undefined,
      // Only which rows it meant, never what the threshold should be: a Rescue scan
      // persists whatever config it is handed, so a link carrying `staleDays` would
      // rewrite the admin's saved settings just by being clicked.
      cta: {
        label: 'Open Rescue',
        href: `/team-ops?tab=rescue${catParam(d)}&flash=${encodeURIComponent([...top.map((s2) => s2.name), ...rbRecv.slice(0, 4).map((r) => r.name)].join(','))}`,
      },
    })
  }

  // -- age, the ordering remedy: free too, but it only reorders one desk's work --
  // Who is actually holding the stale work. It fires only where a rebalance cannot:
  // with somebody standing free the games should MOVE, and offering the same desk two
  // answers at once is how a reader ends up taking neither. The test is the same one
  // the Leaderboard's backlog flag uses, so the two tabs never point at different
  // people. It used to say "into the next assign run BY NAME" and name nobody, so the
  // first thing a reader doing it had to do was go to another tab and work out who.
  const holderRows = (d.backlogBy || []).map((b) => ({ name: b.name, stale: b.stale, n: b.n }))
  // The denominator comes from the SAME source as the holders, never from `oldStock`.
  // Two reasons: `oldStock` is null on a batch window (no pipeline), which printed
  // "871 of the 0 games"; and it ages from the IMPORT date where these rows age from
  // the ASSIGN date, so the two are different measurements of different populations and
  // a sentence putting one over the other is not a share of anything.
  const staleTotal = holderRows.reduce((s2, b) => s2 + b.stale, 0)
  const oldHolders = holderRows
    .filter((b) => b.stale >= STALE.min && b.stale / b.n > STALE.share)
    .sort((a, b) => b.stale - a.stale)
  const top3 = oldHolders.slice(0, 3)
  const holderNames = top3.length === 1 ? top3[0].name
    : `${top3.slice(0, -1).map((b) => b.name).join(', ')} and ${top3[top3.length - 1]?.name}`
  const holderStale = oldHolders.reduce((s2, b) => s2 + b.stale, 0)
  const top3Stale = top3.reduce((s2, b) => s2 + b.stale, 0)
  // Naming people does NOT wait for the team-level ageing test. Those are different
  // questions and the aggregate hides the answer to this one: on a real September the
  // team sat at 33% old against a 35% threshold - so nothing fired - while three
  // people were each over 25% of their own backlog, holding 871 stale games between
  // them. A backlog problem belonging to three named desks should not need the whole
  // team to cross a line before anyone is told.
  //
  // No button. Rescue is either unavailable here (a non-manager has no scan at all) or
  // has nobody to move the games to, and the roster screen sets WHO gets work, not the
  // order a run hands it out in - so there is no screen this line could open that would
  // do what it asks. Law 4: a button has to be something the reader can actually run.
  if (oldHolders.length > 0 && !canRebalance) acts.push({
    sev: 3, key: 'holders', topic: 'age', family: 'backlog',
    lead: 'Put',
    // Says so when the three names are not all of them. On the real payload it read
    // "the 796 games with A, B and C" directly over a `why` counting FOUR people and a
    // different total - three numbers that do not reconcile on one card, and
    // reconciling them is the first thing a manager does.
    rest: <>the {fmt.int(top3Stale)} games sitting {sd}+ days with {holderNames}{oldHolders.length > top3.length ? <>, the top {top3.length} of {oldHolders.length},</> : null} at the front of the next assign run</>,
    why: <>{oldHolders.length === 1 ? 'One person holds' : `${oldHolders.length} people hold`} {fmt.int(holderStale)} of the {fmt.int(staleTotal)} games that have sat {sd}+ days with the same person{staleTotal > 0 ? <> ({fmt.pct(holderStale / staleTotal)})</> : null}, each over {fmt.pct(STALE.share)} of their own backlog.</>,
    payoff: <>The oldest games get judged first, with nobody added</>,
  })

  // -- speed --
  // A team running below its own pace and a team that needs more people are different
  // problems with opposite answers, and the list printed both at once: "add 98
  // person-days" sat directly under "find what changed before adding people". While
  // the pace is short the diagnosis leads and the capacity ask is held back, because
  // buying people to cover a drop nobody has explained buys the drop too.
  //
  // No `family`: this is a diagnosis, not a remedy. Nothing below it is an alternative
  // to finding out what happened, so it never carries or triggers an "Or".
  // Both sides of the comparison have to exist. All-time and "All batches" have no
  // `window.from`, so `elapsedDays` is 0, `perDay` and `ref.velocity` are both 0, the
  // gauge reads 0 and `paceShort` is a flat 66 - a missing denominator crossing the
  // threshold for a problem nobody has. It printed "0.0 games a day against 0.0" on
  // two of the six real-payload fixtures, ate the Speed slot, and suppressed the
  // `capacity` ask through the `!paceIsShort` interlock below. Law 6 is about a
  // reading crossing a line, not about a division that never happened.
  const paceIsShort = perDay > 0 && ref.velocity > 0 && paceShort > T.healthShortPts
  if (paceIsShort) acts.push({
    sev: 3, key: 'pace', topic: 'speed',
    lead: 'Find',
    rest: <>what changed in the working day before adding people</>,
    // The KPI row compares with the previous window and this line used to compare with
    // the trailing 90 days, so the same metric appeared twice on one screen against two
    // unnamed references. It now leads with the window the reader picked, and says
    // which reference it is either way.
    why: prevPerDay > 0
      ? <>The team cleared {perDayFmt(perDay)} games a day against {perDayFmt(prevPerDay)} {kpiRefNote}, and {perDayFmt(ref.velocity)} over the {bl ? `${bl.days} days` : 'buckets'} before this {winName}</>
      : <>The team cleared {perDayFmt(perDay)} games a day against {perDayFmt(ref.velocity)}, the {refNote}</>,
  })

  // -- growth: the remedy that costs effort --
  // Said per person per day, because that is the unit the people being asked work in.
  // "Clear 1,000 more games" is the same arithmetic and nobody can tell from it whether
  // they are being asked for an extra hour or an extra week. Both figures in the
  // bracket are rounded BEFORE the difference is taken, so the sum on screen always
  // adds up - a reader who checks it and finds 22 + 15 = 36 stops reading the rest.
  const nowPer = Math.round(perDay / heads)
  const needPer = elapsedDays > 0 ? Math.round(inTotal / elapsedDays / heads) : 0
  const perPersonWorks = elapsedDays > 0 && needPer > nowPer
  const addPer = needPer - nowPer
  if (inTotal > 0 && gap > T.intakeGap) acts.push({
    sev: 3, key: 'catchup', topic: 'growth', family: 'backlog',
    lead: perPersonWorks ? 'Each person adds' : 'Clear',
    // The fallback is all-time and batch-with-no-dates, where there are no days to
    // divide by and a per-day ask would be a division by zero dressed as advice.
    rest: perPersonWorks
      ? <>{fmt.int(addPer)} {addPer === 1 ? 'game' : 'games'} a day ({fmt.int(nowPer)} to {fmt.int(needPer)}) to break even on intake</>
      : <>{fmt.int(net)} more games to break even on intake</>,
    why: <>{fmt.int(inTotal)} in against {fmt.int(outTotal)} out this {winName} · {heads === 1 ? '1 person' : `${fmt.int(heads)} people`} working</>,
    payoff: <>The backlog stops growing from next {winName}</>,
    // An href, not an in-page tab switch: `focus` is read from the URL once at mount,
    // so a switch made inside the page would arrive at the Leaderboard without it and
    // the column this line is about would not be flagged.
    cta: { label: 'See who is under the pace', href: '/team-ops?tab=performance&rtab=leaderboard&focus=perday' },
  })

  // -- speed: the remedy that costs money --
  // No date on this rung, and two wrong ones were tried before that was settled. The
  // day the backlog would CLEAR is what happens if nobody is added, printed under a
  // sentence asking for people. The day the ASK lands is `catchUpPersonDays`, which is
  // a snapshot of the stock and ignores intake entirely - and law 7 puts the intake gap
  // two rows above it, so the reader can see for themselves that three more weeks of
  // that gap is another 2,500 games. Any date here is a promise this arithmetic does
  // not buy. The payoff says the one thing the instruction does not: the size of the
  // move, from what it is now to what it is being bought down to.
  if (!paceIsShort && daysToClear != null && daysToClear > T.clearDays && catchUpPersonDays >= 1) acts.push({
    sev: 2, key: 'capacity', topic: 'speed', family: 'backlog', priciest: true,
    // "Add 1,153 person-days" is a true number in a unit nobody hires in, and it is the
    // one line on the tab that names a quantity of PEOPLE - so it has to say how many
    // people, for how long. `heads` is what the team actually runs on, so the ask is
    // expressed as more of that, over whole weeks.
    lead: 'Add',
    rest: <>{peopleAsk} to get the backlog under {T.clearDays} days of work</>,
    why: <>{fmt.int(stock)} games in the backlog · the team clears {perDayFmt(perDay)} a day · that is {fmt.dec(daysToClear)} days of work</>,
    payoff: <>{fmt.dec(daysToClear)} days of work down to {T.clearDays}</>,
    cta: { label: 'Open Assign preview', href: '/team-ops?tab=assign' },
  })

  // -- age: the remedy that costs the work itself --
  // The oldest band measured against the pace that would have to reach it. Four times
  // the whole backlog's own target is the line: past that, "we will get to them" is not
  // a plan, it is a sentence, and saying so is the only honest thing left to print.
  //
  // ONE instruction, and no "or" inside it. This used to read "put them at the front,
  // or drop them", and its payoff - days to clear falling - is true of the drop and not
  // of the reordering, which moves no work at all. Reordering is what the two `age`
  // remedies above already ask for; law 7's last rung is the one they are an
  // alternative TO. So this line is the drop and nothing else, its payoff answers
  // exactly it, and the only "or" on the line is the one law 7 puts at the front.
  const oldest = stockAge.a3
  if (oldest > 0 && perDay > 0 && daysToClear != null && oldest / perDay > T.clearDays * 4) acts.push({
    sev: 2, key: 'tail', topic: 'age', family: 'backlog',
    lead: 'Drop',
    rest: <>the {fmt.int(oldest)} games past 15 days</>,
    why: <>Games past 15 days alone are {fmt.dec(oldest / perDay)} days of work at {perDayFmt(perDay)} a day.</>,
    payoff: <>Days to clear falls from {fmt.dec(daysToClear)} to {fmt.dec(Math.max(0, stock - oldest) / perDay)}</>,
  })

  // -- quality --
  // One line left here, and it is about a gate rather than a person: work sitting
  // un-triaged is a fact about the flow. The re-judge line that used to sit beside it
  // was a verdict on how the team judges, and left with law 3.
  if (f.shortlisted > 0 && f.finalPriority === 0) acts.push({
    sev: 1, key: 'notriage', topic: 'quality',
    lead: 'Ask',
    rest: <>a moderator to triage this {winName}&apos;s shortlist</>,
    why: <>{fmt.int(f.shortlisted)} shortlisted, none judged yet</>,
  })
  const shown = rankActs(acts)

  // One clause, and it answers "can the team get through this?" rather than reciting
  // the two numbers the KPI row already carries. The chips under it are the arithmetic
  // that produced it, so the sentence never has to defend itself in its own words.
  const headline = daysToClear == null
    ? (outTotal >= inTotal ? 'The team is clearing more than it takes in.' : 'The team is taking in more than it clears.')
    : daysToClear <= T.clearDays ? 'The team is on top of the backlog.'
      : net <= 0 ? 'The backlog is large, but the team is pulling it down.'
        // Its own test, and deliberately a different one from the `tail` action's:
        // this asks whether the stale share is growing FASTER than it is being cleared
        // (a fact about the window), where `tail` asks whether the 15d+ band is now
        // beyond reach at the current pace (a fact about the stock). The sentence must
        // not claim the old games are sitting on a window where the team is
        // demonstrably working through them, which is what `tailGrowing` rules out.
        : tailGrowing && agedShare > T.agedShare ? 'The backlog is outgrowing the team, and the oldest games are sitting.'
          : 'The backlog is outgrowing the team.'
  /* Each chip is the arithmetic behind one clause of the sentence, and each one has to
     read as a sentence itself. The shorthand they replace was written for the person
     who already knew: "Backlog +927 this month" never says whether 927 IS the backlog
     or the change in it, and "894 waiting 8+ days · 23%" leaves the reader to guess
     what the 23% is a share OF. Both were reported as unreadable by the person the tab
     is for, which is the only test that counts. `topic` is the same key the KPI it was
     computed from and the actions about it carry. */
  const chips: Array<{ key: Topic; text: React.ReactNode; tone: 'good' | 'warn' | 'bad' }> = stock > 0 ? [
    {
      key: 'growth', tone: net > 0 ? (gap > T.intakeGap ? 'bad' : 'warn') : 'good',
      // Three sentences, not one with a sign in front of it: "0 more games arrived than
      // were cleared" is arithmetic, not English, and a reader who meets it first reads
      // the whole banner as a machine talking to itself.
      text: net > 0
        ? <><b>{fmt.int(net)}</b> more games arrived than were cleared this {winName}</>
        : net < 0
          ? <><b>{fmt.int(-net)}</b> more games were cleared than arrived this {winName}</>
          : <>As many games were cleared as arrived this {winName}</>,
    },
    ...(daysToClear != null ? [{
      key: 'speed' as Topic,
      tone: (daysToClear > T.clearDays * 3 ? 'bad' : daysToClear > T.clearDays ? 'warn' : 'good') as 'good' | 'warn' | 'bad',
      text: <><b>{fmt.dec(daysToClear)} days</b> to clear the whole backlog at the current {fmt.int(perDay)} games/day</>,
    }] : []),
    {
      key: 'age', tone: agedShare > T.agedShare ? 'bad' : agedShare > T.agedShare / 2 ? 'warn' : 'good',
      // "since import" is not decoration. The `holders` action a few lines above this
      // chip counts stale games from the ASSIGN date at the admin's configured
      // threshold, so a shorter threshold legitimately produces a larger count than
      // this band does - and a manager reading 1,141 over 1,096 with nothing on screen
      // saying the clocks differ concludes one of them is broken. The band stays a
      // fixed ruler and `staleDays` stays a threshold; only the label is added.
      text: <><b>{fmt.int(oldStock)} games</b> have waited 8+ days since import - {fmt.pct(agedShare)} of the backlog</>,
    },
  ] : []
  // The banner takes the colour of its worst chip. The sentence is a summary of them,
  // so it cannot read calmer than the numbers under it.
  const verdictTone = chips.some((c) => c.tone === 'bad') ? 'bad'
    : chips.some((c) => c.tone === 'warn') ? 'warn' : 'good'

  /* Send the reader to the number a chip or an action was computed from. The lookup is
     by `data-rp-focus` from the page root rather than by a ref per target, so adding a
     KPI or moving a card cannot silently break the link - and the chip never has to
     know where on the page its evidence ended up. Scoped to `.page` rather than the
     document so a second Report mounted in a test or a modal cannot be scrolled by
     this one. */
  const focus = (key: Topic) => {
    const el = bannerRef.current?.closest('.page')?.querySelector(`[data-rp-focus="${key}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('rp-flash')
    window.setTimeout(() => el.classList.remove('rp-flash'), 1200)
  }

  /* Law 7, applied to the list that actually printed. Two things are decided here and
     nowhere else, because both depend on which lines SURVIVED the cap of three:

     - "Or". A remedy printed directly under another remedy for the same problem is an
       alternative to it, so it opens with "Or" and its verb drops its capital. The test
       is ADJACENCY, not "is it the first of its family anywhere in the list". `pace` is
       a diagnosis and carries no family, and it can rank between two remedies - which
       put "Find what changed in the working day before adding people" directly above
       "Or each person adds 100 games a day", where the "Or" reads as an alternative to
       investigating: the exact misreading the pace/capacity interlock exists to stop.
       An "Or" whose antecedent is two lines up, with something unrelated in between, is
       not an "Or". This lives in Overview rather than in `DoBlock`, which is shared
       with two tabs that have no cost ladder to order.
     - How expensive the capacity ask is, said out loud. ", the most expensive of the
       three" is a claim about the other lines on the screen, so it prints only when
       buying people really is the last rung shown: presented as an alternative, and
       with nothing costlier under it. Alone, or with "drop the oldest games" printed
       below, it says nothing. */
  const famTotal = new Map<string, number>()
  for (const a of shown) if (a.family) famTotal.set(a.family, (famTotal.get(a.family) ?? 0) + 1)
  const famCount = new Map<string, number>()
  let prevFamily = ''
  const doActs: DoAct[] = shown.map((a) => {
    const fam = a.family ?? ''
    const alt = !!fam && prevFamily === fam
    const cheaper = fam ? famCount.get(fam) ?? 0 : 0
    if (fam) famCount.set(fam, cheaper + 1)
    prevFamily = fam
    const total = fam ? famTotal.get(fam) ?? 1 : 1
    const isLast = cheaper === total - 1
    return {
      sev: a.sev, key: a.key,
      kicker: TOPIC[a.topic],
      kickerTitle: `Go to the ${TOPIC[a.topic].toLowerCase()} number behind this`,
      do: <>{alt ? `Or ${a.lead.toLowerCase()}` : a.lead} {a.rest}</>,
      why: a.why,
      payoff: a.payoff != null && a.priciest && alt && isLast
        ? <>{a.payoff}, the {total >= 3 ? 'most expensive of the three' : 'more expensive of the two'}</>
        : a.payoff,
      cta: a.cta,
      onKicker: () => focus(a.topic),
    }
  })

  return (
    <>
      {/* First on the page, because a reader who does not know what the numbers mean
          cannot use them, and a card placed after them is a card read after the damage
          is done. Which window is on screen is not repeated here - it is a filter
          state, and it lives on the filter bar. */}
      <Guide title="Overview - can the team get through what is in front of it?"
        read={[
          <span key="1">One sentence, three chips and four numbers are the answer. Every chart below is where they came from.</span>,
          <span key="1c">The small line inside a KPI is that number {unitName} by {unitName} across the window - the caption under it says what it counts. The grey line below is the comparison{pv ? <> against <b>{pv.label}</b></> : null}.</span>,
          <span key="2">Flow &amp; stock: blue arriving, amber finished, dashed line the backlog behind both.</span>,
          <span key="3">Two different references, on purpose: the KPI row compares with {pv ? <b>{pv.label}</b> : <>the period before</>}, because that is the window you picked. <b>Team health</b> compares with the 90 days before it - a standing bar should not move when you change the filter.</span>,
        ]}
        act={[
          <span key="1">Nothing under &ldquo;Do this&rdquo; means nothing crossed a threshold this {winName}.</span>,
          <span key="2">At most three actions show, worst first. The rest wait for next {winName}.</span>,
          <span key="3">Every action is about clearing faster or judging better. Intake size is set upstream, in the push filter.</span>,
        ]} />

      {/* The verdict: one sentence and the three readings it was made from, as one
          object. They used to be a headline and a row of pills stacked in the page
          flow, which left the reader to work out that the pills were the evidence for
          the sentence rather than three more facts. Each chip is a control - it takes
          you to the number it came from. */}
      <div className={`rp-verdict ${verdictTone}`} ref={bannerRef}>
        <p className="rp-headline">{headline}</p>
        {chips.length > 0 && (
          <div className="rp-chips">
            {chips.map((c) => (
              <button type="button" className={`rp-chip ${c.tone}`} key={c.key} onClick={() => focus(c.key)}
                title={`Go to the ${TOPIC[c.key].toLowerCase()} number this came from`}>
                <span className="rp-chip-kicker">{TOPIC[c.key]}</span>
                <span className="rp-chip-text">{c.text}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Five numbers, read left to right as one sentence: what arrived, what went out,
          what is left over, how fast it is going out, and how much of it was worth
          keeping. In / out / stock / speed / quality. The spec capped Tier 1 at four
          numbers; five earn their place here because dropping any one breaks the
          sentence, and because Assigned used to appear ONLY on batch view - where the
          pipeline is null - so the tab changed shape depending on the filter. */}
      <div className="rp-kpi-row">
        <Kpi label="Assigned" value={fmt.int(inTotal)} sub={`new intake this ${winName}`}
          spark={p && p.series.length >= 2 ? done(p.series.map((r) => r.newGames)) : undefined}
          noTrend sparkNote={`games per ${unitName}`} sparkColor={CAT[1]} tip={TIP.assigned} />
        <Kpi label="Evaluated" value={fmt.int(outTotal)} sub={`cleared this ${winName}`} hi
          spark={done(ms.map((m) => m.volume))} noTrend sparkNote={`games per ${unitName}`} tip={TIP.evaluated} />
        {/* Backlog's sub is not "N days of work" - the chip above the KPI row already
            says that. What the number itself needs is its scope: this is every
            unevaluated game ever imported, not the leftovers of the window on screen.

            No trend badge. It used to carry one, derived from the last two points of
            the sparkline - so on a month view it compared one day against the day
            before and printed it beside a number that means "right now, all history".
            Nothing on screen said which of the two it belonged to. */}
        {/* Where the GROWTH chip lands. The chip's number is made of Assigned minus
            Evaluated, but the pile that absorbed the difference is the thing worth
            looking at, and it is the only one of the three that is a level. */}
        <Kpi label="Backlog" value={fmt.int(stock)} sub="unevaluated, all history" noTrend focusKey="growth"
          spark={p && p.series.length >= 2 ? p.series.map((r) => r.backlog) : undefined}
          sparkNote={`backlog at each ${unitName}'s end`} sparkColor={CAT[3]} tip={TIP.backlog} />
        {/* The team's pace, not a person's - see `perDay`. No sparkline: per bucket it
            would be `evaluated ÷ a constant`, which is the Evaluated spark two cards to
            the left with a different y scale. Drawing the same shape twice and calling
            it two readings is the thing this KPI row was cleaned up to stop. */}
        <Kpi label="Games per day" value={perDayFmt(perDay)} sub={`cleared per day, whole team${elapsedDays > 0 ? ` · over ${fmt.int(elapsedDays)} days` : ''}`}
          noTrend focusKey="speed" tip={TIP.gppd}
          bench={prevPerDay > 0 ? {
            text: `${kpiRefNote} ${perDayFmt(prevPerDay)}`,
            delta: (perDay - prevPerDay) / prevPerDay,
            tone: vsRef(perDay, prevPerDay) === 'bad' ? 'bad' : vsRef(perDay, prevPerDay) === 'good' ? 'good' : 'flat',
          } : null} />
        <Kpi label="Shortlist rate" value={srVal} sub={`${fmt.int(f.shortlisted)} of ${fmt.int(f.evaluated)} evaluated`} focusKey="quality"
          spark={done(rated.map((m) => Math.round(m.survivalRate * 1000)))} noTrend sparkNote={`rate per ${unitName}`}
          sparkColor={CAT[3]} tip={TIP.survival}
          bench={kpiRef.survival > 0 ? {
            text: `${kpiRefNote} ${srFmt(kpiRef.survival)}`,
            delta: (t.survivalRate - kpiRef.survival) / kpiRef.survival,
            tone: vsRef(t.survivalRate, kpiRef.survival) === 'bad' ? 'bad' : vsRef(t.survivalRate, kpiRef.survival) === 'good' ? 'good' : 'flat',
          } : null} />
      </div>

      <div className="rp-strip-2">
        <BandBar label="Initial conclusions mix"
          bands={orderedBands(d.initialConclusions, INIT_ORDER)} />
        <BandBar label="Backlog by age" focusKey="age" total={`${fmt.int(stock)} waiting`}
          empty="Nothing waiting."
          bands={AGE_BANDS.map((b) => ({ name: b.label, value: stockAge[b.k], color: b.color }))} />
      </div>

      <DoBlock acts={doActs} />

      <div className="rp-section-title">Flow - what came in, what went out</div>
      <div className="rp-grid-70-30">
        <Card label="Flow &amp; stock" note={p ? `games in and out per ${unitName}, and the backlog underneath` : 'assigned vs evaluated per bucket'}
          tip={<>
            <F>in = count(imported_at), per {unitName}</F>
            <F>out = count(evaluate_date), per {unitName}</F>
            <F>backlog = Σ in − Σ out, cumulative over all history</F>
            All three count games, so all three share one axis. The backlog line runs far
            above the flow lines, and that gap is the reading: a {unitName} of work is a
            fraction of what is already waiting.
            A batch window has no time axis, so it falls back to Assigned vs Evaluated.
          </>}>
          <LineChart series={flowSeries} area />
          <ReadNote>Blue above amber means falling behind that {unitName}. The dashed backlog line is what the gap adds up to, so read its slope.</ReadNote>
        </Card>
        {/* The denominator of "Games per day", on the same days as the chart beside it.
            Without it a thin week and a slow week look identical, which is the first
            thing anyone asks when the pace gauge is short. It cannot share the flow
            chart's axis - people run 4 to 11, games run in the thousands - so it gets
            its own card rather than a second axis. */}
        <Card label="People working" note={`evaluators who logged work, per ${unitName}`} fill
          tip={<><F>= count(distinct initial_evaluator), per {unitName}</F>Anyone who judged at least one game that {unitName}, not the roster. This is the divisor behind Games per day, so read a dip here before reading the pace gauge as a slowdown.</>}>
          {/* indigo, not the red of CAT[5]: a headcount is a fact, and red here both
              read as an alarm and collided with the 15d+ age band next door */}
          {peopleCols.length ? <ColumnChart data={peopleCols} color={CAT[4]} name="Evaluators" fill /> : <Empty text="Needs a time axis" />}
          {peopleLow && <ReadNote>Thinnest {unitName} was <b>{peopleLow.label}</b> with {peopleLow.value} working, against {peopleHigh} at the fullest.</ReadNote>}
        </Card>
      </div>

      <Card label="New games by source" note="which importer the intake came from, per bucket"
        tip={<><F>= count(imported_at) grouped by game_info.type</F>Which importer found the game: the apkcombo, appagg, top-pub and insight-track scrapers, the store sync, or a person adding one by hand. The total matches &ldquo;New games in&rdquo; above; this chart splits it by where the games came from. Volume only - how well a source converts is a question about the push filter, not about this team.</>}>
        {srcRows.length ? <StackedBars rows={srcRows} keys={srcKeys} colors={srcColors} unit="that bucket's" /> : <Empty text={p ? 'No intake in this window' : 'Needs a time axis - switch View by to Week, Month, Quarter or Custom'} />}
        {srcLegend.length > 0 && (
          <div className="rp-srcleg">
            {srcLegend.map((r) => (
              <span className="rp-srcleg-item" key={r.name}>
                <span className="rp-dot" style={{ background: srcColors[r.name] }} />
                <span className="rp-srcleg-name">{r.name}</span>
                <span className="rp-srcleg-n">{fmt.int(r.n)}</span>
                <span className="rp-srcleg-pct">{fmt.pct(r.share)}</span>
              </span>
            ))}
            {srcRest > 0 && (
              <span className="rp-srcleg-item">
                <span className="rp-dot" style={{ background: 'var(--faint)' }} />
                <span className="rp-srcleg-name">{srcRest} smaller</span>
                <span className="rp-srcleg-n">{fmt.int(srcRestN)}</span>
                <span className="rp-srcleg-pct">{fmt.pct(srcRestN / srcIn)}</span>
              </span>
            )}
          </div>
        )}
      </Card>

      <div className="rp-section-title">Quality - what survives, and how the team is holding up</div>
      <div className="rp-grid-2-1">
        <Card label="Shortlist funnel" note="evaluated → shortlist → final priority"
          tip={<><F>shortlist = initial conclusion ≠ bypass</F><F>final = Priority IV + Insight</F>It starts at Evaluated. Assigned counts new intake, a different set of games, which belongs in the flow chart above. Each band carries its conversion from the band over it.</>}>
          <Funnel stages={funnelStages} />
          <ReadNote>{worstStep ? <>Narrowest neck: <b>{worstStep.from} → {worstStep.to}</b>, {fmt.pct(worstStep.b / worstStep.a)} through.</> : 'Read the conversion between steps.'}</ReadNote>
        </Card>
        <Card label="Team health" note={`this window vs ${refNote}`}
          tip={<><F>notch = {bl ? `the same metric over the ${bl.days} days before this window` : 'the average of the buckets on screen'}</F>The notch sits where the team normally runs, and it moves as the team does, so a bar that reaches it reads as normal rather than as hitting a number somebody once picked.<br />The <b>small line</b> beside each value is that same metric {unitName} by {unitName} across the window on screen: it says whether the gauge is a step in a trend or a one-off wobble. The <b>▲▼ figure</b> under the bar is the change from the second-to-last {unitName} to the last one, in points.<br />Unlike the KPI row above, this card stays on the 90-day reference whatever window you pick - it is a threshold, not a comparison.</>}>
          <HealthBars rows={health} unitName={unitName} />
        </Card>
      </div>

      <div className="rp-grid-70-30">
        <Card label="Quality rates over time" note="shortlist &amp; hit %, per bucket"
          tip={<><F>shortlist rate = shortlist ÷ evaluated</F><F>hit rate = final priority ÷ evaluated</F>Each point covers only the games judged in that {unitName}, both halves of the ratio. The line therefore tracks pick quality on its own, free of how much intake happened to land.</>}>
          {ms.length >= 2 ? <LineChart series={rateSeries} format={(v) => `${v.toFixed(1)}%`} /> : <Empty text="Need more than one period" />}
        </Card>
        <Card label="Final conclusions" note="moderator outcomes"
          tip={<><F>= distribution of final_conclusion</F>Only shortlisted games ever get one, so this is usually tens of games. At that size a pie chart is unreadable, which is why it is a list.</>}>
          <ConclusionList data={d.finalConclusions} />
        </Card>
      </div>

      <div className="rp-section-title">Backlog - is the stale end rotting or clearing?</div>
      <div className="rp-grid-2">
        <Card label="Backlog by age over time" note="how old the games still waiting were, end of each bucket"
          tip={<><F>age = bucket end day − import day, for games still unevaluated</F><F>median = half the backlog has waited less than this</F>The same stock the backlog line draws, split into age groups instead of one total. Read it beside the chart on the right: same bands, same colours, so the two say what is waiting against what actually got done.</>}>
          {aging.length ? <StackedBars rows={aging.map((r) => ({ name: r.label, parts: ageParts(r) }))} keys={AGE_KEYS} colors={AGE_COLORS} unit="that bucket's" /> : <Empty text="Needs a time axis" />}
          <ReadNote>{ageInsight}</ReadNote>
        </Card>
        {/* The chart on the left is a snapshot: it shows the 8-14d pile shrinking
            without saying whether those games were judged or turned 15d+. This one
            counts the two events that move a game, on the same days, out of a shared
            centre line - so a bucket reads as ground gained or ground lost. */}
        <Card label="Judged vs aged" note={`what moved each ${unitName}, and which way`}
          tip={<>
            <F>right = evaluated that {unitName}, by age on the day it was judged</F>
            <F>left = crossed into an older band that {unitName} (import day + 4, + 8, + 15)</F>
            Both sides count EVENTS, not stock, so one game can appear at most once on
            each: it is judged once, and it passes a boundary once. That is what makes
            the two halves addable across buckets, which a snapshot chart never is.
            Same scale both ways - the longer side is the reading.
          </>}>
          {divRows.length ? (
            <DivergingBars rows={divRows} rightKeys={AGE_KEYS} leftKeys={AGED_KEYS} colors={AGE_COLORS}
              leftLabel="Aged into" rightLabel="Judged" />
          ) : <Empty text="Needs a time axis" />}
          <ReadNote>{divInsight}{avgWait != null && <> Average wait, import to evaluation: <b>{fmt.dec(avgWait)}d</b>.</>}</ReadNote>
        </Card>
      </div>
    </>
  )
}

/* ---------------- Leaderboard (absorbs the old Compare + Activity tabs) ---------------- */
// One place to answer "who is doing well", and one table to answer it with. The eight
// single-metric rank boards, the eight-series radar and the two bump charts are gone:
// between them they filled a screen with orderings and still could not show what one
// person looks like read across all of them at once.
// Thresholds, same shape as Overview's `T`: a line under "Do this" prints only when a
// number crosses one of these. They belong in report_config next to the score weights;
// they live here until that page has a home for them.
const LB_T = {
  // Gap in bypass share between the strictest and the loosest evaluator. Past this the
  // team's shortlist rate is an average of two different bars, and no quality column on
  // this tab compares anybody.
  calSpread: 0.15,
  // Under this many games a bypass share is a run of luck, not a bar.
  calMin: 50,
  // One person carrying this much of the output is a single point of failure.
  concentration: 0.4,
  turnMult: 2, // times the team's average days waiting
  turnMin: 50, // ... over at least this many games, or one slow game sets the record
  idleShare: 0.4, // share of buckets in which someone evaluated nothing
  // Gap in how well two people's picks survive the moderator. Below this the two are
  // judging alike and the pairing would teach nobody anything.
  pickGap: 0.15,
  // Outlier on shortlist rate. BOTH gates have to pass, because each one alone is
  // wrong in a way the other fixes:
  //   ratio - how many times the team's rate they keep. The size of the thing.
  //   z     - how much of that a sample this size could have produced by chance.
  // On all-time the team judges 58,000 games, so the standard error is a fifth of a
  // point and a 2-point gap scores z = 12: significance alone stops discriminating.
  // The other way round, 3 shortlists out of 6 games is 9x the team rate and means
  // nothing. The 50-game floor is `calMin`, the same one the bypass bar uses.
  //
  // The two sides are NOT mirror images, on purpose. A high rate is the cheap kind of
  // outlier - a lower bar, or a lucky run - so it has to be extreme before it is worth
  // a line. A low rate is the expensive kind: signal being thrown away, and nobody
  // downstream ever sees what was dropped. Half the team's rate is already too far.
  outlierHigh: 5,
  outlierLow: 0.5,
  outlierZ: 2,
}

function Leaderboard({ d, focusOnce, onConsumeFocus }: {
  d: Bundle
  // A one-shot key from Overview's "See who is under the pace" link. Read once, held
  // in local state (NOT re-derived from `focusOnce` on every render) so the ring plays
  // once and then stops - a re-render half a second later must not restart it, and the
  // parent clearing its own copy must not erase the flash mid-animation.
  focusOnce?: string
  onConsumeFocus?: () => void
}) {
  const ev = d.evaluators
  const sd = staleDays(d)
  const [flashPerDay] = useState(focusOnce === 'perday')
  useEffect(() => {
    if (focusOnce !== 'perday') return
    onConsumeFocus?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const W = d.config.weights
  const winName = windowNoun(d)
  // The heatmap's grain, NOT the trend charts'. They differ on every view except a
  // plain week, and reading cadence off one while naming it with the other printed
  // "13 of 13 weeks with nothing evaluated" over a grid of thirteen days.
  const unitName = d.activityUnit === 'day' ? 'day' : d.activityUnit === 'week' ? 'week' : 'month'
  const unitNames = `${unitName}s`
  // Same rule as Overview: the current window's last bucket is a part-period, and
  // anything read as a rank or a trend has to stop before it. "Dropped four places"
  // off a bucket that is three hours old is a fact about the clock.
  const partialTail = !d.window.to || d.window.to > vnTodayIso()
  const done = <V,>(a: V[]) => (partialTail && a.length > 1 ? a.slice(0, -1) : a)

  const active = ev.filter((e) => e.evaluated > 0)
  const totalEval = active.reduce((s, e) => s + e.evaluated, 0)

  // ---- Overall score: one number for how much someone did and how well they did it.
  // Volume keeps its configured weight undiscounted - it IS the evidence. Every other
  // axis is scaled by SAMPLE WEIGHT = min(1, their games ÷ the team's median), because
  // a rate computed over 30 games swings wildly and used to let a light workload
  // outrank sustained output on one lucky run.
  const volumes = active.map((x) => x.evaluated).sort((a, b) => a - b)
  const medianVol = volumes.length ? volumes[Math.floor(volumes.length / 2)] : 0
  const sampleWeight = (games: number) =>
    d.config.credibility ? (medianVol > 0 ? Math.min(1, games / medianVol) : 1) : 1
  const scoreBy = new Map<string, number>()
  for (const r of d.radar) {
    const e = ev.find((x) => x.key === r.key)
    // Someone who judged nothing this window has no score, not a score of zero: the
    // radar axes they are normalized against are all zero too, so the number would be
    // an artefact of the arithmetic rather than a statement about them.
    if (!e || e.evaluated === 0) continue
    scoreBy.set(r.key, allRounderScore(r.axes, W, sampleWeight(e.evaluated)))
  }
  const score = (e: Ev) => (scoreBy.has(e.key) ? scoreBy.get(e.key)! : null)

  // ---- is the team judging by one bar? ----
  const bypassShare = (e: Ev) => {
    const tot = Object.values(e.initialConclusions).reduce((s, n) => s + n, 0)
    return tot > 0 ? (e.initialConclusions['Bypass'] || 0) / tot : 0
  }
  const calPool = active.filter((e) => e.evaluated >= LB_T.calMin)
    .sort((a, b) => bypassShare(b) - bypassShare(a))
  const strict = calPool[0], loose = calPool[calPool.length - 1]
  const calSpread = calPool.length >= 2 ? bypassShare(strict) - bypassShare(loose) : null

  // ---- whose backlog is not moving ----
  const teamTa = d.teamTotals.avgTurnaround
  const stuck = teamTa != null
    ? active.filter((e) => e.turnaround != null && e.turnaround > teamTa * LB_T.turnMult && e.evaluated >= LB_T.turnMin)
      .sort((a, b) => b.turnaround! - a.turnaround!)
    : []

  // ---- who is carrying the tab ----
  const top = [...active].sort((a, b) => b.evaluated - a.evaluated)[0]
  const topShare = top && totalEval > 0 ? top.evaluated / totalEval : 0

  // ---- cadence, off the heatmap's own buckets ----
  const periods = done(d.heatmap.periods)
  // A TRAILING run of empty buckets, not a count of holes anywhere in the row. Total
  // gaps answered the wrong question and contradicted the table next to it: it printed
  // "13 of 13 weeks with nothing evaluated" beside a row showing 17 games, because the
  // person's whole month landed in the part-bucket that gets trimmed. A trailing run
  // says the thing the tab is actually asking - who has stopped - and it cannot
  // contradict a number on screen, because any recent work ends the run.
  // The part-bucket is trimmed from the count but NOT from the test: a game judged
  // this morning is weak evidence of a rate and conclusive evidence of presence. Skip
  // that and the month view claimed someone had been silent for thirteen days beside a
  // row crediting them with seventeen games, all of them landing today.
  const silentFor = (r: Bundle['heatmap']['rows'][number]) => {
    const all = d.heatmap.periods
    if (all.length > periods.length && (r.cells[all[all.length - 1].key] || 0)) return 0
    let n = 0
    for (let i = periods.length - 1; i >= 0 && !(r.cells[periods[i].key] || 0); i--) n++
    return n
  }
  // Anyone the speed line already names is out of the running here: "unblock NhiLV's
  // backlog" directly above "ask NhiLV whether it is leave or a stalled backlog" is one
  // problem spending two of the three lines, and the second asks a question the first
  // already answered. Dropping them from the pool rather than suppressing the line
  // means the next-most-silent person still gets said.
  const idle = periods.length >= 3
    ? d.heatmap.rows.filter((r) => !stuck.some((e) => e.name === r.name))
      .map((r) => ({ name: r.name, gaps: silentFor(r) }))
      .filter((r) => r.gaps > 0).sort((a, b) => b.gaps - a.gaps)[0]
    : null
  // Biggest movers: rank over the first half of the window against the second. This is
  // the whole of what two bump charts used to say - seven lines crossing over seven
  // days was a tangle, and a day-grain rank of a composite score that had to drop two
  // of its five axes to survive one day was noise with a shape.
  //
  // Halves, not endpoints. First-bucket-against-last is the mistake this report has
  // already made once: it ranked everybody off whoever happened to be working on the
  // 1st, which on a quiet day is one person, and the line then either said nothing or
  // said something enormous about a Sunday.
  const movers = (() => {
    if (periods.length < 4) return null
    const half = Math.floor(periods.length / 2)
    const sum = (r: Bundle['heatmap']['rows'][number], ps: typeof periods) =>
      ps.reduce((s, p) => s + (r.cells[p.key] || 0), 0)
    const rankOver = (ps: typeof periods) => {
      const present = d.heatmap.rows.filter((r) => sum(r, ps) > 0).sort((a, b) => sum(b, ps) - sum(a, ps))
      return new Map(present.map((r, i) => [r.name, i + 1]))
    }
    const before = rankOver(periods.slice(0, half)), after = rankOver(periods.slice(half))
    // Only people who worked in BOTH halves: someone who was on leave for the first
    // half has not climbed, they have arrived.
    const deltas = d.heatmap.rows.filter((r) => before.has(r.name) && after.has(r.name))
      .map((r) => ({ name: r.name, delta: before.get(r.name)! - after.get(r.name)!, to: after.get(r.name)! }))
      .sort((a, b) => b.delta - a.delta)
    if (deltas.length < 2) return null
    const up = deltas[0], down = deltas[deltas.length - 1]
    return up.delta > 0 || down.delta < 0 ? { up, down } : null
  })()

  // ---- the lead chart: how much against whether it held up ----
  // Only people with enough games are PLOTTED. On a real week the roster splits into
  // two populations with a 15x gap between them - six people on 224 to 957 games, and
  // four on 4 to 15 - and the second group breaks the chart three ways: their rates
  // (27% to 57%) are sampling noise, that noise stretches the y axis over a range
  // nobody else occupies, and it drags the reference lines above every working
  // evaluator. They are named under the chart instead, and they keep their row in the
  // table, which is where a per-person number belongs anyway.
  const plotted = active.filter((e) => e.evaluated >= LB_T.calMin)
  const thin = active.filter((e) => e.evaluated < LB_T.calMin).sort((a, b) => b.evaluated - a.evaluated)
  // POOLED, not the mean of the rates: a mean of ratios weights a 6-game rate the same
  // as a 957-game one, which put the team line at 21% when the team actually keeps
  // 5.7%. This is also the figure Overview shows, so the two tabs now agree.
  const poolEval = plotted.reduce((s2, e) => s2 + e.evaluated, 0)
  const poolShort = plotted.reduce((s2, e) => s2 + e.shortlisted, 0)
  const teamKeep = poolEval > 0 ? poolShort / poolEval : 0
  const avgVol = plotted.length ? poolEval / plotted.length : 0
  const scatterPts = plotted.map((e, i) => ({
    name: e.name, x: e.evaluated, y: e.survivalRate * 100, size: Math.max(0.1, e.throughput), color: CAT[i % CAT.length],
  }))
  // How far off the team someone is, and whether a sample that size could have done it
  // by luck. `ratio` is the size of the claim; `z` is the evidence for it.
  //
  // Both are measured against EVERYONE ELSE, not against a pool the person is inside.
  // An outlier drags the bar it is being judged by: one evaluator who kept 84 of 95
  // games put those 84 into the team total and so scored 4.7x - just under the line -
  // when against the other four people they were 10.1x. The bigger the outlier, the
  // harder self-inclusion works to hide it, which is exactly backwards.
  const restKeep = (e: Ev) => {
    const oe = poolEval - e.evaluated, os = poolShort - e.shortlisted
    return oe > 0 ? os / oe : teamKeep
  }
  const ratioOf = (e: Ev) => {
    const rest = restKeep(e)
    return rest > 0 ? e.survivalRate / rest : 0
  }
  const zOf = (e: Ev) => {
    const rest = restKeep(e)
    const se = Math.sqrt((rest * (1 - rest)) / Math.max(1, e.evaluated))
    return se > 0 ? (e.survivalRate - rest) / se : 0
  }
  const loud = (e: Ev) => Math.abs(zOf(e)) >= LB_T.outlierZ
  const outHigh = plotted.filter((e) => loud(e) && ratioOf(e) >= LB_T.outlierHigh)
    .sort((a, b) => ratioOf(b) - ratioOf(a))
  const outLow = plotted.filter((e) => loud(e) && ratioOf(e) <= LB_T.outlierLow)
    .sort((a, b) => ratioOf(a) - ratioOf(b))
  // "keeps 1 game in 18" lands where "5.7%" has to be converted first - but only while
  // the rate is small. At 88% the same form reads "1 game in 1", so a high rate goes
  // back to a percentage, and BOTH sides of a comparison switch together: a sentence
  // that puts "1 in 96" against "9%" makes the reader convert one of them.
  const oneIn = (r: number) => (r > 0 ? fmt.int(1 / r) : '\u221e')
  const keepOne = (r: number) => (r >= 0.25 ? fmt.pct(r) : `1 in ${oneIn(r)}`)
  const keepPair = (a2: number, b2: number): [string, string] =>
    a2 <= 0 ? ['nothing', keepOne(b2)]
      : a2 >= 0.25 || b2 >= 0.25 ? [fmt.pct(a2), fmt.pct(b2)]
        : [`1 game in ${oneIn(a2)}`, `1 in ${oneIn(b2)}`]

  // ---- how each person judges, and how the moderator judged them back ----
  const initRows = [...active].sort((a, b) => b.evaluated - a.evaluated).slice(0, 12)
    .map((e) => ({ name: e.name, parts: { ...e.initialConclusions, ...(e.linkDead ? { Link_dead: e.linkDead } : {}) } }))
  const initKeys = orderedKeys(initRows.map((r) => r.parts), INIT_ORDER, ['Link_dead'])
  const finRows = active.filter((e) => Object.keys(e.finalConclusions).length > 0)
    .map((e) => ({ name: e.name, parts: e.finalConclusions }))
  const finKeys = orderedKeys(finRows.map((r) => r.parts), FINAL_ORDER, ['Not Found'])
  const holdUp = (e: Ev) => {
    const tot = Object.values(e.finalConclusions).reduce((s, n) => s + n, 0)
    return tot > 0 ? ((e.finalConclusions['Priority IV'] || 0) + (e.finalConclusions['Insight'] || 0)) / tot : 0
  }
  const finPeople = active.filter((e) => Object.values(e.finalConclusions).reduce((s, n) => s + n, 0) >= 5)
    .sort((a, b) => holdUp(b) - holdUp(a))

  // ---- what each chart says THIS window, for its footer. A reading, never an
  // instruction: every action on this tab lives in "Do this" and nowhere else. ----
  const pace = plotted.map((e) => e.throughput)
  const paceMax = pace.length ? Math.max(...pace) : 1
  // same curve the chart uses, so the key is the scale rather than a picture of one
  const scatterRad = (v: number) => 4 + Math.sqrt(v / Math.max(1e-9, paceMax)) * 9
  const bestRate = [...active].sort((a, b) => b.survivalRate - a.survivalRate)[0]
  const initTot = (e: Ev) => Object.values(e.initialConclusions).reduce((s2, n) => s2 + n, 0)
  const ideaShare = (e: Ev) => (initTot(e) > 0 ? (e.initialConclusions['List_Idea'] || 0) / initTot(e) : 0)
  const byIdea = [...active].filter((e) => initTot(e) >= LB_T.calMin).sort((a, b) => ideaShare(b) - ideaShare(a))
  const finTot = (e: Ev) => Object.values(e.finalConclusions).reduce((s2, n) => s2 + n, 0)
  const finJudged = active.filter((e) => finTot(e) > 0)
  const finGames = active.reduce((s2, e) => s2 + finTot(e), 0)

  // ---- who is holding the unevaluated backlog ----
  // A STOCK, read as of now and never sliced by the window - it is the same backlog
  // Overview's Backlog KPI counts, and the rows sum to that number. `net` is the
  // person's flow across the window on screen, which is the only part of this card
  // the filter bar moves: the size of the backlog is a fact about today, the direction
  // of travel is a fact about the window.
  const evByKey = new Map(ev.map((e) => [e.key, e]))
  const queueRows = (d.backlogBy || []).map((b) => {
    const e = evByKey.get(b.key)
    return {
      key: b.key, name: b.name, n: b.n, oldest: b.oldest,
      parts: [b.a0, b.a1, b.a2, b.a3],
      stale: b.stale,
      // null is not zero: someone who neither took nor cleared anything this window
      // has no direction of travel, and printing "level" would claim they held steady.
      net: e && (e.assigned > 0 || e.evaluated > 0) ? e.assigned - e.evaluated : null,
    }
  })
  const queueTotal = queueRows.reduce((s2, r) => s2 + r.n, 0)
  const queueStale = queueRows.reduce((s2, r) => s2 + r.stale, 0)
  const queueTop = queueRows[0] || null
  const queueGrowing = queueRows.filter((r) => (r.net ?? 0) > 0).sort((a, b) => (b.net ?? 0) - (a.net ?? 0))
  // ONE definition of "this person's backlog is in trouble", used by the bars, by the
  // footer and by the action below. Three places deciding it separately is how a chart
  // ends up flagging one set of people while the sentence under it names another.
  const queueWarn = queueRows
    .filter((r) => r.stale >= STALE.min && r.stale / r.n > STALE.share)
    .sort((a, b) => b.stale - a.stale)
  const warnKeys = new Set(queueWarn.map((r) => r.key))
  const nameList = (names: string[]) => names.length === 1 ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

  // ---- the answer: at most three moves, one per family ----
  // CALIBRATION (is the bar shared), SPEED (is anyone's backlog stuck), COVERAGE (is the
  // work spread), PICKS (do the shortlists hold up). One line per family, because three
  // versions of the same complaint fill the cap and leave the other problems unsaid.
  // `who` is the person the line is ABOUT. Two lines naming the same person is the
  // single most common way this block goes wrong: the reader gets one name three times
  // and the other problems on the team go unsaid. The family filter cannot catch it,
  // because the whole point of families is that different families say different
  // things - and "ThuDT bypasses too much" and "ThuDT's backlog has gone stale" are
  // genuinely different things about genuinely one person.
  type Act = {
    sev: number; fam: string; key: string; who?: string; do: React.ReactNode; why: React.ReactNode
    cta?: DoAct['cta']
  }
  const acts: Act[] = []

  // Shortlist rate and bypass share are the same quantity read from opposite ends, so
  // the spread and the outlier test measure one thing twice. They are kept apart by
  // job, not by metric: the outlier NAMES a person and is backed by a test, so it
  // leads; the spread only speaks when the team is smeared across a wide range with
  // nobody individually far enough out to name.
  if (outLow.length) acts.push({
    sev: 3, fam: 'cal', key: 'outlow', who: outLow[0].key,
    do: <>Re-read 20 games {outLow[0].name} bypassed, with a moderator</>,
    // "games" is said once, over the evaluated count. Repeating it in the projection
    // took this sentence to 153 characters on a real five-digit volume - over the
    // 150-character evidence budget the whole block is written to.
    why: <>{outLow[0].name} keeps {keepPair(outLow[0].survivalRate, restKeep(outLow[0]))[0]} where the rest of the team keeps {keepPair(outLow[0].survivalRate, restKeep(outLow[0]))[1]}, over {fmt.int(outLow[0].evaluated)} games. At the others&apos; rate that is about {fmt.int(outLow[0].evaluated * restKeep(outLow[0]))} sent on instead of {fmt.int(outLow[0].shortlisted)}.</>,
  })
  else if (calSpread != null && calSpread > LB_T.calSpread) acts.push({
    sev: 3, fam: 'cal', key: 'cal', who: strict.key,
    do: <>Have {loose.name} re-read 20 games {strict.name} bypassed, then agree where the bar sits</>,
    why: <>At {loose.name}&apos;s rate, {strict.name}&apos;s {fmt.int(strict.evaluated)} games would have sent on about {fmt.int(strict.evaluated * loose.survivalRate)} instead of {fmt.int(strict.shortlisted)}. Same backlog, same genre.</>,
  })
  else if (outHigh.length) acts.push({
    sev: 2, fam: 'cal', key: 'outhigh', who: outHigh[0].key,
    do: <>Have {outHigh[0].name} talk the team through 5 games they kept</>,
    why: <>{outHigh[0].name} keeps {keepPair(outHigh[0].survivalRate, restKeep(outHigh[0]))[0]} where the rest of the team keeps {keepPair(outHigh[0].survivalRate, restKeep(outHigh[0]))[1]}, over {fmt.int(outHigh[0].evaluated)} games. Either they see something the others do not, or their bar is lower.</>,
  })

  // SPEED: somebody's backlog has stopped moving. Two tests, ONE family, because both
  // end in the same move - shift work off a person - and printing them together spends
  // two of the three slots saying it twice about different names.
  //
  // The stale-pile test goes first and therefore wins the tie: it counts games that
  // are demonstrably sitting there right now and points at a button that moves them,
  // where turnaround is an average over the games that DID get judged, which a person
  // can keep low while a third of their backlog rots untouched.
  //
  // Anyone the calibration line above already named is dropped from the pool, so the
  // NEXT most stale person gets said instead of the backlog problem going unmentioned.
  // Dropping the line outright is the wrong fix: the `who` filter at the bottom would
  // do that, and a real problem on a second person would disappear because a first
  // person happened to have two.
  const spoken = new Set(acts.map((a) => a.who).filter(Boolean) as string[])
  const queueStuck = queueWarn.find((r) => !spoken.has(r.key))
  const stuckFree = stuck.filter((e) => !spoken.has(e.key))
  if (queueStuck) acts.push({
    sev: 3, fam: 'speed', key: 'backlog', who: queueStuck.key,
    // This is a name's problem, not the bucket's: Reassign moves what is named here,
    // where Overview's Rescue button scans and picks both sides itself. Two different
    // operations for two different altitudes - see law 2.
    do: <>Reassign {queueStuck.name}&apos;s backlog</>,
    why: <>{fmt.int(queueStuck.stale)} of {queueStuck.name}&apos;s {fmt.int(queueStuck.n)} games sat past {sd} days ({fmt.pct(queueStuck.stale / queueStuck.n)} of their backlog, {fmt.pct(queueStuck.stale / Math.max(1, queueStale))} of the team&apos;s stale total). Oldest is {queueStuck.oldest} days.</>,
    cta: { label: `Reassign ${queueStuck.name}`, href: `/team-ops?tab=reassign${catParam(d)}&from=${encodeURIComponent(queueStuck.name)}` },
  })
  else if (stuckFree.length) acts.push({
    sev: 3, fam: 'speed', key: 'stuck', who: stuckFree[0].key,
    do: <>Move part of {stuckFree.slice(0, 2).map((e) => e.name).join(' and ')}&apos;s backlog to someone with room</>,
    why: <>A game waits {stuckFree.slice(0, 2).map((e) => `${e.turnaround!.toFixed(0)} days with ${e.name}`).join(' and ')} before it is judged, against {teamTa!.toFixed(0)} days for the team</>,
  })

  if (top && active.length >= 3 && topShare > LB_T.concentration) acts.push({
    sev: 2, fam: 'cover', key: 'conc', who: top.key,
    do: <>Share {top.name}&apos;s backlog with a second person this {winName}</>,
    why: <>{top.name} judged {fmt.int(top.evaluated)} of the {fmt.int(totalEval)} games this {winName}. A day of their leave costs the team {fmt.int(top.throughput)} games.</>,
  })
  else if (idle && idle.gaps / periods.length > LB_T.idleShare) acts.push({
    sev: 2, fam: 'cover', key: 'idle', who: idle.name.toLowerCase(),
    do: <>Ask {idle.name} today whether it is leave or a stalled backlog</>,
    why: <>Nothing evaluated in their last {idle.gaps} {idle.gaps === 1 ? unitName : unitNames}, of {periods.length} on the heatmap</>,
  })

  // Held back while no moderator has judged anything yet: the final conclusion is
  // stamped days after the evaluation, so a fresh window reads every shortlist as weak.
  if (finPeople.length >= 2 && d.funnel.finalPriority > 0
    && holdUp(finPeople[0]) - holdUp(finPeople[finPeople.length - 1]) > LB_T.pickGap) acts.push({
      sev: 1, fam: 'picks', key: 'picks', who: finPeople[0].key,
      do: <>Ask {finPeople[0].name} to show {finPeople[finPeople.length - 1].name} five games {finPeople[0].name} shortlisted that became Priority IV or Insight</>,
      why: <>{fmt.pct(holdUp(finPeople[0]))} of {finPeople[0].name}&apos;s picks get there, against {fmt.pct(holdUp(finPeople[finPeople.length - 1]))} of {finPeople[finPeople.length - 1].name}&apos;s</>,
    })

  // One line per family AND one line per person, worst first. A person already spoken
  // for is dropped rather than said again, so the third slot goes to whoever else on
  // the team has a problem.
  const fams = new Set<string>()
  const named = new Set<string>()
  const shown = rankActs([...acts].sort((a, b) => b.sev - a.sev).filter((a) => {
    if (fams.has(a.fam)) return false
    if (a.who && named.has(a.who)) return false
    fams.add(a.fam)
    if (a.who) named.add(a.who)
    return true
  }))

  // One clause, answering the tab's question rather than reciting the table under it.
  const headline = active.length === 0
    ? `Nobody evaluated anything this ${winName}.`
    : calSpread != null && calSpread > LB_T.calSpread
      ? 'The team is not judging by the same bar.'
      : stuck.length
        ? 'The work is getting done, but someone’s backlog has stopped moving.'
        : top && active.length >= 3 && topShare > LB_T.concentration
          ? `Most of the output is ${top.name}.`
          : 'The team is judging by one bar, at a comparable pace.'

  const chips: Array<{ key: string; text: React.ReactNode; tone: 'good' | 'warn' | 'bad' }> = active.length ? [
    {
      key: 'people', tone: band(ev.length ? active.length / ev.length : 0, 0.6, 0.85),
      text: <>{active.length} of {ev.length} people judged games</>,
    },
    ...(top ? [{
      key: 'top',
      tone: (topShare > LB_T.concentration ? 'bad' : topShare > LB_T.concentration * 0.75 ? 'warn' : 'good') as 'good' | 'warn' | 'bad',
      text: <>{top.name} judged {fmt.pct(topShare)} of all games</>,
    }] : []),
    ...(calSpread != null ? [{
      key: 'cal',
      tone: (calSpread > LB_T.calSpread ? 'bad' : calSpread > LB_T.calSpread / 2 ? 'warn' : 'good') as 'good' | 'warn' | 'bad',
      text: <>{strict.name} keeps {keepPair(strict.survivalRate, loose.survivalRate)[0]}, {loose.name} {keepPair(strict.survivalRate, loose.survivalRate)[1]}</>,
    }] : []),
  ] : []

  // Eight rank boards became these columns. Sorting is the only state on the tab and it
  // never leaves the browser, so re-asking a question costs a click and not a request.
  const cols: Array<SortCol<Ev>> = [
    {
      key: 'games', label: 'Games', tip: TIP.evaluated,
      value: (e) => e.evaluated, cell: (e) => fmt.int(e.evaluated),
      // only where there is work to have been active on: "1 active day" under a
      // Games count of zero is two halves of one cell contradicting each other
      sub: (e) => (e.evaluated > 0 && e.activeDays > 0 ? `${e.activeDays} active ${e.activeDays === 1 ? 'day' : 'days'}` : null),
    },
    {
      key: 'perday', label: 'Games per day', tip: TIP.perDay('games evaluated'), focusKey: 'perday',
      value: (e) => (e.evaluated > 0 ? e.throughput : null),
      cell: (e) => (e.evaluated > 0 ? fmt.dec(e.throughput) : '·'),
    },
    {
      key: 'wait', label: 'Days waiting', tip: TIP.turnaround,
      value: (e) => e.turnaround, cell: (e) => (e.turnaround == null ? '·' : fmt.days(e.turnaround)),
    },
    {
      key: 'short', label: 'Shortlist %', tip: TIP.survival,
      value: (e) => (e.evaluated > 0 ? e.survivalRate : null),
      cell: (e) => (e.evaluated > 0 ? fmt.pct(e.survivalRate) : '·'),
      sub: (e) => (e.evaluated > 0 ? `${fmt.int(e.shortlisted)} of ${fmt.int(e.evaluated)}` : null),
    },
    {
      key: 'signal', label: 'Hit %', tip: TIP.signal, late: true,
      value: (e) => (e.evaluated > 0 ? e.signalRate : null),
      cell: (e) => (e.evaluated > 0 ? fmt.pct(e.signalRate) : '·'),
      sub: (e) => (e.evaluated > 0 ? `${fmt.int(e.finalPriority)} of ${fmt.int(e.evaluated)}` : null),
    },
    {
      key: 'video', label: 'Video', tip: TIP.recorded,
      value: (e) => e.recorded, cell: (e) => fmt.int(e.recorded),
    },
    {
      key: 'score', label: 'Overall score', tip: TIP.overall,
      value: (e) => score(e),
      cell: (e) => { const s = score(e); return s == null ? '·' : s < 1 ? '<1' : fmt.dec(s, 0) },
      sub: (e) => (d.config.credibility && e.evaluated > 0
        ? `sample weight ${Math.round(sampleWeight(e.evaluated) * 100)}%` : null),
    },
  ]

  return (
    <>
      <Guide title="Leaderboard - who is doing well, and who needs attention this week?"
        read={[
          <span key="1">One sentence, three chips and at most three moves are the answer. The table is where they came from.</span>,
          <span key="2"><b>The table sorts</b> - click any column. Every rate carries the counts behind it in the same cell, so a high percentage on a thin sample cannot pass for the best number on the page.</span>,
          <span key="3"><b>Games</b> and <b>Games / day</b> say how much; <b>Shortlist %</b> and <b>Hit %</b> say whether it held up. The scatter is those two read against each other.</span>,
          <span key="4"><b>Hit %</b> lands late: a moderator stamps the final conclusion days after the evaluation, so an open {winName} reads low for everyone and judges nobody.</span>,
        ]}
        act={[
          <span key="1">Nothing under &ldquo;Do this&rdquo; means nothing crossed a threshold this {winName}.</span>,
          <span key="2">At most three moves show, worst first - one person, one thing, this {winName}.</span>,
          <span key="3">A wide bypass spread always comes first. Until the team judges by one bar, no quality column here compares anybody.</span>,
        ]} />

      <p className="rp-headline">{headline}</p>
      {chips.length > 0 && (
        <div className="rp-chips">
          {chips.map((c) => <span className={`rp-chip ${c.tone}`} key={c.key}>{c.text}</span>)}
        </div>
      )}
      <DoBlock acts={shown.map((a) => ({
        sev: a.sev, key: a.key, kicker: famLabel(a.fam), do: a.do, why: a.why, cta: a.cta,
      }))} />

      <div className="rp-section-title">Everyone - who produces, and does it hold up?</div>
      <Card label="Volume vs shortlist rate" note="x = games evaluated · y = shortlist % · bubble = games per day"
        tip={<><F>x = evaluated · y = shortlist ÷ evaluated · bubble = games ÷ active day</F>How much someone judged, read against how much of it they kept. The team line is the pooled rate, total over total, so a light workload cannot move it. The dashed line is the whole team; the outlier test compares each person with EVERYONE ELSE, because someone extreme drags a pool they are inside. Called out at under half the others&apos; rate, or over {LB_T.outlierHigh} times it, on {LB_T.calMin}+ games and by more than chance explains. The two ends are not symmetric on purpose: a high rate is usually a lower bar or a lucky run, a low rate is signal nobody downstream will ever see.</>}>
        {scatterPts.length ? <Scatter points={scatterPts} xLabel="Games evaluated" yLabel="Shortlist %"
          sizeLabel="Games per day" avgX={avgVol} avgY={teamKeep * 100}
          avgXLabel={`team average, ${fmt.int(avgVol)} games`} avgYLabel={`team keeps ${keepOne(teamKeep)}`}
          emphasis={[...outLow.map((e) => ({ name: e.name, tone: 'low' as const })),
            ...outHigh.map((e) => ({ name: e.name, tone: 'high' as const }))]}
          xFormat={(v) => fmt.int(v)} yFormat={(v) => `${Math.round(v)}%`} /> : <Empty text={`Nobody reached ${LB_T.calMin} games this ${winName}`} />}
        {thin.length > 0 && (
          <div className="rp-thin">
            <span className="rp-thin-cap">Under {LB_T.calMin} games, not placed</span>
            {thin.map((e) => <span className="rp-thin-chip" key={e.key}>{e.name}<b>{fmt.int(e.evaluated)}</b></span>)}
            <span className="rp-thin-note">A rate over this few games is chance, not a bar. Their numbers are in the table.</span>
          </div>
        )}
        <Foot
          read={<>Across: how many games someone judged. Up: how much of it they kept. The dashed lines are the team, so the quadrant is the reading. Bubble size is pace, which makes a <b>big low bubble</b> someone fast who bypasses nearly everything, and a <b>small low bubble</b> a backlog that is slow and still producing nothing. A dashed ring marks someone outside the team&apos;s range, red below it and blue above.</>}
          now={outLow.length || outHigh.length
            ? <>
              {outLow.map((e) => <span key={e.key}><b>{e.name}</b> keeps {keepPair(e.survivalRate, restKeep(e))[0]} where the others keep {keepPair(e.survivalRate, restKeep(e))[1]} - {fmt.dec(1 / Math.max(1e-9, ratioOf(e)))}x under, on {fmt.int(e.evaluated)} games. </span>)}
              {outHigh.map((e) => <span key={e.key}><b>{e.name}</b> keeps {keepPair(e.survivalRate, restKeep(e))[0]} where the others keep {keepPair(e.survivalRate, restKeep(e))[1]} - {fmt.dec(ratioOf(e))}x over, on {fmt.int(e.evaluated)} games. </span>)}
            </>
            : <>Nobody keeps under half the team&apos;s {keepOne(teamKeep)}, or over {LB_T.outlierHigh}x it{plotted.length >= 2 ? <>. The spread runs {fmt.pct(Math.min(...plotted.map((e) => e.survivalRate)))} to {fmt.pct(Math.max(...plotted.map((e) => e.survivalRate)))} across the {plotted.length} people with {LB_T.calMin}+ games</> : null}.</>}>
          {pace.length > 1 && <BubbleKey caption="Games / day" min={Math.min(...pace)} max={paceMax}
            rad={scatterRad} format={(v) => fmt.dec(v, 0)} />}
        </Foot>
      </Card>
      <Card label="Everyone, side by side" note="click a column to sort · rates carry their counts"
        tip={<><F>one row per evaluator · every column sorts</F>This replaced eight separate rank boards. Reading one person across all eight was the thing those boards could never do.</>}>
        {/* Overview's "See who is under the pace" promised a table sorted by Games
            per day ascending with the under-pace rows flashed. `focusSort` is what
            delivers the first half: without it the reader arrived at a table still
            sorted by Overall score, with a ring somewhere below the fold. */}
        <SortTable<Ev> rows={ev} cols={cols} initialSort="score"
          focusSort={flashPerDay ? { key: 'perday', dir: 'asc' } : undefined}
          rowKey={(e) => e.key} rowName={(e) => e.name}
          rowSub={(e) => e.title || null}
          inactive={(e) => e.evaluated === 0}
          inactiveNote={`No evaluations this ${winName} - listed, not ranked`}
          rowFlash={(e) => flashPerDay && e.evaluated > 0 && e.throughput < d.teamTotals.avgThroughput} />
        <Foot
          read={<>Click any column to sort, click again to flip it, once more to clear. Every rate carries the counts it came from, so a percentage and its sample are read together.</>}
          now={bestRate && <><b>{bestRate.name}</b> has the highest shortlist rate at {fmt.pct(bestRate.survivalRate)}, on {fmt.int(bestRate.evaluated)} games against a team median of {fmt.int(medianVol)}. Sample weight is what keeps that from topping the score.</>} />
      </Card>

      <Card label="Whose backlog is it" note="the backlog now, by who holds it · colour = how long they have held it"
        tip={<><F>= unevaluated games, grouped by their assigned evaluator</F>The <b>stock</b>, not the window: every game still in the backlog, whenever it arrived. The bars therefore add up to the Backlog number on Overview, and this card is the answer to whose desks those games are on.<br />Bands are days since the game was <b>assigned to this person</b>, which is not the clock Overview&apos;s &ldquo;Backlog by age&rdquo; uses - that one counts from import. Here the question is how long this person has held it, and a handover restarts that clock on purpose, the same way &ldquo;Days waiting&rdquo; does. So the two cards agree on the total and can disagree on the split.<br />The last column is their flow across the window on screen: games taken minus games cleared. Red is a backlog still filling.</>}>
        <QueueBars rows={queueRows.map((r) => ({ ...r, warn: warnKeys.has(r.key) }))}
          bands={AGE_BANDS.map((b) => ({ label: b.label, color: b.color }))}
          unitName={winName} staleFrom={sd} />
        <Foot
          read={<>Bar length is that person&apos;s backlog right now; the colours are how long they have held it. The number after the bar is the backlog, then the age of its oldest game, then what they took minus what they cleared this {winName} - so a <b>long bar in red</b> is a backlog that is still filling, and a long bar in green is one being worked off.</>}
          now={queueTotal === 0
            ? <>The backlog is empty.</>
            /* Lead with WHO, not with the total. The card's job on this tab is to name
               people, and a reader who has to match a red triangle against eleven bars
               has been handed the work the sentence was supposed to do. */
            : <>{queueWarn.length > 0
              ? <><b>{nameList(queueWarn.map((r) => r.name))}</b> {queueWarn.length === 1 ? 'is' : 'are'} flagged, each holding over {fmt.pct(STALE.share)} of their backlog past {sd} days - {fmt.int(queueWarn.reduce((s2, r) => s2 + r.stale, 0))} games {queueWarn.length === 1 ? 'in all' : 'between them'}. </>
              : <>Nobody is over {fmt.pct(STALE.share)} of their backlog past {sd} days. </>}
              {fmt.int(queueTotal)} games in total across {queueRows.length} {queueRows.length === 1 ? 'person' : 'people'}
              {queueTop && queueRows.length > 1 ? <>, {fmt.pct(queueTop.n / queueTotal)} of it with <b>{queueTop.name}</b></> : null}.{' '}
              {queueGrowing.length > 0 && <>{queueGrowing.length === 1
                ? <><b>{queueGrowing[0].name}</b>&apos;s backlog grew by {fmt.int(queueGrowing[0].net!)} this {winName}.</>
                : <>{queueGrowing.length} backlogs grew this {winName}, most of all <b>{queueGrowing[0].name}</b> at +{fmt.int(queueGrowing[0].net!)}.</>}</>}
            </>} />
      </Card>

      <div className="rp-section-title">Cadence - who is running, and who has stopped?</div>
      <Card label="Activity heatmap" note={`games evaluated · person × ${unitName}`}
        tip={<><F>cell = count(evaluated) for that person, that {unitName}</F>Day cells for a week, month or batch window; week cells for a quarter.</>}>
        <Heatmap periods={d.heatmap.periods} rows={d.heatmap.rows} />
        <Foot
          read={<>Darker is more games. A gap in a row is a {unitName} with nothing evaluated, and a run of them at the right-hand end is someone who has stopped.</>}
          now={movers
            ? <>First half of these {periods.length} {unitNames} against the second: <b>{movers.up.name}</b> {movers.up.delta > 0 ? `climbed ${movers.up.delta} to #${movers.up.to}` : `held #${movers.up.to}`}, <b>{movers.down.name}</b> {movers.down.delta < 0 ? `fell ${Math.abs(movers.down.delta)} to #${movers.down.to}` : `held #${movers.down.to}`}.</>
            : <>Nobody changed rank between the two halves of this {winName}.</>} />
      </Card>

      <div className="rp-section-title">Calls - how each person judges, and how it lands</div>
      <Card label="Initial conclusions by evaluator" note="quality order: List_Idea › Playtest &amp; Bypass › Bypass · gray = Link_dead"
        tip={<><F>bar = one evaluator · segment = count per conclusion</F>The picture behind the bypass spread in the chips above: red is where each person&apos;s bar sits.</>}>
        {initRows.length ? <StackedBars rows={initRows} keys={initKeys} /> : <Empty />}
        <Foot
          read={<>Purple (<b>List_Idea</b>) is signal, red (<b>Bypass</b>) is gatekeeping, gray is dead links caught. A red share well above the others means that person&apos;s bar sits higher than the team&apos;s.</>}
          now={byIdea.length < 2
            ? <>Only {byIdea.length} {byIdea.length === 1 ? 'person has' : 'people have'} judged the {LB_T.calMin}+ games it takes to read a share here.</>
            : ideaShare(byIdea[0]) - ideaShare(byIdea[byIdea.length - 1]) < 0.02
              ? <>All {byIdea.length} people send on about the same share, near {fmt.pct(ideaShare(byIdea[0]))} List_Idea.</>
              : <><b>{byIdea[0].name}</b> sends on the largest share of what they judge, {fmt.pct(ideaShare(byIdea[0]))} List_Idea, against <b>{byIdea[byIdea.length - 1].name}</b> at {fmt.pct(ideaShare(byIdea[byIdea.length - 1]))}.</>} />
      </Card>
      <Card label="Their picks - final outcomes" note="quality order: Priority IV › Insight › Watch List › Priority V › Theme/Art › Bypass"
        tip={<><F>bar = games one evaluator shortlisted · segment = the moderator&apos;s verdict</F>Stamped days after the evaluation, so a window that just opened is mostly empty here.</>}>
        {finRows.length ? <StackedBars rows={finRows} keys={finKeys} /> : <Empty text="No picks reached a final conclusion in this window" />}
        <Foot
          read={<>How the moderator judged each person&apos;s shortlist. Violet and teal are the picks that held up; the bar&apos;s length is how many of their picks have been judged at all.</>}
          now={finGames === 0
            ? <>No pick from this {winName} has reached a moderator yet, which is normal until the {winName} closes.</>
            : finJudged.length === active.length
              ? <>Every one of the {active.length} people has picks the moderator has judged, {fmt.int(finGames)} games in all.</>
              : <><b>{finJudged.length}</b> of {active.length} people have picks the moderator has judged, {fmt.int(finGames)} games in all. For the other {active.length - finJudged.length}, a short bar means still waiting rather than judged weak.</>} />
      </Card>
    </>
  )
}

/* ---------------- Individual ---------------- */
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

// A percentage and the benchmark it is being compared with, formatted at the SAME
// precision - escalated to a decimal when the default rounding would print two
// different numbers identically. On real data HuyDD's 6.8% against the team's 7.3%
// rendered as "7% … team 7% -7%": a badge claiming to be the gap between two figures
// the reader can see are the same. Both sides move together, the way `keepPair` does
// on the Leaderboard, because escalating only one of them just relocates the puzzle.
function pctPair(value: number, bench: number | null): [string, (n: number) => string] {
  return bench != null && Math.abs(value - bench) > 1e-9 && fmt.pct(value) === fmt.pct(bench)
    ? [fmt.pct1(value), fmt.pct1]
    : [fmt.pct(value), fmt.pct]
}
/* Daily breakdown: one row per calendar DAY, plain numbers, no chart. The three
   named conclusions are the ones the team steers by; anything else the Config tab
   allows is folded into "Other" (hover it for the split). Video counts come from
   the recording list rows (confirmed date + slot), so this panel and the recording list
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

// Thresholds for the one "Do this" block on this tab. Same discipline as Overview's
// `T` and the Leaderboard's `LB_T`: a line prints only when a number crosses one of
// these, and nothing prints when nothing does.
const IND_T = {
  // Their backlog is filling faster than they clear it, as a share of what they took.
  intakeGap: 0.15,
  // Below this many games a rate is the sample talking, not the person. Same floor
  // the Leaderboard's calibration test uses, for the same reason.
  calMin: 50,
  // How far from the team's rate before the bar is worth a conversation. Half the
  // team's rate, matching the Leaderboard's low-side outlier gate.
  calLow: 0.5,
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
  const sd = staleDays(d)
  // Same panel, two readers: a manager looking at someone else, or the evaluator
  // looking at their own row. The numbers and charts are identical - only the voice
  // changes, because half of a manager's moves (reassign the backlog, run a calibration
  // session) are not this person's to make.
  const self = !d.canSeeTeam
  const They = self ? 'You' : e.name
  const their = self ? 'your' : 'their'
  const Their = self ? 'Your' : 'Their'
  const winName = windowNoun(d)
  const unitName = d.bucketUnit === 'day' ? 'day' : d.bucketUnit === 'week' ? 'week' : 'month'
  // The current window's last bucket is a part-period. Anything read as a rate or a
  // trend stops before it; running counts keep it, because they are true as far as
  // they go. Same rule as the other two tabs.
  const partialTail = !d.window.to || d.window.to > vnTodayIso()
  const done = <V,>(a: V[]) => (partialTail && a.length > 1 ? a.slice(0, -1) : a)

  const t = d.teamTotals
  const tf = d.funnel
  const tb = d.bench
  const multi = tb.people >= 2
  // `ok` gates metrics whose own denominator is empty for this person: a rate over
  // zero assigned is not a 100% shortfall, it is "not applicable", and showing it red
  // would be a false signal.
  const cmp = (value: number | null, bench: number | null, format: (n: number) => string, dir: 'up' | 'down' | 'flat', ok = true): Bench | null =>
    multi && ok ? vsTeam(value, bench, format, dir) : null
  const hasDays = e.activeDays > 0
  const [srVal, srFmt] = pctPair(e.survivalRate, multi ? tb.survivalRate : null)

  const rad = d.radar.find((r) => r.key === e.key)
  const radarValues = rad ? RADAR_AXES.map((a) => rad.axes[a] || 0) : RADAR_AXES.map(() => 0)
  // raw counterpart of each normalized axis, printed under the axis caption
  const radarRaw = [fmt.int(e.evaluated), fmt.pct(e.consistency), fmt.pct(e.signalRate), fmt.pct(e.survivalRate), fmt.int(e.recorded)]
  const weakAxis = rad ? RADAR_AXES.reduce((w, a) => ((rad.axes[a] || 0) < (rad.axes[w] || 0) ? a : w), RADAR_AXES[0]) : null
  const strongAxis = rad ? RADAR_AXES.reduce((w, a) => ((rad.axes[a] || 0) > (rad.axes[w] || 0) ? a : w), RADAR_AXES[0]) : null

  const funnelStages = [
    { label: 'Evaluated', value: e.evaluated },
    { label: 'Shortlist', value: e.shortlisted },
    { label: 'Final Priority', value: e.finalPriority, parts: [
      { label: 'Priority IV', value: e.priorityIV, color: CAT[4] },
      { label: 'Insight', value: e.insight, color: CAT[6] },
    ] },
  ]
  // Assigned is gone from the funnel, matching Overview: it counts new intake, a
  // different set of games from the ones judged in this window, so putting it on top
  // made the first conversion a ratio between two populations.
  const pSteps = [
    { from: 'Evaluated', to: 'Shortlist', a: e.evaluated, b: e.shortlisted, team: tf.evaluated > 0 ? tf.shortlisted / tf.evaluated : 0 },
    { from: 'Shortlist', to: 'Final Priority', a: e.shortlisted, b: e.finalPriority, team: tf.shortlisted > 0 ? tf.finalPriority / tf.shortlisted : 0 },
  ].filter((s) => s.a > 0)
  const pWorstStep = [...pSteps].sort((x, y) => x.b / x.a - y.b / y.a)[0]

  // ---- their own series ----
  const ps = d.personSeries?.[e.key] || []
  const vids = d.videos?.[e.key] || []
  const personSpark = done(ps.map((p) => p.evaluated))
  const actSeries = [
    { name: 'Assigned', color: CAT[5], points: ps.map((p) => ({ label: p.label, value: p.assigned })) },
    { name: 'Evaluated', color: CAT[0], points: ps.map((p) => ({ label: p.label, value: p.evaluated })) },
    { name: 'Link dead', color: '#94a3b8', points: ps.map((p) => ({ label: p.label, value: p.linkDead })) },
  ]
  const psTotals = ps.length
    ? ps.reduce((acc, p) => ({ assigned: acc.assigned + p.assigned, evaluated: acc.evaluated + p.evaluated }), { assigned: 0, evaluated: 0 })
    : null

  // ---- pick quality over time, against the team on the same axis ----
  // The gap this tab had: every chart on it plotted volume, so a person's pick quality
  // had a level and never a direction. A rate needs its own denominator in the bucket,
  // so buckets where they judged nothing are dropped rather than drawn as 0% - which
  // would read as "bypassed everything" on a day they were on leave.
  const teamRateBy = new Map(d.metricSeries.map((m) => [m.key, m]))
  const qualityRows = done(ps.filter((p) => p.evaluated > 0))
  // An evaluator's bundle carries no team series at all - `metricSeries` is emptied
  // server-side, not filtered - so the per-bucket team line is only available to a
  // manager. Reading the empty map would have drawn the team flat along 0%, which is
  // not "no data", it is "the team bypassed everything". They get the window rate as a
  // straight reference line instead, and the legend says which of the two it is.
  const teamPerBucket = d.metricSeries.length > 0
  const teamAt = (key: string) => {
    const tm = teamRateBy.get(key)
    // A bucket the team did nothing in has no rate; fall back to the window rate
    // rather than plotting a zero that reads as a collapse.
    return (tm && tm.evaluated > 0 ? tm.shortlisted / tm.evaluated : t.survivalRate) * 100
  }
  const qualitySeries = qualityRows.length >= 2 ? [
    { name: self ? 'You' : e.name, color: CAT[0], points: qualityRows.map((p) => ({ label: p.label, value: (p.shortlisted / p.evaluated) * 100 })) },
    ...(multi && t.survivalRate > 0 ? [{
      name: teamPerBucket ? 'Team' : `Team, ${winName} average`, color: '#94a3b8', dashed: true,
      points: qualityRows.map((p) => ({
        label: p.label,
        value: teamPerBucket ? teamAt(p.key) : t.survivalRate * 100,
      })),
    }] : []),
  ] : []
  // First half against second half, weighted by volume. NEVER first bucket against
  // last: on a quiet opening day that ranks someone off two games.
  const half = (rows: typeof qualityRows) => {
    const ev2 = rows.reduce((s, p) => s + p.evaluated, 0), sh = rows.reduce((s, p) => s + p.shortlisted, 0)
    return ev2 > 0 ? sh / ev2 : null
  }
  const mid = Math.floor(qualityRows.length / 2)
  const qFirst = qualityRows.length >= 4 ? half(qualityRows.slice(0, mid)) : null
  const qLast = qualityRows.length >= 4 ? half(qualityRows.slice(mid)) : null
  const qDrift = qFirst != null && qLast != null ? qLast - qFirst : null
  // Both ends at one precision, escalated only when rounding would collapse two
  // genuinely different numbers - same rule as `pctPair`. The verdict below is then
  // read off these two STRINGS rather than off a separate threshold, which is what
  // keeps the word and the numbers from disagreeing.
  const qDriftPair: [string, string] = qFirst != null && qLast != null
    ? (fmt.pct(qFirst) === fmt.pct(qLast) && Math.abs(qDrift!) > 1e-9
      ? [fmt.pct1(qFirst), fmt.pct1(qLast)]
      : [fmt.pct(qFirst), fmt.pct(qLast)])
    : ['', '']

  // ---- their slice of the backlog ----
  // A STOCK: read as of now, never sliced by the window. It is their row out of the
  // same backlog Overview counts and the Leaderboard splits by person.
  const bq = (d.backlogBy || []).find((b) => b.key === e.key) || null
  const queueParts = bq ? [bq.a0, bq.a1, bq.a2, bq.a3] : []
  const queueStale = bq ? bq.stale : 0
  const queueNet = psTotals ? psTotals.assigned - psTotals.evaluated : null

  // ---- judged vs aged, per bucket: the two halves of what moved on their desk ----
  // Buckets are the UNION of both sides. A bucket where they judged nothing but their
  // backlog kept ageing is precisely the bucket this card exists to show, so dropping it
  // would hide the only bad weeks.
  const moves = d.personMoves?.[e.key] || []
  const moveRows = moves.map((m) => ({
    name: m.label,
    right: Object.fromEntries(AGE_KEYS.map((k, i) => [k, m.cleared[i] || 0])),
    left: Object.fromEntries(AGED_KEYS.map((k, i) => [k, m.aged[i] || 0])),
  }))
  const clearedTot = moves.reduce((s2, m) => s2 + m.cleared.reduce((a, b) => a + b, 0), 0)
  const agedTotP = moves.reduce((s2, m) => s2 + m.aged.reduce((a, b) => a + b, 0), 0)
  // Old work CLEARED against old work CREATED, on the same population: games judged at
  // 8+ days against games that crossed INTO 8-14d or 15d+. Weighing all-ages-cleared
  // against crossings-into-15d+ is the trap Overview already fell into once, and it
  // printed the opposite of the truth.
  const clearedOld = moves.reduce((s2, m) => s2 + m.cleared[2] + m.cleared[3], 0)
  const agedIntoOldP = moves.reduce((s2, m) => s2 + m.aged[1] + m.aged[2], 0)

  // ---- conclusion flow: what they decided, and how it was judged ----
  const initBands = orderedBands(Object.entries(e.initialConclusions).map(([name, count]) => ({ name, count })), INIT_ORDER)
  const finBands = orderedBands(Object.entries(e.finalConclusions).map(([name, count]) => ({ name, count })), FINAL_ORDER)
  const initTot = initBands.reduce((s, b) => s + b.value, 0)
  const finTot = finBands.reduce((s, b) => s + b.value, 0)
  // The three per-day KPI tiles this replaces. Kept as a sentence under the bar rather
  // than as three tiles: they are one distribution read three times, and the only
  // thing the tiles added over the bar was dividing it by active days.
  const perDay = (c: string) => (e.activeDays > 0 ? (e.initialConclusions[c] || 0) / e.activeDays : 0)

  // Rows stuck in Recording: Confirm was pressed but no upload has ever been matched.
  // Under a week that is the normal gap; past that the video is missing or the sheet
  // title drifted.
  const stuck = vids.filter((v) => vidStatus(v) === 'recording' && daysSince(v.confirmedOn) > STUCK_DAYS)
  const deadShare = e.evaluated + e.linkDead > 0 ? e.linkDead / (e.evaluated + e.linkDead) : 0
  const outShare = tf.evaluated > 0 ? e.evaluated / tf.evaluated : 0
  // LEAVE ONE OUT. The bar this person is measured against is what EVERYONE ELSE
  // keeps, never a pool they are inside. On this roster one person judges 30% of all
  // games, so their own games set a third of the "team" rate they are then compared
  // with - and the further out they are, the harder that works to pull the reference
  // towards them and hide it. The same rule the Leaderboard's outlier test uses.
  const restEval = tf.evaluated - e.evaluated
  const restKeep = restEval > 0 ? (tf.shortlisted - e.shortlisted) / restEval : null
  const keepRatio = restKeep != null && restKeep > 0 ? e.survivalRate / restKeep : null
  const enoughToJudge = e.evaluated >= IND_T.calMin

  // ---- the answer: at most three moves, one per family ----
  // QUEUE (is work piling up on them), CALIBRATION (is their bar the team's),
  // RECORDING (is a video lost). One line per family: three versions of the same
  // complaint would fill the cap and leave the other problems unsaid.
  type Act = { sev: number; fam: string; key: string; do: React.ReactNode; why: React.ReactNode; payoff?: React.ReactNode }
  const acts: Act[] = []

  // No `idle` act here any more: the Leaderboard already carries that line, and Law 2
  // says a story is concluded at exactly one altitude. No `cta` on `stale` either - this
  // tab coaches what this ONE person should change next week, never moves a game. That
  // decision is between people, and the Leaderboard's Reassign already made it.
  //
  // The TRIGGER splits by voice on purpose. An admin's `stale` reads the band-share
  // test (`queueStale`/`STALE.min`/`STALE.share`) that matches the language of the
  // Backlog card next to it - worth a conversation only once it is a real share of a
  // real pile. A contractor's own reading reads `d.selfStale` instead: the exact same
  // number the Rescue panel would compute for them (see the Bundle comment on
  // `selfStale`), at a much lower floor (5, not 60+), because this line is not "does
  // this deserve a team conversation" - it is "here are five games to start with
  // today", and it must never disagree with what Rescue would show this person if they
  // opened it.
  const selfOldFires = !!bq && self && d.selfStale != null && d.selfStale >= 5
  const adminOldFires = !!bq && !self && queueStale >= STALE.min && queueStale / bq.n > STALE.share
  if (bq && (selfOldFires || adminOldFires)) acts.push({
    sev: 3, fam: 'backlog', key: 'stale',
    do: self
      ? <>Start each day with your 5 oldest games</>
      : <>Ask {e.name} to start each day with their 5 oldest games</>,
    why: self
      ? <>{fmt.int(d.selfStale!)} of your {fmt.int(bq.n)} games have gone past {sd} days, oldest {bq.oldest}d.</>
      : <>{fmt.int(queueStale)} of {their} {fmt.int(bq.n)} games have gone past {sd} days, oldest {bq.oldest}d.</>,
    /* ONE answer, in both voices. The admin payoff used to divide by `e.throughput` -
       the person's full measured pace - and so answered a question the card does not
       ask: the instruction directly above it asks for five games a day, not for
       everything they have. On the same person, the same 316 games and the same
       threshold, the two voices printed 2.6 days and 64 days, twenty-five times apart,
       and a manager and the contractor they are talking to could not both be right.
       Five a day is the instruction, so five a day is the arithmetic. */
    payoff: (() => {
      const n = self ? (d.selfStale ?? 0) : queueStale
      const days = Math.ceil(Math.max(1, n) / 5)
      return self
        ? <>Your stale games gone in about {days} days</>
        : <>{Their} stale games gone in about {days} days</>
    })(),
  })
  else if (psTotals && psTotals.assigned > 0 && (psTotals.assigned - psTotals.evaluated) / psTotals.assigned > IND_T.intakeGap) acts.push({
    sev: 2, fam: 'backlog', key: 'behind',
    do: self
      ? <>Ask for a rebalance now, not at the end of the {winName}</>
      : <>Move {fmt.int(psTotals.assigned - psTotals.evaluated)} games off {e.name} to someone with room</>,
    why: <>{They} took {fmt.int(psTotals.assigned)} and cleared {fmt.int(psTotals.evaluated)} this {winName}, so {fmt.int(psTotals.assigned - psTotals.evaluated)} joined the backlog.</>,
  })

  // Calibration only where the sample can carry it. Under 50 games a rate is chance,
  // and a conversation started on chance teaches the wrong lesson.
  //
  // `callow` is the one line whose trigger reads the TEAM on purpose, in both voices:
  // a bar that is not shared makes the data downstream (Priority IV, Insight) useless
  // for everyone, so unlike `stale`/`behind`/`rhythm` this is never judged against the
  // reader's own past. Only the self `do` changes here - "20 games" read as an audit
  // when a manager assigns it, but reads as busywork when a contractor is asked to
  // grade their own homework 20 times over; "your last 5" is a task they can start
  // before lunch.
  if (enoughToJudge && keepRatio != null && keepRatio < IND_T.calLow) acts.push({
    sev: 3, fam: 'cal', key: 'callow',
    do: self
      ? <>Send your last 5 bypasses to a moderator to check the bar together</>
      : <>Re-read 20 games {e.name} bypassed, with a moderator</>,
    // "At their rate" over a sentence whose subject is this person reads as their own
    // rate, which would make the clause say nothing. The rate being applied is the
    // rest of the team's, in both voices.
    why: <>{They} keep{self ? '' : 's'} {fmt.pct(e.survivalRate)} where the rest of the team keeps {fmt.pct(restKeep!)}. At the team&apos;s rate {their} {fmt.int(e.evaluated)} games would have sent on about {fmt.int(e.evaluated * restKeep!)} instead of {fmt.int(e.shortlisted)}.</>,
  })
  else if (enoughToJudge && keepRatio != null && keepRatio > 2.5) acts.push({
    sev: 1, fam: 'cal', key: 'calhigh',
    do: self
      ? <>Talk the team through 5 games {self ? 'you' : 'they'} kept</>
      : <>Have {e.name} talk the team through 5 games they kept</>,
    why: <>{They} keep{self ? '' : 's'} {fmt.pct(e.survivalRate)} where the rest of the team keeps {fmt.pct(restKeep!)}. Either {self ? 'you see' : 'they see'} something the others do not, or the bar is lower.</>,
  })

  if (stuck.length) acts.push({
    sev: 2, fam: 'rec', key: 'rec',
    do: self
      ? <>Check your {stuck.length} recording{stuck.length > 1 ? 's' : ''} confirmed over {STUCK_DAYS} days ago with no upload</>
      : <>Check the {stuck.length} recording{stuck.length > 1 ? 's' : ''} confirmed over {STUCK_DAYS} days ago with no upload</>,
    // Second-person, and under the 150-char evidence budget (the admin copy just
    // below stays as it was - see the task note on `rec`'s pre-existing 158/178-char
    // exception, which this rewrite does not inherit because it is a genuinely new
    // string, not that one reworded).
    why: self
      ? <>Confirm was pressed but no video has matched yet. A title that drifted from the store name in <i>ytb_uploaded</i> can hide a real upload.</>
      : <>Confirm was pressed but no video has ever matched. A game title that drifted from the store title in the <i>ytb_uploaded</i> sheet makes a real video invisible here.</>,
  })

  // ---- self-only: rhythm and a good-news line, neither of which is an admin's to see ----
  // Both read against THIS PERSON'S OWN previous window (`d.prev`), never the team's
  // current pace - a freelancer who works three sessions a week and always has is not
  // doing anything wrong, so there is nothing here for a manager to act on about
  // anyone but themselves. `callow` above is the one line in this family that reads
  // the team instead, and on purpose: a shared bar is the one thing that has to be
  // shared to mean anything.
  const prevThroughputRef = d.prev?.personDayThroughput ?? null
  const prevActiveDaysRef = d.prev?.activeDays ?? null
  // Total calendar days in the CURRENT window - absent on batch/all-time, where there
  // is no "how many of them were you out" to ask.
  const winDays = d.window.from && d.window.to
    ? Math.max(1, Math.round((Date.parse(d.window.to) - Date.parse(d.window.from)) / 86400_000))
    : null

  if (self && prevActiveDaysRef != null && prevActiveDaysRef > 0 && e.activeDays < prevActiveDaysRef * 0.7 && winDays != null) acts.push({
    sev: 2, fam: 'rhythm', key: 'rhythm',
    do: <>Spread the same work over more days</>,
    why: <>You were out {fmt.int(Math.max(0, winDays - e.activeDays))} of {fmt.int(winDays)} days; on the days you worked you cleared {fmt.dec(e.throughput)} a day, against {fmt.dec(prevThroughputRef ?? e.throughput)} last {winName} and {fmt.dec(tb.throughput)} for the team.</>,
  })

  // The one good-news line on this tab (binding constraint: a tab that only ever
  // criticises stops being opened). Its own threshold, and `sev: 0` - the lowest of
  // any act here - so `rankActs`' worst-first sort can never let it bump a red line
  // out of the cap of three.
  if (self && prevThroughputRef != null && prevThroughputRef > 0 && e.throughput > prevThroughputRef * 1.2) acts.push({
    sev: 0, fam: 'output', key: 'up',
    do: <>Keep the change you made this {winName}</>,
    why: <>{fmt.dec(e.throughput)} a day, up from {fmt.dec(prevThroughputRef)} last {winName}, and the team is at {fmt.dec(tb.throughput)}.</>,
  })

  const fams = new Set<string>()
  const shown = rankActs([...acts].sort((a, b) => b.sev - a.sev).filter((a) => {
    if (fams.has(a.fam)) return false
    fams.add(a.fam)
    return true
  }))

  // One clause, answering the tab's question rather than reciting the KPI row.
  const headline = e.evaluated === 0 && e.assigned === 0
    ? `${self ? 'You have' : `${e.name} has`} no work in this ${winName}.`
    : e.evaluated === 0
      ? `${self ? 'You have' : `${e.name} has`} not judged anything this ${winName}.`
      : enoughToJudge && keepRatio != null && keepRatio < IND_T.calLow
        ? `${They} ${self ? 'are' : 'is'} bypassing far more than the team.`
        : psTotals && psTotals.assigned > 0 && (psTotals.assigned - psTotals.evaluated) / psTotals.assigned > IND_T.intakeGap
          ? `${self ? 'Your' : `${e.name}'s`} backlog is growing faster than ${self ? 'you clear' : 'they clear'} it.`
          : `${They} ${self ? 'are' : 'is'} keeping up, and ${their} picks hold up.`

  const chips: Array<{ key: string; text: React.ReactNode; tone: 'good' | 'warn' | 'bad' }> = e.evaluated > 0 || e.assigned > 0 ? [
    ...(multi && tf.evaluated > 0 ? [{
      key: 'share', tone: 'good' as const,
      text: <>Judged {fmt.pct(outShare)} of the team&apos;s games this {winName}</>,
    }] : []),
    ...(queueNet != null ? [{
      key: 'net', tone: (queueNet > 0 ? 'warn' : 'good') as 'good' | 'warn' | 'bad',
      text: <>Backlog {queueNet >= 0 ? '+' : '−'}{fmt.int(Math.abs(queueNet))} this {winName}</>,
    }] : []),
    ...(bq ? [{
      key: 'wait', tone: (queueStale / bq.n > STALE.share ? 'bad' : 'good') as 'good' | 'warn' | 'bad',
      text: <>Backlog {fmt.int(bq.n)}, oldest {bq.oldest}d</>,
    }] : []),
  ] : []

  return (
    <>
      <Guide title={self ? 'Your workload, tempo and pick quality' : "Individual - one evaluator's workload, tempo and pick quality"}
        read={[
          self
            ? <span key="1">One sentence, three chips and five numbers are the answer. Every card below is your own work in this {winName}.</span>
            : <span key="1">One sentence, three chips and five numbers are the answer. <b>The name chips switch person</b> - every card re-renders for them.</span>,
          <span key="2">Each KPI carries a <b>team</b> line: the team&apos;s number on the same metric and the gap in %. Green or red only past ±5%, and only where one direction is genuinely better.</span>,
          <span key="3"><b>Backlog</b> is the only number here the {winName} filter does not reach: it is every game still sitting with {self ? 'you' : 'them'} right now, whenever it arrived. Overview and the Leaderboard call the same backlog by the same name.</span>,
          <span key="4"><b>Pick quality over time</b> is the one chart that says whether {self ? 'you are' : 'they are'} improving. Everything else says how much.</span>,
        ]}
        act={[
          <span key="1">Nothing under &ldquo;Do this&rdquo; means nothing crossed a threshold this {winName}.</span>,
          <span key="2">At most three moves show, worst first - one thing, this {winName}.</span>,
          <span key="3">A rate over fewer than {IND_T.calMin} games is the sample talking, so no calibration line fires under it.</span>,
        ]} />

      <div className="rp-people">
        {d.evaluators.map((x) => (
          d.canSeeTeam ? (
            <button key={x.key} className={'rp-chip' + (x.key === e.key ? ' active' : '')} onClick={() => { setSel(x.key); setDaily(false) }}>
              {x.name}{x.title && <span className="rp-chip-title">{x.title}</span>} <span className="rp-chip-n">{x.evaluated || x.recorded}</span>
            </button>
          ) : (
            // scoped view: their own name, as a label - there is nobody to switch to
            <span key={x.key} className="rp-chip active" aria-current="true">
              {x.name}{x.title && <span className="rp-chip-title">{x.title}</span>} <span className="rp-chip-n">{x.evaluated || x.recorded}</span>
            </span>
          )
        ))}
        <button className="rp-daily-btn" onClick={() => setDaily(true)}
          title={`Day-by-day numbers for ${e.name}: Bypass · Playtest & Bypass · List_Idea · 5min & 20min videos`}>
          ▦ Daily breakdown
        </button>
      </div>
      {daily && (
        <DailyBreakdown person={e.name} mix={d.dailyMix?.[e.key] || {}} vids={vids} win={d.window} onClose={() => setDaily(false)} />
      )}

      <p className="rp-headline">{headline}</p>
      {chips.length > 0 && (
        <div className="rp-chips">
          {chips.map((c) => <span className={`rp-chip ${c.tone}`} key={c.key}>{c.text}</span>)}
        </div>
      )}
      <DoBlock acts={shown.map((a) => ({
        sev: a.sev, key: a.key, kicker: famLabel(a.fam), do: a.do, why: a.why, payoff: a.payoff,
      }))} />

      {/* Five, down from twelve. What went: the three per-day mix tiles (one
          distribution read three times - it is the conclusion-flow bar now), Note
          coverage (a note is mandatory in the form, so it reads ~100% for everyone and
          separates nobody), Link dead and Recorded (source quality and assigned work,
          both of which have a card that shows them in context), Assigned (it is the
          Backlog chip and the activity chart), and Hit rate (it lands days late, so a
          KPI tile makes an open window look like a collapse - it is on the radar and
          in the funnel, where the lateness can be said). */}
      <div className="rp-kpi-row">
        <Kpi label="Evaluated" value={fmt.int(e.evaluated)} sub={`judged this ${winName}`} hi
          spark={personSpark.length >= 2 ? personSpark : undefined} noTrend sparkNote={`games per ${unitName}`}
          tip={TIP.evaluated} bench={cmp(e.evaluated, tb.evaluated, fmt.int, 'up')} />
        <Kpi label="Backlog" value={bq ? fmt.int(bq.n) : '0'} sub={bq ? `oldest ${bq.oldest}d, all history` : 'backlog empty'}
          tip={TIP.personBacklog} />
        <Kpi label="Games per day" value={fmt.dec(e.throughput)} sub="games / active day" tip={TIP.perDay('Games evaluated')}
          bench={cmp(e.throughput, tb.throughput, (n) => fmt.dec(n), 'up', hasDays)} />
        <Kpi label="Days waiting" value={fmt.days(e.turnaround)} sub="assign → evaluate" tip={TIP.turnaround}
          bench={cmp(e.turnaround, tb.turnaround, (n) => fmt.days(n), 'down')} />
        <Kpi label="Shortlist rate" value={srVal} sub={`${fmt.int(e.shortlisted)} of ${fmt.int(e.evaluated)} evaluated`}
          spark={qualityRows.length >= 2 ? qualityRows.map((p) => Math.round((p.shortlisted / p.evaluated) * 1000)) : undefined}
          noTrend sparkNote={`rate per ${unitName}`} sparkColor={CAT[3]} tip={TIP.survival}
          bench={cmp(e.survivalRate, tb.survivalRate, srFmt, 'up', e.evaluated > 0)} />
      </div>

      <div className="rp-section-title">Shape - what {self ? 'you are' : 'they are'} strong and weak at</div>
      <div className="rp-grid-2-1">
        <Card label={self ? 'Your performance shape' : `${e.name} - performance shape`} note="5 axes, normalized to team best · raw value under each axis" tip={TIP.radar}>
          <Radar axes={RADAR_AXES.map((a) => AXIS_LABEL[a])} series={[{ name: e.name, values: radarValues }]} axisRaw={radarRaw} size={260} />
          <Foot
            read={<>A balanced polygon is well-rounded, a spiky one is lopsided. Every axis is scaled so the team&apos;s best person scores 100, and the real number sits under each caption.</>}
            now={weakAxis && strongAxis
              ? <>{Their} shortest axis is <b>{AXIS_LABEL[weakAxis]}</b> at {rad?.axes[weakAxis] ?? 0} of 100, {their} longest <b>{AXIS_LABEL[strongAxis]}</b> at {rad?.axes[strongAxis] ?? 0}.{weakAxis === 'Signal' ? ' Hit rate is stamped by a moderator days later, so an open window reads low here for everyone.' : ''}</>
              : null} />
        </Card>
        <Card label="Pick funnel" note="evaluated → shortlist → final priority"
          tip={<><F>shortlist = initial ≠ bypass · final = Priority IV + Insight</F>It starts at Evaluated, matching Overview. Assigned counts new intake - a different set of games from the ones judged here - so a conversion from it would be a ratio between two populations. Each band carries its conversion from the band above.</>}>
          <Funnel stages={funnelStages} />
          <Foot
            read={<>Each band is a share of the one above it, so the narrow step is where the picks are lost. Final Priority is stamped by a moderator days after the evaluation, so it reads low on a {winName} that is still open.</>}
            now={pWorstStep
              ? <>The narrowest step is <b>{pWorstStep.from} → {pWorstStep.to}</b>, {fmt.pct(pWorstStep.b / pWorstStep.a)} through against {fmt.pct(pWorstStep.team)} for the team.</>
              : <>Nothing has been judged this {winName} yet.</>} />
        </Card>
      </div>

      <div className="rp-section-title">Tempo - what came in, what went out, and what is left</div>
      {ps.length >= 2 ? (
        <Card label={self ? 'Your activity over time' : `${e.name} - activity over time`} note={`assigned · evaluated · link dead per ${unitName}`}
          tip={<><F>assigned by assigned_date · evaluated &amp; link dead by evaluate_date</F>Buckets are the union of both axes, so a {unitName} where they were only assigned work still appears.</>}>
          <LineChart series={actSeries} area />
          <Foot
            read={<>Red above blue is work arriving faster than it is cleared; blue above red is an older backlog being worked off. Gray is dead links, which is source quality rather than filtering - it makes the volume numbers undercount the effort.</>}
            now={psTotals
              ? <>{They} took {fmt.int(psTotals.assigned)} and cleared {fmt.int(psTotals.evaluated)} across these {unitName}s{psTotals.assigned > psTotals.evaluated
                ? <>, so {fmt.int(psTotals.assigned - psTotals.evaluated)} joined the backlog</>
                : psTotals.evaluated > psTotals.assigned ? <>, {fmt.int(psTotals.evaluated - psTotals.assigned)} of them from the older backlog</> : null}.
                {deadShare > 0.08 ? <> {fmt.pct(deadShare)} of what {self ? 'you' : 'they'} got through was dead links.</> : null}</>
              : null} />
        </Card>
      ) : null}

      {moveRows.length > 0 && (
        <Card label={self ? 'Your judged vs aged' : `${e.name} - judged vs aged`} note={`what moved on their desk each ${unitName}, and which way`}
          tip={<>
            <F>right = games they judged that {unitName}, by age on the day they judged it</F>
            <F>left = games of theirs that crossed into an older band that {unitName} (assign day + 4, + 8, + 15)</F>
            The per-person half of the same card on Overview. Both sides count EVENTS,
            not stock, so a game appears at most once on each: it is judged once, and it
            passes a boundary once. That is what makes the two halves addable across
            buckets, which a snapshot never is - a game that sits still all week would
            otherwise be counted in every bucket of it.<br />
            The clock is the <b>assign</b> date, not the import date Overview uses, so a
            handover restarts it and the crossings follow the game to its new owner.
            Same scale both ways: the longer side is the reading.
          </>}>
          <DivergingBars rows={moveRows} rightKeys={AGE_KEYS} leftKeys={AGED_KEYS} colors={AGE_COLORS}
            leftLabel="Aged into" rightLabel="Judged" />
          <Foot
            read={<>Right is work finished, left is work that only got older. Colour is the age band on both sides, so a bar that is red on the left and green on the right means {self ? 'you are' : 'they are'} clearing the new games while the old ones keep sliding.</>}
            now={clearedTot + agedTotP === 0
              ? <>Nothing moved either way this {winName}.</>
              : <>{fmt.int(clearedTot)} judged against {fmt.int(agedTotP)} that only got older.{' '}
                {agedIntoOldP > 0
                  /* Both sides are EVENT counts over the window, so they say which way
                     the stale work moved - not what the backlog is now. That is
                     the backlog card beside this one, and a game can cross the line
                     here and be cleared next week, so stating a stock from these two
                     numbers would contradict a card the reader can see. */
                  ? <>Past 8 days: {fmt.int(clearedOld)} cleared against {fmt.int(agedIntoOldP)} that crossed in, so stale work arrived {clearedOld > agedIntoOldP ? 'slower than it was cleared' : clearedOld === agedIntoOldP ? 'as fast as it was cleared' : 'faster than it was cleared'}.</>
                  : <>Nothing crossed into 8+ days.</>}</>} />
        </Card>
      )}

      <div className="rp-grid-2">
        <Card label={self ? 'Your backlog' : `${e.name} - backlog`} note="games on their desk now · colour = how long they have held it"
          tip={TIP.personBacklog}>
          <BandBar label="Backlog by age" total={bq ? `${fmt.int(bq.n)} games` : undefined}
            bands={bq ? AGE_BANDS.map((b, i) => ({ name: b.label, value: queueParts[i] || 0, color: b.color })) : []}
            empty="Backlog empty - nothing is waiting on them" />
          <Foot
            read={<>Days count from when the game was assigned to {self ? 'you' : 'them'}, not from when it was imported - a handover restarts that clock, so this is time on {self ? 'your' : 'their'} desk. A snapshot of right now: the {winName} filter does not reach it.</>}
            now={bq
              ? <>The oldest has sat {bq.oldest} days. {queueStale > 0
                ? <>{fmt.int(queueStale)} of the {fmt.int(bq.n)} ({fmt.pct(queueStale / bq.n)}) are past {sd} days.</>
                : <>Nothing is past {sd} days.</>}</>
              : <>Nothing on their desk.</>} />
        </Card>
        <Card label="Conclusion flow" note="what they decided, then how it was judged"
          tip={<><F>top = their initial_conclusion · bottom = final_conclusion on what they shortlisted</F>Two tiers of one story, on the same width: everything they judged, then the part of it a moderator has ruled on. This replaced two donuts - a donut makes the reader compare arc lengths, and two of them side by side made them do it twice for two different totals.<br />The per-day figures under the bars are the same distribution divided by active days, which is what the three &ldquo;/ day&rdquo; KPI tiles used to show.</>}>
          {initTot > 0 ? (
            <div className="rp-tiers">
              <BandBar label="What they decided" total={`${fmt.int(initTot)} judged`} bands={initBands} />
              <BandBar label="How those picks were judged" total={initTot > 0 ? `${fmt.int(finTot)} of ${fmt.int(initTot)} ruled on` : `${fmt.int(finTot)} ruled on`}
                bands={finBands} scaleTo={initTot} restLabel={`${fmt.int(Math.max(0, initTot - finTot))} not ruled on yet`}
                empty={`Nothing ruled on yet this ${winName} - a moderator stamps this days later`} />
            </div>
          ) : <Empty />}
          <Foot
            read={<>The top bar is every game {self ? 'you' : 'they'} judged, split by the call {self ? 'you' : 'they'} made. The bottom bar is the part a moderator has since ruled on - it is a subset, so it stays narrower for longer on an open {winName}.</>}
            now={e.activeDays > 0
              ? <>Per active day: {fmt.dec(perDay('Bypass'))} Bypass, {fmt.dec(perDay('Playtest & Bypass'))} Playtest &amp; Bypass, {fmt.dec(perDay('List_Idea'))} List_Idea, across {fmt.int(e.activeDays)} day{e.activeDays === 1 ? '' : 's'}.</>
              : null} />
        </Card>
      </div>

      <div className="rp-section-title">Direction - is the bar moving?</div>
      <Card label={self ? 'Your pick quality over time' : `${e.name} - pick quality over time`} note={`shortlist rate per ${unitName}, against the team`}
        tip={<><F>= their shortlist ÷ their evaluated, per {unitName}</F>The one chart on this tab with a direction rather than a level. Both halves of the ratio count the same games, so the size of the backlog behind them leaves the rate alone.<br />A {unitName} where they judged nothing is dropped, not drawn as 0%: a day off is not a day they bypassed everything.</>}>
        {qualitySeries.length ? <LineChart series={qualitySeries} format={(v) => `${v.toFixed(1)}%`} />
          : <Empty text={`Need two ${unitName}s with work in them`} />}
        <Foot
          read={<>{self ? 'Your' : 'Their'} line against the team&apos;s on one axis. Above the team is a wider bar, below it a stricter one - neither is automatically better, and what matters is whether the gap is closing or opening.</>}
          now={qDrift != null
            /* The word and the two numbers must agree. Printed with fmt.pct they
               rounded independently of the test, so a drift just under the threshold
               read "7% → 8%, holding steady" on the real quarter - the sentence
               contradicting itself inside six words. Both sides are now formatted at
               the precision that makes them differ, and "steady" is only said when the
               two printed figures are actually the same. */
            ? <>Across this {winName} the rate went {qDriftPair[0]} → {qDriftPair[1]}, {qDriftPair[0] === qDriftPair[1] ? 'holding steady' : qDrift > 0 ? 'widening' : 'tightening'}. Measured as the first half of the {unitName}s against the second, weighted by how many games each judged.
              {multi ? <> The team sits at {fmt.pct(t.survivalRate)}.</> : null}</>
            : qualityRows.length > 0
              ? <>{qualityRows.length} {unitName}{qualityRows.length === 1 ? '' : 's'} with work in {qualityRows.length === 1 ? 'it' : 'them'} - too few to call a direction.</>
              : null} />
      </Card>

      <div className="rp-section-title">Recording - is anything lost?</div>
      <Card label={self ? 'Your recording list' : `${e.name} - recording list`} note="videos assigned & recorded in this window · open rows always shown"
        tip={<><F>rows where they are the 5min/20min assignee</F>Same three states as the Record tab, and the video is what settles them: <b>Recorded</b> = an upload was matched to this game, <b>Recording</b> = Confirm was pressed but no upload yet, <b>Pending</b> = neither (the Record tab calls this Draft). A row confirmed over {STUCK_DAYS} days ago with still no upload is flagged.</>}>
        <VideoQueue vids={vids} />
        <Foot
          read={<>A video is what settles a row, not the Confirm click - so a row can sit in <i>Recording</i> while the upload exists under a title that drifted from the store title in the <i>ytb_uploaded</i> sheet.</>}
          now={vids.length === 0
            ? <>No recording work this {winName}.</>
            : stuck.length > 0
              ? <>{fmt.int(e.recorded)} recorded ({e.rec5} × 5min, {e.rec20} × 20min), and {stuck.length} row{stuck.length > 1 ? 's have' : ' has'} sat in <i>Recording</i> for over {STUCK_DAYS} days with no upload matched.</>
              : <>{fmt.int(e.recorded)} recorded ({e.rec5} × 5min, {e.rec20} × 20min), nothing stuck.</>} />
      </Card>
    </>
  )
}

/* ---------------- Config: who counts + how the Overall score is weighted ---------------- */
// Persisted team-wide in app_config (key 'report_config'), not per browser: these
// choices define what the numbers MEAN, so two admins must never read the same tab
// and see different rankings. Saving invalidates the API's bundle cache.
function ConfigTab({ d, onSaved }: { d: Bundle; onSaved: () => void }) {
  const [roster, setRoster] = useState<Array<{ key: string; name: string }>>([])
  const [excluded, setExcluded] = useState<string[]>(d.config.excluded)
  const [weights, setWeights] = useState<Record<AxisName, number>>(d.config.weights)
  const [sampleWeightOn, setSampleWeightOn] = useState(d.config.credibility)
  const [state, setState] = useState<'idle' | 'loading' | 'saving' | 'saved' | 'error'>('loading')

  useEffect(() => {
    let alive = true
    fetch('/api/report/config').then((r) => r.json()).then((j) => {
      if (!alive) return
      setRoster(j.roster || [])
      if (j.config) { setExcluded(j.config.excluded); setWeights(j.config.weights); setSampleWeightOn(j.config.credibility) }
      setState('idle')
    }).catch(() => alive && setState('error'))
    return () => { alive = false }
  }, [])

  const total = ALL_ROUNDER_AXES.reduce((s, a) => s + (weights[a] || 0), 0) || 1
  const dirty = JSON.stringify({ excluded: [...excluded].sort(), weights, credibility: sampleWeightOn })
    !== JSON.stringify({ excluded: [...d.config.excluded].sort(), weights: d.config.weights, credibility: d.config.credibility })

  const save = async () => {
    setState('saving')
    try {
      const res = await fetch('/api/report/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ excluded, weights, credibility: sampleWeightOn }),
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
          <span key="2"><b>Overall score weights</b>: the relative pull of each axis. Numbers are relative, so 40/15/15/15/15 and 8/3/3/3/3 behave the same - the share next to each row is what actually applies.</span>,
          <span key="3"><b>Sample weight</b> scales every axis except Volume by min(1, their games ÷ median team games): someone who evaluated half as many games as a typical teammate gets half credit on the quality axes. How much they did is never discounted - that part is the evidence.</span>,
        ]}
        act={[
          <span key="1">Changing weights <b>re-ranks the Overall score column on the Leaderboard</b> for everyone - agree on it with the team before saving.</span>,
          <span key="2">Untick a recorder-only or trial account instead of mentally discounting them every time you read the Leaderboard.</span>,
          <span key="3">Turn sample weight off only when comparing people with similar workloads; with it off, a 30-game sample ranks on equal footing with a 700-game one.</span>,
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
        <Card label="Overall score weights" note="relative pull of each axis"
          tip={TIP.overall}>
          <div className="rp-cfg-list">
            {ALL_ROUNDER_AXES.map((a) => (
              <div key={a} className="rp-cfg-w">
                <span className="rp-cfg-name">{AXIS_LABEL[a]}</span>
                <input type="range" min={0} max={100} step={5} value={weights[a] ?? 0}
                  onChange={(e2) => setWeights((w) => ({ ...w, [a]: Number(e2.target.value) }))} />
                <span className="rp-cfg-share">{Math.round(((weights[a] || 0) / total) * 100)}%</span>
              </div>
            ))}
          </div>
          <label className="rp-cfg-row" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={sampleWeightOn} onChange={() => setSampleWeightOn((v) => !v)} />
            <span className="rp-cfg-name">Sample weight discount</span>
            <span className="rp-cfg-meta">scale non-Volume axes by sample size</span>
          </label>
          <div className="rp-cfg-actions">
            <button className="btn btn-sm btn-primary" onClick={save} disabled={!dirty || state === 'saving'}>
              {state === 'saving' ? 'Saving…' : 'Save settings'}
            </button>
            <button className="btn btn-sm" onClick={() => { setWeights(DEFAULT_REPORT_CONFIG.weights); setSampleWeightOn(true) }}>Reset to defaults</button>
            <span className="rp-cfg-state">
              {state === 'error' ? <b style={{ color: 'var(--bad)' }}>Save failed</b>
                : state === 'saved' && !dirty ? 'Saved - all tabs recomputed'
                : dirty ? 'Unsaved changes' : 'Up to date'}
            </span>
          </div>
        </Card>
      </div>
      <Card label="Preview - Overall score with these weights" note="live, before saving"
        tip={<><F>same formula as the Leaderboard board, using the sliders above</F>Recomputed as you drag; nothing is stored until you press Save.</>}>
        <RankBars color={CAT[4]} format={(v) => fmt.dec(v, 0)}
          rows={d.radar.filter((r) => !excluded.includes(r.key)).map((r) => {
            const evc = d.evaluators.find((x) => x.key === r.key)?.evaluated || 0
            const vols = d.evaluators.filter((x) => x.evaluated > 0 && !excluded.includes(x.key)).map((x) => x.evaluated).sort((a, b) => a - b)
            const med = vols.length ? vols[Math.floor(vols.length / 2)] : 0
            const cred = sampleWeightOn ? (med > 0 ? Math.min(1, evc / med) : 1) : 1
            return { name: r.name, value: allRounderScore(r.axes, weights, cred), sub: `${fmt.int(evc)} games` }
          }).sort((a, b) => b.value - a.value)} />
        <ReadNote>Axis values still come from the current window and are normalized to the team best, so this preview moves when the filter bar changes too.</ReadNote>
      </Card>
    </>
  )
}

/* ---------------- recording list table (5 rows tall, scrolls for more) ---------------- */
// One definition of "done", shared with the Record tab (app/(manager)/youtube
// recordStatus): the VIDEO settles it. A matched upload is Recorded whatever the
// Confirm says; Confirm alone only means Recording. Before this the Report read
// record_confirmed_at only, so the same game could be Recorded on one screen and
// Pending on the other. (Record tab's fourth state, `pending` = no assignee, cannot
// occur here - every recording list row has one - so its `draft` is this table's Pending.)
type VidRow = Bundle['videos'][string][number]
type VidStatus = 'recorded' | 'recording' | 'pending'
function vidStatus(v: VidRow): VidStatus {
  if (v.youtube) return 'recorded'
  if (v.confirmedOn) return 'recording'
  return 'pending'
}
const STUCK_DAYS = 7
function daysSince(day: string | null): number {
  if (!day) return 0
  const ms = Date.parse(day + 'T00:00:00Z')
  return Number.isFinite(ms) ? Math.floor((Date.now() - ms) / 86400000) : 0
}
// ISO day → d/m (module scope already has a Date-based `dm`)
const dmISO = (day: string) => day.split('-').reverse().slice(0, 2).map(Number).join('/')

// The recording list can run to dozens of rows and used to push every card below it off the
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
              const st = vidStatus(v)
              // The only state left that needs chasing: confirmed long ago, still no
              // video. Everything else is a normal point in the recording lifecycle.
              const age = st === 'recording' ? daysSince(v.confirmedOn) : 0
              const odd = age > STUCK_DAYS ? `Confirmed ${age} days ago, no upload matched yet` : null
              return (
                <tr key={`${v.gameId}-${v.slot}`} className={odd ? 'rp-vid-odd' : undefined}>
                  <td className="rp-vid-i">{i + 1}</td>
                  <td className="rp-vid-game">{v.title || v.gameId}{v.os && <span className="rp-vid-os"> · {v.os}</span>}
                    {odd && <span className="rp-vid-flag" title={odd}>!</span>}</td>
                  <td>{v.slot}</td>
                  <td>{v.batch || '-'}</td>
                  <td>{st === 'recorded'
                    ? <span className="rp-vid-done">Recorded{v.recordedOn ? ` ${dmISO(v.recordedOn)}` : ''}</span>
                    : st === 'recording'
                      ? <span className="rp-vid-wip" title="Confirm pressed in the Record tab; no upload matched yet">Recording{v.confirmedOn ? ` · ${dmISO(v.confirmedOn)}` : ''}</span>
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

/* ---------------- shared bits ---------------- */
function band(v: number, warn: number, good: number): 'good' | 'warn' | 'bad' {
  return v >= good ? 'good' : v >= warn ? 'warn' : 'bad'
}
function Card({ label, note, tip, fill, children }: { label: string; note?: string; tip?: React.ReactNode; fill?: boolean; children: React.ReactNode }) {
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
  // A card in a grid row is as tall as its tallest sibling, so a short chart used to
  // leave a column of dead space under its own footer. Splitting the children into a
  // body and a footer lets the body take the slack and centre in it, and pins the
  // footer to the bottom edge - so a row of cards lines its footers up whatever is
  // drawn above them. The split is by component identity rather than by position,
  // because several cards render the footer conditionally.
  const kids = React.Children.toArray(children)
  const isFoot = (n: React.ReactNode) => React.isValidElement(n) && (n.type === Foot || n.type === ReadNote)
  const foot = kids.filter(isFoot)
  const body = kids.filter((n) => !isFoot(n))
  const inner = (
    <>
      <div className="card-body">{body}</div>
      {foot}
    </>
  )
  return (
    <>
      <div className={'card' + (fill ? ' rp-card-fill' : '')}>
        {head(false)}
        {inner}
      </div>
      {open && (
        <div className="rp-modal-backdrop" onClick={() => setOpen(false)}>
          <div className="rp-modal card" onClick={(e) => e.stopPropagation()}>
            {head(true)}
            {inner}
          </div>
        </div>
      )}
    </>
  )
}

/* Per-tab usage guide: what each element means + what to do when it looks off.
   Modeled after "How to read / Actions" review-dashboard panels.

   It folds, and it starts folded. It used to be pinned open above the headline, which
   is right exactly once - on a first visit - and wrong on every visit after it, where
   eight lines of standing instructions push the answer below the fold. Closed it is a
   single bar, so the reader can still see that the explanation exists and where it is.

   This is the ONLY thing on these tabs that folds. A chart or a number behind a toggle
   is a chart or a number nobody reads; instructions are the one kind of text a reader
   stops needing. Closed means REMOVED from the DOM, not hidden with CSS, so the word
   count a screen reader gets matches the one the eye gets. */
function Guide({ title, read, act }: { title: string; read: React.ReactNode[]; act: React.ReactNode[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={'card rp-guide' + (open ? ' open' : '')}>
      <button type="button" className="rp-guide-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="rp-guide-kicker">How to use</span>
        <span className="rp-guide-title">{title}</span>
        <span className="rp-guide-caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <>
          <div className="read">
            <div className="rp-guide-col-title read">◎ How to read</div>
            <ul>{read.map((r, i) => <li key={i}>{r}</li>)}</ul>
          </div>
          <div className="act">
            <div className="rp-guide-col-title act">⚡ What to do</div>
            <ul>{act.map((a, i) => <li key={i}>{a}</li>)}</ul>
          </div>
        </>
      )}
    </div>
  )
}
function ReadNote({ children }: { children: React.ReactNode }) { return <p className="rp-readnote">{children}</p> }
/* A chart's footer, in three parts: an optional scale key on the left, the standing
   explanation of how to read the chart, and ONE line computed from the numbers this
   window actually drew. The third part is what makes the footer worth its space - a
   fixed sentence about the axes tells a reader who has already looked at them nothing.
   It is a reading, not an instruction: actions live in "Do this" at the top of the tab
   and nowhere else. */
function Foot({ read, now, children }: { read: React.ReactNode; now?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="rp-foot">
      {children && <div className="rp-foot-key">{children}</div>}
      <div className="rp-foot-text">
        <p className="rp-readnote">{read}</p>
        {now && <p className="rp-foot-now"><span className="rp-now-tag">Now</span>{now}</p>}
      </div>
    </div>
  )
}
/* The bubble scale, drawn at the same radii the chart uses. "Bubble size is games per
   day" is a sentence about a unit; two circles and two numbers are the unit. */
function BubbleKey({ min, max, rad, caption, format }: {
  min: number; max: number; rad: (v: number) => number; caption: string; format: (v: number) => string
}) {
  const rMin = rad(min), rMax = rad(max), h = rMax * 2 + 2
  return (
    <>
      <span className="rp-foot-key-cap">{caption}</span>
      <svg viewBox={`0 0 ${rMin * 2 + rMax * 2 + 14} ${h}`} width={rMin * 2 + rMax * 2 + 14} height={h} aria-hidden="true">
        <circle cx={rMin + 1} cy={h / 2} r={rMin} />
        <circle cx={rMin * 2 + 12 + rMax} cy={h / 2} r={rMax} />
      </svg>
      <span className="rp-foot-key-val">{format(min)} to {format(max)}</span>
    </>
  )
}
// Per-chart actionable line: what THIS window's data says to do, computed from the
// numbers on screen. ReadNote explains how to read a chart in general; Act names the
// move. Charts that are pure counts (donuts, rank boards) get no Act - there is
// nothing to decide from a tally alone.
// Sort a count list into a fixed display order and give each entry its colour.
// Where the backlog went over the window, as a matrix. Every other backlog chart is a
// snapshot, so none of them can separate "the 8-14d backlog shrank because we judged
// those games" from "it shrank because they turned 15d+". Rows are where a game stood
// when the window opened, columns where it stands now; each game is counted once.
function orderedBands(data: Cnt[], order: string[]): Band[] {
  return [...data].filter((c) => c.count > 0)
    .sort((a, b) => {
      const ia = order.indexOf(a.name), ib = order.indexOf(b.name)
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
    })
    .map((c, i) => ({ name: c.name, value: c.count, color: conclusionColor(c.name, i) }))
}
type Band = { name: string; value: number; color: string }
// One 100%-wide stacked bar plus its own legend. It replaced an 8px strip captioned
// "3,156 0–3d · 753 4–7d · 2,026 8–14d · 315 15d+", where reading any one band meant
// matching a colour to a position in a run-on sentence. The bar is thick enough to
// carry the share of any band worth naming, and the legend puts the names in a grid
// the eye can go down.
// A segment narrower than this gets no number inside it. The old floor let a 10%
// sliver take a label that then sat on the segment boundary or was cropped by the
// container - and the share is in the legend anyway, so nothing is lost by dropping it.
const LABEL_MIN = 0.14
function BandBar({ label, total, bands, empty, scaleTo, restLabel, focusKey }: {
  label: string; total?: string; bands: Band[]
  // What to say instead of a chart when there is nothing yet. A one-line note, not the
  // full `Empty` block: this bar is often the second tier of a pair, and a 30px padded
  // placeholder under a bar that DOES have data leaves a hole the width of the card.
  empty?: string
  // Draw this bar against a LARGER total, leaving the remainder as empty track. For a
  // tier that is a subset of the one above it: both bars stretched to full width made
  // 120 games ruled on look the same size as the 1,842 they came from, while the text
  // underneath called it a subset. The bar has to be the thing the sentence says.
  scaleTo?: number
  restLabel?: string
  // Same contract as `Kpi`'s: names this bar as the landing place for the chip computed
  // from it, so the chip does not have to know where the bar sits.
  focusKey?: string
}) {
  const sum = bands.reduce((s, b) => s + b.value, 0)
  if (!sum) {
    return (
      <div className="rp-mix-block" data-rp-focus={focusKey}>
        <span className="rp-mix-label">{label}</span>
        <p className="rp-band-none">{empty || 'Nothing yet'}</p>
      </div>
    )
  }
  const shown = bands.filter((b) => b.value > 0)
  // A subset tier keeps the parent's scale, so its width IS its share of the parent.
  const span = scaleTo && scaleTo > sum ? sum / scaleTo : 1
  // ONE band is not a chart. A full-width bar reading "100%" over a legend reading
  // "247" is a one-bar bar chart: it spends a chart's worth of height restating a
  // number the caption already gave, and the colour encodes nothing because there is
  // nothing to tell it apart from. The number IS the chart, so show the number.
  if (shown.length === 1) {
    return (
      <div className="rp-mix-block" data-rp-focus={focusKey}>
        <span className="rp-mix-label">{label}</span>
        <p className="rp-band-solo">
          <b>{fmt.int(shown[0].value)}</b>
          <span className="rp-dot" style={{ background: shown[0].color }} />
          <span>all within <b className="rp-band-solo-band">{shown[0].name}</b></span>
        </p>
      </div>
    )
  }
  return (
    <div className="rp-mix-block" data-rp-focus={focusKey}>
      <span className="rp-mix-label">{label}{total && <> · {total}</>}</span>
      <div className={'rp-band-bar' + (span < 1 ? ' scaled' : '')}>
        {shown.map((b) => {
          const share = b.value / sum
          return (
            <span key={b.name} style={{ width: `${share * span * 100}%`, background: b.color }}
              title={`${b.name}: ${fmt.int(b.value)} (${Math.round(share * 100)}%)`}>
              {/* the label has to fit the DRAWN width, not the share of this bar's own
                  total - a 68% segment of a bar occupying 7% of the track is 5% of the
                  card, and the number inside it would be clipped */}
              {share * span >= LABEL_MIN && <em>{Math.round(share * 100)}%</em>}
            </span>
          )
        })}
        {span < 1 && <span className="rp-band-rest" title={restLabel} />}
      </div>
      {/* One grid for the whole legend, not one per row. Each item used to be its own
          three-column grid, so in a two-column legend the counts sat at whatever x
          each name happened to end at - "List_Idea 19" beside "Playtest & Bypass 63",
          with the two numbers on different rails and nothing to read down. The share
          moves here too, which is what lets the narrow segments drop their labels. */}
      <div className={'rp-band-legend' + (shown.length > 4 ? ' two' : '')}>
        {shown.map((b) => {
          const share = b.value / sum
          return (
            <React.Fragment key={b.name}>
              <span className="rp-dot" style={{ background: b.color }} />
              <span className="rp-band-name" title={b.name}>{b.name}</span>
              <span className="rp-band-n">{fmt.int(b.value)}</span>
              <span className="rp-band-pct">{share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`}</span>
            </React.Fragment>
          )
        })}
      </div>
    </div>
  )
}
// A small sample (tens of games) makes a donut's slices unreadable at a glance - a
// plain ranked list carries the same counts without the chart chrome.
function ConclusionList({ data }: { data: Cnt[] }) {
  if (!data.length) return <Empty text="No final conclusions in this window" />
  const total = data.reduce((s, c) => s + c.count, 0)
  const rows = [...data].sort((a, b) => b.count - a.count)
  return (
    <div className="rp-conc-list">
      {rows.map((c, i) => (
        <div className="rp-conc-row" key={c.name}>
          <span className="rp-dot" style={{ background: conclusionColor(c.name, i) }} />
          <span className="rp-conc-name">{c.name}</span>
          <span className="rp-conc-val">{fmt.int(c.count)} <span className="rp-conc-pct">({Math.round((c.count / total) * 100)}%)</span></span>
        </div>
      ))}
    </div>
  )
}
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
