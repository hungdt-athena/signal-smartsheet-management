'use client'
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ALL_ROUNDER_AXES, allRounderScore, DEFAULT_REPORT_CONFIG, DEFAULT_REPORT_RULES, REPORT_RULE_BOUNDS, parseReportRules, type AxisName, type ReportConfig, type ReportRules } from '@/lib/report-config'
import {
  Kpi, RankBars, Heatmap, Funnel, HealthBars, StackedBars, ColumnChart, DivergingBars, QueueBars,
  LineChart, Scatter, SortTable, Empty, fmt, InfoTip, conclusionColor, usePalette, PaletteContext, inkOn,
  type Bench, type SortCol,
} from '@/components/report/charts'
import type { BenchStats } from '@/lib/report'
import { isBucket } from '@/lib/buckets'
import { ReviewTable } from '@/components/report/ReviewTable'
import { DailyBlock, DayBreakdown } from '@/components/report/DailyBlock'
import { Meter, RatioStrip, RuleBlock, RuleControl, SpreadLine, ThresholdBars, type VizState } from '@/components/report/RuleViz'
import { NEUTRAL as NEUTRAL_REF, PALETTES, PALETTE_KEYS, ROLE_LABELS, parsePaletteKey, resolvePalette, type PaletteKey } from '@/lib/report-palette'

