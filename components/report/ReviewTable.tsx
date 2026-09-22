'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Lightbox } from '@/components/Lightbox'
import { prettyConclusion } from '@/lib/buckets'

// The Individual tab's bottom block: one evaluator's judged games, one row each,
// with the StoreKit screenshots visible so a wrong call is obvious at a glance --
// closing the gap where a reviewer had to leave the Report and rebuild the same
// filters on the Evaluations screen. It owns its own filter state and ignores the
// window/genre filter at the top of the page (Task 6 says so in the copy above it).

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

// The canonical 17 are the FLOOR: live data can only add to them or reorder them,
// and an empty `live` (a failed fetch, or a genuinely empty answer) must leave that
// floor intact rather than collapsing the dropdown to just the current selection.
// app/(manager)/evaluations/page.tsx's fetchFacets guards the identical case with
// `if (json.available_conclusions?.length) { ... }`, simply not touching state (which
// started as the full canonical list) on an empty/failed response. This does the
// same thing at the merge itself, so it holds regardless of who calls it.
//
// When `live` is non-empty: canonical-first, then any live values the canonical list
// doesn't know about (sorted) -- same ordering /api/evaluations/route.ts computes for
// available_conclusions server-side and that page's fetchFacets mirrors client-side.
// `selected` is folded in either way so the currently-chosen filter value never
// disappears from its own dropdown mid-fetch or if the live list omits it.
function mergeConclusionOptions(live: string[], selected: string): string[] {
  if (live.length === 0) {
    return selected && !CONCLUSION_DEFAULTS.includes(selected)
      ? [...CONCLUSION_DEFAULTS, selected]
      : CONCLUSION_DEFAULTS.slice()
  }
  const merged = Array.from(new Set([...live, selected]))
  return CONCLUSION_DEFAULTS.filter(c => merged.includes(c))
    .concat(merged.filter(c => !CONCLUSION_DEFAULTS.includes(c)).sort())
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
  evaluate_date: string | null
  updated_at: string | null
  screenshot_urls: string[] | null
  manual_screenshot_urls: string[] | null
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

// "The newest 3 days that have any rows", not the last 3 calendar days: a person
// who did not work over the weekend must not open an empty table and read it as
// broken. /api/evaluations has no "distinct days with data" facet, so this costs
// one extra round trip on mount (up to 100 rows, no screenshots, sorted newest
// first) purely to read off which days are present, then the real paginated
// fetch runs against the resolved [from, to] window.
async function fetchNewestDays(
  evaluator: string, category: string, conclusion: string,
): Promise<{ from: string | null; to: string | null }> {
  const params = new URLSearchParams({
    evaluator, category, conclusion, date_basis: 'evaluated',
    sort: 'desc', page: '1', limit: '100', meta: '0',
  })
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
    if (days.length === 0) return { from: null, to: null }
    // Rows arrive newest-first, so the first distinct day found is the newest and
    // the last one collected (up to 3) is the oldest of that set.
    return { from: days[days.length - 1], to: days[0] }
  } catch {
    return { from: null, to: null }
  }
}

