// lib/report-config.ts - admin-tunable settings for the Performance report.
//
// PURE module: no DB import. It is pulled into the client bundle by ReportView, so
// adding a `lib/db` import here drags the postgres driver into the browser and the
// whole page 500s on `Can't resolve 'net'`. DB access lives in report-config-db.ts.
//
// Stored as one JSON blob in app_config under key 'report_config' (no migration:
// app_config is an existing key/value table). Two knobs:
//   excluded  - roster names left OUT of every stat and chart. The roster
//               (evaluator_roster, list_type='initial') still decides who EXISTS;
//               this only hides people who should not be measured this cycle.
//   weights   - relative weight of each all-rounder axis. Stored as raw numbers and
//               normalized at use time, so "40/15/15/15/15" and "8/3/3/3/3" behave
//               identically and the UI never has to force a sum of 100.
// credibility - when on, the non-Volume axes are scaled by
//               min(1, games ÷ median team games) so a small sample cannot outrank
//               sustained output. Off = raw weighted average.

export const REPORT_CONFIG_KEY = 'report_config'
export const ALL_ROUNDER_AXES = ['Volume', 'Consistency', 'Signal', 'Survival', 'Recording'] as const
export type AxisName = (typeof ALL_ROUNDER_AXES)[number]

export interface ReportConfig {
  excluded: string[]                     // lowercased evaluator keys
  weights: Record<AxisName, number>
  credibility: boolean
}

export const DEFAULT_REPORT_CONFIG: ReportConfig = {
  excluded: [],
  weights: { Volume: 40, Consistency: 15, Signal: 15, Survival: 15, Recording: 15 },
  credibility: true,
}

// Tolerant parse: a hand-edited or older blob must never break the report, so every
// field falls back to its default rather than throwing.
export function parseReportConfig(raw: string | null | undefined): ReportConfig {
  if (!raw) return DEFAULT_REPORT_CONFIG
  try {
    const o = JSON.parse(raw) as Partial<ReportConfig>
    const weights = { ...DEFAULT_REPORT_CONFIG.weights }
    for (const a of ALL_ROUNDER_AXES) {
      const v = Number(o.weights?.[a])
      if (Number.isFinite(v) && v >= 0) weights[a] = v
    }
    // all-zero weights would divide by zero downstream
    if (ALL_ROUNDER_AXES.every((a) => weights[a] === 0)) Object.assign(weights, DEFAULT_REPORT_CONFIG.weights)
    return {
      excluded: Array.isArray(o.excluded) ? o.excluded.map((s) => String(s).trim().toLowerCase()).filter(Boolean) : [],
      weights,
      credibility: o.credibility !== false,
    }
  } catch {
    return DEFAULT_REPORT_CONFIG
  }
}

// Weighted all-rounder score from normalized (0-100) axis values.
export function allRounderScore(
  axes: Record<string, number>,
  weights: Record<AxisName, number>,
  credibility: number,
): number {
  const total = ALL_ROUNDER_AXES.reduce((s, a) => s + (weights[a] || 0), 0) || 1
  // Volume is the evidence itself, so it is never discounted; the rest are.
  return ALL_ROUNDER_AXES.reduce((s, a) => {
    const w = (weights[a] || 0) / total
    const v = axes[a] || 0
    return s + w * v * (a === 'Volume' ? 1 : credibility)
  }, 0)
}
