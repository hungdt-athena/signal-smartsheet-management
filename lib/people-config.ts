// lib/people-config.ts — who shows up in the evaluator dropdowns.
//
// PURE module: no DB import, same reason as report-config.ts — it is pulled into
// the client bundle by the Config page, so a `lib/db` import here would drag the
// postgres driver into the browser. DB access lives in people-config-db.ts.
//
// Stored as one JSON blob in app_config under key 'people_config' (no migration:
// app_config is an existing key/value table). One knob:
//   hiddenInFilters - lowercased evaluator keys left OUT of every evaluator
//                     dropdown (Evaluate, Short List, Weekly Feedback). Hiding
//                     someone never touches data: their name stays on every game
//                     they evaluated, and a filter already set to that name keeps
//                     working.
//
// The Report flag is deliberately NOT here — it lives in report_config.excluded,
// the array the Report tab's own Config already edits, so the two surfaces cannot
// drift apart. Assign is not here either: the roster is Team Ops' business.

export const PEOPLE_CONFIG_KEY = 'people_config'

export interface PeopleConfig {
  hiddenInFilters: string[]   // lowercased evaluator keys
}

export const DEFAULT_PEOPLE_CONFIG: PeopleConfig = { hiddenInFilters: [] }

/** Tolerant parse: a hand-edited or older blob must never break a dropdown. */
export function parsePeopleConfig(raw: string | null | undefined): PeopleConfig {
  if (!raw) return DEFAULT_PEOPLE_CONFIG
  try {
    const o = JSON.parse(raw) as Partial<PeopleConfig>
    return {
      hiddenInFilters: Array.isArray(o.hiddenInFilters)
        ? Array.from(new Set(o.hiddenInFilters.map(s => String(s).trim().toLowerCase()).filter(Boolean)))
        : [],
    }
  } catch {
    return DEFAULT_PEOPLE_CONFIG
  }
}

/** Drop hidden people from a list of display names. Comparison is on lower(name),
 *  matching how every other evaluator key in this codebase is normalized. */
export function visibleEvaluators(names: string[], hidden: string[]): string[] {
  if (hidden.length === 0) return names
  const set = new Set(hidden)
  return names.filter(n => !set.has(String(n).trim().toLowerCase()))
}
