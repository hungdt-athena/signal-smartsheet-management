// The numbers the search box and the search query have to agree on.
//
// Kept apart from lib/evaluations-filters because that module imports the database
// client, and the client component that owns the search box cannot.

// The trigram size. A one- or two-character pattern produces no trigram, so no GIN
// index can serve it and Postgres falls back to scanning: measured against the
// production database (2026-09-08, 625k games), '%me%' costs 673ms where '%mer%' costs
// 209ms. Below this floor the client filters the rows it already has instead.
export const SEARCH_MIN_CHARS = 3

/** How long the box waits after the last keystroke. Long enough that typing a word
 *  costs one request, short enough to feel like it answered you. */
export const SEARCH_DEBOUNCE_MS = 350

/** Cap on the search total. An exact all-time count(*) costs ~1.1s wall on this
 *  database where the list itself costs ~380ms; the header only needs "500+". */
export const SEARCH_TOTAL_CAP = 500

/** Rows per search page. Relevance ordering puts what you asked for at the top, so a
 *  search does not need the 200-row pages the month view uses. */
export const SEARCH_PAGE_SIZE = 50

/** One run of a label: `hit` marks the part the search matched. */
export interface Segment { text: string; hit: boolean }

/** Split a label around every occurrence of the search term, for highlighting.
 *
 *  Case-insensitive and literal, to agree with the ILIKE '%term%' the server matched
 *  on. Literal is the reason this walks the string with indexOf instead of building a
 *  RegExp: a term is raw user input, so '(' would throw and '.' would match anything. */
export function splitOnMatch(text: string, term: string): Segment[] {
  if (!text) return []
  if (!term) return [{ text, hit: false }]

  const haystack = text.toLowerCase()
  const needle = term.toLowerCase()
  const out: Segment[] = []
  let at = 0
  for (;;) {
    const found = haystack.indexOf(needle, at)
    if (found < 0) break
    if (found > at) out.push({ text: text.slice(at, found), hit: false })
    out.push({ text: text.slice(found, found + needle.length), hit: true })
    at = found + needle.length
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false })
  return out.length > 0 ? out : [{ text, hit: false }]
}

// ---- Ordering ----

/** The final conclusions that mean the game got somewhere.
 *
 *  Deliberately NOT `final_conclusion IS NOT NULL`: that also holds for Bypass and
 *  Not Found (31 and 23 puzzle rows on production), so a search would open with games
 *  the team already rejected. Order follows the quality ranking the Report tab uses
 *  (see FINAL_ORDER in components/report/ReportView), minus the outcomes that are a no. */
export const POSITIVE_FINAL_CONCLUSIONS = [
  'Priority IV', 'Insight', 'Watch List', 'Priority V', 'Theme/Art',
] as const

/** Escape POSIX regex metacharacters. A different set from LIKE's: '(' and '.' matter
 *  here and '%' and '_' do not, so escaping the LIKE set would be both wrong ways. */
function escapeRegex(s: string) {
  return s.replace(/[.^$*+?()[\]{}|\\]/g, c => `\\${c}`)
}

/** A pattern matching the term at the start of any word, or null when the term cannot
 *  begin one.
 *
 *  Anchored at the START only. Anchoring both ends drops plurals -- 'Groveland Blocks'
 *  would not count as a match for 'block' -- while a start anchor draws the line people
 *  actually mean: 'Ball Merge' and 'Merge Balls' match, 'Cosmerge' and 'Unblock Me' do
 *  not. Store ids come along for free: '.' is a non-word character, so `\ykinger`
 *  matches com.roar.kinger.slots without any splitting.
 *
 *  A term starting with punctuation gets null: `\y%merge` demands a word character
 *  before the '%', which is not what anyone typing that means. Those terms rank by
 *  containment alone. */
export function wordStartPattern(term: string): string | null {
  // An ASCII word character, or anything outside ASCII -- which for game titles means
  // a letter (Vietnamese, Korean, Japanese all pass). Spelled without \p{...} because
  // the typecheck config targets ES5, where the regex `u` flag is not available.
  if (!/^(?:[A-Za-z0-9_]|[^\x00-\x7F])/.test(term)) return null
  return `\\y${escapeRegex(term)}`
}