export function ReviewTable({ evaluator, canSeeTeam }: { evaluator: string; canSeeTeam: boolean }): JSX.Element {
  const [category, setCategory] = useState('puzzle')
  const [conclusion, setConclusion] = useState('List_Idea')
  // Full canonical list until the live facets response narrows it -- same as
  // app/(manager)/evaluations/page.tsx's own availableConclusions state, so the
  // dropdown never flashes down to just the one selected value on first paint.
  const [conclusionOptions, setConclusionOptions] = useState<string[]>(() => CONCLUSION_DEFAULTS.slice())
  const [from, setFrom] = useState<string | null>(null)
  const [to, setTo] = useState<string | null>(null)
  const [initializing, setInitializing] = useState(true)
  const [rows, setRows] = useState<ReviewRow[]>([])
  // Starts true: the very first paint is always waiting on the newest-days probe
  // (and then page 1), so there is no in-between frame where "no rows yet" would
  // be mistaken for "no rows ever" and flash the empty sentence.
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const [lightboxImages, setLightboxImages] = useState<string[]>([])

  const pageRef = useRef(1)
  const fetchSeqRef = useRef(0)
  const sentinelRef = useRef<HTMLDivElement>(null)
  // Read inside the conclusion-options effect below without making `conclusion`
  // one of its dependencies -- that fetch only needs to re-run when evaluator or
  // category changes, not on every selection the person makes in that same dropdown.
  const conclusionRef = useRef(conclusion)
  useEffect(() => { conclusionRef.current = conclusion }, [conclusion])

  // Resolve the newest-3-days default whenever the person being viewed changes
  // (also covers first mount). Resets the other two filters to their defaults too,
  // so switching person always re-targets to a clean, known state.
  useEffect(() => {
    let cancelled = false
    setInitializing(true)
    setCategory('puzzle')
    setConclusion('List_Idea')
    void (async () => {
      const { from: f, to: t } = await fetchNewestDays(evaluator, 'puzzle', 'List_Idea')
      if (cancelled) return
      setFrom(f)
      setTo(t)
      setInitializing(false)
    })()
    return () => { cancelled = true }
  }, [evaluator])

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
      evaluator, category, conclusion, date_basis: 'evaluated',
      page: String(page), limit: String(PAGE_SIZE), with_screenshots: '1',
      sort: 'desc', meta: '0',
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
      if (seq === fetchSeqRef.current && !append) { setRows([]); setHasMore(false) }
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
  // triple guard.
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

  function openShot(url: string, images: string[]) {
    setLightboxImages(images)
    setLightboxUrl(url)
  }

  const who = canSeeTeam ? evaluator : 'You'
  const have = canSeeTeam ? 'has' : 'have'
  const catLabel = CATEGORY_OPTIONS.find(([v]) => v === category)?.[1] || category
  const rangeText = from && to
    ? (from === to ? ` on ${fmtDate(from)}` : ` between ${fmtDate(from)} and ${fmtDate(to)}`)
    : ''
  const emptySentence = `${who} ${have} no ${catLabel} games marked ${prettyConclusion(conclusion)}${rangeText}.`

  const showEmpty = !initializing && !loading && rows.length === 0

  return (
    <div className={`rp-review-table${expanded ? ' rp-review-table-expanded' : ''}`}>
      <div className="rp-review-toolbar">
        <div className="rp-review-filters">
          <label className="rp-review-filter">
            <span>Category</span>
            <select aria-label="Category" value={category} onChange={e => setCategory(e.target.value)}>
              {CATEGORY_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="rp-review-filter">
            <span>Initial conclusion</span>
            <select aria-label="Initial conclusion" value={conclusion} onChange={e => setConclusion(e.target.value)}>
              {conclusionOptions.map(c => <option key={c} value={c}>{prettyConclusion(c)}</option>)}
            </select>
          </label>
          <label className="rp-review-filter">
            <span>From</span>
            <input aria-label="From date" type="date" value={from || ''}
              onChange={e => setFrom(e.target.value || null)} />
          </label>
          <label className="rp-review-filter">
            <span>To</span>
            <input aria-label="To date" type="date" value={to || ''}
              onChange={e => setTo(e.target.value || null)} />
          </label>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setExpanded(v => !v)}>
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>

      {showEmpty ? (
        <div className="rp-review-empty">{emptySentence}</div>
      ) : (
        <div className="rp-review-rows">
          {rows.map(row => {
            const shots = shotsFor(row)
            const judged = fmtDate(row.evaluate_date || row.updated_at)
            return (
              <div className="rp-review-row" key={row.id}>
                <div className="rp-review-icon">
                  {row.icon_url ? (
                    <img src={row.icon_url} alt="" width={40} height={40} />
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
                  <div className="rp-review-meta">
                    <span>{row.publisher_name || 'Unknown developer'}</span>
                    <span>{row.os ? row.os.toUpperCase() : '—'}</span>
                    <span>{fmtDate(row.release_date)}</span>
                  </div>
                </div>
                <div className="rp-review-conclusion">
                  <span className="pill tag">{prettyConclusion(row.initial_conclusion)}</span>
                  <span className="rp-review-judged">Judged {judged}</span>
                </div>
                {shots.length > 0 && (
                  <div className="rp-review-shots">
                    {shots.map((url, i) => (
                      <img key={i} src={url} alt={`Screenshot ${i + 1}`}
                        className="rp-review-shot"
                        onClick={() => openShot(url, shots)} />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          <div ref={sentinelRef} style={{ height: 1 }} />
          {loadingMore && <div className="rp-review-loading">Loading more...</div>}
        </div>
      )}

      <Lightbox url={lightboxUrl} images={lightboxImages} onClose={() => setLightboxUrl(null)} />
    </div>
  )
}
