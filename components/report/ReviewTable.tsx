'use client'
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { Lightbox } from '@/components/Lightbox'
import { TrendTagCell, type GameTrendTag } from '@/components/TrendTagCell'
import { prettyConclusion } from '@/lib/buckets'
import { thumbUrl } from '@/lib/image-thumbs'

// The Individual tab's bottom block: one evaluator's judged games, one row each,
// with the StoreKit screenshots visible so a wrong call is obvious at a glance --
// closing the gap where a reviewer had to leave the Report and rebuild the same
// filters on the Evaluations screen.
//
// It owns its Category and Initial conclusion filters. Its DATES do not float free:
// they open on the whole period the page's own filter bar is showing (`windowFrom` /
// `windowTo`) and the two pickers are clamped to that period, so this table can only
// ever narrow what the reader already selected above -- never contradict it. Only
// when the page is on a window with no bounds at all (All batches / all time) does
// it fall back to resolving its own "newest days that have rows" default.

const PAGE_SIZE = 20

// 'all' is deliberately absent from the category filter: category_group is a
// required, non-empty column and there is no 'all' value for it in the DB.
const CATEGORY_OPTIONS: Array<[string, string]> = [
  ['puzzle', 'Puzzle'], ['arcade', 'Arcade'], ['simulation', 'Sim'],
]

// Fallback/canonical ordering for the conclusion filter -- kept in sync with
// CONFIG_DEFAULTS.conclusion in lib/config.ts (server-only, so not imported
// directly into this client component), the same way the Evaluations page's own
// local CONCLUSION_OPTIONS copy is. This is never the only source of truth: it
// is merged with the live, admin-editable list fetched from /api/evaluations/facets
// below, the same merge app/(manager)/evaluations/page.tsx's fetchFacets already
// does. Without that merge this dropdown would only ever offer 3 of the 17 real
// values, and a manager reviewing an evaluator whose games carry any of the other
// 14 could never select a filter that would show them.
const CONCLUSION_DEFAULTS = [
  'Bypass', 'Conclusion', 'Good', 'Link_dead', 'M_ByPass', 'Need deeper testing', 'Skip',
  'Wait for PlayTest', 'Priority IV: Idea', 'Priority III: Watchlist for next phase',
  'Check Market Data', 'Watchlist for next milestone', 'Priority II', 'Priority I',
  'Need Direction', 'List_Idea', 'Playtest & Bypass',
]

// Not calls -- housekeeping. `Link_dead` says the store page went away and
// `Stale_release` says the build aged out; nobody judged anything in either case.
// The whole Report already draws this line: its `judged` predicate is
// "initial_conclusion IS NOT NULL AND NOT IN ('Link_dead', 'Stale_release')"
// (app/api/report/route.ts), which is why every KPI on the tabs above this table
// counts them out. A block titled "check the calls themselves" that offers them as
// filters -- and could open on one, showing an empty table under a person who did
// plenty of work -- is offering to review something that was never a decision.
const HOUSEKEEPING = ['Link_dead', 'Stale_release']

// The dropdown's "every real call" entry, and the default. It is not a value the API
// stores: it travels as `exclude_conclusions`, which the route reads as "judged, and
// not one of these" -- the same line app/api/report's `judged` predicate draws, so
// this table and the KPIs above it count the same rows.
//
// An exclusion, not the list of everything else, because the list of everything else
// would have to be built from the live facets -- which arrive in a second request, so
// page 1 would be fetched once against a guess and again when that landed. This is a
// constant, and it stays right when an admin adds a conclusion in Config.
const ALL_CONCLUSIONS = '__all__'