type View = 'week' | 'month' | 'quarter' | 'year' | 'batch' | 'custom'
// The axis keys below have to stay 'Signal'/'Survival' - they index the `axes` map the
// API sends (still read by the Leaderboard's Overall score and the Config tab's weight
// preview) and the all-rounder weights in lib/report-config.ts. What the reader sees is
// the lexicon's own word for each: this is the ONLY place that translation happens.
const AXIS_LABEL: Record<string, string> = {
  Volume: 'Volume', Consistency: 'Consistency', Signal: 'Hit rate', Survival: 'Shortlist rate',
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
//
// Both numbers are admin-editable now (Config -> Alert rules); `tabRules` below turns
// the saved rules into the four threshold objects the tabs read.

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
  turnaround: <><F>= avg( evaluate date − assigned date )</F>How long a game sits with someone before they evaluate it. When it climbs, the backlog grows.</>,
  survival: <><F>= shortlist ÷ evaluated</F>Shortlist means the initial conclusion was anything other than Bypass. Both halves count the same games, the ones evaluated in this window, so the size of the backlog behind them leaves the rate alone.</>,
  signal: <><F>= (Priority IV + Insight) ÷ evaluated</F>How much of what they evaluated reached Priority IV or Insight. It usually sits under 1%, so the trend matters more than the number. A window that just opened reads low, because a moderator stamps the final conclusion days after the evaluation.</>,
  finalPriority: <><F>= count(final ∈ {'{'}Priority IV, Insight{'}'})</F>Priority V is left out, by the team&apos;s own convention.</>,
  noteCoverage: <><F>= noted ÷ evaluated</F>The team&apos;s rule is 90%. A conclusion with no note cannot be audited afterwards.</>,
  linkDead: <><F>= count(initial_conclusion = Link_dead)</F>Housekeeping. It measures the state of the source links, so it says nothing about how well someone evaluates.</>,
  perDay: (what: string) => <><F>= {what} ÷ active days</F>An active day is a day with at least one evaluation, so a four-day week is not read as a slow one.</>,
  backlog: <><F>= count(no evaluate date AND no conclusion)</F>Every game still waiting, across all history. The window filter does not affect it. Games that arrived already evaluated never enter the backlog.</>,
  personBacklog: <><F>= count(backlog games assigned to this person)</F>Their slice of the same total the Backlog number on Overview counts, so every evaluator&apos;s slice adds up to it. The window filter does not affect it - this is a snapshot of right now.<br />Age is counted from the day the game was <b>assigned to them</b>, not from when it was imported the way Overview&apos;s &ldquo;Backlog by age&rdquo; counts it. The question here is how long this person has held it, and a reassign or handover restarts that clock on purpose - the same clock &ldquo;Days waiting&rdquo; uses. So the two agree on the total and can differ on the age split.</>,
  recorded: <><F>= count(5min) + count(20min)</F>Credited to whoever actually uploaded the video, taken from the upload sheet.</>,
  // Named "all-rounder score" until the redesign: one word of jargon that had to be
  // translated before the number could be read. The formula is unchanged.
  overall: <><F>= 0.4×Volume + 0.6×avg(Consistency, Hit rate, Shortlist rate)×sample weight</F>How much someone did, at 40%, and how well, at 60%. The quality half is scaled by sample weight, so 35 games on a good run cannot outrank 700 steady ones. Volume itself is never discounted. On each axis the team&apos;s best scores 100.</>,
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
  // `backlog` = their pile at the END of the bucket (running total over all history,
  // carried over buckets where nothing moved). Optional: an older cached payload lacks it.
  personSeries: Record<string, Array<{ key: string; label: string; assigned: number; evaluated: number; shortlisted: number; linkDead: number; backlog?: number }>>
  videos: Record<string, Array<{ gameId: string; title: string | null; os: string | null; slot: string; batch: string | null; recordedOn: string | null; confirmedOn: string | null; youtube: string | null }>>
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
//
// ONE hue, light -> dark, because age is an ordered scale and the dark end is the one
// a reader must see. The old green -> amber -> orange -> red heat gave the biggest,
// most saturated block to the 0-3d games nobody needs to act on, left 15d+ as a thin
// sliver, and its green was the Backlog colour of the Standard preset. Red family, so
// "old" still reads as the alarm the stale flags raise. Generated in OKLCH (L 0.78 ->
// 0.42, hue 30) and passed the dataviz validator's --ordinal checks: one hue, steady
// lightness steps, light end above 2:1 on white. Fixed - it does not change with the
// chart preset, and it is never a series colour.
const AGE_BANDS = [
  { k: 'a0' as const, label: '0–3d', color: '#f19f91' },
  { k: 'a1' as const, label: '4–7d', color: '#da6d5d' },
  { k: 'a2' as const, label: '8–14d', color: '#b93f31' },
  { k: 'a3' as const, label: '15d+', color: '#86281d' },
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
            : <>Your performance · initial evaluation, recording &amp; shortlist quality, compared with the team average</>}
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

      {/* One palette for every chart on every tab: the admin's preset from Config. */}
      {!loading && data && !data.empty && (
        <PaletteContext.Provider value={resolvePalette(data.config?.palette)}>
          {activeTab === 'overview' && <Overview d={data} />}
          {activeTab === 'leaderboard' && <Leaderboard d={data} focusOnce={focusOnce}
            onConsumeFocus={() => setFocusOnce('')} />}
          {activeTab === 'individual' && <Individual d={data} />}
          {activeTab === 'config' && <ConfigTab d={data} onSaved={fetchData} />}
        </PaletteContext.Provider>
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
// intakeGap (|in − out| ÷ in), agedShare (stock 8+ days old) and clearDays (days of
// work the backlog may hold) are admin rules now - see `tabRules`.
const T_BASE = {
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
  cal: 'Shortlist rate',
  cover: 'Activity',
  output: 'Output',
  picks: 'Final conclusions',
  rec: 'Recording',
  rhythm: 'Work days',
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

/* Send the reader to the number a chip (or an action, on Overview) was computed
   from. The lookup is by `data-rp-focus` from the page root rather than by a ref per
   target, so adding a KPI or moving a card cannot silently break the link - and a
   chip never has to know where on the page its evidence ended up.

   Scoped to `.page` rather than the document so a second Report mounted in a test or
   a modal cannot be scrolled by this one - `ref` has to anchor inside the CALLER's
   own `.page`, which is why this is a hook a tab attaches to one of its own elements,
   not a bare function. Originally Overview-only; lifted here (Task 13) so
   Leaderboard and Individual's chips can be clickable controls too, the same
   contract Overview's chips have always carried. */
function useRpFocus<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null)
  const focus = (key: string) => {
    const el = ref.current?.closest('.page')?.querySelector(`[data-rp-focus="${key}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('rp-flash')
    window.setTimeout(() => el.classList.remove('rp-flash'), 1200)
  }
  return { ref, focus }
}

/* The banner's colour: the WORST of three readings, so it can never look calmer than
   anything printed under it.
     1. its chips - the numbers the sentence was made from;
     2. the sentence itself, when it names a problem (`headTone`). "MyTL bypasses far
        more games than the team" over three green chips printed as a green all-clear;
     3. the "Do this" list. A real action (sev 2+) means there is something to look
        into, so the banner is at least amber. A sev-1 nudge or sev-0 good news does
        not count.
   Actions and the sentence only lift it to amber: red stays the chips' call, where
   the thresholds live. One rule for all three tabs. */
type Tone = 'good' | 'warn' | 'bad'
function bannerTone(chips: Array<{ tone: Tone }>, headTone: Tone, acts: Array<{ sev: number }>): Tone {
  const rank = { good: 0, warn: 1, bad: 2 } as const
  let t: Tone = chips.some((c) => c.tone === 'bad') ? 'bad' : chips.some((c) => c.tone === 'warn') ? 'warn' : 'good'
  const floor: Tone = headTone !== 'good' || acts.some((a) => a.sev >= 2) ? 'warn' : 'good'
  if (rank[floor] > rank[t]) t = floor
  return t
}

/* The verdict: one sentence and the readings it was made from, as ONE object. Used
   to be Overview-only - a headline and a row of pills stacked in the page flow left
   the reader to work out that the pills were the evidence for the sentence rather
   than three more facts. Lifted here (Task 13) so Leaderboard and Individual get the
   same boxed banner, the same clickable chips and the same "colour of the worst
   chip" tone rule, instead of the bare, inert `<span className="rp-chip">` row they
   printed before. `kicker` is per-tab because each tab's chips are keyed by its own
   vocabulary (Overview: growth/speed/age; Leaderboard: people/top/cal; Individual:
   share/net/wait) - see the FAM_LABEL comment above for why a raw key must never
   reach the screen un-translated. */
function VerdictHeader({ tone, headline, chips, kicker, verdictRef, onChip }: {
  tone: 'good' | 'warn' | 'bad'
  headline: React.ReactNode
  chips: Array<{ key: string; text: React.ReactNode; tone: 'good' | 'warn' | 'bad' }>
  kicker: (key: string) => string
  verdictRef: React.RefObject<HTMLDivElement>
  onChip: (key: string) => void
}) {
  return (
    <div className={`rp-verdict ${tone}`} ref={verdictRef}>
      <p className="rp-headline">{headline}</p>
      {chips.length > 0 && (
        <div className="rp-chips">
          {chips.map((c) => (
            <button type="button" className={`rp-chip ${c.tone}`} key={c.key} onClick={() => onChip(c.key)}
              title={`Go to the ${kicker(c.key).toLowerCase()} number this came from`}>
              <span className="rp-chip-kicker">{kicker(c.key)}</span>
              <span className="rp-chip-text">{c.text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* The team's clearing pace in games per CALENDAR day, and what the backlog therefore
   weighs in days of work. Days, not buckets: "26 days to clear" is a number anyone can
   act on, where "5.2 weeks of work" needs the reader to know how long a bucket is. The
   window's tail is clamped to today, or the current week reads its pace across seven
   days when only three have happened.

   Games the TEAM clears per day - the only "games per day" on Overview. It used to sit
   beside `teamTotals.personDayThroughput` (games per evaluator on a day they worked)
   under the same three words, and the reader had to work out they were different
   quantities. Per-evaluator belongs on the Leaderboard, where every row is a person.

   One function because two screens read it: Overview's Speed chip and actions, and the
   "Backlog may hold" preview on Config. */
function teamPace(d: Bundle) {
  const p = d.pipeline
  const outTotal = p ? p.window.evaluated : d.funnel.evaluated
  const stock = d.stock?.backlog ?? p?.current.backlog ?? 0
  const elapsedDays = (() => {
    if (!d.window.from) return 0
    const today = vnTodayIso()
    const end = d.window.to && d.window.to <= today ? d.window.to : addDays(today, 1)
    return Math.max(1, Math.round((Date.parse(end) - Date.parse(d.window.from)) / 86400000))
  })()
  const perDay = elapsedDays > 0 ? outTotal / elapsedDays : 0
  return { elapsedDays, perDay, stock, daysToClear: perDay > 0 && stock > 0 ? stock / perDay : null }
}

function Overview({ d }: { d: Bundle }) {
  const { T, STALE } = tabRules(d)
  const P = usePalette()
  const { ref: bannerRef, focus } = useRpFocus<HTMLDivElement>()
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
  // Pace and days to clear: see `teamPace`, shared with Config's live preview.
  const { elapsedDays, perDay } = teamPace(d)
  // Enough precision to be useful at both ends: 497 needs none, 8.4 needs one.
  const perDayFmt = (v: number) => (v >= 100 ? fmt.int(v) : fmt.dec(v))
  // The same pace over the window the filter bar is comparing against.
  const prevDays = d.prev?.from && d.prev?.to
    ? Math.max(1, Math.round((Date.parse(d.prev.to) - Date.parse(d.prev.from)) / 86400000)) : 0
  const prevPerDay = d.prev && prevDays > 0 ? d.prev.evaluated / prevDays : 0
  const refDays = d.baseline?.days ?? 0
  const refPerDay = d.baseline && refDays > 0 ? d.baseline.evaluated / refDays : 0
  const daysToClear = teamPace(d).daysToClear
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
      // the conclusion colours, the same two the Conclusion flow bars use
      { label: 'Priority IV', value: f.priorityIV, color: conclusionColor('Priority IV') },
      { label: 'Insight', value: f.insight, color: conclusionColor('Insight') },
    ] },
  ]
  const fnStages = [
    { from: 'Evaluated', to: 'Shortlist', a: f.evaluated, b: f.shortlisted },
    { from: 'Shortlist', to: 'Final Priority', a: f.shortlisted, b: f.finalPriority },
  ].filter((s) => s.a > 0)
  const worstStep = [...fnStages].sort((x, y) => x.b / x.a - y.b / y.a)[0]

  // ---- charts over time ----
  const rateSeries = [
    { name: 'Shortlist rate %', color: P.role.shortlist, points: pts((m) => m.survivalRate * 100) },
    { name: 'Hit rate %', color: P.role.hit, points: pts((m) => m.signalRate * 100) },
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
        { name: 'New games in', color: P.role.intake, points: p.series.map((r) => ({ label: r.label, value: r.newGames })) },
        { name: 'Evaluated', color: P.role.evaluated, points: p.series.map((r) => ({ label: r.label, value: r.evaluated })) },
        { name: 'Backlog', color: P.role.backlog, dashed: true, area: false, points: p.series.map((r) => ({ label: r.label, value: r.backlog })) },
      ]
    : [
        { name: 'Assigned', color: P.role.intake, points: pts((m) => m.assigned) },
        { name: 'Evaluated', color: P.role.evaluated, points: pts((m) => m.evaluated) },
      ]
  // Shortlist-rate drift across the window used to be computed here, first half
  // against last, to fire a "re-judge a sample" action. That action is gone (law 3 -
  // how well a named team judges is the Leaderboard's question), and a number computed
  // for nothing is a number the next reader has to work out the purpose of.

  // ---- intake by source ----
  const srcTotals = p?.sourceYield ?? []
  const srcIn = srcTotals.reduce((s, r) => s + r.n, 0)
  const srcKeys = srcTotals.map((r) => srcName(r.src))
  const srcColors = Object.fromEntries(srcKeys.map((k, i) => [k, P.slots[i % P.slots.length]]))
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

  // ---- who was actually working, per bucket ----
  // Live, including the bucket still running: the team wants to see who has worked
  // TODAY while today is happening, not the next morning. It used to stop at the last
  // complete bucket so that "0 people at 08:40" could not read as the team being out;
  // the running bar is drawn faded with a dashed edge and labelled "so far" instead,
  // and it is kept out of the fewest/most facts, which compare whole days.
  const peopleAll = p ? p.series.map((r) => ({ label: r.label, value: r.people })) : []
  const peopleLive = partialTail && peopleAll.length > 0 ? peopleAll[peopleAll.length - 1] : null
  const peopleCols = peopleAll.map((r, i) => (peopleLive && i === peopleAll.length - 1
    ? { ...r, partial: true, sub: 'Evaluators so far' } : r))
  const nowName = unitName === 'day' ? 'Today' : `This ${unitName}`
  const peopleDone = done(peopleAll)
  const peopleLow = peopleDone.length >= 2 ? peopleDone.reduce((a, b) => (b.value < a.value ? b : a)) : null
  const peopleHigh = peopleDone.length ? Math.max(...peopleDone.map((r) => r.value)) : 0
  const flowFirst = p?.series[0], flowLast = p?.series[p.series.length - 1]
  const backlogMove = flowFirst && flowLast && p!.series.length >= 2 ? flowLast.backlog - flowFirst.backlog : null

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
  // Facts, not a paragraph: each pill is one number with its label. The 8+ day pair is
  // the reading of the card - old games evaluated against games newly past 8 days, the
  // same population on both sides - so its verdict gets its own pill with an arrow.
  const divFacts: Fact[] = agedTot > 0 ? [
    { label: 'Evaluated', value: fmt.int(clearedTot) },
    { label: 'Got older', value: fmt.int(agedTot), note: rotted > 0 ? `${fmt.int(rotted)} reached 15+ days` : undefined },
    { label: '8+ days', value: <>{fmt.int(clearedOld)} evaluated vs {fmt.int(agedIntoOld)} new</> },
    clearedOld >= agedIntoOld
      ? { value: 'Stale backlog shrinking', tone: 'good', icon: '▼' }
      : { value: 'Stale backlog growing', tone: 'bad', icon: '▲' },
    ...(avgWait != null ? [{ label: 'Avg wait', value: `${fmt.dec(avgWait)}d`, note: 'import to evaluation' }] : []),
  ] : [{ value: `No game got older this ${winName}` }]

  const ageFacts: Fact[] = ageFirst && ageLast && aging.length >= 2 ? [
    {
      label: 'Median wait',
      value: ageLast.medAge === ageFirst.medAge ? `${ageLast.medAge}d` : `${ageFirst.medAge}d → ${ageLast.medAge}d`,
      ...(ageLast.medAge > ageFirst.medAge ? { tone: 'bad' as const, icon: '▲' as const }
        : ageLast.medAge < ageFirst.medAge ? { tone: 'good' as const, icon: '▼' as const } : {}),
    },
    { label: 'Slowest 10%', value: `${ageLast.p90Age}d` },
    { label: 'Oldest', value: `${ageLast.maxAge}d` },
  ] : [{ value: 'Needs more than one bucket to show a trend' }]

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
      rest: <>{fmt.int(moving)} stale games from {names} to the {rbRecv.length === 1 ? 'evaluator' : `${rbRecv.length} evaluators`} Rescue picked</>,
      why: <>{rbSources.length === 1 ? 'One person holds' : `${rbSources.length} people hold`} {fmt.int(staleHeld)} games that have been in their backlog for more than {rb.staleDays} days{rbSources.length > top.length ? <>, most of them these {top.length}</> : null}. Rescue found {rbRecv.length === 1 ? 'one evaluator' : `${rbRecv.length} evaluators`} who can take them.</>,
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
    rest: <>the {fmt.int(top3Stale)} games that have waited more than {sd} days with {holderNames} first in the next assign run</>,
    why: <>{oldHolders.length === 1 ? 'One person holds' : `${oldHolders.length} people hold`} {fmt.int(holderStale)} of the team&apos;s {fmt.int(staleTotal)} games that have been in a backlog for more than {sd} days{staleTotal > 0 ? <> ({fmt.pct(holderStale / staleTotal)})</> : null}{oldHolders.length > top3.length ? <>, most of them these {top3.length}</> : null}. For each of them that is over {fmt.pct(STALE.share)} of their backlog.</>,
    payoff: <>The oldest games get evaluated first, without adding people</>,
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
    rest: <>out why the pace dropped before adding people</>,
    // The KPI row compares with the previous window and this line used to compare with
    // the trailing 90 days, so the same metric appeared twice on one screen against two
    // unnamed references. It now leads with the window the reader picked, and says
    // which reference it is either way.
    why: prevPerDay > 0
      ? <>The team evaluated {perDayFmt(perDay)} games a day, vs {perDayFmt(prevPerDay)} {kpiRefNote} and {perDayFmt(ref.velocity)} over the {bl ? `${bl.days} days` : 'buckets'} before this {winName}</>
      : <>The team evaluated {perDayFmt(perDay)} games a day, vs {perDayFmt(ref.velocity)}, the {refNote}</>,
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
      ? <>{fmt.int(addPer)} {addPer === 1 ? 'game' : 'games'} a day ({fmt.int(nowPer)} to {fmt.int(needPer)}) to evaluate as many games as arrive</>
      : <>{fmt.int(net)} more games to evaluate as many games as arrived</>,
    why: <>{fmt.int(inTotal)} games arrived, {fmt.int(outTotal)} evaluated this {winName} · {heads === 1 ? '1 person' : `${fmt.int(heads)} people`} working</>,
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
    why: <>{fmt.int(stock)} games in the backlog · the team evaluates {perDayFmt(perDay)} a day · that is {fmt.dec(daysToClear)} days of work</>,
    payoff: <>Backlog drops from {fmt.dec(daysToClear)} days of work to {T.clearDays}</>,
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
    rest: <>the {fmt.int(oldest)} games that have waited 15+ days since import</>,
    why: <>The games waiting 15+ days alone are {fmt.dec(oldest / perDay)} days of work at {perDayFmt(perDay)} a day.</>,
    payoff: <>Days to clear falls from {fmt.dec(daysToClear)} to {fmt.dec(Math.max(0, stock - oldest) / perDay)}</>,
  })

  // -- quality --
  // One line left here, and it is about a gate rather than a person: work sitting
  // un-triaged is a fact about the flow. The re-judge line that used to sit beside it
  // was a verdict on how the team judges, and left with law 3.
  if (f.shortlisted > 0 && f.finalPriority === 0) acts.push({
    sev: 1, key: 'notriage', topic: 'quality',
    lead: 'Ask',
    rest: <>a moderator to give final conclusions on this {winName}&apos;s shortlist</>,
    why: <>{fmt.int(f.shortlisted)} shortlisted games, none has a final conclusion yet</>,
  })
  const shown = rankActs(acts)

  // One sentence about the WHOLE backlog - every unevaluated game, all history - never
  // just the window. "The backlog is small" used to print whenever the pace could clear
  // it inside T.clearDays, so a batch that evaluated its own games read "small and
  // cleared fast" over 3,505 games still waiting, a third of them 8+ days old, under an
  // amber banner. The sentence now says which way the backlog moved, then the worst
  // problem among the Speed and Age chips, so it can never read calmer than they do.
  const speedTone: 'good' | 'warn' | 'bad' = daysToClear == null ? 'good'
    : daysToClear > T.clearDays * 3 ? 'bad' : daysToClear > T.clearDays ? 'warn' : 'good'
  const ageTone: 'good' | 'warn' | 'bad' = agedShare > T.agedShare ? 'bad' : agedShare > T.agedShare / 2 ? 'warn' : 'good'
  const rankTone = { good: 0, warn: 1, bad: 2 } as const
  const problem = rankTone[ageTone] === 0 && rankTone[speedTone] === 0 ? null
    // Age wins a tie: old games are the part of the backlog someone can act on today.
    : rankTone[ageTone] >= rankTone[speedTone]
      ? `${fmt.pct(agedShare)} of it has waited 8+ days`
      : `it takes ${fmt.dec(daysToClear!)} days to clear at the current pace`
  const direction = net < 0 ? 'The backlog is shrinking' : net > 0 ? 'The backlog is growing' : 'The backlog did not change'
  const headline = stock === 0 ? 'The backlog is empty.'
    : daysToClear == null
      ? `${outTotal >= inTotal ? 'The team evaluated more games than arrived' : 'More games arrived than the team evaluated'}: ${fmt.int(stock)} games waiting.`
      : problem
        ? `${direction}${net > 0 ? ', and ' : ', but '}${problem}.`
        : `${direction}: ${fmt.int(stock)} games ${net < 0 ? 'still ' : ''}waiting.`
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
        ? <>Backlog grew by <b>{fmt.int(net)}</b> games this {winName}</>
        : net < 0
          ? <>Backlog shrank by <b>{fmt.int(-net)}</b> games this {winName}</>
          : <>Backlog did not change this {winName}</>,
    },
    ...(daysToClear != null ? [{
      key: 'speed' as Topic,
      tone: speedTone,
      text: <><b>{fmt.dec(daysToClear)} days</b> to clear the backlog at {fmt.int(perDay)} games/day</>,
    }] : []),
    {
      key: 'age', tone: ageTone,
      // "since import" is not decoration. The `holders` action a few lines above this
      // chip counts stale games from the ASSIGN date at the admin's configured
      // threshold, so a shorter threshold legitimately produces a larger count than
      // this band does - and a manager reading 1,141 over 1,096 with nothing on screen
      // saying the clocks differ concludes one of them is broken. The band stays a
      // fixed ruler and `staleDays` stays a threshold; only the label is added.
      text: <><b>{fmt.int(oldStock)} games</b> ({fmt.pct(agedShare)} of the backlog) have waited 8+ days since import</>,
    },
  ] : []
  // The banner takes the colour of its worst chip. The sentence is a summary of them,
  // so it cannot read calmer than the numbers under it.
  const verdictTone = bannerTone(chips, 'good', shown)

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
      <Guide title="Overview - how big is the backlog, and is it shrinking?"
        read={[
          <span key="1">The sentence and chips at the top are the summary. The charts below show where the numbers come from.</span>,
          <span key="1c">The small line inside each KPI is that number per {unitName} across the window. The grey line below compares with {pv ? <b>{pv.label}</b> : <>the period before</>}.</span>,
          <span key="2">Flow chart: the two solid lines are games arrived and games evaluated, the dashed line is the backlog. The legend under it names each colour.</span>,
          <span key="3">The KPI row compares with {pv ? <b>{pv.label}</b> : <>the period before</>}. <b>Team health</b> compares with the 90 days before the window, so it does not change when you change the filter.</span>,
        ]}
        act={[
          <span key="1">If &ldquo;Do this&rdquo; is empty, nothing needs action this {winName}.</span>,
          <span key="2">At most three actions show, most urgent first.</span>,
          <span key="3">Actions are about evaluating faster or better. How many games arrive is set by the push filter, not here.</span>,
        ]} />

      {/* The verdict: one sentence and the three readings it was made from, as one
          object. They used to be a headline and a row of pills stacked in the page
          flow, which left the reader to work out that the pills were the evidence for
          the sentence rather than three more facts. Each chip is a control - it takes
          you to the number it came from. Shared with Leaderboard and Individual
          (Task 13) - see `VerdictHeader`. */}
      <VerdictHeader tone={verdictTone} headline={headline} chips={chips}
        kicker={(k) => TOPIC[k as Topic]} verdictRef={bannerRef} onChip={focus} />

      {/* Five numbers, read left to right as one sentence: what arrived, what went out,
          what is left over, how fast it is going out, and how much of it was worth
          keeping. In / out / stock / speed / quality. The spec capped Tier 1 at four
          numbers; five earn their place here because dropping any one breaks the
          sentence, and because Assigned used to appear ONLY on batch view - where the
          pipeline is null - so the tab changed shape depending on the filter. */}
      <div className="rp-kpi-row">
        <Kpi label="Assigned" value={fmt.int(inTotal)} sub={`new games this ${winName}`}
          spark={p && p.series.length >= 2 ? done(p.series.map((r) => r.newGames)) : undefined}
          noTrend sparkNote={`games per ${unitName}`} sparkColor={P.role.intake} tip={TIP.assigned} />
        <Kpi label="Evaluated" value={fmt.int(outTotal)} sub={`evaluated this ${winName}`} hi
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
          sparkNote={`backlog at each ${unitName}'s end`} sparkColor={P.role.backlog} tip={TIP.backlog} />
        {/* The team's pace, not a person's - see `perDay`. No sparkline: per bucket it
            would be `evaluated ÷ a constant`, which is the Evaluated spark two cards to
            the left with a different y scale. Drawing the same shape twice and calling
            it two readings is the thing this KPI row was cleaned up to stop. */}
        <Kpi label="Games per day" value={perDayFmt(perDay)} sub={`evaluated per day, whole team${elapsedDays > 0 ? ` · over ${fmt.int(elapsedDays)} days` : ''}`}
          noTrend focusKey="speed" tip={TIP.gppd}
          bench={prevPerDay > 0 ? {
            text: `${kpiRefNote} ${perDayFmt(prevPerDay)}`,
            delta: (perDay - prevPerDay) / prevPerDay,
            tone: vsRef(perDay, prevPerDay) === 'bad' ? 'bad' : vsRef(perDay, prevPerDay) === 'good' ? 'good' : 'flat',
          } : null} />
        <Kpi label="Shortlist rate" value={srVal} sub={`${fmt.int(f.shortlisted)} of ${fmt.int(f.evaluated)} evaluated`} focusKey="quality"
          spark={done(rated.map((m) => Math.round(m.survivalRate * 1000)))} noTrend sparkNote={`rate per ${unitName}`}
          sparkColor={P.role.shortlist} tip={TIP.survival}
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

      <div className="rp-section-title">Flow - games arrived vs evaluated</div>
      <div className="rp-grid-70-30">
        <Card label="Flow &amp; backlog" note={p ? `arrived vs evaluated per ${unitName}, plus the backlog` : 'assigned vs evaluated per bucket'}
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
          <Foot hint={<>&ldquo;New games in&rdquo; above &ldquo;Evaluated&rdquo; = more games arrived than were evaluated that {unitName}</>}
            facts={[
              { label: 'Arrived', value: fmt.int(inTotal) },
              { label: 'Evaluated', value: fmt.int(outTotal) },
              backlogMove != null && {
                label: 'Backlog', value: `${fmt.int(flowFirst!.backlog)} → ${fmt.int(flowLast!.backlog)}`,
                tone: backlogMove > 0 ? 'bad' : 'good', icon: backlogMove > 0 ? '▲' : '▼',
              },
            ]} />
          {p && <FlowTable partialTail={partialTail} inLabel="Arrived" outLabel="Evaluated"
            rows={p.series.map((r) => ({ label: r.label, in: r.newGames, out: r.evaluated, backlog: r.backlog }))} />}
        </Card>
        {/* The denominator of "Games per day", on the same days as the chart beside it.
            Without it a thin week and a slow week look identical, which is the first
            thing anyone asks when the pace gauge is short. It cannot share the flow
            chart's axis - people run 4 to 11, games run in the thousands - so it gets
            its own card rather than a second axis. */}
        <Card label="People working" note={`evaluators who logged work, per ${unitName}`} fill
          tip={<><F>= count(distinct initial_evaluator), per {unitName}</F>Anyone who evaluated at least one game that {unitName}, not the roster. This is the divisor behind Games per day, so read a dip here before reading the pace gauge as a slowdown.</>}>
          {/* indigo, not the red of CAT[5]: a headcount is a fact, and red here both
              read as an alarm and collided with the 15d+ age band next door */}
          {peopleCols.length ? <ColumnChart data={peopleCols} color={P.role.people} name="Evaluators" fill /> : <Empty text="Needs a time axis" />}
          {peopleCols.length > 0 && (
            <Foot keys={peopleLive ? [{ shape: 'bar', color: P.role.people, label: `Full ${unitName}` }, { shape: 'bar-partial', color: P.role.people, label: `${nowName}, so far` }] : undefined}
              facts={[
                peopleLive && { label: `${nowName} so far`, value: fmt.int(peopleLive.value) },
                peopleLow && { label: 'Fewest', value: fmt.int(peopleLow.value), note: peopleLow.label },
                peopleLow && { label: 'Most', value: fmt.int(peopleHigh) },
              ]} />
          )}
        </Card>
      </div>

      <Card label="New games by source" note="which importer the games came from, per bucket"
        tip={<><F>= count(imported_at) grouped by game_info.type</F>Which importer found the game: the apkcombo, appagg, top-pub and insight-track scrapers, the store sync, or a person adding one by hand. The total matches &ldquo;New games in&rdquo; above; this chart splits it by where the games came from. Volume only - how well a source converts is a question about the push filter, not about this team.</>}>
        {srcRows.length ? <StackedBars rows={srcRows} keys={srcKeys} colors={srcColors} unit="that bucket's" /> : <Empty text={p ? 'No new games in this window' : 'Needs a time axis - switch View by to Week, Month, Quarter or Custom'} />}
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

      <div className="rp-section-title">Quality - shortlist and final conclusions</div>
      <div className="rp-grid-2-1">
        <Card label="Shortlist funnel" note="evaluated → shortlist → final priority"
          tip={<><F>shortlist = initial conclusion ≠ Bypass</F><F>final = Priority IV + Insight</F>It starts at Evaluated. Assigned counts new games, a different set, which belongs in the flow chart above. Each band carries its conversion from the band over it.</>}>
          <Funnel stages={funnelStages} />
          {worstStep && <Foot facts={[{ label: 'Biggest drop', value: <>{worstStep.from} → {worstStep.to}</>, note: `${fmt.pct(worstStep.b / worstStep.a)} pass` }]} />}
        </Card>
        <Card label="Team health" note={`this window vs ${refNote}`}
          tip={<><F>notch = {bl ? `the same metric over the ${bl.days} days before this window` : 'the average of the buckets on screen'}</F>The notch sits where the team normally runs, and it moves as the team does, so a bar that reaches it reads as normal rather than as hitting a number somebody once picked.<br />The <b>small line</b> beside each value is that same metric {unitName} by {unitName} across the window on screen: it says whether the gauge is a step in a trend or a one-off wobble. The <b>▲▼ figure</b> under each bar shows the change from the second-to-last {unitName} to the last one, in points.<br />Unlike the KPI row above, this card stays on the 90-day reference whatever window you choose - it is a threshold, not a comparison.</>}>
          <HealthBars rows={health} unitName={unitName} />
        </Card>
      </div>

      <div className="rp-grid-70-30">
        <Card label="Quality rates over time" note="shortlist &amp; hit %, per bucket"
          tip={<><F>shortlist rate = shortlist ÷ evaluated</F><F>hit rate = final priority ÷ evaluated</F>Each point covers only the games evaluated in that {unitName}, both halves of the ratio. The line therefore tracks shortlist quality on its own, whatever the number of new games.</>}>
          {ms.length >= 2 ? <LineChart series={rateSeries} format={(v) => `${v.toFixed(1)}%`} /> : <Empty text="Need more than one period" />}
        </Card>
        <Card label="Final conclusions" note="moderator outcomes"
          tip={<><F>= distribution of final_conclusion</F>Only shortlisted games ever get one, so this is usually tens of games. At that size a pie chart is unreadable, which is why it is a list.</>}>
          <ConclusionList data={d.finalConclusions} />
        </Card>
      </div>

      <div className="rp-section-title">Backlog - are the old games being evaluated?</div>
      <div className="rp-grid-2">
        <Card label="Backlog by age over time" note="age of the games in the backlog at the end of each bucket"
          tip={<><F>age = bucket end day − import day, for games still unevaluated</F><F>median = half the backlog has waited less than this</F>The same backlog as the dashed line in the flow chart, split into age groups instead of one total. Read it beside the chart on the right: same bands, same colours, so the two say what is waiting against what actually got done.</>}>
          {aging.length ? <StackedBars rows={aging.map((r) => ({ name: r.label, parts: ageParts(r) }))} keys={AGE_KEYS} colors={AGE_COLORS} unit="that bucket's" /> : <Empty text="Needs a time axis" />}
          <Foot facts={ageFacts} />
        </Card>
        {/* The chart on the left is a snapshot: it shows the 8-14d pile shrinking
            without saying whether those games were judged or turned 15d+. This one
            counts the two events that move a game, on the same days, out of a shared
            centre line - so a bucket reads as ground gained or ground lost. */}
        <Card label="Evaluated vs got older" note={`evaluated vs got older, per ${unitName}`}
          tip={<>
            <F>right = evaluated that {unitName}, by age on the day it was evaluated</F>
            <F>left = crossed into an older band that {unitName} (import day + 4, + 8, + 15)</F>
            Both sides count EVENTS, not the backlog itself, so one game can appear at most once on
            each: it is evaluated once, and it passes a boundary once. That is what makes
            the two halves addable across buckets, which a snapshot chart never is.
            Same scale both ways - the longer side is the reading.
          </>}>
          {divRows.length ? (
            <DivergingBars rows={divRows} rightKeys={AGE_KEYS} leftKeys={AGED_KEYS} colors={AGE_COLORS}
              leftLabel="Got older" rightLabel="Evaluated" />
          ) : <Empty text="Needs a time axis" />}
          <Foot hint="Right = evaluated, left = got older. The longer side wins." facts={divFacts} />
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
// number crosses one of these. calSpread, calMin, concentration and the two outlier
// ratios are admin rules (Config -> Alert rules, folded in by `tabRules`); the rest
// stay fixed here.
// The kicker on Leaderboard's verdict chips. Overview's TOPIC map speaks to the
// backlog (growth/speed/age); this tab's sentence is about the TEAM, so its chips
// carry the team's own vocabulary - who worked at all, how concentrated the output
// is, and whether everyone judges by the same bar.
const LB_KICKER: Record<string, string> = { people: 'ACTIVE', top: 'TOP EVALUATOR', cal: 'SHORTLIST RATE' }
const LB_T_BASE = {
  // calSpread: gap in shortlist rate between the strictest and the loosest evaluator,
  // past which the team's rate is an average of two different bars.
  // calMin: under this many games a rate is a run of luck, not a bar.
  // concentration: one person carrying this much of the output is a single point of
  // failure. All three are admin rules now.
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
  // downstream ever sees what was dropped. The two ratios (outlierHigh/outlierLow) are
  // the admin's `highRate`/`lowRate` rules - the same pair Individual's shortlist
  // actions read, so "far more than the team" means one thing on both tabs.
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
  const { LB_T, STALE } = tabRules(d)
  const P = usePalette()
  const ev = d.evaluators
  const sd = staleDays(d)
  const { ref: verdictRef, focus } = useRpFocus<HTMLDivElement>()
  const [flashPerDay] = useState(focusOnce === 'perday')
  useEffect(() => {
    if (focusOnce !== 'perday') return
    onConsumeFocus?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Naming somebody in a chart's sentence and leaving the reader to find them in a
  // table of fifteen rows is half a navigation. Same contract the design doc sets for
  // Overview's buttons: land on the right screen, with the named row flashed. The
  // flash clears itself, because a tint that stays is no longer a signal - and it
  // clears on unmount too, or a timer fires into a component that is gone.
  const tableRef = useRef<HTMLDivElement>(null)
  const [flashName, setFlashName] = useState('')
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current) }, [])
  function focusPerson(name: string) {
    setFlashName(name)
    tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlashName(''), 2400)
  }
  // A name in a sentence that moves the page is a control, so it is a button: it has
  // to be reachable from the keyboard and announce itself as one. It keeps the bold
  // weight the plain name had, so the sentence still reads the same.
  const Who = ({ name }: { name: string }) => (
    <button type="button" className="rp-who" onClick={() => focusPerson(name)}
      title={`Show ${name} in the table below`}>{name}</button>
  )
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
  // Coloured by TITLE, the one thing about a person position cannot show: where the
  // fulltime team sits against the freelancers. Not by quadrant (that is the position
  // itself, drawn twice) and not by computed clusters (they reshuffle every window and
  // name nothing). Two groups only - a scatter is an all-pairs form, capped at three.
  const groupOf = (t: string | null) => (t && /full/i.test(t) ? 0 : t && /free/i.test(t) ? 1 : null)
  const scatterPts = plotted.map((e) => {
    const g = groupOf(e.title)
    return { name: e.name, x: e.evaluated, y: e.survivalRate * 100, size: Math.max(0.1, e.throughput),
      color: g == null ? P.role.neutral : P.groups[g] }
  })
  const scatterGroups = ([['Fulltime', 0], ['Freelancer', 1]] as const)
    .filter(([, g]) => plotted.some((e) => groupOf(e.title) === g))
  const noTitle = plotted.some((e) => groupOf(e.title) == null)
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
    do: <>Review 20 games {outLow[0].name} bypassed with a moderator</>,
    // "games" is said once, over the evaluated count. Repeating it in the projection
    // took this sentence to 153 characters on a real five-digit volume - over the
    // 150-character evidence budget the whole block is written to.
    why: <>{outLow[0].name} shortlists {fmtRate(outLow[0].survivalRate)}; the rest of the team shortlists {fmtRate(restKeep(outLow[0]))}, over {fmt.int(outLow[0].evaluated)} games. At the team&apos;s rate that is about {fmt.int(outLow[0].evaluated * restKeep(outLow[0]))} shortlisted, not {fmt.int(outLow[0].shortlisted)}.</>,
  })
  else if (calSpread != null && calSpread > LB_T.calSpread) acts.push({
    sev: 3, fam: 'cal', key: 'cal', who: strict.key,
    do: <>Have {loose.name} review 20 games {strict.name} bypassed, then agree on one shortlist rule</>,
    why: <>At {loose.name}&apos;s rate, {strict.name} would have shortlisted about {fmt.int(strict.evaluated * loose.survivalRate)} of {fmt.int(strict.evaluated)} games, not {fmt.int(strict.shortlisted)}. Same genre.</>,
  })
  else if (outHigh.length) acts.push({
    sev: 2, fam: 'cal', key: 'outhigh', who: outHigh[0].key,
    do: <>Have {outHigh[0].name} explain 5 games they shortlisted to the team</>,
    why: <>{outHigh[0].name} shortlists {fmtRate(outHigh[0].survivalRate)}; the rest of the team shortlists {fmtRate(restKeep(outHigh[0]))}, over {fmt.int(outHigh[0].evaluated)} games. Either they see more, or they shortlist too easily.</>,
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
    why: <>{fmt.int(queueStuck.stale)} of {queueStuck.name}&apos;s {fmt.int(queueStuck.n)} games have been in their backlog for more than {sd} days ({fmt.pct(queueStuck.stale / queueStuck.n)} of their backlog, {fmt.pct(queueStuck.stale / Math.max(1, queueStale))} of the team&apos;s stale games). Oldest: {queueStuck.oldest} days.</>,
    cta: { label: `Reassign ${queueStuck.name}`, href: `/team-ops?tab=reassign${catParam(d)}&from=${encodeURIComponent(queueStuck.name)}` },
  })
  else if (stuckFree.length) acts.push({
    sev: 3, fam: 'speed', key: 'stuck', who: stuckFree[0].key,
    do: <>Move part of {stuckFree.slice(0, 2).map((e) => e.name).join(' and ')}&apos;s backlog to someone with room</>,
    why: <>Games wait {stuckFree.slice(0, 2).map((e) => `${e.turnaround!.toFixed(0)} days with ${e.name}`).join(' and ')} before evaluation. Team average: {teamTa!.toFixed(0)} days</>,
  })

  if (top && active.length >= 3 && topShare > LB_T.concentration) acts.push({
    sev: 2, fam: 'cover', key: 'conc', who: top.key,
    do: <>Give part of {top.name}&apos;s games to a second evaluator this {winName}</>,
    why: <>{top.name} evaluated {fmt.int(top.evaluated)} of the {fmt.int(totalEval)} games this {winName}. One day off for {top.name} costs the team {fmt.int(top.throughput)} games.</>,
  })
  else if (idle && idle.gaps / periods.length > LB_T.idleShare) acts.push({
    sev: 2, fam: 'cover', key: 'idle', who: idle.name.toLowerCase(),
    do: <>Ask {idle.name} whether they are on leave or stuck</>,
    why: <>{idle.name} evaluated nothing in the last {idle.gaps} of {periods.length} {unitNames}</>,
  })

  // Held back while no moderator has judged anything yet: the final conclusion is
  // stamped days after the evaluation, so a fresh window reads every shortlist as weak.
  if (finPeople.length >= 2 && d.funnel.finalPriority > 0
    && holdUp(finPeople[0]) - holdUp(finPeople[finPeople.length - 1]) > LB_T.pickGap) acts.push({
      sev: 1, fam: 'picks', key: 'picks', who: finPeople[0].key,
      do: <>Ask {finPeople[0].name} to show {finPeople[finPeople.length - 1].name} 5 of their shortlisted games that became Priority IV or Insight</>,
      why: <>{fmt.pct(holdUp(finPeople[0]))} of {finPeople[0].name}&apos;s shortlisted games reached Priority IV or Insight; {fmt.pct(holdUp(finPeople[finPeople.length - 1]))} of {finPeople[finPeople.length - 1].name}&apos;s did</>,
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
  const LB_ALL_CLEAR = 'Everyone is evaluating at a similar pace and shortlist rate.'
  const headline = active.length === 0
    ? `Nobody evaluated anything this ${winName}.`
    : calSpread != null && calSpread > LB_T.calSpread
      ? 'Shortlist rates differ a lot between evaluators.'
      // Stale backlogs before the all-clear: the Reassign line fires on `queueWarn`, so
      // a headline that only read `stuck` said "everyone is fine" over that action.
      : queueWarn.length
        ? (queueWarn.length === 1
          ? `${fmt.int(queueWarn[0].stale)} games have been in ${queueWarn[0].name}'s backlog for more than ${sd} days.`
          : `${queueWarn.length} evaluators have many games in their backlog for more than ${sd} days.`)
      : stuck.length
        ? (stuck.length === 1 ? `${stuck[0].name}'s backlog is not moving.` : `${stuck.length} evaluators have a backlog that is not moving.`)
        : top && active.length >= 3 && topShare > LB_T.concentration
          ? `${top.name} evaluated most of the games.`
          : LB_ALL_CLEAR

  // Both rates as percentages, same as the Shortlist % column the chip points at.
  const calWords = calSpread != null
    ? { clause1: fmtRate(strict.survivalRate), clause2: fmtRate(loose.survivalRate) } : null

  const chips: Array<{ key: string; text: React.ReactNode; tone: 'good' | 'warn' | 'bad' }> = active.length ? [
    {
      key: 'people', tone: band(ev.length ? active.length / ev.length : 0, 0.6, 0.85),
      text: <><b>{active.length} of {ev.length} evaluators</b> active this {winName}</>,
    },
    ...(top ? [{
      key: 'top',
      tone: (topShare > LB_T.concentration ? 'bad' : topShare > LB_T.concentration * 0.75 ? 'warn' : 'good') as 'good' | 'warn' | 'bad',
      text: <><b>{top.name}</b> evaluated <b>{fmt.pct(topShare)}</b> of all games this {winName}</>,
    }] : []),
    ...(calWords ? [{
      key: 'cal',
      tone: (calSpread! > LB_T.calSpread ? 'bad' : calSpread! > LB_T.calSpread / 2 ? 'warn' : 'good') as 'good' | 'warn' | 'bad',
      // Both RATES bold, not just the names: the spec's rule for every chip on every
      // tab is that the number is bold and the sentence around it carries the meaning,
      // and this chip sits on the same screen as `people` and `top`, which both do it.
      text: <><b>{strict.name}</b> shortlists <b>{calWords.clause1}</b> of their games; <b>{loose.name}</b> shortlists <b>{calWords.clause2}</b></>,
    }] : []),
  ] : []
  // Every headline branch above the all-clear names a problem. The stale-backlog one
  // matters most: none of the three chips reads the backlog, so without this the banner
  // printed green over "N games have been in X's backlog for more than 7 days".
  const headTone: Tone = headline === LB_ALL_CLEAR ? 'good' : 'warn'
  const verdictTone = bannerTone(chips, headTone, shown)

  // Eight rank boards became these columns. Sorting is the only state on the tab and it
  // never leaves the browser, so re-asking a question costs a click and not a request.
  const cols: Array<SortCol<Ev>> = [
    {
      key: 'games', label: 'Games', tip: TIP.evaluated, focusKey: 'top',
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
      key: 'short', label: 'Shortlist %', tip: TIP.survival, focusKey: 'cal',
      value: (e) => (e.evaluated > 0 ? e.survivalRate : null),
      cell: (e) => (e.evaluated > 0 ? fmtRate(e.survivalRate) : '·'),
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
      <Guide title="Leaderboard - who is doing well, and who needs help?"
        read={[
          <span key="1">The sentence and chips at the top are the summary. The table below is the detail.</span>,
          <span key="2"><b>Click any column to sort.</b> Each rate shows its counts in the same cell, so a high % on few games is easy to spot.</span>,
          <span key="3"><b>Games</b> and <b>Games / day</b> show how much someone evaluated. <b>Shortlist %</b> and <b>Hit %</b> show how good their shortlist is.</span>,
          <span key="4"><b>Hit %</b> comes late: moderators give final conclusions days after the evaluation, so an open {winName} looks low for everyone.</span>,
        ]}
        act={[
          <span key="1">If &ldquo;Do this&rdquo; is empty, nothing needs action this {winName}.</span>,
          <span key="2">At most three actions show, most urgent first, one per person.</span>,
          <span key="3">A big gap in shortlist rates always comes first. Until rates are similar, the quality columns cannot be compared between people.</span>,
        ]} />

      <VerdictHeader tone={verdictTone} headline={headline} chips={chips}
        kicker={(k) => LB_KICKER[k] ?? k.toUpperCase()} verdictRef={verdictRef} onChip={focus} />
      <DoBlock acts={shown.map((a) => ({
        sev: a.sev, key: a.key, kicker: famLabel(a.fam), do: a.do, why: a.why, cta: a.cta,
      }))} />

      {/* One day at a time, directly under the actions. It is the only block on this
          tab that is not about the whole period, and that is the point: everything
          else here asks where people differ from each other, which needs a window
          long enough to mean something, and this asks whether a particular day's work
          happened, which does not. So it counts and never rates - no percentage, no
          ranking - and the note says which of the filters above still reach it.
          Its data is its own request, not part of the report payload: Overview and
          Individual must not pay for a table they never show. `window.to` is
          EXCLUSIVE on the payload, so the last day is to-1; absent on a window with
          no bounds, where the route falls back to a recent span of its own. */}
      <div className="rp-section-title">Day by day - what was evaluated each day</div>
      <p className="rp-daily-scope">
        Counts for a single day, never rates - a day is far too short to read anyone&apos;s bar
        from. The period above chooses which days you can step through; the Category filter
        chooses which buckets appear.
      </p>
      <DailyBlock category={d.category}
        windowFrom={d.window.from || null}
        windowTo={d.window.to ? addDays(d.window.to, -1) : null} />

      <div className="rp-section-title">Everyone - how much each person evaluated, and how good their shortlist is</div>
      <Card label="Volume vs shortlist rate" note="x = games evaluated · y = shortlist % · bubble = games per day"
        tip={<><F>x = evaluated · y = shortlist ÷ evaluated · bubble = games ÷ active day</F>How much someone evaluated, against how much of it they shortlisted. The team line is the pooled rate, total over total, so a light workload cannot move it. The dashed line is the whole team; the outlier test compares each person with EVERYONE ELSE, because someone extreme drags a pool they are inside. Called out at under {LB_T.outlierLow} times the others&apos; rate, or over {LB_T.outlierHigh} times it, on {LB_T.calMin}+ games and by more than chance explains. The two ends are not symmetric on purpose: a high rate is usually someone shortlisting too easily or a lucky run, a low rate is games with signal that nobody downstream will ever see.</>}>
        {scatterPts.length ? <Scatter points={scatterPts} xLabel="Games evaluated" yLabel="Shortlist %"
          sizeLabel="Games per day" avgX={avgVol} avgY={teamKeep * 100}
          avgXLabel={`average evaluated, ${fmt.int(avgVol)} games`} avgYLabel={`average shortlist rate, ${fmtRate(teamKeep)}`}
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
          keys={[
            ...scatterGroups.map(([label, g]) => ({ shape: 'dot' as const, color: P.groups[g], label })),
            ...(noTitle ? [{ shape: 'dot' as const, color: P.role.neutral, label: 'No title' }] : []),
            { shape: 'dash', label: 'Average' },
            { shape: 'ring-low', label: 'Shortlists far less than the others' },
            { shape: 'ring-high', label: 'Shortlists far more' },
          ]}
          facts={outLow.length || outHigh.length
            // No multiple when there is nothing to multiply: a 0% rate has a ratio of
            // zero, and "1000000000.0x less" is what the old guard printed for it.
            ? [...outLow, ...outHigh].map((e) => {
              const r = ratioOf(e), low = outLow.includes(e)
              return {
                label: <Who name={e.name} />,
                value: <>{fmtRate(e.survivalRate)} vs {fmtRate(restKeep(e))}</>,
                note: <>{r > 0 ? `${fmt.dec(low ? 1 / r : r)}x ${low ? 'less' : 'more'} · ` : ''}{fmt.int(e.evaluated)} games</>,
                tone: low ? 'bad' as const : undefined,
                icon: low ? '▼' as const : '▲' as const,
              }
            })
            : [
              { value: 'Nobody far from the team', tone: 'good', icon: '✓' },
              { label: 'Average', value: fmtRate(teamKeep) },
              plotted.length >= 2 && {
                label: 'Range',
                value: <>{fmtRate(Math.min(...plotted.map((e) => e.survivalRate)))} to {fmtRate(Math.max(...plotted.map((e) => e.survivalRate)))}</>,
                note: `${plotted.length} people, ${LB_T.calMin}+ games`,
              },
            ]}>
          {pace.length > 1 && <BubbleKey caption="Games / day" min={Math.min(...pace)} max={paceMax}
            rad={scatterRad} format={(v) => fmt.dec(v, 0)} />}
        </Foot>
      </Card>
      <div ref={tableRef}>
      <Card label="Everyone, side by side" note="click a column to sort · each rate shows its counts"
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
          rowFlash={(e) => e.name === flashName
            || (flashPerDay && e.evaluated > 0 && e.throughput < d.teamTotals.avgThroughput)} />
        <Foot
          hint={d.config.credibility
            ? <>Click a column to sort. Sample weight = games ÷ median games ({fmt.int(medianVol)}), capped at 100%.</>
            : <>Click a column to sort.</>}
          facts={[
            bestRate && { label: 'Top shortlist rate', value: <><Who name={bestRate.name} /> {fmtRate(bestRate.survivalRate)}</>, note: `${fmt.int(bestRate.evaluated)} games` },
            active.length > 0 && { label: 'Median', value: `${fmt.int(medianVol)} games` },
          ]} />
      </Card>
      </div>

      <Card label="Backlog by person" note="backlog now, per person · colour = how long the games have waited"
        tip={<><F>= unevaluated games, grouped by their assigned evaluator</F>The backlog now, not the window: every game still in the backlog, whenever it arrived. The bars add up to the Backlog number on Overview, and this card shows who holds those games.<br />Bands are days since the game was <b>assigned to this person</b>, which is not the clock Overview&apos;s &ldquo;Backlog by age&rdquo; uses - that one counts from import. Here the question is how long this person has held it, and a handover restarts that clock on purpose, the same way &ldquo;Days waiting&rdquo; does. So the two cards agree on the total and can disagree on the split.<br />The last column is games received minus games evaluated across the window on screen. Red is a backlog still growing.</>}>
        <QueueBars rows={queueRows.map((r) => ({ ...r, warn: warnKeys.has(r.key) }))}
          bands={AGE_BANDS.map((b) => ({ label: b.label, color: b.color }))}
          unitName={winName} staleFrom={sd} />
        <Foot
          hint={<>Bar = backlog now. After the bar: oldest game, then received minus evaluated this {winName}.</>}
          facts={queueTotal === 0
            ? [{ value: 'The backlog is empty', tone: 'good', icon: '✓' }]
            : [
              queueWarn.length > 0
                ? { label: `Over ${fmt.pct(STALE.share)} of backlog waiting ${sd}+ days`, value: nameList(queueWarn.map((r) => r.name)), note: `${fmt.int(queueWarn.reduce((s2, r) => s2 + r.stale, 0))} games`, tone: 'bad', icon: '!' }
                : { value: `Nobody has over ${fmt.pct(STALE.share)} of their backlog waiting ${sd}+ days`, tone: 'good', icon: '✓' },
              { label: 'Total', value: fmt.int(queueTotal), note: `${queueRows.length} ${queueRows.length === 1 ? 'person' : 'people'}` },
              queueTop && queueRows.length > 1 && { label: 'Most', value: queueTop.name, note: fmt.pct(queueTop.n / queueTotal) },
              queueGrowing.length > 0 && { label: 'Grew most', value: queueGrowing[0].name, note: `+${fmt.int(queueGrowing[0].net!)}`, tone: 'warn', icon: '▲' },
            ]} />
      </Card>

      <div className="rp-section-title">Activity - who is working, and who has stopped</div>
      <Card label="Activity heatmap" focusKey="people" note={`games evaluated · person × ${unitName}`}
        tip={<><F>cell = count(evaluated) for that person, that {unitName}</F>Day cells for a week, month or batch window; week cells for a quarter.</>}>
        <Heatmap periods={d.heatmap.periods} rows={d.heatmap.rows} />
        <Foot
          keys={[{ shape: 'heat', color: P.role.evaluated, label: 'Fewer → more games' }]}
          hint={<>Empty cells at the right end = stopped</>}
          facts={movers
            ? [
              movers.up.delta > 0 && { label: 'Climbed', value: movers.up.name, note: `+${movers.up.delta} to #${movers.up.to}`, tone: 'good', icon: '▲' },
              movers.down.delta < 0 && { label: 'Fell', value: movers.down.name, note: `${movers.down.delta} to #${movers.down.to}`, tone: 'warn', icon: '▼' },
              { label: 'Compared', value: `first vs second half of the ${winName}` },
            ]
            : [{ value: `No rank change between the two halves of this ${winName}` }]} />
      </Card>

      <div className="rp-section-title">Conclusions - what each person decided, and the moderator&apos;s final conclusions</div>
      <Card label="Initial conclusions by evaluator" note="quality order: List_Idea › Playtest &amp; Bypass › Bypass · gray = Link_dead"
        tip={<><F>bar = one evaluator · segment = count per conclusion</F>The picture behind the bypass spread in the chips above: red is where each person&apos;s bar sits.</>}>
        {initRows.length ? <StackedBars rows={initRows} keys={initKeys} /> : <Empty />}
        <Foot
          hint="A bigger red part than the others = bypasses more than the team"
          facts={byIdea.length < 2
            ? [{ value: `${byIdea.length} ${byIdea.length === 1 ? 'person has' : 'people have'} ${LB_T.calMin}+ games`, note: 'too few to compare' }]
            : ideaShare(byIdea[0]) - ideaShare(byIdea[byIdea.length - 1]) < 0.02
              ? [{ label: 'List_Idea share', value: `about ${fmtRate(ideaShare(byIdea[0]))}`, note: `all ${byIdea.length} people` }]
              : [
                { label: 'Most List_Idea', value: byIdea[0].name, note: fmtRate(ideaShare(byIdea[0])) },
                { label: 'Least List_Idea', value: byIdea[byIdea.length - 1].name, note: fmtRate(ideaShare(byIdea[byIdea.length - 1])) },
              ]} />
      </Card>
      <Card label="Shortlisted games - final conclusions" note="quality order: Priority IV › Insight › Watch List › Priority V › Theme/Art › Bypass"
        tip={<><F>bar = games one evaluator shortlisted · segment = the moderator&apos;s final conclusion</F>Final conclusions come days after the evaluation, so a window that just opened is mostly empty here.</>}>
        {finRows.length ? <StackedBars rows={finRows} keys={finKeys} /> : <Empty text="No shortlisted game has a final conclusion in this window" />}
        <Foot
          hint="Bar length = shortlisted games with a final conclusion. Short bar = still waiting."
          facts={finGames === 0
            ? [{ value: `No final conclusion yet this ${winName}`, note: 'normal until it closes', tone: 'warn', icon: '!' }]
            : [
              { label: 'People with one', value: `${finJudged.length} of ${active.length}` },
              { label: 'Games', value: fmt.int(finGames) },
            ]} />
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
/* A shortlist rate, as a percentage - always. The tab used to switch to "1 game in 70"
   for small rates, which the team then had to convert back to compare it with the "10%"
   printed in the table beside it. Under 10% it keeps one decimal, so 1.4% and 5.9% stay
   apart instead of rounding to 1% and 6%. */
export const fmtRate = (r: number) => (r > 0 && r < 0.1 ? fmt.pct1(r) : fmt.pct(r))
function pctPair(value: number, bench: number | null): [string, (n: number) => string] {
  return bench != null && Math.abs(value - bench) > 1e-9 && fmt.pct(value) === fmt.pct(bench)
    ? [fmt.pct1(value), fmt.pct1]
    : [fmt.pct(value), fmt.pct]
}
// The kicker on Individual's verdict chips. `net` and `wait` reuse Overview's own
// words on purpose: this tab's "Backlog +N" chip IS growth and its "oldest Nd" chip
// IS age - the same two numbers Overview's chips are named for, read for one person
// instead of the whole team. `share` has no Overview equivalent, so it gets its own
// word: how much of the team's output this person accounts for.
const IND_KICKER: Record<string, string> = { share: 'OUTPUT', net: 'GROWTH', wait: 'AGE' }
// Thresholds for the one "Do this" block on this tab. Same discipline as Overview's
// `T` and the Leaderboard's `LB_T`: a line prints only when a number crosses one of
// these, and nothing prints when nothing does.
// Individual's thresholds are all admin rules (see `tabRules`): intakeGap (backlog
// filling faster than they clear it, as a share of what they took), calMin (below it a
// rate is the sample talking), calLow/calHigh (how far from the rest of the team before
// the bar is worth a conversation). Same numbers the Leaderboard reads.
const IND_T_BASE = {}

// The saved alert rules (Config -> Alert rules) folded over the fixed parts of each
// tab's thresholds. Called at the top of each tab, so every rule is read from ONE
// place and a rule that two tabs share cannot drift: `minGames` is the Leaderboard's
// calibration floor and Individual's, `growthGap` is Overview's intake alert and
// Individual's, `lowRate`/`highRate` are the Leaderboard's outlier gates and
// Individual's shortlist actions. A payload without rules (an old cache, a fixture)
// reads the defaults.
function tabRules(d: Bundle) {
  const r: ReportRules = parseReportRules(d.config?.rules)
  return {
    R: r,
    STALE: { min: r.staleMin, share: r.staleShare },
    T: { ...T_BASE, intakeGap: r.growthGap, agedShare: r.agedShare, clearDays: r.clearDays },
    LB_T: {
      ...LB_T_BASE, calMin: r.minGames, calSpread: r.calSpread, concentration: r.concentration,
      outlierLow: r.lowRate, outlierHigh: r.highRate,
    },
    IND_T: { ...IND_T_BASE, calMin: r.minGames, intakeGap: r.growthGap, calLow: r.lowRate, calHigh: r.highRate },
  }
}

function Individual({ d }: { d: Bundle }) {
  const { IND_T, STALE } = tabRules(d)
  const P = usePalette()
  const [selKey, setSel] = useState('')
  const selected = useMemo(() => {
    if (!d.evaluators.length) return null
    return d.evaluators.find((e) => e.key === selKey) || d.evaluators[0]
  }, [d.evaluators, selKey])
  const { ref: verdictRef, focus } = useRpFocus<HTMLDivElement>()
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

  // ---- their own series ----
  const ps = d.personSeries?.[e.key] || []
  const vids = d.videos?.[e.key] || []
  const personSpark = done(ps.map((p) => p.evaluated))
  // Backlog rides on the same axis as the flows because all four count games - the
  // Overview flow chart does the same, in the same green dash. It skips the area fill,
  // which would bury the other lines.
  const hasBacklog = ps.length > 0 && ps.every((p) => p.backlog != null)
  const actSeries = [
    { name: 'Assigned', color: P.role.intake, points: ps.map((p) => ({ label: p.label, value: p.assigned })) },
    { name: 'Evaluated', color: P.role.evaluated, points: ps.map((p) => ({ label: p.label, value: p.evaluated })) },
    { name: 'Link dead', color: P.role.neutral, points: ps.map((p) => ({ label: p.label, value: p.linkDead })) },
    ...(hasBacklog ? [{ name: 'Backlog', color: P.role.backlog, dashed: true, area: false, points: ps.map((p) => ({ label: p.label, value: p.backlog! })) }] : []),
  ]
  const psTotals = ps.length
    ? ps.reduce((acc, p) => ({ assigned: acc.assigned + p.assigned, evaluated: acc.evaluated + p.evaluated, dead: acc.dead + p.linkDead }), { assigned: 0, evaluated: 0, dead: 0 })
    : null
  // The pile before the first bucket, backed out of that bucket's own movement, so the
  // footer reads start -> end of the window rather than end of day one -> end.
  const blOpen = hasBacklog ? Math.max(0, ps[0].backlog! - (ps[0].assigned - ps[0].evaluated - ps[0].linkDead)) : null
  const blClose = hasBacklog ? ps[ps.length - 1].backlog! : null

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
    { name: self ? 'You' : e.name, color: P.role.shortlist, points: qualityRows.map((p) => ({ label: p.label, value: (p.shortlisted / p.evaluated) * 100 })) },
    ...(multi && t.survivalRate > 0 ? [{
      name: teamPerBucket ? 'Team' : `Team, ${winName} average`, color: P.role.neutral, dashed: true,
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
  // QUEUE (is work piling up on them), CALIBRATION (is their bar the team's), and on
  // a contractor's own view RHYTHM and a good-news line. One line per family: three versions of the same
  // complaint would fill the cap and leave the other problems unsaid.
  type Act = { sev: number; fam: string; key: string; do: React.ReactNode; why: React.ReactNode; payoff?: React.ReactNode; cta?: DoAct['cta'] }
  const acts: Act[] = []
  // The second answer to a backlog problem, for a manager: move the games instead of
  // asking one person to work faster. It opens Reassign with this person already picked
  // as the source. Never on a contractor's own view - Reassign is not theirs to run.
  const reassignCta: DoAct['cta'] | undefined = self ? undefined : {
    label: `Or reassign ${e.name}'s games`,
    href: `/team-ops?tab=reassign${catParam(d)}&from=${encodeURIComponent(e.name)}`,
  }

  // No `idle` act here any more: the Leaderboard already carries that line, and Law 2
  // says a story is concluded at exactly one altitude.
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
      ? <>{fmt.int(d.selfStale!)} of your {fmt.int(bq.n)} games have been in your backlog for more than {sd} days. Oldest: {bq.oldest} days.</>
      : <>{fmt.int(queueStale)} of {e.name}&apos;s {fmt.int(bq.n)} games have been in their backlog for more than {sd} days. Oldest: {bq.oldest} days.</>,
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
        ? <>Your stale games cleared in about {days} days</>
        : <>{Their} stale games cleared in about {days} days</>
    })(),
    cta: reassignCta,
  })
  else if (psTotals && psTotals.assigned > 0 && (psTotals.assigned - psTotals.evaluated) / psTotals.assigned > IND_T.intakeGap) acts.push({
    sev: 2, fam: 'backlog', key: 'behind',
    do: self
      ? <>Ask to have some of your games moved to someone else now</>
      : <>Move {fmt.int(psTotals.assigned - psTotals.evaluated)} games off {e.name} to someone with room</>,
    why: <>{They} received {fmt.int(psTotals.assigned)} games and evaluated {fmt.int(psTotals.evaluated)} this {winName}, so {their} backlog grew by {fmt.int(psTotals.assigned - psTotals.evaluated)}.</>,
    cta: reassignCta ? { ...reassignCta, label: `Reassign ${e.name}'s games` } : undefined,
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
      ? <>Ask a moderator to review your last 5 bypassed games with you</>
      : <>Review 20 games {e.name} bypassed with a moderator</>,
    // "At their rate" over a sentence whose subject is this person reads as their own
    // rate, which would make the clause say nothing. The rate being applied is the
    // rest of the team's, in both voices.
    why: <>{They} shortlist{self ? '' : 's'} {fmtRate(e.survivalRate)}; the rest of the team shortlists {fmtRate(restKeep!)}. At the team&apos;s rate that is about {fmt.int(e.evaluated * restKeep!)} shortlisted of {fmt.int(e.evaluated)} games, not {fmt.int(e.shortlisted)}.</>,
  })
  else if (enoughToJudge && keepRatio != null && keepRatio > IND_T.calHigh) acts.push({
    sev: 1, fam: 'cal', key: 'calhigh',
    do: self
      ? <>Explain 5 games you shortlisted to the team</>
      : <>Have {e.name} explain 5 games they shortlisted to the team</>,
    why: <>{They} shortlist{self ? '' : 's'} {fmtRate(e.survivalRate)}; the rest of the team shortlists {fmtRate(restKeep!)}. Either {self ? 'you see' : 'they see'} more, or {self ? 'you shortlist' : 'they shortlist'} too easily.</>,
  })

  // No recording line here on purpose. The upload match is best-effort (a video
  // title that drifts from the store name is not found), and the team tracks its
  // recordings with each other, so "confirmed but no upload" was mostly noise.

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
    why: <>You worked {fmt.int(e.activeDays)} of {fmt.int(winDays)} days. On those days you evaluated {fmt.dec(e.throughput)} games a day, vs {fmt.dec(prevThroughputRef ?? e.throughput)} last {winName} and {fmt.dec(tb.throughput)} for the team.</>,
  })

  // The one good-news line on this tab (binding constraint: a tab that only ever
  // criticises stops being opened). Its own threshold, and `sev: 0` - the lowest of
  // any act here - so `rankActs`' worst-first sort can never let it bump a red line
  // out of the cap of three.
  if (self && prevThroughputRef != null && prevThroughputRef > 0 && e.throughput > prevThroughputRef * 1.2) acts.push({
    sev: 0, fam: 'output', key: 'up',
    do: <>Keep doing what you did this {winName}</>,
    why: <>{fmt.dec(e.throughput)} games a day, up from {fmt.dec(prevThroughputRef)} last {winName}. Team: {fmt.dec(tb.throughput)}.</>,
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
      ? `${self ? 'You have' : `${e.name} has`} not evaluated anything this ${winName}.`
      : enoughToJudge && keepRatio != null && keepRatio < IND_T.calLow
        ? `${self ? 'You bypass' : `${e.name} bypasses`} far more games than the team.`
        : psTotals && psTotals.assigned > 0 && (psTotals.assigned - psTotals.evaluated) / psTotals.assigned > IND_T.intakeGap
          ? `${self ? 'Your' : `${e.name}'s`} backlog is growing: more games arrived than ${self ? 'you' : 'they'} evaluated.`
          // The same test that fires the `stale` action, so the sentence never says
          // "keeping up" over "start each day with your 5 oldest games".
          : selfOldFires || adminOldFires
            ? `${fmt.int(self ? d.selfStale! : queueStale)} games have been in ${self ? 'your' : `${e.name}'s`} backlog for more than ${sd} days.`
            : enoughToJudge && keepRatio != null && keepRatio > IND_T.calHigh
              ? `${self ? 'You shortlist' : `${e.name} shortlists`} far more games than the team.`
              // "in line with the team" is only a claim the sample can back.
              : enoughToJudge && keepRatio != null
                ? `${self ? 'You are' : `${e.name} is`} keeping up, and ${their} shortlist rate is in line with the team.`
                : `${self ? 'You are' : `${e.name} is`} keeping up with ${their} backlog.`

  const chips: Array<{ key: string; text: React.ReactNode; tone: 'good' | 'warn' | 'bad' }> = e.evaluated > 0 || e.assigned > 0 ? [
    ...(multi && tf.evaluated > 0 ? [{
      key: 'share', tone: 'good' as const,
      // Bold percentage, same rule as every other chip: it was the one chip on these
      // two tabs with no emphasis at all.
      text: <>Evaluated <b>{fmt.pct(outShare)}</b> of the team&apos;s games this {winName}</>,
    }] : []),
    // Three sentences, not one with a sign in front of it, same as Overview's growth
    // chip: "0 games joined their backlog" is arithmetic, not English, and "-12 games
    // joined" is worse.
    ...(queueNet != null ? [{
      key: 'net', tone: (queueNet > 0 ? 'warn' : 'good') as 'good' | 'warn' | 'bad',
      text: queueNet > 0
        ? <>{Their} backlog grew by <b>{fmt.int(queueNet)} games</b> this {winName}</>
        : queueNet < 0
          ? <>{Their} backlog shrank by <b>{fmt.int(-queueNet)} games</b> this {winName}</>
          : <>{Their} backlog did not change this {winName}</>,
    }] : []),
    ...(bq ? [{
      // Green only when nothing is over the limit. Some old games under the share that
      // makes it a team problem is still something to look at, so amber.
      key: 'wait', tone: (bq.n > 0 && queueStale / bq.n > STALE.share ? 'bad' : queueStale > 0 ? 'warn' : 'good') as 'good' | 'warn' | 'bad',
      // "Nothing is waiting" is its own sentence rather than "0 games waiting, the
      // oldest sat 0 days" - a zero-day oldest game reads as a fact about a game that
      // does not exist.
      text: bq.n > 0
        ? <><b>{fmt.int(bq.n)} games</b> in {their} backlog, the oldest waiting <b>{fmt.int(bq.oldest)} days</b></>
        : <>{Their} backlog is empty</>,
    }] : []),
  ] : []
  // Same rule as the other two tabs (`bannerTone`). The headline only reads calm on its
  // last two branches ("keeping up") and when there is simply no work; every other
  // branch names something to look into.
  const headCalm = (e.evaluated === 0 && e.assigned === 0) || headline.includes('keeping up')
  const verdictTone = bannerTone(chips, headCalm ? 'good' : 'warn', shown)

  return (
    <>
      <Guide title={self ? 'Your workload, pace and shortlist quality' : "Individual - one evaluator's workload, pace and shortlist quality"}
        read={[
          self
            ? <span key="1">The sentence and chips at the top are the summary. Every card below is your own work this {winName}, except the review table at the bottom.</span>
            : <span key="1">The sentence and chips at the top are the summary. <b>Click a name chip</b> to switch person.</span>,
          <span key="2">Each KPI shows the <b>team</b>&apos;s number for the same metric and the gap in %. Green or red only when the gap is over 5% and one direction is clearly better.</span>,
          // "only KPI", not "only number": the review table at the bottom ignores the
          // window too, and says so in its own note. A guide that teaches a rule the
          // reader then meets an exception to, three screens down, is worse than no
          // guide - so the exception is named here rather than left to be discovered.
          <span key="3"><b>Backlog</b> is the only KPI the {winName} filter does not affect: it is every game still with {self ? 'you' : 'them'} right now. The review table at the bottom has its own filters.</span>,
          <span key="4"><b>Shortlist quality over time</b> shows whether {self ? 'you are' : 'they are'} improving. The other charts show how much was done.</span>,
        ]}
        act={[
          <span key="1">If &ldquo;Do this&rdquo; is empty, nothing needs action this {winName}.</span>,
          <span key="2">At most three actions show, most urgent first.</span>,
          <span key="3">Shortlist rate is only compared after {IND_T.calMin} or more games. Fewer than that is too small a sample.</span>,
        ]} />

      <div className="rp-people">
        {d.evaluators.map((x) => (
          d.canSeeTeam ? (
            <button key={x.key} className={'rp-chip' + (x.key === e.key ? ' active' : '')} onClick={() => setSel(x.key)}>
              {x.name}{x.title && <span className="rp-chip-title">{x.title}</span>} <span className="rp-chip-n">{x.evaluated || x.recorded}</span>
            </button>
          ) : (
            // scoped view: their own name, as a label - there is nobody to switch to
            <span key={x.key} className="rp-chip active" aria-current="true">
              {x.name}{x.title && <span className="rp-chip-title">{x.title}</span>} <span className="rp-chip-n">{x.evaluated || x.recorded}</span>
            </span>
          )
        ))}
      </div>

      <VerdictHeader tone={verdictTone} headline={headline} chips={chips}
        kicker={(k) => IND_KICKER[k] ?? k.toUpperCase()} verdictRef={verdictRef} onChip={focus} />
      <DoBlock acts={shown.map((a) => ({
        sev: a.sev, key: a.key, kicker: famLabel(a.fam), do: a.do, why: a.why, payoff: a.payoff, cta: a.cta,
      }))} />

      {/* Five, down from twelve. What went: the three per-day mix tiles (one
          distribution read three times - it is the conclusion-flow bar now), Note
          coverage (a note is mandatory in the form, so it reads ~100% for everyone and
          separates nobody), Link dead and Recorded (source quality and assigned work,
          both of which have a card that shows them in context), Assigned (it is the
          Backlog chip and the activity chart), and Hit rate (it lands days late, so a
          KPI tile makes an open window look like a collapse - it is folded into the
          Shortlist rate sub-line's final-priority count instead, where it reads as
          "N of these M" rather than as a rate an open window would understate). */}
      <div className="rp-kpi-row">
        <Kpi label="Evaluated" value={fmt.int(e.evaluated)} sub={`evaluated this ${winName}`} hi focusKey="share"
          spark={personSpark.length >= 2 ? personSpark : undefined} noTrend sparkNote={`games per ${unitName}`}
          tip={TIP.evaluated} bench={cmp(e.evaluated, tb.evaluated, fmt.int, 'up')} />
        <Kpi label="Backlog" value={bq ? fmt.int(bq.n) : '0'} sub={bq ? `oldest ${bq.oldest}d, all history` : 'backlog empty'}
          focusKey="net" tip={TIP.personBacklog} />
        <Kpi label="Games per day" value={fmt.dec(e.throughput)} sub="games / active day" tip={TIP.perDay('Games evaluated')}
          bench={cmp(e.throughput, tb.throughput, (n) => fmt.dec(n), 'up', hasDays)} />
        <Kpi label="Days waiting" value={fmt.days(e.turnaround)} sub="assign → evaluate" tip={TIP.turnaround}
          bench={cmp(e.turnaround, tb.turnaround, (n) => fmt.days(n), 'down')} />
        {/* Sub-line carries a second number, from Task 2: the Pick funnel card is gone,
            but its third figure - final priority, the one count of the three that was
            not already a KPI elsewhere on this tab - must not be lost with it. */}
        <Kpi label="Shortlist rate" value={srVal}
          sub={`${fmt.int(e.shortlisted)} of ${fmt.int(e.evaluated)} evaluated, ${fmt.int(e.finalPriority)} final priority`}
          spark={qualityRows.length >= 2 ? qualityRows.map((p) => Math.round((p.shortlisted / p.evaluated) * 1000)) : undefined}
          noTrend sparkNote={`rate per ${unitName}`} sparkColor={P.role.shortlist} tip={TIP.survival}
          bench={cmp(e.survivalRate, tb.survivalRate, srFmt, 'up', e.evaluated > 0)} />
      </div>

      {/* The same table as the Leaderboard's daily block, turned on its side: one row
          per day for this person instead of one row per person for one day. Same
          columns, same counting rule, same endpoint - so this person's row here and
          their row over there cannot drift apart. No day picker, because every day in
          the period is already a row. */}
      <div className="rp-section-title">Day by day - what {self ? 'you' : e.name} evaluated</div>
      <p className="rp-daily-scope">
        Counts per day, never rates. The period and Category filters at the top of the page
        choose the days and the buckets.
      </p>
      <DayBreakdown evaluator={e.name} category={d.category}
        windowFrom={d.window.from || null}
        windowTo={d.window.to ? addDays(d.window.to, -1) : null} />

      <div className="rp-section-title">Activity - games received, evaluated, and backlog</div>
      {ps.length >= 2 ? (
        <Card label={self ? 'Your activity over time' : `${e.name} - activity over time`} note={`assigned · evaluated · link dead per ${unitName}, plus the backlog`}
          tip={<>
            <F>assigned by assigned_date · evaluated &amp; link dead by evaluate_date</F>
            <F>backlog = games of theirs not evaluated yet, at the end of each {unitName}</F>
            Buckets are the union of both axes, so a {unitName} where they were only assigned work still appears.
            Backlog counts all history, not just this {winName}, and follows the current owner: a game
            reassigned away leaves their past backlog too.
          </>}>
          <LineChart series={actSeries} area />
          <Foot hint="Assigned above Evaluated = received more than evaluated, so the backlog grew"
            facts={psTotals ? [
              { label: 'Received', value: fmt.int(psTotals.assigned) },
              { label: 'Evaluated', value: fmt.int(psTotals.evaluated) },
              blOpen != null && blClose != null
                ? {
                  label: 'Backlog', value: `${fmt.int(blOpen)} → ${fmt.int(blClose)}`,
                  ...(blClose > blOpen ? { tone: 'bad' as const, icon: '▲' as const } : blClose < blOpen ? { tone: 'good' as const, icon: '▼' as const } : {}),
                }
                : psTotals.assigned > psTotals.evaluated
                  ? { label: 'Backlog', value: `+${fmt.int(psTotals.assigned - psTotals.evaluated)}`, tone: 'bad', icon: '▲' }
                  : psTotals.evaluated > psTotals.assigned
                    ? { label: 'Backlog', value: `-${fmt.int(psTotals.evaluated - psTotals.assigned)}`, tone: 'good', icon: '▼' }
                    : null,
              deadShare > 0.08 && { label: 'Dead links', value: fmt.pct(deadShare), tone: 'warn', icon: '!' },
            ] : []} />
          {hasBacklog && <FlowTable partialTail={partialTail} inLabel="Received" outLabel="Evaluated"
            rows={ps.map((p) => ({ label: p.label, in: p.assigned, out: p.evaluated, dead: p.linkDead, backlog: p.backlog! }))} />}
        </Card>
      ) : null}

      {moveRows.length > 0 && (
        <Card label={self ? 'Your evaluated vs got older' : `${e.name} - evaluated vs got older`} note={`evaluated vs got older, per ${unitName}`}
          tip={<>
            <F>right = games they evaluated that {unitName}, by age on the day they evaluated it</F>
            <F>left = games of theirs that crossed into an older band that {unitName} (assign day + 4, + 8, + 15)</F>
            The per-person half of the same card on Overview. Both sides count EVENTS,
            not the backlog itself, so a game appears at most once on each: it is evaluated once, and it
            passes a boundary once. That is what makes the two halves addable across
            buckets, which a snapshot never is - a game that sits still all week would
            otherwise be counted in every bucket of it.<br />
            The clock is the <b>assign</b> date, not the import date Overview uses, so a
            handover restarts it and the crossings follow the game to its new owner.
            Same scale both ways: the longer side is the reading.
          </>}>
          <DivergingBars rows={moveRows} rightKeys={AGE_KEYS} leftKeys={AGED_KEYS} colors={AGE_COLORS}
            leftLabel="Got older" rightLabel="Evaluated" />
          {/* Both sides are EVENT counts over the window, so the verdict says which way
              the stale work MOVED - "more old games were added than evaluated" - never
              what the backlog is now; that is the backlog card beside this one. */}
          <Foot hint="Right = evaluated, left = only got older. The longer side wins."
            facts={clearedTot + agedTotP === 0
              ? [{ value: `No games evaluated or got older this ${winName}` }]
              : [
                { label: 'Evaluated', value: fmt.int(clearedTot) },
                { label: 'Got older', value: fmt.int(agedTotP) },
                ...(agedIntoOldP > 0 ? [
                  { label: '8+ days', value: <>{fmt.int(clearedOld)} evaluated vs {fmt.int(agedIntoOldP)} new</> },
                  clearedOld > agedIntoOldP
                    ? { value: 'More old games were evaluated than added', tone: 'good' as const, icon: '▼' as const }
                    : clearedOld === agedIntoOldP
                      ? { value: 'As many old games were added as evaluated' }
                      : { value: 'More old games were added than evaluated', tone: 'bad' as const, icon: '▲' as const },
                ] : [{ value: 'Nothing crossed into 8+ days', tone: 'good' as const, icon: '✓' as const }]),
              ]} />
        </Card>
      )}

      <div className="rp-grid-2">
        <Card label={self ? 'Your backlog' : `${e.name} - backlog`} note="games in the backlog now · colour = days since assigned"
          tip={TIP.personBacklog}>
          <BandBar label="Backlog by age" focusKey="wait" total={bq ? `${fmt.int(bq.n)} games` : undefined}
            bands={bq ? AGE_BANDS.map((b, i) => ({ name: b.label, value: queueParts[i] || 0, color: b.color })) : []}
            empty="Backlog empty - nothing is waiting on them" />
          <Foot hint={<>Days since assigned to {self ? 'you' : 'them'}. Right now - the {winName} filter does not affect it.</>}
            facts={bq
              ? [
                { label: 'Oldest', value: `${bq.oldest} days` },
                queueStale > 0
                  ? { label: `Waiting over ${sd} days`, value: fmt.int(queueStale), note: `${fmt.pct(queueStale / bq.n)} of ${fmt.int(bq.n)}`, tone: queueStale / bq.n > STALE.share ? 'bad' : 'warn', icon: '!' }
                  : { value: `Nothing waiting over ${sd} days`, tone: 'good', icon: '✓' },
              ]
              : [{ value: `${Their} backlog is empty`, tone: 'good', icon: '✓' }]} />
        </Card>
        <Card label="Conclusion flow" note="initial conclusions, then final conclusions"
          tip={<><F>top = their initial_conclusion · bottom = final_conclusion on what they shortlisted</F>Two bars on the same width: everything they evaluated, then the part with a final conclusion from a moderator. This replaced two donuts - a donut makes the reader compare arc lengths, and two of them side by side made them do it twice for two different totals.<br />The per-day figures under the bars are the same distribution divided by active days, which is what the three &ldquo;/ day&rdquo; KPI tiles used to show.</>}>
          {initTot > 0 ? (
            <div className="rp-tiers">
              <BandBar label="Initial conclusions" total={`${fmt.int(initTot)} evaluated`} bands={initBands} />
              <BandBar label="Final conclusions" total={initTot > 0 ? `${fmt.int(finTot)} of ${fmt.int(initTot)} have one` : `${fmt.int(finTot)} have one`}
                bands={finBands} scaleTo={initTot} restLabel={`${fmt.int(Math.max(0, initTot - finTot))} waiting for a final conclusion`}
                empty={`No final conclusion yet this ${winName} - moderators give them days later`} />
            </div>
          ) : <Empty />}
          <Foot hint="Top = initial conclusions. Bottom = the part with a final conclusion, shorter on an open window."
            facts={e.activeDays > 0 ? [
              { label: 'Per active day', value: fmt.dec(perDay('Bypass')), note: 'Bypass' },
              { value: fmt.dec(perDay('Playtest & Bypass')), note: 'Playtest & Bypass' },
              { value: fmt.dec(perDay('List_Idea')), note: 'List_Idea' },
              { label: 'Active days', value: fmt.int(e.activeDays) },
            ] : []} />
        </Card>
      </div>

      <div className="rp-section-title">Trend - is the shortlist rate changing?</div>
      <Card label={self ? 'Your shortlist quality over time' : `${e.name} - shortlist quality over time`} note={`shortlist rate per ${unitName}, against the team`}
        tip={<><F>= their shortlist ÷ their evaluated, per {unitName}</F>The one chart on this tab with a direction rather than a level. Both halves of the ratio count the same games, so the size of the backlog behind them leaves the rate alone.<br />A {unitName} where they evaluated nothing is dropped, not drawn as 0%: a day off is not a day they bypassed everything.</>}>
        {qualitySeries.length ? <LineChart series={qualitySeries} format={(v) => `${v.toFixed(1)}%`} />
          : <Empty text={`Need two ${unitName}s with work in them`} />}
        {/* The word and the two numbers must agree: both ends are formatted at the
            precision that makes them differ, and "no change" is only said when the two
            printed figures are actually the same. */}
        <Foot keys={multi ? [{ shape: 'dash', label: 'Team' }] : undefined}
          hint="Above the team = shortlists more. Neither side is better by itself."
          facts={qDrift != null
            ? [
              {
                label: 'First half → second half', value: `${qDriftPair[0]} → ${qDriftPair[1]}`,
                ...(qDriftPair[0] === qDriftPair[1] ? {} : qDrift > 0 ? { icon: '▲' as const } : { icon: '▼' as const }),
                note: qDriftPair[0] === qDriftPair[1] ? 'no change' : qDrift > 0 ? 'moving up' : 'moving down',
              },
              multi && { label: 'Team', value: fmtRate(t.survivalRate) },
            ]
            : qualityRows.length > 0
              ? [{ value: `Only ${qualityRows.length} ${unitName}${qualityRows.length === 1 ? '' : 's'} with work`, note: 'too few for a trend' }]
              : []} />
      </Card>

      <div className="rp-section-title">Recording - videos this {winName}</div>
      <Card label={self ? 'Your recording list' : `${e.name} - recording list`} note="videos assigned & recorded in this window · open rows always shown"
        tip={<><F>rows where they are the 5min/20min assignee</F>Same three states as the Record tab, and the video is what settles them: <b>Recorded</b> = an upload was matched to this game, <b>Recording</b> = Confirm was pressed but no upload yet, <b>Pending</b> = neither (the Record tab calls this Draft). The upload match is best-effort, so a row can stay in Recording after the video is up.</>}>
        <VideoQueue vids={vids} />
        <Foot hint="Recorded = a video was matched to the game"
          facts={vids.length === 0
            ? [{ value: `No recording work this ${winName}` }]
            : [{ label: 'Recorded', value: fmt.int(e.recorded), note: `${e.rec5} × 5min, ${e.rec20} × 20min` }]} />
      </Card>

      {/* Last block on the tab, and the one that carries its own controls. It is not
          a second, unrelated selection: its dates OPEN on the same period the filter
          bar above is showing and can only be narrowed inside it, so this table can
          never contradict the charts it sits under. What it does own is Category and
          Initial conclusion. Without the rule+title+note a reader assumes the whole
          thing is the selection above and reads the narrowing as a bug (plan doc,
          "The review table", Design section C). */}
      <div className="rp-review-section">
        <div className="rp-review-rule" />
        <div className="rp-section-title">Review - the evaluations themselves, with screenshots</div>
        {/* Names the control by the label the filter bar actually prints - "Category" -
            not "genre", which appears nowhere in the Report's screen text. A reader
            who goes looking for a "genre" control will not find one, and this table's
            own filter is labelled Category too. "period" stands in for the middle
            control rather than naming it literally: its label changes with the view
            (Batch/Week/Month/Quarter/Year, or Range on a custom window), so any one
            name would only be true some of the time. */}
        <p className="rp-review-scope-note">This table has its own Category and Initial conclusion. Its dates open on the whole period selected at the top of the page and can only be narrowed inside it.</p>
        {/* `window.to` is EXCLUSIVE on the payload (see the Bundle type); the picker
            below is inclusive at both ends, so the last day is to-1. Absent on a
            window with no bounds at all (All batches), where the table resolves its
            own newest-days default instead. */}
        <ReviewTable evaluator={e.name} canSeeTeam={d.canSeeTeam}
          windowFrom={d.window.from || null}
          windowTo={d.window.to ? addDays(d.window.to, -1) : null} />
      </div>
    </>
  )
}

/* ---------------- Config: who counts + how the Overall score is weighted ---------------- */
// Persisted team-wide in app_config (key 'report_config'), not per browser: these
// choices define what the numbers MEAN, so two admins must never read the same tab
// and see different rankings. Saving invalidates the API's bundle cache.
// Alert rules as Config shows them. Shares are stored as fractions and shown as whole
// percents; `pts` is a gap between two rates, also stored as a fraction.
type RuleUnit = 'pct' | 'pts' | 'x' | 'games' | 'days'
const RULE_UNIT: Record<RuleUnit, string> = { pct: '%', pts: 'pts', x: '×', games: 'games', days: 'days' }
const ruleShow = (u: RuleUnit, v: number) => (u === 'pct' || u === 'pts' ? Math.round(v * 1000) / 10 : v)
const ruleStore = (u: RuleUnit, v: number) => (u === 'pct' || u === 'pts' ? v / 100 : v)
// Per rule: its unit and the slider's everyday range, in DISPLAY units. The box beside
// the slider still takes anything inside REPORT_RULE_BOUNDS.
const RULE_UI: Record<keyof ReportRules, { unit: RuleUnit; label: string; slider: { min: number; max: number; step: number } }> = {
  minGames: { unit: 'games', label: 'Compare shortlist rates after', slider: { min: 10, max: 300, step: 5 } },
  lowRate: { unit: 'x', label: 'Shortlists too little', slider: { min: 0.1, max: 0.9, step: 0.05 } },
  highRate: { unit: 'x', label: 'Shortlists too much', slider: { min: 1.5, max: 10, step: 0.5 } },
  calSpread: { unit: 'pts', label: 'Bypass rates too far apart', slider: { min: 5, max: 50, step: 1 } },
  growthGap: { unit: 'pct', label: 'Backlog growing', slider: { min: 5, max: 50, step: 1 } },
  staleShare: { unit: 'pct', label: 'Share of their backlog', slider: { min: 5, max: 75, step: 1 } },
  staleMin: { unit: 'games', label: 'At least', slider: { min: 5, max: 300, step: 5 } },
  agedShare: { unit: 'pct', label: 'Team backlog too old', slider: { min: 10, max: 80, step: 1 } },
  clearDays: { unit: 'days', label: 'Backlog may hold', slider: { min: 1, max: 30, step: 1 } },
  concentration: { unit: 'pct', label: 'One person does too much', slider: { min: 20, max: 80, step: 1 } },
}
const CFG_SECTIONS = [
  { id: 'cfg-people', label: 'People', sub: 'who is counted' },
  { id: 'cfg-score', label: 'Overall score', sub: 'how it is weighted' },
  { id: 'cfg-rate', label: 'Shortlist rate', sub: 'alert rules' },
  { id: 'cfg-backlog', label: 'Backlog', sub: 'alert rules' },
  { id: 'cfg-workload', label: 'Workload', sub: 'alert rule' },
  { id: 'cfg-colours', label: 'Chart colours', sub: 'one palette' },
] as const
// The score-weight bar takes its colours from the palette's ROLES, so an axis is the
// colour its metric has on every other tab (Volume = evaluated, Hit rate = hit,
// Shortlist rate = shortlist). This four-in-a-row was part of each preset's validation.
const weightColors = (pal: ReturnType<typeof resolvePalette>): Record<AxisName, string> => ({
  Volume: pal.role.evaluated, Consistency: pal.role.consistency, Signal: pal.role.hit, Survival: pal.role.shortlist,
})

/* ---------------- Config: who counts, how the score is weighted, when to alert ---------------- */
// Persisted team-wide in app_config (key 'report_config'), not per browser: these
// choices define what the numbers MEAN, so two admins must never read the same tab
// and see different rankings. Saving invalidates the API's bundle cache.
//
// Five sections, one question each, with a sticky list of them on the left. Every
// alert rule draws THIS window's people against itself and says who it would flag,
// so a rule is tuned by watching it, not by guessing what 0.5x means. Nothing leaves
// the browser until Save, and the save bar says how many changes are waiting.
function ConfigTab({ d, onSaved }: { d: Bundle; onSaved: () => void }) {
  const [roster, setRoster] = useState<Array<{ key: string; name: string }>>([])
  const [excluded, setExcluded] = useState<string[]>(d.config.excluded)
  const [weights, setWeights] = useState<Record<AxisName, number>>(d.config.weights)
  const [sampleWeightOn, setSampleWeightOn] = useState(d.config.credibility)
  const [rules, setRules] = useState<ReportRules>(parseReportRules(d.config.rules))
  const [palette, setPalette] = useState<PaletteKey>(parsePaletteKey(d.config.palette))
  const [state, setState] = useState<'idle' | 'loading' | 'saving' | 'saved' | 'error'>('loading')
  const [activeSec, setActiveSec] = useState<string>(CFG_SECTIONS[0].id)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/report/config').then((r) => r.json()).then((j) => {
      if (!alive) return
      setRoster(j.roster || [])
      if (j.config) { setExcluded(j.config.excluded); setWeights(j.config.weights); setSampleWeightOn(j.config.credibility); setRules(parseReportRules(j.config.rules)); setPalette(parsePaletteKey(j.config.palette)) }
      setState('idle')
    }).catch(() => alive && setState('error'))
    return () => { alive = false }
  }, [])

  // The section list follows the reader: whichever section's top is nearest the top of
  // the viewport is the one lit.
  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
      if (vis[0]) setActiveSec(vis[0].target.id)
    }, { rootMargin: '-10% 0px -60% 0px' })
    CFG_SECTIONS.forEach((s2) => { const el = root.querySelector(`#${s2.id}`); if (el) io.observe(el) })
    return () => io.disconnect()
  }, [])

  // ---- what is waiting to be saved ----
  const savedRules = parseReportRules(d.config.rules)
  const changes = [
    JSON.stringify([...excluded].sort()) !== JSON.stringify([...d.config.excluded].sort()) ? 1 : 0,
    ...ALL_ROUNDER_AXES.map((a) => (weights[a] !== d.config.weights[a] ? 1 : 0)),
    sampleWeightOn !== d.config.credibility ? 1 : 0,
    ...(Object.keys(rules) as Array<keyof ReportRules>).map((k) => (rules[k] !== savedRules[k] ? 1 : 0)),
    palette !== parsePaletteKey(d.config.palette) ? 1 : 0,
  ].reduce((s2, n) => s2 + n, 0)
  const dirty = changes > 0
  const discard = () => {
    setExcluded(d.config.excluded); setWeights(d.config.weights); setSampleWeightOn(d.config.credibility); setRules(savedRules)
    setPalette(parsePaletteKey(d.config.palette))
  }
  const save = async () => {
    setState('saving')
    try {
      const res = await fetch('/api/report/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        // Always the WHOLE blob: the route rebuilds the config from this body, so a
        // save that left `rules` out would reset every alert rule to its default.
        body: JSON.stringify({ excluded, weights, credibility: sampleWeightOn, rules, palette }),
      })
      if (!res.ok) throw new Error(String(res.status))
      setState('saved')
      onSaved()
    } catch { setState('error') }
  }
  const toggle = (k: string) => setExcluded((x) => x.includes(k) ? x.filter((v) => v !== k) : [...x, k])
  const included = roster.filter((r) => !excluded.includes(r.key)).length
  const setRule = (k: keyof ReportRules) => (display: number) => {
    const v = ruleStore(RULE_UI[k].unit, display)
    const b = REPORT_RULE_BOUNDS[k]
    setRules((r) => ({ ...r, [k]: Math.min(b.max, Math.max(b.min, v)) }))
  }
  const ctl = (k: keyof ReportRules, label = RULE_UI[k].label) => {
    const u = RULE_UI[k].unit
    return (
      <RuleControl key={k} label={label} value={ruleShow(u, rules[k])} onChange={setRule(k)}
        slider={RULE_UI[k].slider}
        bounds={{ min: ruleShow(u, REPORT_RULE_BOUNDS[k].min), max: ruleShow(u, REPORT_RULE_BOUNDS[k].max) }}
        unit={RULE_UNIT[u]} def={ruleShow(u, DEFAULT_REPORT_RULES[k])}
        fmtDef={`${ruleShow(u, DEFAULT_REPORT_RULES[k])}${u === 'pct' ? '%' : u === 'x' ? '×' : ''}`} />
    )
  }

  // ---- this window's people, as the tabs will see them after Save ----
  // Unticking someone in People drops them from every preview below at once, the way
  // it will drop them from every tab.
  const people = d.evaluators.filter((e) => e.evaluated > 0 && !excluded.includes(e.key))
    .sort((a, b) => b.evaluated - a.evaluated)
  const poolEval = people.reduce((s2, e) => s2 + e.evaluated, 0)
  const poolShort = people.reduce((s2, e) => s2 + e.shortlisted, 0)
  const compared = people.filter((e) => e.evaluated >= rules.minGames)
  const notCompared = people.filter((e) => e.evaluated < rules.minGames)
  const names = (xs: Array<{ name: string }>, max = 4) =>
    xs.length === 1 ? xs[0].name
      : xs.length <= max ? `${xs.slice(0, -1).map((x) => x.name).join(', ')} and ${xs[xs.length - 1].name}`
      : `${xs.slice(0, max).map((x) => x.name).join(', ')} and ${xs.length - max} more`

  // Rate against everyone ELSE - the leave-one-out rule both tabs use.
  const ratioRows = compared.map((e) => {
    const oe = poolEval - e.evaluated, os = poolShort - e.shortlisted
    const rest = oe > 0 ? os / oe : 0
    const own = e.evaluated > 0 ? e.shortlisted / e.evaluated : 0
    const ratio = rest > 0 ? own / rest : 1
    const side = ratio < rules.lowRate ? 'low' : ratio > rules.highRate ? 'high' : null
    return { e, own, rest, ratio, side }
  })
  const lowFlags = ratioRows.filter((r) => r.side === 'low'), highFlags = ratioRows.filter((r) => r.side === 'high')
  const xFmt = (v: number) => (v >= 10 ? fmt.int(v) : v >= 1 ? v.toFixed(1) : v.toFixed(2))

  const bypassOf = (e: typeof people[number]) => {
    const tot = Object.values(e.initialConclusions).reduce((s2, n) => s2 + n, 0)
    return tot > 0 ? (e.initialConclusions['Bypass'] || 0) / tot : 0
  }
  const spread = compared.map((e) => ({ key: e.key, name: e.name, value: bypassOf(e), tip: `${e.name}: bypasses ${fmt.pct(bypassOf(e))} of ${fmt.int(e.evaluated)} games` }))
  const spreadGap = spread.length >= 2 ? Math.max(...spread.map((x) => x.value)) - Math.min(...spread.map((x) => x.value)) : null

  // Backlog growth: the team (Overview's number) and each person (Individual's).
  const pipeWin = d.pipeline?.window
  const teamIn = pipeWin ? pipeWin.newGames : d.funnel.assigned
  const teamOut = pipeWin ? pipeWin.evaluated : d.funnel.evaluated
  const growRows = [
    ...(teamIn > 0 ? [{ key: '_team', name: 'Team', in: teamIn, out: teamOut }] : []),
    ...d.evaluators.filter((e) => e.assigned > 0 && !excluded.includes(e.key))
      .map((e) => ({ key: e.key, name: e.name, in: e.assigned, out: e.evaluated })),
  ].map((r) => ({ ...r, gap: (r.in - r.out) / r.in }))
    .sort((a, b) => (a.key === '_team' ? -1 : b.key === '_team' ? 1 : b.gap - a.gap))
  const growFlags = growRows.filter((r) => r.gap > rules.growthGap)
  const growMin = Math.max(-1, Math.min(-0.25, ...growRows.map((r) => r.gap)))
  const growMax = Math.min(1, Math.max(rules.growthGap * 1.6, 0.25, ...growRows.map((r) => r.gap)))

  // Stale backlog per person: BOTH gates, share and count.
  const sd = staleDays(d)
  // Only people with something stale are drawn; the rest are one clause in the note.
  const staleClean = (d.backlogBy || []).filter((b) => b.n > 0 && b.stale === 0 && !excluded.includes(b.key))
  const staleRows = (d.backlogBy || []).filter((b) => b.n > 0 && b.stale > 0 && !excluded.includes(b.key))
    .map((b) => ({ b, share: b.stale / b.n, flag: b.stale >= rules.staleMin && b.stale / b.n > rules.staleShare, small: b.stale < rules.staleMin }))
    .sort((a, b) => b.share - a.share)
  const staleFlags = staleRows.filter((r) => r.flag)
  const staleMax = Math.min(1, Math.max(rules.staleShare * 1.6, 0.2, ...staleRows.map((r) => r.share)))

  const stockAge = d.stock?.age ?? d.pipeline?.current.age ?? { a0: 0, a1: 0, a2: 0, a3: 0 }
  const pace = teamPace(d)
  const agedShare = pace.stock > 0 ? (stockAge.a2 + stockAge.a3) / pace.stock : 0

  const totalEval = people.reduce((s2, e) => s2 + e.evaluated, 0)
  const shareRows = people.map((e) => ({ e, share: totalEval > 0 ? e.evaluated / totalEval : 0 }))
  const topFlag = people.length >= 3 && shareRows[0] && shareRows[0].share > rules.concentration ? shareRows[0] : null
  const shareMax = Math.min(1, Math.max(rules.concentration * 1.4, ...shareRows.map((r) => r.share)))

  // Score: shares of the four axes, and each person's sample weight.
  const wTotal = ALL_ROUNDER_AXES.reduce((s2, a) => s2 + (weights[a] || 0), 0) || 1
  const wShare = (a: AxisName) => (weights[a] || 0) / wTotal
  const vols = people.map((e) => e.evaluated).sort((a, b) => a - b)
  const median = vols.length ? vols[Math.floor(vols.length / 2)] : 0
  const swRows = people.map((e) => {
    const w = sampleWeightOn ? (median > 0 ? Math.min(1, e.evaluated / median) : 1) : 1
    return { key: e.key, name: e.name, value: w, label: `${fmt.pct(w)} · ${fmt.int(e.evaluated)}`, state: (w < 1 ? 'hit' : 'base') as VizState, tip: `${e.name}: ${fmt.int(e.evaluated)} games, quality axes count at ${fmt.pct(w)}` }
  })

  const flagsIn: Record<string, number> = {
    'cfg-rate': lowFlags.length + highFlags.length + (spreadGap != null && spreadGap > rules.calSpread ? 1 : 0),
    'cfg-backlog': growFlags.length + staleFlags.length + (agedShare > rules.agedShare ? 1 : 0) + (pace.daysToClear != null && pace.daysToClear > rules.clearDays ? 1 : 0),
    'cfg-workload': topFlag ? 1 : 0,
  }
  const go = (id: string) => {
    setActiveSec(id)
    rootRef.current?.querySelector(`#${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const winName = windowNoun(d)
  // The PENDING preset, so the sample below and the weight bar show the choice before
  // it is saved.
  const pal = resolvePalette(palette)
  const WC = weightColors(pal)
  const flowSample = (d.pipeline?.series || []).slice(-10)
  const qualitySample = d.metricSeries.filter((m) => m.evaluated > 0).slice(-10)

  return (
    <div className="cfg" ref={rootRef}>
      <Guide title="Config - who is counted, how the Overall score is weighted, and when the Report raises an alert"
        read={[
          <span key="1"><b>People</b>: unticking someone removes them from every stat, chart and denominator on all tabs - not just the lists.</span>,
          <span key="2"><b>Overall score</b>: the relative pull of each axis. Numbers are relative, so the share beside each slider is what applies.</span>,
          <span key="3"><b>Alert rules</b>: the numbers behind every colour and &ldquo;Do this&rdquo; line. Each one draws this {winName}&apos;s people against it, so you see who it flags before you save.</span>,
        ]}
        act={[
          <span key="1">Nothing is saved until you press <b>Save</b> in the bar at the bottom. It says how many changes are waiting.</span>,
          <span key="2">Raising a rule makes the Report quieter for everyone, lowering it makes it louder. Change one at a time.</span>,
        ]} />

      <div className="cfg-layout">
        <nav className="cfg-nav" aria-label="Config sections">
          {CFG_SECTIONS.map((s2) => (
            <button key={s2.id} type="button" className={'cfg-nav-i' + (activeSec === s2.id ? ' on' : '')} onClick={() => go(s2.id)}>
              <span className="cfg-nav-l">{s2.label}</span>
              <span className="cfg-nav-s">{s2.id === 'cfg-colours' ? PALETTES[palette].label : s2.sub}</span>
              {flagsIn[s2.id] > 0 && <span className="cfg-nav-flag" title="alerts these rules raise in this window">! {flagsIn[s2.id]}</span>}
            </button>
          ))}
        </nav>

        <div className="cfg-main">
          {/* ---- 1. People ---- */}
          <section className="cfg-sec" id="cfg-people">
            <header className="cfg-sec-h">
              <h3>People</h3>
              <p>Who is measured. The roster decides who exists; this only leaves people out of the Report.</p>
              <span className="cfg-sec-meta">{included} of {roster.length} counted</span>
            </header>
            {state === 'loading' ? <Empty text="Loading roster…" /> : roster.length === 0 ? <Empty text="No initial evaluators on the roster" /> : (
              <div className="cfg-people">
                {roster.map((r) => {
                  const on = !excluded.includes(r.key)
                  const ev = d.evaluators.find((e) => e.key === r.key)
                  return (
                    <label key={r.key} className={'cfg-person' + (on ? ' on' : '')}>
                      <input type="checkbox" checked={on} onChange={() => toggle(r.key)} />
                      <span className="cfg-person-n">{r.name}</span>
                      <span className="cfg-person-m">{ev?.title ? `${ev.title} · ` : ''}{fmt.int(ev?.evaluated ?? 0)} games</span>
                    </label>
                  )
                })}
              </div>
            )}
            <p className="cfg-sec-foot">Unticking someone moves team totals and every rate that divides by them, on every tab.</p>
          </section>

          {/* ---- 2. Overall score ---- */}
          <section className="cfg-sec" id="cfg-score">
            <header className="cfg-sec-h">
              <h3>Overall score</h3>
              <p>How much someone did, and how well. Volume is never discounted; the three quality axes are scaled by sample weight.</p>
            </header>
            <div className="cfg-score">
              <div className="cfg-weights">
                {ALL_ROUNDER_AXES.map((a) => (
                  <div key={a} className="rp-cfg-w">
                    <span className="rp-cfg-name"><i className="cfg-swatch" style={{ background: WC[a] }} />{AXIS_LABEL[a]}</span>
                    <input type="range" aria-label={`${AXIS_LABEL[a]} weight`} min={0} max={100} step={5} value={weights[a] ?? 0}
                      onChange={(e2) => setWeights((w) => ({ ...w, [a]: Number(e2.target.value) }))} />
                    <span className="rp-cfg-share">{Math.round(wShare(a) * 100)}%</span>
                  </div>
                ))}
                <button type="button" className="rv-ctl-def" onClick={() => setWeights(DEFAULT_REPORT_CONFIG.weights)}>weights back to default ↺</button>
              </div>
              <div className="cfg-mix">
                <div className="cfg-mix-bar" role="img" aria-label="Share of the Overall score per axis">
                  {ALL_ROUNDER_AXES.filter((a) => wShare(a) > 0).map((a) => (
                    <span key={a} style={{ flexGrow: wShare(a), background: WC[a] }} title={`${AXIS_LABEL[a]} ${Math.round(wShare(a) * 100)}%`} />
                  ))}
                </div>
                <div className="cfg-mix-legend">
                  {ALL_ROUNDER_AXES.map((a) => (
                    <span key={a}><i className="cfg-swatch" style={{ background: WC[a] }} />{AXIS_LABEL[a]} <b>{Math.round(wShare(a) * 100)}%</b></span>
                  ))}
                </div>
                <p className="cfg-formula">
                  Overall = <b>{Math.round(wShare('Volume') * 100)}%</b> Volume + <b>{Math.round((1 - wShare('Volume')) * 100)}%</b> quality
                  {sampleWeightOn ? ' × sample weight' : ''}. Each axis scores the team&apos;s best as 100. Recording is not part of the score.
                </p>
              </div>
            </div>
            <div className="cfg-sub">
              <label className="cfg-switch">
                <input type="checkbox" checked={sampleWeightOn} onChange={() => setSampleWeightOn((v) => !v)} />
                <span><b>Sample weight</b> - quality counts at min(1, games ÷ median games). Median this {winName}: <b>{fmt.int(median)} games</b>.</span>
              </label>
              {sampleWeightOn
                ? <><ThresholdBars rows={swRows} domain={[0, 1]} ariaLabel="Sample weight per person" />
                  <p className="rv-note">Blue bars: fewer games than the median, so their quality axes count for less. Grey: full weight. Label = weight · games.</p></>
                : <p className="rv-empty">Off: a 30-game sample ranks on equal footing with a 700-game one.</p>}
            </div>
          </section>

          {/* ---- 3. Shortlist rate ---- */}
          <section className="cfg-sec" id="cfg-rate">
            <header className="cfg-sec-h">
              <h3>Shortlist rate</h3>
              <p>When someone&apos;s bar is far from the team&apos;s. Used by the Leaderboard and Individual.</p>
            </header>
            <RuleBlock title="Compare shortlist rates after" where="Leaderboard · Individual"
              what="Under this many games a rate is a small sample, not a bar. Nobody below it is called out."
              controls={ctl('minGames')}
              tone="none"
              verdict={<><b>{compared.length} of {people.length}</b> people have {fmt.int(rules.minGames)}+ games{notCompared.length ? <>. Not compared: {names(notCompared)}</> : null}.</>}>
              <ThresholdBars ariaLabel="Games evaluated per person, against the minimum"
                rows={people.map((e) => ({ key: e.key, name: e.name, value: e.evaluated, label: fmt.int(e.evaluated), state: e.evaluated >= rules.minGames ? 'base' as const : 'muted' as const }))}
                domain={[0, Math.max(rules.minGames * 1.2, ...people.map((e) => e.evaluated))]}
                limit={rules.minGames} limitLabel={`${fmt.int(rules.minGames)} games`} />
            </RuleBlock>
            <RuleBlock title="Shortlist rate against the rest of the team" where="Leaderboard · Individual"
              what="Their rate as a multiple of everyone else's. The two sides are not mirror images: a low rate throws signal away, so it is called out sooner."
              controls={<>{ctl('lowRate')}{ctl('highRate')}</>}
              tone={lowFlags.length + highFlags.length ? 'flag' : 'ok'}
              verdict={lowFlags.length + highFlags.length
                ? <>{lowFlags.length > 0 && <>Too little: <b>{lowFlags.map((r) => `${r.e.name} (${xFmt(r.ratio)}×)`).join(', ')}</b>. </>}
                  {highFlags.length > 0 && <>Too much: <b>{highFlags.map((r) => `${r.e.name} (${xFmt(r.ratio)}×)`).join(', ')}</b>.</>}</>
                : <>Nobody is under {rules.lowRate}× or over {rules.highRate}× the rest of the team.</>}>
              {ratioRows.length
                ? <RatioStrip low={rules.lowRate} high={rules.highRate} ariaLabel="Each person's shortlist rate as a multiple of the rest of the team"
                  dots={ratioRows.map((r) => ({ key: r.e.key, name: r.e.name, ratio: r.ratio, state: r.side ? 'flag' as const : 'base' as const,
                    tip: `${r.e.name}: ${fmtRate(r.own)} vs ${fmtRate(r.rest)} for the rest = ${xFmt(r.ratio)}×` }))} />
                : <p className="rv-empty">Nobody has {fmt.int(rules.minGames)}+ games in this {winName}</p>}
              <p className="rv-note">The Leaderboard also needs the gap to be bigger than chance explains before it names someone.</p>
            </RuleBlock>
            <RuleBlock title="Bypass rates too far apart" where="Leaderboard"
              what="The gap between the evaluator who bypasses most and the one who bypasses least. Past it, the team is working to two different bars."
              controls={ctl('calSpread')}
              tone={spreadGap != null && spreadGap > rules.calSpread ? 'flag' : spreadGap != null ? 'ok' : 'none'}
              verdict={spreadGap == null ? <>Needs two people with {fmt.int(rules.minGames)}+ games.</>
                : spreadGap > rules.calSpread ? <><b>{Math.round(spreadGap * 100)} pts</b> apart, over the {Math.round(rules.calSpread * 100)}-point limit.</>
                : <>{Math.round(spreadGap * 100)} pts apart, inside the {Math.round(rules.calSpread * 100)}-point limit.</>}>
              <SpreadLine dots={spread} limit={rules.calSpread} ariaLabel="Bypass share per person, with the allowed spread" />
            </RuleBlock>
          </section>

          {/* ---- 4. Backlog ---- */}
          <section className="cfg-sec" id="cfg-backlog">
            <header className="cfg-sec-h">
              <h3>Backlog</h3>
              <p>When games build up or wait too long. The backlog is read as of now, whatever the {winName}.</p>
              <span className="cfg-sec-meta">
                Stale = in someone&apos;s backlog for more than <b>{sd} days</b> · <a href="/team-ops?tab=rescue">set in Rescue ↗</a>
              </span>
            </header>
            <RuleBlock title="Backlog growing" where="Overview · Individual"
              what="Games received beat games evaluated by this share of what was received."
              controls={ctl('growthGap')}
              tone={growFlags.length ? 'flag' : growRows.length ? 'ok' : 'none'}
              verdict={growFlags.length ? <>Growing: <b>{names(growFlags)}</b>.</> : growRows.length ? <>Nobody received {fmt.pct(rules.growthGap)} more than they evaluated.</> : <>No games were received in this {winName}.</>}>
              <ThresholdBars ariaLabel="Received minus evaluated, as a share of received"
                rows={growRows.map((r) => ({ key: r.key, name: r.name, value: r.gap, label: `${r.gap > 0 ? '+' : ''}${fmt.pct(r.gap)}`, state: r.gap > rules.growthGap ? 'flag' as const : 'base' as const,
                  tip: `${r.name}: received ${fmt.int(r.in)}, evaluated ${fmt.int(r.out)}` }))}
                domain={[growMin, growMax]} limit={rules.growthGap} limitLabel={`+${fmt.pct(rules.growthGap)}`} />
            </RuleBlock>
            <RuleBlock title="Stale backlog per person" where="all tabs"
              what={<>Both have to hold: this share of their backlog is over {sd} days old, and it is at least this many games.</>}
              controls={<>{ctl('staleShare')}{ctl('staleMin')}</>}
              tone={staleFlags.length ? 'flag' : staleRows.length || staleClean.length ? 'ok' : 'none'}
              verdict={staleFlags.length ? <>Flagged: <b>{staleFlags.map((r) => `${r.b.name} (${fmt.int(r.b.stale)} games)`).join(', ')}</b>.</>
                : staleRows.length || staleClean.length ? <>Nobody has {fmt.pct(rules.staleShare)} of their backlog, and {fmt.int(rules.staleMin)}+ games, waiting over {sd} days.</> : <>Every backlog is empty.</>}>
              <ThresholdBars ariaLabel="Share of each backlog waiting over the stale days"
                rows={staleRows.map((r) => ({ key: r.b.key, name: r.b.name, value: r.share, label: `${fmt.pct(r.share)} · ${fmt.int(r.b.stale)}`,
                  state: r.flag ? 'flag' as const : r.small ? 'muted' as const : 'base' as const,
                  tip: `${r.b.name}: ${fmt.int(r.b.stale)} of ${fmt.int(r.b.n)} games waiting over ${sd} days${r.small ? ` (under the ${fmt.int(rules.staleMin)}-game minimum)` : ''}` }))}
                domain={[0, staleMax]} limit={rules.staleShare} limitLabel={fmt.pct(rules.staleShare)} />
              <p className="rv-note">
                Light bars have fewer than {fmt.int(rules.staleMin)} stale games, so they are never flagged.
                {staleClean.length > 0 && <> Nothing stale: {names(staleClean, 6)}.</>}
              </p>
            </RuleBlock>
            <div className="rv-pair">
              <RuleBlock title="Team backlog too old" where="Overview"
                what="Share of the whole backlog waiting 8+ days since import."
                controls={ctl('agedShare')}
                tone={pace.stock === 0 ? 'none' : agedShare > rules.agedShare ? 'flag' : 'ok'}
                verdict={pace.stock === 0 ? <>The backlog is empty.</> : <>{fmt.pct(agedShare)} of {fmt.int(pace.stock)} games {agedShare > rules.agedShare ? 'is over' : 'is under'} the {fmt.pct(rules.agedShare)} limit.</>}>
                <Meter value={agedShare} limit={rules.agedShare} max={1} format={(v) => fmt.pct(v)} ariaLabel="Team backlog waiting 8+ days, against the limit" />
              </RuleBlock>
              <RuleBlock title="Backlog may hold" where="Overview"
                what="Days of work in the backlog at this window's pace."
                controls={ctl('clearDays')}
                tone={pace.daysToClear == null ? 'none' : pace.daysToClear > rules.clearDays ? 'flag' : 'ok'}
                verdict={pace.daysToClear == null ? <>No pace to measure in this {winName}.</>
                  : <>{fmt.dec(pace.daysToClear)} days of work at {fmt.int(pace.perDay)} games a day, {pace.daysToClear > rules.clearDays ? 'over' : 'under'} the {rules.clearDays}-day limit.</>}>
                {pace.daysToClear != null
                  ? <Meter value={pace.daysToClear} limit={rules.clearDays} max={Math.max(rules.clearDays * 2, pace.daysToClear * 1.15)} format={(v) => `${fmt.dec(v)}d`} ariaLabel="Days of work in the backlog, against the limit" />
                  : <p className="rv-empty">No pace in this {winName}</p>}
              </RuleBlock>
            </div>
          </section>

          {/* ---- 5. Workload ---- */}
          <section className="cfg-sec" id="cfg-workload">
            <header className="cfg-sec-h">
              <h3>Workload</h3>
              <p>When the team leans on one person.</p>
            </header>
            <RuleBlock title="One person does too much" where="Leaderboard"
              what="Their share of all games evaluated. Only checked with three or more people working."
              controls={ctl('concentration')}
              tone={topFlag ? 'flag' : people.length >= 3 ? 'ok' : 'none'}
              verdict={topFlag ? <><b>{topFlag.e.name}</b> evaluated {fmt.pct(topFlag.share)} of all games.</>
                : people.length >= 3 ? <>Nobody evaluated over {fmt.pct(rules.concentration)} of all games.</> : <>Fewer than three people worked this {winName}.</>}>
              <ThresholdBars ariaLabel="Each person's share of all games evaluated"
                rows={shareRows.map((r, i) => ({ key: r.e.key, name: r.e.name, value: r.share, label: fmt.pct(r.share),
                  state: i === 0 && topFlag ? 'flag' as const : 'base' as const, tip: `${r.e.name}: ${fmt.int(r.e.evaluated)} of ${fmt.int(totalEval)} games` }))}
                domain={[0, shareMax]} limit={rules.concentration} limitLabel={fmt.pct(rules.concentration)} />
            </RuleBlock>
            <div className="cfg-sec-actions">
              <button type="button" className="btn btn-sm" onClick={() => setRules(DEFAULT_REPORT_RULES)}>Reset every alert rule to its default</button>
            </div>
          </section>
          {/* ---- 6. Chart colours ---- */}
          <section className="cfg-sec" id="cfg-colours">
            <header className="cfg-sec-h">
              <h3>Chart colours</h3>
              <p>One palette for every chart on every tab. Each metric has one colour everywhere: Evaluated is the same colour on Overview, the Leaderboard and Individual.</p>
            </header>
            <div className="cfg-pals" role="radiogroup" aria-label="Chart colour preset">
              {PALETTE_KEYS.map((k) => {
                const pr = PALETTES[k]
                const rp = resolvePalette(k)
                const on = palette === k
                return (
                  <label key={k} className={'cfg-pal' + (on ? ' on' : '')}>
                    <input type="radio" name="cfg-palette" checked={on} onChange={() => setPalette(k)} />
                    <span className="cfg-pal-head">
                      <b>{pr.label}</b>
                      {k === 'standard' && <span className="cfg-pal-tag">default</span>}
                    </span>
                    <span className="cfg-pal-strip" aria-hidden="true">
                      {pr.slots.map((c) => <i key={c} style={{ background: c }} />)}
                    </span>
                    <span className="cfg-pal-note">{pr.note}</span>
                    <span className="cfg-pal-roles">
                      {ROLE_LABELS.map(([role, label]) => (
                        <span key={role}><i style={{ background: rp.role[role] }} />{label}</span>
                      ))}
                    </span>
                    <span className={'cfg-pal-check' + (pr.cvd >= 8 ? ' ok' : ' warn')}>
                      {pr.cvd >= 8 ? '✓' : '!'} Colour-blind check ΔE {pr.cvd}{pr.cvd >= 8 ? '' : ' - leans on labels and the dashed backlog line'}
                    </span>
                  </label>
                )
              })}
            </div>
            {/* The real charts, redrawn in the pending preset. */}
            <PaletteContext.Provider value={pal}>
              <div className="cfg-pal-sample">
                <div>
                  <div className="cfg-pal-sample-l">Flow &amp; backlog, this {winName}</div>
                  {flowSample.length >= 2
                    ? <LineChart area series={[
                      { name: 'New games in', color: pal.role.intake, points: flowSample.map((r) => ({ label: r.label, value: r.newGames })) },
                      { name: 'Evaluated', color: pal.role.evaluated, points: flowSample.map((r) => ({ label: r.label, value: r.evaluated })) },
                      { name: 'Backlog', color: pal.role.backlog, dashed: true, area: false, points: flowSample.map((r) => ({ label: r.label, value: r.backlog })) },
                    ]} />
                    : <p className="rv-empty">Needs a window with a time axis</p>}
                </div>
                <div>
                  <div className="cfg-pal-sample-l">Quality rates, this {winName}</div>
                  {qualitySample.length >= 2
                    ? <LineChart format={(v) => `${v.toFixed(1)}%`} series={[
                      { name: 'Shortlist rate %', color: pal.role.shortlist, points: qualitySample.map((m) => ({ label: m.label, value: m.survivalRate * 100 })) },
                      { name: 'Hit rate %', color: pal.role.hit, points: qualitySample.map((m) => ({ label: m.label, value: m.signalRate * 100 })) },
                    ]} />
                    : <p className="rv-empty">Needs two buckets with work</p>}
                </div>
              </div>
            </PaletteContext.Provider>
            <div className="cfg-pal-fixed">
              <span className="cfg-pal-fixed-l">Never change with the preset</span>
              <span><i style={{ background: 'var(--good)' }} /><i style={{ background: 'var(--warn)' }} /><i style={{ background: 'var(--bad)' }} /> status: good, warning, bad</span>
              <span>{AGE_BANDS.map((b) => <i key={b.k} style={{ background: b.color }} />)} backlog age bands</span>
              <span>{['List_Idea', 'Playtest & Bypass', 'Bypass', 'Priority IV', 'Insight'].map((c) => <i key={c} style={{ background: conclusionColor(c) }} />)} conclusions</span>
              <span><i style={{ background: NEUTRAL_REF }} /> team average and link dead</span>
            </div>
          </section>
        </div>
      </div>

      {/* Sticky: the only Save on the tab, so there is never a question of which of two
          buttons saves what. */}
      <div className={'cfg-savebar' + (dirty ? ' dirty' : '')}>
        <span className="cfg-savebar-s">
          {state === 'error' ? <b className="bad">Save failed - try again</b>
            : state === 'saving' ? 'Saving…'
            : dirty ? <><b>{changes}</b> unsaved {changes === 1 ? 'change' : 'changes'}. They change the Report for everyone.</>
            : state === 'saved' ? 'Saved - all tabs recomputed' : 'Up to date'}
        </span>
        <button type="button" className="btn btn-sm" onClick={discard} disabled={!dirty || state === 'saving'}>Discard</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={!dirty || state === 'saving'}>Save settings</button>
      </div>
    </div>
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
// 'ios' -> 'iOS', same as the Review table under it.
const fmtOs = (os: string) => (os.trim().toLowerCase() === 'ios' ? 'iOS' : os.trim().toLowerCase() === 'android' ? 'Android' : os)
type VidStatus = 'recorded' | 'recording' | 'pending'
function vidStatus(v: VidRow): VidStatus {
  if (v.youtube) return 'recorded'
  if (v.confirmedOn) return 'recording'
  return 'pending'
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
              return (
                <tr key={`${v.gameId}-${v.slot}`}>
                  <td className="rp-vid-i">{i + 1}</td>
                  <td className="rp-vid-game">{v.title || v.gameId}{v.os && <span className="rp-vid-os"> · {fmtOs(v.os)}</span>}</td>
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
function Card({ label, note, tip, fill, focusKey, children }: {
  label: string; note?: string; tip?: React.ReactNode; fill?: boolean
  // Marks the card's own instance (not the modal copy) `data-rp-focus="<focusKey>"`,
  // same idiom as `Kpi`, `BandBar` and `SortCol` - so a verdict chip can send a
  // reader straight to a card, not just a KPI tile or a table column.
  focusKey?: string
  children: React.ReactNode
}) {
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
      <div className={'card' + (fill ? ' rp-card-fill' : '')} data-rp-focus={focusKey}>
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
// The numbers behind a flow chart's lines: one ROW per metric and one COLUMN per
// bucket, so time runs left to right under a chart whose x axis also runs left to
// right and the eye drops straight from a point to its figure. The columns are what
// grow, and the wrapper scrolls sideways with the metric names and the Total pinned.
// Change = in - out (- link dead) per bucket: positive means the backlog grew, and only
// that row carries a colour, or the table turns into a heatmap. Backlog is a stock, so
// its Total cell is empty. The last bucket of an open window stays in (a running count
// is true as far as it goes) and says so. Shared by Overview and Individual.
type FlowRow = { label: string; in: number; out: number; dead?: number; backlog: number }
function FlowTable({ rows, partialTail, inLabel, outLabel }: {
  rows: FlowRow[]; partialTail: boolean; inLabel: string; outLabel: string
}) {
  if (!rows.length) return null
  const showDead = rows.some((r) => (r.dead || 0) > 0)
  const sum = (f: (r: FlowRow) => number) => rows.reduce((s, r) => s + f(r), 0)
  const change = (r: FlowRow) => r.in - r.out - (r.dead || 0)
  const signed = (n: number) => (n > 0 ? `+${fmt.int(n)}` : n < 0 ? `-${fmt.int(-n)}` : '0')
  const tone = (n: number) => (n > 0 ? 'up' : n < 0 ? 'down' : '')
  const last = rows.length - 1
  const netTot = sum(change)
  return (
    <div className="rp-flow-scroll">
      <table className="rp-flow-table">
        <thead>
          <tr>
            <th />
            {rows.map((r, i) => (
              <th key={r.label + i} className={partialTail && i === last ? 'partial' : undefined}>
                {r.label}{partialTail && i === last && <small>so far</small>}
              </th>
            ))}
            <th className="rp-flow-total">Total</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>{inLabel}</th>
            {rows.map((r, i) => <td key={i}>{fmt.int(r.in)}</td>)}
            <td className="rp-flow-total">{fmt.int(sum((r) => r.in))}</td>
          </tr>
          <tr>
            <th>{outLabel}</th>
            {rows.map((r, i) => <td key={i}>{fmt.int(r.out)}</td>)}
            <td className="rp-flow-total">{fmt.int(sum((r) => r.out))}</td>
          </tr>
          {showDead && (
            <tr>
              <th>Link dead</th>
              {rows.map((r, i) => <td key={i}>{fmt.int(r.dead || 0)}</td>)}
              <td className="rp-flow-total">{fmt.int(sum((r) => r.dead || 0))}</td>
            </tr>
          )}
          <tr>
            <th>Change</th>
            {rows.map((r, i) => {
              const n = change(r)
              return <td key={i} className={tone(n) || undefined}>{signed(n)}</td>
            })}
            <td className={`rp-flow-total ${tone(netTot)}`.trim()}>{signed(netTot)}</td>
          </tr>
          <tr className="rp-flow-stock">
            <th>Backlog</th>
            {rows.map((r, i) => <td key={i}>{fmt.int(r.backlog)}</td>)}
            <td className="rp-flow-total" />
          </tr>
        </tbody>
      </table>
    </div>
  )
}

/* A chart's footer: a legend for whatever the chart draws that its own legend does not
   name (a dashed average, a ring, a faded bar), then ONE row of facts computed from the
   numbers this window drew. Facts are pills - a short label, the number in bold - not a
   paragraph: the reader was handed three lines of prose under every chart and had to
   dig the numbers out of it. Longer explanations live in the card's "?" tip.
   It is a reading, not an instruction: actions live in "Do this" and nowhere else. */
export type FootKey = {
  shape: 'dash' | 'ring-low' | 'ring-high' | 'bar' | 'bar-partial' | 'heat' | 'dot'
  color?: string
  label: React.ReactNode
}
export type Fact = {
  label?: React.ReactNode
  value: React.ReactNode
  note?: React.ReactNode
  // good / bad / warn are status; `up` / `down` are a verdict about a direction and
  // always carry an arrow, so the colour is never the only thing saying which way.
  tone?: 'good' | 'warn' | 'bad'
  icon?: '▲' | '▼' | '✓' | '!'
}
function KeyGlyph({ k }: { k: FootKey }) {
  const c = k.color || 'var(--faint)'
  return (
    <svg className="rp-fkey-g" width={22} height={12} viewBox="0 0 22 12" aria-hidden="true">
      {k.shape === 'dash' && <line x1={1} x2={21} y1={6} y2={6} stroke={c} strokeWidth={1.6} strokeDasharray="4 3" />}
      {(k.shape === 'ring-low' || k.shape === 'ring-high') && (
        <circle cx={11} cy={6} r={4.6} fill="none" strokeWidth={1.4} strokeDasharray="2.4 2"
          stroke={k.shape === 'ring-low' ? 'var(--bad)' : 'var(--accent-strong)'} />
      )}
      {k.shape === 'bar' && <rect x={6} y={1} width={10} height={10} rx={2} fill={c} />}
      {k.shape === 'bar-partial' && <rect x={6} y={1.5} width={10} height={9} rx={2} fill={c} fillOpacity={0.32} stroke={c} strokeWidth={1.2} strokeDasharray="2.5 2" />}
      {k.shape === 'dot' && <circle cx={11} cy={6} r={4} fill={c} />}
      {k.shape === 'heat' && [0.18, 0.5, 1].map((o, i) => <rect key={i} x={1 + i * 7} y={2} width={6} height={8} rx={1.5} fill={c} fillOpacity={o} />)}
    </svg>
  )
}
function Foot({ keys, hint, facts, children }: {
  keys?: FootKey[]
  // One short muted line, for the single reading rule a legend cannot draw.
  hint?: React.ReactNode
  facts?: Array<Fact | null | false | undefined>
  children?: React.ReactNode
}) {
  const shown = (facts || []).filter(Boolean) as Fact[]
  const legend = (keys && keys.length > 0) || hint
  return (
    <div className="rp-foot">
      {children && <div className="rp-foot-key">{children}</div>}
      <div className="rp-foot-text">
        {legend && (
          <div className="rp-foot-legend">
            {(keys || []).map((k, i) => (
              <span className="rp-fkey" key={i}><KeyGlyph k={k} /><span>{k.label}</span></span>
            ))}
            {hint && <span className="rp-foot-hint">{hint}</span>}
          </div>
        )}
        {shown.length > 0 && (
          <div className="rp-foot-now">
            {/* The {' '} runs are invisible in a flex row (whitespace between flex
                items is not rendered) but keep the text readable as text: a screen
                reader, a copy-paste or a test reads "Alpha 0% vs 20% 250 games", not
                "Alpha0% vs 20%250 games". */}
            <span className="rp-now-tag">Now</span>{' '}
            {shown.map((f, i) => (
              <React.Fragment key={i}>
                <span className={'rp-fact' + (f.tone ? ` ${f.tone}` : '')}>
                  {f.icon && <span className="rp-fact-i" aria-hidden="true">{f.icon}</span>}
                  {f.label && <><span className="rp-fact-l">{f.label}</span>{' '}</>}
                  <b className="rp-fact-v">{f.value}</b>
                  {f.note && <>{' '}<span className="rp-fact-n">{f.note}</span></>}
                </span>{' '}
              </React.Fragment>
            ))}
          </div>
        )}
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
              {share * span >= LABEL_MIN && <em style={{ color: inkOn(b.color) }}>{Math.round(share * 100)}%</em>}
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
