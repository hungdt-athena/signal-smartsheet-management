// lib/report-config.ts - admin-tunable settings for the Performance report.
//
// PURE module: no DB import. It is pulled into the client bundle by ReportView, so
// adding a `lib/db` import here drags the postgres driver into the browser and the
// whole page 500s on `Can't resolve 'net'`. DB access lives in report-config-db.ts.
//
// Stored as one JSON blob in app_config under key 'report_config' (no migration:
// app_config is an existing key/value table). Five knobs:
//   excluded  - roster names left OUT of every stat and chart. The roster
//               (evaluator_roster, list_type='initial') still decides who EXISTS;
//               this only hides people who should not be measured this cycle.
//   weights   - relative weight of each all-rounder axis. Stored as raw numbers and
//               normalized at use time, so "40/15/15/15/15" and "8/3/3/3/3" behave
//               identically and the UI never has to force a sum of 100.
// credibility - when on, the non-Volume axes are scaled by
//               min(1, games ÷ median team games) so a small sample cannot outrank
//               sustained output. Off = raw weighted average.
// rules       - the alert thresholds behind every colour and "Do this" line; see
//               ReportRules below.
// palette     - which validated colour preset every chart draws from.

import { DEFAULT_PALETTE, parsePaletteKey, type PaletteKey } from '@/lib/report-palette'

export const REPORT_CONFIG_KEY = 'report_config'
// No Recording axis (removed 2026-09-25): the upload match behind it is best-effort
// and the team tracks recordings itself, so a missed match cost someone score points.
export const ALL_ROUNDER_AXES = ['Volume', 'Consistency', 'Signal', 'Survival'] as const
export type AxisName = (typeof ALL_ROUNDER_AXES)[number]

// Alert rules: the numbers that decide a colour or a "Do this" line on the three
// tabs. One number per rule, even where two tabs use it - two copies of "50 games"
// were two chances to drift apart. Shares are stored as fractions (0.15 = 15%).
// What "stale" means in DAYS is NOT here: it belongs to the Rescue config, which is
// the screen that acts on it, and the Report only reads it.
export interface ReportRules {
  minGames: number       // games before anyone's shortlist rate is judged
  lowRate: number        // "shortlists too little": under this x the rest of the team
  highRate: number       // "shortlists too much": over this x the rest of the team
  growthGap: number      // received beats evaluated by this share -> backlog alert
  staleShare: number     // a person's stale games as a share of their backlog
  staleMin: number       // ... and at least this many of them
  agedShare: number      // team backlog share waiting 8+ days since import
  clearDays: number      // days of work the team backlog may hold
  concentration: number  // one person's share of all games evaluated
  calSpread: number      // points between the strictest and loosest shortlist rate
}

export const DEFAULT_REPORT_RULES: ReportRules = {
  minGames: 50,
  lowRate: 0.5,
  // 5x, not the 2.5x Individual used to hard-code: the Leaderboard's reasoning wins -
  // a high rate is the cheap kind of outlier (a lower bar, a lucky run), so it must be
  // extreme before it is worth a line. Low is the expensive side, hence only 0.5x.
  highRate: 5,
  growthGap: 0.15,
  staleShare: 0.25,
  staleMin: 60,
  agedShare: 0.35,
  clearDays: 5,
  concentration: 0.4,
  calSpread: 0.15,
}

// Inclusive bounds. A value outside them is clamped on save, so a typo cannot switch a
// rule off (0) or make it fire on everyone.
export const REPORT_RULE_BOUNDS: Record<keyof ReportRules, { min: number; max: number }> = {
  minGames: { min: 5, max: 1000 },
  lowRate: { min: 0.05, max: 0.95 },
  highRate: { min: 1.1, max: 20 },
  growthGap: { min: 0.01, max: 1 },
  staleShare: { min: 0.01, max: 1 },
  staleMin: { min: 1, max: 5000 },
  agedShare: { min: 0.01, max: 1 },
  clearDays: { min: 1, max: 60 },
  concentration: { min: 0.1, max: 1 },
  calSpread: { min: 0.01, max: 1 },
}

export function parseReportRules(o: unknown): ReportRules {
  const src = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>
  const out = { ...DEFAULT_REPORT_RULES }
  for (const k of Object.keys(DEFAULT_REPORT_RULES) as Array<keyof ReportRules>) {
    const v = Number(src[k])
    if (src[k] == null || src[k] === '' || !Number.isFinite(v)) continue
    const b = REPORT_RULE_BOUNDS[k]
    out[k] = Math.min(b.max, Math.max(b.min, v))
  }
  return out
}

export interface ReportConfig {
  excluded: string[]                     // lowercased evaluator keys
  weights: Record<AxisName, number>
  credibility: boolean
  rules: ReportRules
  palette: PaletteKey                    // chart colour preset, see lib/report-palette.ts
}

export const DEFAULT_REPORT_CONFIG: ReportConfig = {
  excluded: [],
  weights: { Volume: 40, Consistency: 20, Signal: 20, Survival: 20 },
  credibility: true,
  rules: DEFAULT_REPORT_RULES,
  palette: DEFAULT_PALETTE,
}

// Tolerant parse: a hand-edited or older blob must never break the report, so every
// field falls back to its default rather than throwing.
export function parseReportConfig(raw: string | null | undefined): ReportConfig {
  if (!raw) return DEFAULT_REPORT_CONFIG
  try {
    const o = JSON.parse(raw) as Partial<ReportConfig>
    const weights = { ...DEFAULT_REPORT_CONFIG.weights }
    const saved = (o.weights || {}) as Record<string, unknown>
    // A blob saved with the old five-axis DEFAULTS (40/15/15/15/15) reads as the new
    // defaults. Dropping Recording alone would leave 40/15/15/15, which quietly moves
    // Volume from 40% to 47% of the score. A customised blob keeps its numbers.
    const oldDefaults = saved.Recording != null && [saved.Volume, saved.Consistency, saved.Signal, saved.Survival, saved.Recording]
      .map(Number).join('/') === '40/15/15/15/15'
    if (!oldDefaults) {
      for (const a of ALL_ROUNDER_AXES) {
        const v = Number(saved[a])
        if (saved[a] != null && Number.isFinite(v) && v >= 0) weights[a] = v
      }
    }
    // all-zero weights would divide by zero downstream
    if (ALL_ROUNDER_AXES.every((a) => weights[a] === 0)) Object.assign(weights, DEFAULT_REPORT_CONFIG.weights)
    return {
      excluded: Array.isArray(o.excluded) ? o.excluded.map((s) => String(s).trim().toLowerCase()).filter(Boolean) : [],
      weights,
      credibility: o.credibility !== false,
      rules: parseReportRules(o.rules),
      palette: parsePaletteKey(o.palette),
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
