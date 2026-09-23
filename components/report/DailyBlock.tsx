'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { BUCKETS } from '@/lib/buckets'

// The Leaderboard's daily block: one day at a time, with a strip of the days in the
// period so the reader can jump between them.
//
// It is NOT the Leaderboard at a shorter window, and the two must not become each
// other. The tab around it asks where people differ and answers in rates and ranks;
// one day is far too noisy to support that. This asks whether the day's work
// happened and answers in counts. Nothing here is a rate, a rank or a score.
//
// Everything it shows obeys the filter bar above: the period picks which days are on
// the strip, and the Category filter picks which buckets are in the table. A block
// that showed three genres under a page set to Puzzle would be a contradiction on one
// screen, which is the thing this whole Report was redesigned to stop.

const BUCKET_LABEL: Record<string, string> = {
  puzzle: 'Puzzle', arcade: 'Arcade', simulation: 'Simulation',
}
const bucketOrder = (b: string) => {
  const i = (BUCKETS as readonly string[]).indexOf(b)
  return i === -1 ? BUCKETS.length : i
}

// Above this many days the strip stops showing the quiet days. Up to a month, a
// greyed-out button is worth having -- "nobody worked Sunday" is exactly the sort of
// thing a daily check is for. Over a month (a quarter, a year) the same rule would
// print hundreds of buttons to say it, so only the days with work are listed.
const FULL_STRIP_DAYS = 31