// The canonical 17 are the FALLBACK, not a floor: they are what the dropdown offers
// when there is no live answer, and the live answer REPLACES them when there is one.
//
// An empty `live` (a failed fetch, or a genuinely empty answer) leaves the canonical
// list intact rather than collapsing the dropdown to just the current selection --
// app/(manager)/evaluations/page.tsx's fetchFacets guards the identical case with
// `if (json.available_conclusions?.length) { ... }`, simply not touching state (which
// started as the full canonical list) on an empty/failed response. This does the same
// thing at the merge itself, so it holds regardless of who calls it.
//
// When `live` is non-empty the canonical list NARROWS to it: the result is the
// canonical values this evaluator/category actually has rows for, in canonical order,
// then any live values the canonical list doesn't know about (sorted) -- the same
// ordering /api/evaluations/route.ts computes for available_conclusions server-side
// and that page's fetchFacets mirrors client-side. A canonical value with no rows is
// dropped on purpose: an option that can only ever return an empty table is noise.
// (report-review-table.test.tsx's "not.toContain('Skip')" case is exactly this.)
// `selected` is folded in either way so the currently-chosen filter value never
// disappears from its own dropdown mid-fetch or if the live list omits it.
function mergeConclusionOptions(live: string[], selected: string): string[] {
  const keep = (list: string[]) => list.filter(c => !HOUSEKEEPING.includes(c))
  const defaults = keep(CONCLUSION_DEFAULTS)
  const sel = selected === ALL_CONCLUSIONS || HOUSEKEEPING.includes(selected) ? '' : selected
  if (live.length === 0) {
    return sel && !defaults.includes(sel) ? [...defaults, sel] : defaults
  }
  const merged = Array.from(new Set(keep(live).concat(sel ? [sel] : [])))
  return defaults.filter(c => merged.includes(c))
    .concat(merged.filter(c => !defaults.includes(c)).sort())
}

// The live, admin-editable conclusion list for this evaluator/category (Config tab,
// config_options table). Scoped by category+evaluator only (no date/conclusion
// filter) so it reflects every value that evaluator's rows have ever carried, not
// just what falls inside whatever date window this table's filters currently show.
async function fetchConclusionOptions(evaluator: string, category: string): Promise<string[]> {
  try {
    const params = new URLSearchParams({ category, evaluator })
    const res = await fetch(`/api/evaluations/facets?${params}`)
    const json = await res.json()
    return Array.isArray(json.available_conclusions) ? json.available_conclusions : []
  } catch {
    return []
  }
}

interface ReviewRow {
  id: number
  game_id: string
  title: string | null
  icon_url: string | null
  publisher_name: string | null
  release_date: string | null
  os: string | null
  app_link: string | null
  initial_conclusion: string | null
  initial_evaluator: string | null
  evaluate_date: string | null
  updated_at: string | null
  tags: GameTrendTag[] | null
  screenshot_urls: string[] | null
  manual_screenshot_urls: string[] | null
}

// What a conclusion MEANS, in four tones, so a column of pills reads as kept /
// dropped / not decided without anyone learning seventeen labels.
//
// Rules, not a table of seventeen values, because the list is admin-editable in
// Config -- a table would leave every new value colourless. The bypass rule is not
// invented here either: `NOT ILIKE '%bypass%'` is exactly how the server decides what
// counts as shortlisted (app/api/report/route.ts), so "Playtest & Bypass" and
// "M_ByPass" land on the same side of the line here as they do in the KPI above.
function conclusionTone(v: string | null | undefined): string {
  if (!v) return 'rp-tone-none'
  if (HOUSEKEEPING.includes(v)) return 'rp-tone-none'
  if (/bypass/i.test(v) || /^skip$/i.test(v)) return 'rp-tone-bad'
  // Not a verdict yet -- it asks for more work before anyone can call it.
  if (/^(need|wait|check)\b/i.test(v)) return 'rp-tone-hold'
  return 'rp-tone-good'
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—' // em dash used ONLY as the established placeholder glyph for a
  // missing data value (matches EvalRow/InfoField elsewhere in this codebase) -- never
  // written into a sentence, which is what the lexicon rule actually forbids.
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return '—'
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

// StoreKit first, manual second -- same fallback EvalDetailPanel/ManualScreenshotsCard
// use, so a game with no store screenshots but a manually-attached one still shows a
// strip instead of a blank row.
function shotsFor(row: ReviewRow): string[] {
  if (Array.isArray(row.screenshot_urls) && row.screenshot_urls.length > 0) return row.screenshot_urls
  if (Array.isArray(row.manual_screenshot_urls) && row.manual_screenshot_urls.length > 0) return row.manual_screenshot_urls
  return []
}

// How far back the newest-days probe looks before it gives up and asks all-time.
// 90 days is far past any window a person is plausibly reviewing and still short
// enough to be an index-friendly range predicate.
// What to ask the store CDNs for, in device pixels: the CSS box times a 2x screen,
// rounded up a little. The originals behind these are phone-resolution PNGs, so a
// row of eight is megabytes of transfer and eight full-size decodes for boxes 144px
// and 52px tall. See lib/image-thumbs.ts.
const SHOT_PX = 320
const ICON_PX = 128

// A rewritten URL is a guess about someone else's CDN, so every <img> that uses one
// falls back to the original on error -- once. Without the guard a genuinely broken
// image swaps src forever, and an onError that sets the same src it just failed on
// is an infinite request loop.
function fallbackToOriginal(e: SyntheticEvent<HTMLImageElement>, original: string) {
  const img = e.currentTarget
  if (img.dataset.fellBack === '1' || img.src === original) return
  img.dataset.fellBack = '1'
  img.src = original
}

const PROBE_DAYS = 90

// Today in Asia/Ho_Chi_Minh (UTC+7) -- the timezone /api/evaluations resolves its
// date columns in, so the probe's window lines up with the rows it is asking about.
function vnToday(): string {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10)
}
function shiftDays(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

// One probe request: up to 100 rows, newest first, no screenshots, read purely for
// which calendar days are present.
// `ok: false` marks a probe that never got an answer (network/parse failure), which
// callers must NOT treat the same as `ok: true` with no days -- that pair is a real
// answer ("nothing in this range") and is what licenses the unbounded retry below.
// `conclusion` -> the query parameter for it. One real value goes on `conclusion`;
// ALL_CONCLUSIONS expands onto `conclusions` (the route's IN-list form) so the
// request still names every value it wants and housekeeping stays out.
function conclusionParams(conclusion: string): Record<string, string> {
  return conclusion === ALL_CONCLUSIONS
    ? { exclude_conclusions: HOUSEKEEPING.join(',') }
    : { conclusion }
}

async function probeDays(
  evaluator: string, category: string, conclusion: string,
  range: { from: string; to: string } | null,
): Promise<{ from: string | null; to: string | null; ok: boolean }> {
  const params = new URLSearchParams({
    evaluator, category, date_basis: 'evaluated',
    sort: 'desc', page: '1', limit: '100', meta: '0', stats: '0',
    ...conclusionParams(conclusion),
  })
  if (range) { params.set('from', range.from); params.set('to', range.to) }
  try {
    const res = await fetch(`/api/evaluations?${params}`)
    const json = await res.json()
    const rows: Array<{ evaluate_date?: string | null; updated_at?: string | null }> = json.data || []
    const days: string[] = []
    for (const r of rows) {
      const raw = r.evaluate_date || r.updated_at
      if (!raw) continue
      const day = String(raw).slice(0, 10)
      if (!days.includes(day)) days.push(day)
      if (days.length === 3) break
    }
    if (days.length === 0) return { from: null, to: null, ok: true }
    // Rows arrive newest-first, so the first distinct day found is the newest and
    // the last one collected (up to 3) is the oldest of that set.
    return { from: days[days.length - 1], to: days[0], ok: true }
  } catch {
    return { from: null, to: null, ok: false }
  }
}

// "The newest 3 days that have any rows", not the last 3 calendar days: a person
// who did not work over the weekend must not open an empty table and read it as
// broken. /api/evaluations has no "distinct days with data" facet, so this costs
// one extra round trip on mount purely to read off which days are present, then
// the real paginated fetch runs against the resolved [from, to] window.
//
// ONLY REACHED ON AN UNBOUNDED PAGE WINDOW (All batches / all time). When the page's
// filter bar has real bounds, those ARE the default and this probe never runs -- the
// common path now costs one round trip fewer than it used to.
//
// BOUNDED FIRST, and that bound is load-bearing. Without from/to the route's
// rangeFilter is EMPTY (app/api/evaluations/route.ts, `rangeFilterFor` only fires
// when both ends are present), which makes this one request pay for an unbounded
// scan of that evaluator's whole history: the rows query, whose
// `ORDER BY COALESCE(ge.evaluate_date, ge.updated_at) DESC` is an expression order
// no plain index serves. Passing a range bounds it. (`stats=0` now drops the page-1
// count(*) that used to ride along with it -- but a bound is still the fix, because
// dropping the count would have left the unbounded row scan.)
// The database is on another continent from the app, so a heavy scan here is paid
// in full, every time the Individual tab opens.
//
// Only if 90 days comes back GENUINELY empty (`ok: true`, no `from`) do we ask
// all-time -- one extra round trip, in the rare case of a person with no work in a
// quarter, in exchange for never paying the unbounded scan on the common path. A
// FAILED bounded probe (`ok: false`) must not take that branch: it is not evidence
// of "no rows here", and escalating it would mean a network hiccup on the cheap
// bounded probe reaches the expensive unbounded one every time.
async function fetchNewestDays(
  evaluator: string, category: string, conclusion: string,
): Promise<{ from: string | null; to: string | null }> {
  const today = vnToday()
  // `to` is tomorrow, not today: the route's upper bound is exclusive-of-the-next-day
  // already, and one extra day absorbs a row whose evaluate_date was written slightly
  // ahead of VN midnight rather than dropping it and reading as "no recent work".
  const bounded = await probeDays(evaluator, category, conclusion,
    { from: shiftDays(today, -PROBE_DAYS), to: shiftDays(today, 1) })
  if (bounded.from) return bounded
  if (!bounded.ok) return { from: null, to: null }
  const unbounded = await probeDays(evaluator, category, conclusion, null)
  return { from: unbounded.from, to: unbounded.to }
}

export function ReviewTable({ evaluator, canSeeTeam, windowFrom = null, windowTo = null }: {
  evaluator: string
  canSeeTeam: boolean
  // The page filter bar's resolved window, INCLUSIVE at both ends (the report payload
  // carries an exclusive `to`; the call site subtracts the day). Null on a window with
  // no bounds -- All batches / all time -- which is the only case that still probes.
  windowFrom?: string | null
  windowTo?: string | null
}): JSX.Element {
  const [category, setCategory] = useState('puzzle')
  const [conclusion, setConclusion] = useState(ALL_CONCLUSIONS)
  // Full canonical list until the live facets response narrows it -- same as
  // app/(manager)/evaluations/page.tsx's own availableConclusions state, so the
  // dropdown never flashes down to just the one selected value on first paint.
  // Housekeeping is filtered out of the FIRST paint too, not only after the facets
  // response merges: the canonical list is what the dropdown shows until that lands,
  // so seeding it raw put Link_dead in front of the reader on every tab open.
  const [conclusionOptions, setConclusionOptions] = useState<string[]>(
    () => CONCLUSION_DEFAULTS.filter(c => !HOUSEKEEPING.includes(c)))
  const [from, setFrom] = useState<string | null>(null)
  const [to, setTo] = useState<string | null>(null)
  const [initializing, setInitializing] = useState(true)
  const [rows, setRows] = useState<ReviewRow[]>([])
  // Starts true: the very first paint is always waiting on the resolved window
  // (and then page 1), so there is no in-between frame where "no rows yet" would
  // be mistaken for "no rows ever" and flash the empty sentence.
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const [lightboxImages, setLightboxImages] = useState<string[]>([])

  const pageRef = useRef(1)
  const fetchSeqRef = useRef(0)
  const sentinelRef = useRef<HTMLDivElement>(null)
  // The rows area is its own scroll container now (one screen tall, the list runs
  // inside it), so the sentinel is NOT in the viewport's scrolling box any more.
  // An IntersectionObserver left on the default root watches the viewport and would
  // either never fire or fire once forever, so the observer below is rooted here.
  const rowsRef = useRef<HTMLDivElement>(null)
  // Read inside the conclusion-options effect below without making `conclusion`
  // one of its dependencies -- that fetch only needs to re-run when evaluator or
  // category changes, not on every selection the person makes in that same dropdown.
  const conclusionRef = useRef(conclusion)
  useEffect(() => { conclusionRef.current = conclusion }, [conclusion])

  // Switching person resets this table to a clean, known state. Done DURING RENDER
  // (React's documented "adjusting state when a prop changes" pattern) rather than in
  // an effect, for two reasons:
  //   1. `rows` must be emptied in the same commit the new name paints in. In an
  //      effect it is not: there is a frame where `initializing` is true, `loading` is
  //      false and `rows` still holds the PREVIOUS person's games, so an admin clicking
  //      through the name chips sees one person's games under another's name.
  //   2. The window effect below keys on [evaluator, category, ...]. Resetting category
  //      in an effect would let that effect fire once with the outgoing category and
  //      again with 'puzzle' -- two resolutions per person switch.
  const [lastEvaluator, setLastEvaluator] = useState(evaluator)
  if (evaluator !== lastEvaluator) {
    setLastEvaluator(evaluator)
    // Bump the sequence too, not just the visible state: an outgoing person's
    // page-1 fetchPage may still be in flight (it awaited the window resolution
    // before this reset ran), and until a new fetchPage call bumps fetchSeqRef
    // itself -- which does not happen until the effect below resolves -- that stale
    // response's `seq` still equals fetchSeqRef.current and would repopulate `rows`
    // with the previous person's games under the new name.
    fetchSeqRef.current++
    setCategory('puzzle')
    setConclusion(ALL_CONCLUSIONS)
    setFrom(null)
    setTo(null)
    setRows([])
    setHasMore(false)
    setLoading(true)
    setInitializing(true)
  }

  // Resolve the default date window.
  //
  // With page bounds, that is simply the page's own period -- no request, and the
  // table opens showing exactly what the filter bar above it says it is showing.
  // Re-runs when the reader changes the period up there, so the two never drift.
  //
  // Without them (All batches / all time) it falls back to the newest-3-days probe,
  // keyed on the person AND the category: the whole reason that default exists ("a
  // person who did not work over the weekend must not open an empty table and read it
  // as broken") applies just as much to switching Category to Arcade, where the puzzle
  // window would otherwise be kept and an evaluator with no arcade work in those exact
  // three days reads as broken. Not keyed on conclusion: that dropdown is a deliberate
  // narrowing the reader just made, and "no Puzzle games marked Priority I between
  // these dates" is a coherent answer to it, not a broken-looking one -- and
  // re-probing on every pick would double the request count of using that dropdown.
  useEffect(() => {
    if (windowFrom && windowTo) {
      setFrom(windowFrom)
      setTo(windowTo)
      setInitializing(false)
      return
    }
    let cancelled = false
    setInitializing(true)
    void (async () => {
      const { from: f, to: t } = await fetchNewestDays(evaluator, category, conclusionRef.current)
      if (cancelled) return
      setFrom(f)
      setTo(t)
      setInitializing(false)
    })()
    return () => { cancelled = true }
  }, [evaluator, category, windowFrom, windowTo])

  // Live conclusion options for the dropdown, merged with the canonical default
  // ordering. Re-fetches on evaluator or category change; a selection change alone
  // does not need a new fetch (see conclusionRef above).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const live = await fetchConclusionOptions(evaluator, category)
      if (cancelled) return
      setConclusionOptions(mergeConclusionOptions(live, conclusionRef.current))
    })()
    return () => { cancelled = true }
  }, [evaluator, category])

  const fetchPage = useCallback(async (page: number, append: boolean) => {
    const seq = ++fetchSeqRef.current
    if (append) setLoadingMore(true); else setLoading(true)
    const params = new URLSearchParams({
      evaluator, category, date_basis: 'evaluated',
      page: String(page), limit: String(PAGE_SIZE), with_screenshots: '1',
      sort: 'desc', meta: '0', stats: '0',
      ...conclusionParams(conclusion),
    })
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    try {
      const res = await fetch(`/api/evaluations?${params}`)
      const json = await res.json()
      if (seq !== fetchSeqRef.current) return // stale response; a newer fetch owns the state
      const newRows: ReviewRow[] = json.data || []
      setRows(prev => (append ? [...prev, ...newRows] : newRows))
      setHasMore(newRows.length === PAGE_SIZE)
    } catch {
      if (seq === fetchSeqRef.current) {
        if (append) {
          // Roll the page back and stop. Leaving hasMore true after a failed append
          // is an infinite retry loop, not a retry: pageRef has already advanced, the
          // sentinel is still intersecting, and the observer re-fires the moment
          // loadingMore clears -- asking for page N+2 forever and never showing the
          // page that failed. Rolling back keeps the next successful load asking for
          // the right page.
          pageRef.current = Math.max(1, pageRef.current - 1)
          setHasMore(false)
        } else {
          setRows([])
          setHasMore(false)
        }
      }
    }
    if (seq === fetchSeqRef.current) { setLoading(false); setLoadingMore(false) }
  }, [evaluator, category, conclusion, from, to])

  useEffect(() => {
    if (initializing) return
    pageRef.current = 1
    fetchPage(1, false)
  }, [initializing, category, conclusion, from, to, fetchPage])

  // The repo's existing infinite-scroll idiom (app/(manager)/evaluations/page.tsx,
  // ~1258-1270): an IntersectionObserver on a 1px sentinel, same rootMargin, same
  // triple guard -- rooted on the rows scroller rather than the viewport, because
  // that is the box the sentinel now scrolls inside.
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore && !loading && !loadingMore) {
        pageRef.current += 1
        fetchPage(pageRef.current, true)
      }
      // 600px, not the 200 the Evaluations page uses. There the sentinel sits in a
      // page-height viewport; here it sits in a box one screen tall whose rows are
      // ~170px each, so 200px of warning is barely one row -- the reader reaches the
      // end and waits. 600 starts the next page about three rows early, which is
      // roughly the time the request takes from here.
    }, { root: rowsRef.current, rootMargin: '600px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loading, loadingMore, fetchPage])

  // NO WHEEL HANDLER HERE, and that is a decision, not an omission.
  //
  // This block used to intercept downward wheel events so the page finished scrolling
  // the table into view before the list started moving. It worked with a mouse wheel
  // and was unusable with a trackpad: a non-passive `wheel` listener takes scrolling
  // off the compositor thread entirely, so every frame has to wait for JS -- and a
  // trackpad delivers a continuous stream of small, fractional deltas plus momentum,
  // which the handler then fought by assigning `scrollTop` on each one. The symptom
  // was exactly that: smooth on the scrollbar, smooth upward, stuttering and then
  // dead on the way down. The cost is on the LISTENER, so returning early does not
  // buy it back -- the only fix is not to listen.
  //
  // What is left is what the browser does natively and does well: the wheel scrolls
  // whichever box is under the pointer, and `overscroll-behavior` is left at `auto`
  // (see globals.css) so reaching either end of the list chains straight on to the
  // page. Nothing traps the reader in the middle of the tab, which was the original
  // complaint; what is gone is "the page scrolls first, then the list", which cannot
  // be had smoothly alongside momentum scrolling.

  function openShot(url: string, images: string[]) {
    setLightboxImages(images)
    setLightboxUrl(url)
  }

  // Category owns the date window too, so it has to flip `initializing` here, in the
  // event handler, not in the effect: an effect runs one flush too late, and the
  // page-1 effect below (which also depends on `category`) would fire once against the
  // outgoing category's dates before the new window is even asked for.
  function changeCategory(next: string) {
    setCategory(next)
    setInitializing(true)
    setRows([])
    setHasMore(false)
    setLoading(true)
  }

  // A date the reader picks can only ever land inside the page's own period. The
  // pickers already carry min/max, but a typed date bypasses those in several
  // browsers, so the value is clamped here as well -- this table must never show
  // rows from outside the window the rest of the page is reporting on.
  function clampToWindow(v: string): string {
    if (windowFrom && v < windowFrom) return windowFrom
    if (windowTo && v > windowTo) return windowTo
    return v
  }

  // Clearing a box goes back to the page's period when there is one. Where there
  // isn't, it clears both: the route applies a range only when BOTH ends are present
  // (rangeFilterFor in lib/evaluations-filters.ts), so a half-filled pair is silently
  // all-time while one box still shows a date -- the table would then be lying about
  // its own scope in its own toolbar. "No dates" is a state the reader can see and
  // the query actually has.
  function resetDates() {
    if (windowFrom && windowTo) { setFrom(windowFrom); setTo(windowTo) }
    else { setFrom(null); setTo(null) }
  }

  // A reversed pair has no rows by construction, but would print "between
  // 22/09/2026 and 18/09/2026" in the empty sentence, which reads as a bug rather
  // than as the reader's own reversed input. Moving one end past the other carries
  // the other end with it, the way a date picker normally behaves, so the pair is
  // never stored reversed.
  function changeFrom(raw: string) {
    if (!raw) { resetDates(); return }
    const next = clampToWindow(raw)
    setFrom(next)
    if (to && next > to) setTo(next)
  }
  function changeTo(raw: string) {
    if (!raw) { resetDates(); return }
    const next = clampToWindow(raw)
    setTo(next)
    if (from && next < from) setFrom(next)
  }

  const who = canSeeTeam ? evaluator : 'You'
  const have = canSeeTeam ? 'has' : 'have'
  const catLabel = CATEGORY_OPTIONS.find(([v]) => v === category)?.[1] || category
  const rangeText = from && to
    ? (from === to ? ` on ${fmtDate(from)}` : ` between ${fmtDate(from)} and ${fmtDate(to)}`)
    : ''
  // On "All" there is no conclusion to name, so the sentence says what the filter
  // really is -- judged at all -- rather than printing the sentinel.
  const markedText = conclusion === ALL_CONCLUSIONS ? 'judged' : `marked ${prettyConclusion(conclusion)}`
  const emptySentence = `${who} ${have} no ${catLabel} games ${markedText}${rangeText}.`

  const showEmpty = !initializing && !loading && rows.length === 0

  return (
    <div className="rp-review-table">
      <div className="rp-review-toolbar">
        <div className="rp-review-filters">
          <label className="rp-review-filter">
            <span>Category</span>
            <select aria-label="Category" value={category} onChange={e => changeCategory(e.target.value)}>
              {CATEGORY_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="rp-review-filter">
            <span>Initial conclusion</span>
            <select aria-label="Initial conclusion" value={conclusion} onChange={e => setConclusion(e.target.value)}>
              <option value={ALL_CONCLUSIONS}>All</option>
              {conclusionOptions.map(c => <option key={c} value={c}>{prettyConclusion(c)}</option>)}
            </select>
          </label>
          <label className="rp-review-filter">
            <span>From</span>
            <input aria-label="From date" type="date" value={from || ''}
              min={windowFrom || undefined} max={to || windowTo || undefined}
              onChange={e => changeFrom(e.target.value)} />
          </label>
          <label className="rp-review-filter">
            <span>To</span>
            <input aria-label="To date" type="date" value={to || ''}
              min={from || windowFrom || undefined} max={windowTo || undefined}
              onChange={e => changeTo(e.target.value)} />
          </label>
        </div>
      </div>

      {showEmpty ? (
        <div className="rp-review-empty">{emptySentence}</div>
      ) : (
        <div className="rp-review-rows" ref={rowsRef}>
          {rows.map(row => {
            const shots = shotsFor(row)
            const judged = fmtDate(row.evaluate_date || row.updated_at)
            const tags = Array.isArray(row.tags) ? row.tags : []
            return (
              <div className="rp-review-row" key={row.id}>
                <div className="rp-review-main">
                  <div className="rp-review-icon">
                    {row.icon_url ? (
                      <img src={thumbUrl(row.icon_url, ICON_PX)} alt="" width={52} height={52}
                        loading="lazy" decoding="async"
                        onError={e => fallbackToOriginal(e, row.icon_url!)} />
                    ) : (
                      <div className="rp-review-icon-fallback" />
                    )}
                  </div>
                  <div className="rp-review-info">
                    <div className="rp-review-title">
                      {row.app_link ? (
                        <a href={row.app_link} target="_blank" rel="noopener">{row.title || 'Untitled'}</a>
                      ) : (row.title || 'Untitled')}
                    </div>
                    <div className="rp-review-pub">{row.publisher_name || 'Unknown developer'}</div>
                    {/* Every fact on these two lines is a badge, and the two dates say
                        which date they are. Two bare dd/mm/yy in one row, one of them
                        the store's and one the team's, is a guess the reader should
                        not have to make. */}
                    <div className="rp-review-meta">
                      <span className="rp-review-badge">{row.os ? row.os.toUpperCase() : '—'}</span>
                      <span className="rp-review-badge">Release: {fmtDate(row.release_date)}</span>
                      {/* Tags only when the game has any -- an empty row of chips would
                          add a line to every row to say nothing. */}
                      {tags.length > 0 && <TrendTagCell tags={tags} maxWidth={260} />}
                    </div>
                    <div className="rp-review-verdict">
                      <span className={`pill ${conclusionTone(row.initial_conclusion)}`}>
                        {prettyConclusion(row.initial_conclusion)}</span>
                      <span className="rp-review-badge">Evaluated: {judged}</span>
                      <span className="rp-review-badge">{row.initial_evaluator || evaluator}</span>
                    </div>
                  </div>
                </div>
                {shots.length > 0 && (
                  <div className="rp-review-shots">
                    {/* An <img> with an onClick and nothing else is a mouse-only
                        control: no role, no tab stop, no key handler. role/tabIndex/
                        onKeyDown make the same zoom reachable from the keyboard. */}
                    {shots.map((url, i) => (
                      // `alt=""` with the name on aria-label, deliberately. An <img>
                      // that has not arrived yet renders its alt text, so alt here
                      // filled every strip with "Screenshot 1 Screenshot 2 ..." beside
                      // a broken-image glyph while the images were still in flight --
                      // a loading table that reads as a broken one. Empty alt leaves
                      // the grey placeholder box (globals.css) showing instead, and
                      // aria-label keeps the name for the button this <img> really is.
                      <img key={i} src={thumbUrl(url, SHOT_PX)} alt=""
                        aria-label={`Screenshot ${i + 1}`}
                        className="rp-review-shot"
                        // A page of 20 rows is ~160 StoreKit images. Eager, that is
                        // megabytes before the first row is readable; lazy, the
                        // browser fetches the strips the reader reaches.
                        loading="lazy" decoding="async"
                        onError={e => fallbackToOriginal(e, url)}
                        role="button" tabIndex={0}
                        // The LIGHTBOX gets the originals, never the thumbnails: the
                        // whole point of the zoom is to look closely.
                        onClick={() => openShot(url, shots)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            openShot(url, shots)
                          }
                        }} />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          <div ref={sentinelRef} style={{ height: 1 }} />
          {/* First page: say so rather than showing a screen-tall empty box. */}
          {loading && rows.length === 0 && <div className="rp-review-loading">Loading...</div>}
          {loadingMore && <div className="rp-review-loading">Loading more...</div>}
        </div>
      )}

      <Lightbox url={lightboxUrl} images={lightboxImages} onClose={() => setLightboxUrl(null)} />
    </div>
  )
}