interface DailyRow {
  name: string; total: number; idea: number; pbp: number; bypass: number
  other: number; tagRows: number; tagged: number
}
interface DailyBucket {
  bucket: string; evaluators: number; total: number
  linkDead: number; staleRelease: number; rows: DailyRow[]
}
interface DailyDay { date: string; total: number; buckets: DailyBucket[] }
interface IndexEntry { date: string; total: number }

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const parts = (iso: string) => iso.split('-').map(Number)
// Built from the parts rather than a locale format: these are VN calendar days
// already resolved server-side, and re-parsing them in the browser's own timezone is
// how a day label slides by one.
function dayLabel(iso: string): string {
  const [y, m, d] = parts(iso)
  if (!y || !m || !d) return iso
  return `${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MON[m - 1]} ${y}`
}
function shortLabel(iso: string): string {
  const [, m, d] = parts(iso)
  return m && d ? `${d}/${m}` : iso
}
function eachDay(from: string, to: string): string[] {
  const out: string[] = []
  const [fy, fm, fd] = parts(from)
  const [ty, tm, td] = parts(to)
  if (!fy || !ty) return out
  const cur = new Date(Date.UTC(fy, fm - 1, fd))
  const end = new Date(Date.UTC(ty, tm - 1, td))
  // A guard, not a limit: a reversed or absurd pair must not spin here.
  for (let i = 0; cur <= end && i < 800; i++) {
    out.push(cur.toISOString().slice(0, 10))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return out
}
const int = (n: number) => Math.round(n).toLocaleString('en-US')

// "11/6" reads as eleven tags spread over six games; one number alone cannot say
// whether a person tagged many games or one game many times.
function tagCell(row: { tagRows: number; tagged: number }): string {
  if (row.tagRows === 0 && row.tagged === 0) return '—'
  return `${int(row.tagRows)}/${int(row.tagged)}`
}
function sum(rows: DailyRow[], pick: (r: DailyRow) => number): number {
  return rows.reduce((s, r) => s + pick(r), 0)
}

function BucketTable({ b }: { b: DailyBucket }): JSX.Element {
  // Other exists only when something landed outside the three the team talks about,
  // so a row adds up instead of quietly not adding up.
  const showOther = b.rows.some((r) => r.other > 0)
  const showTags = b.rows.some((r) => r.tagRows > 0 || r.tagged > 0)
  return (
    <div className="rp-daily-bucket">
      <div className="rp-daily-bucket-head">
        <span className="rp-daily-bucket-name">{BUCKET_LABEL[b.bucket] || b.bucket}</span>
        <span className="rp-daily-bucket-sub">
          {int(b.evaluators)} {b.evaluators === 1 ? 'evaluator' : 'evaluators'} · {int(b.total)} evaluated
        </span>
      </div>
      <table className="rp-daily-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col" className="num">Total</th>
            <th scope="col" className="num">Idea</th>
            <th scope="col" className="num">P&amp;BP</th>
            <th scope="col" className="num">Bypass</th>
            {showOther && <th scope="col" className="num">Other</th>}
            {showTags && <th scope="col" className="num">Tags/Games</th>}
          </tr>
        </thead>
        <tbody>
          {b.rows.map((r) => (
            <tr key={r.name}>
              <th scope="row">{r.name}</th>
              <td className="num strong">{int(r.total)}</td>
              <td className="num">{int(r.idea)}</td>
              <td className="num">{int(r.pbp)}</td>
              <td className="num">{int(r.bypass)}</td>
              {showOther && <td className="num">{int(r.other)}</td>}
              {showTags && <td className="num">{tagCell(r)}</td>}
            </tr>
          ))}
          <tr className="rp-daily-total">
            <th scope="row">Total</th>
            <td className="num strong">{int(b.total)}</td>
            <td className="num">{int(sum(b.rows, (r) => r.idea))}</td>
            <td className="num">{int(sum(b.rows, (r) => r.pbp))}</td>
            <td className="num">{int(sum(b.rows, (r) => r.bypass))}</td>
            {showOther && <td className="num">{int(sum(b.rows, (r) => r.other))}</td>}
            {showTags && (
              <td className="num">
                {int(sum(b.rows, (r) => r.tagRows))}/{int(sum(b.rows, (r) => r.tagged))}
              </td>
            )}
          </tr>
        </tbody>
      </table>
      {/* The chat card says "counted in Total"; here it is the opposite, and saying so
          is the point. A dead link and an aged-out build are housekeeping, not calls,
          and every other number in this Report leaves them out - so they print beside
          the total rather than inside it. */}
      {(b.linkDead > 0 || b.staleRelease > 0) && (
        <p className="rp-daily-foot">
          {[
            b.linkDead > 0 ? `${int(b.linkDead)} link dead` : '',
            b.staleRelease > 0 ? `${int(b.staleRelease)} stale release` : '',
          ].filter(Boolean).join(' · ')} — handled, not counted in Total
        </p>
      )}
    </div>
  )
}

export function DailyBlock({ windowFrom, windowTo, category }: {
  // The page's resolved period, INCLUSIVE at both ends. Null on a window with no
  // bounds (All batches), where the route falls back to a recent span and tells us
  // which one it used.
  windowFrom?: string | null
  windowTo?: string | null
  category: string
}): JSX.Element {
  const [index, setIndex] = useState<IndexEntry[]>([])
  const [day, setDay] = useState<DailyDay | null>(null)
  const [range, setRange] = useState<{ from: string; to: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [switching, setSwitching] = useState(false)
  const [failed, setFailed] = useState(false)
  const seqRef = useRef(0)

  const load = useCallback(async (pickDay: string) => {
    const seq = ++seqRef.current
    if (pickDay) setSwitching(true); else { setLoading(true); setFailed(false) }
    const params = new URLSearchParams({ category })
    if (windowFrom) params.set('from', windowFrom)
    if (windowTo) params.set('to', windowTo)
    // Switching day does not move the strip, so the day list is not asked for again.
    if (pickDay) { params.set('day', pickDay); params.set('index', '0') }
    try {
      const res = await fetch(`/api/report/daily?${params}`)
      const json = await res.json()
      if (seq !== seqRef.current) return // a newer request owns the state
      setDay(json.day || null)
      if (!pickDay) {
        setIndex(json.index || [])
        setRange(json.from && json.to ? { from: json.from, to: json.to } : null)
      }
    } catch {
      if (seq !== seqRef.current) return
      if (!pickDay) { setIndex([]); setDay(null); setRange(null); setFailed(true) }
    }
    if (seq === seqRef.current) { setLoading(false); setSwitching(false) }
  }, [windowFrom, windowTo, category])

  // Re-reads whenever the filter bar moves, so this block and the charts under it are
  // always describing the same stretch of calendar and the same buckets.
  useEffect(() => { load('') }, [load])

  const selected = day?.date || ''
  // Next/previous walk the days that HAVE work, not the calendar, so neither button
  // ever lands the reader on an empty day they then have to click past.
  const worked = index.map((e) => e.date)
  const at = worked.indexOf(selected)
  const older = at >= 0 && at < worked.length - 1 ? worked[at + 1] : '' // index is newest-first
  const newer = at > 0 ? worked[at - 1] : ''

  const totalByDay = new Map(index.map((e) => [e.date, e.total]))
  const span = range ? eachDay(range.from, range.to) : []
  const strip = span.length > 0 && span.length <= FULL_STRIP_DAYS ? span : worked.slice().reverse()

  if (loading) return <div className="card"><div className="rp-daily-note">Loading...</div></div>
  if (failed) {
    return <div className="card"><div className="rp-daily-note">Could not load the daily tables. Try again in a moment.</div></div>
  }
  if (!day) {
    return (
      <div className="card">
        <div className="rp-daily-note">No evaluation work landed on any day in this period.</div>
      </div>
    )
  }

  return (
    <div className="card rp-daily">
      <div className="rp-daily-head">
        <div className="rp-daily-when">
          <span className="rp-daily-date">{dayLabel(day.date)}</span>
          <span className="rp-daily-count">{int(day.total)} evaluated</span>
        </div>
        <div className="rp-daily-nav">
          <button type="button" className="btn btn-sm" disabled={!older || switching}
            onClick={() => load(older)} aria-label="Previous day with work">← Previous</button>
          <button type="button" className="btn btn-sm" disabled={!newer || switching}
            onClick={() => load(newer)} aria-label="Next day with work">Next →</button>
        </div>
      </div>

      {strip.length > 1 && (
        <div className="rp-daily-strip" role="group" aria-label="Days in this period">
          {strip.map((dte) => {
            const n = totalByDay.get(dte)
            const quiet = n === undefined
            return (
              <button type="button" key={dte}
                className={'rp-daily-chip'
                  + (dte === selected ? ' on' : '')
                  + (quiet ? ' quiet' : '')}
                disabled={quiet || switching}
                title={quiet ? `${dayLabel(dte)} — no work` : `${dayLabel(dte)} — ${int(n!)} evaluated`}
                aria-current={dte === selected ? 'true' : undefined}
                onClick={() => load(dte)}>
                {shortLabel(dte)}
              </button>
            )
          })}
        </div>
      )}

      {day.buckets.length === 0
        ? <div className="rp-daily-note">Nothing was evaluated on this day.</div>
        : day.buckets.slice().sort((a, b) => bucketOrder(a.bucket) - bucketOrder(b.bucket))
            .map((b) => <BucketTable key={b.bucket} b={b} />)}
    </div>
  )
}


// ---- the Individual tab's breakdown -----------------------------------------
// The same table turned on its side: one row per DAY for one person, over the whole
// period, instead of one row per person for one day. Same columns, same counting rule,
// same endpoint - a second query would be how this person's row here and their row in
// the Leaderboard's block start disagreeing.
//
// No day chips: every day is already a row, so a picker would only scroll the page.

interface PersonDay {
  date: string; total: number; idea: number; pbp: number; bypass: number
  other: number; linkDead: number; staleRelease: number; tagRows: number; tagged: number
}

export function DayBreakdown({ evaluator, windowFrom, windowTo, category }: {
  evaluator: string
  windowFrom?: string | null
  windowTo?: string | null
  category: string
}): JSX.Element {
  const [rows, setRows] = useState<PersonDay[]>([])
  const [range, setRange] = useState<{ from: string; to: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const seqRef = useRef(0)

  useEffect(() => {
    const seq = ++seqRef.current
    setLoading(true)
    setFailed(false)
    void (async () => {
      const params = new URLSearchParams({ by: 'day', evaluator, category })
      if (windowFrom) params.set('from', windowFrom)
      if (windowTo) params.set('to', windowTo)
      try {
        const res = await fetch(`/api/report/daily?${params}`)
        const json = await res.json()
        if (seq !== seqRef.current) return
        setRows(json.byDay || [])
        setRange(json.from && json.to ? { from: json.from, to: json.to } : null)
      } catch {
        if (seq !== seqRef.current) return
        setRows([])
        setRange(null)
        setFailed(true)
      }
      if (seq === seqRef.current) setLoading(false)
    })()
  }, [evaluator, windowFrom, windowTo, category])

  if (loading) return <div className="card"><div className="rp-daily-note">Loading...</div></div>
  if (failed) {
    return <div className="card"><div className="rp-daily-note">Could not load the day breakdown. Try again in a moment.</div></div>
  }
  if (rows.length === 0) {
    return <div className="card"><div className="rp-daily-note">No evaluation work on any day in this period.</div></div>
  }

  const byDate = new Map(rows.map((r) => [r.date, r]))
  const span = range ? eachDay(range.from, range.to) : []
  // Same rule as the strip on the Leaderboard, and the same reason: up to a month, a
  // zero row is worth printing, because "which days did they not work" is half of what
  // this table is for. Past a month it would be hundreds of rows to say it, so only
  // the days with work are listed and the quiet ones are counted underneath.
  const full = span.length > 0 && span.length <= FULL_STRIP_DAYS
  const listed = full ? span.slice().reverse() : rows.map((r) => r.date)
  const quiet = full ? 0 : span.length > 0 ? span.length - rows.length : 0

  const pick = (d: string) => byDate.get(d)
  const showOther = rows.some((r) => r.other > 0)
  const showTags = rows.some((r) => r.tagRows > 0 || r.tagged > 0)
  const add = (f: (r: PersonDay) => number) => rows.reduce((a, r) => a + f(r), 0)
  const linkDead = add((r) => r.linkDead)
  const staleRelease = add((r) => r.staleRelease)

  return (
    <div className="card rp-daily">
      <table className="rp-daily-table">
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col" className="num">Total</th>
            <th scope="col" className="num">Idea</th>
            <th scope="col" className="num">P&amp;BP</th>
            <th scope="col" className="num">Bypass</th>
            {showOther && <th scope="col" className="num">Other</th>}
            {showTags && <th scope="col" className="num">Tags/Games</th>}
          </tr>
        </thead>
        <tbody>
          {listed.map((d) => {
            const r = pick(d)
            // A day they did not work is a row of zeroes, dimmed - not a gap in the
            // table that the reader has to notice is missing.
            return (
              <tr key={d} className={r ? undefined : 'rp-daily-quiet-row'}>
                <th scope="row">{dayLabel(d)}</th>
                <td className="num strong">{int(r?.total ?? 0)}</td>
                <td className="num">{int(r?.idea ?? 0)}</td>
                <td className="num">{int(r?.pbp ?? 0)}</td>
                <td className="num">{int(r?.bypass ?? 0)}</td>
                {showOther && <td className="num">{int(r?.other ?? 0)}</td>}
                {showTags && <td className="num">{r ? tagCell(r) : '—'}</td>}
              </tr>
            )
          })}
          <tr className="rp-daily-total">
            <th scope="row">Total</th>
            <td className="num strong">{int(add((r) => r.total))}</td>
            <td className="num">{int(add((r) => r.idea))}</td>
            <td className="num">{int(add((r) => r.pbp))}</td>
            <td className="num">{int(add((r) => r.bypass))}</td>
            {showOther && <td className="num">{int(add((r) => r.other))}</td>}
            {showTags && (
              <td className="num">{int(add((r) => r.tagRows))}/{int(add((r) => r.tagged))}</td>
            )}
          </tr>
        </tbody>
      </table>
      {(linkDead > 0 || staleRelease > 0) && (
        <p className="rp-daily-foot">
          {[
            linkDead > 0 ? `${int(linkDead)} link dead` : '',
            staleRelease > 0 ? `${int(staleRelease)} stale release` : '',
          ].filter(Boolean).join(' · ')} — handled, not counted in Total
        </p>
      )}
      {quiet > 0 && (
        <p className="rp-daily-quiet-note">
          {int(quiet)} other {quiet === 1 ? 'day' : 'days'} in this period had no evaluation work.
        </p>
      )}
    </div>
  )
}
