import { sql } from '@/lib/db'

/** Dropdown fields whose option lists are editable from the Config tab. */
export const CONFIG_FIELDS = ['conclusion', 'final_conclusion'] as const
export type ConfigField = (typeof CONFIG_FIELDS)[number]

export function isConfigField(v: unknown): v is ConfigField {
  return typeof v === 'string' && (CONFIG_FIELDS as readonly string[]).includes(v)
}

/** Human-readable labels used in the Config UI. */
export const CONFIG_FIELD_LABELS: Record<ConfigField, string> = {
  conclusion: 'Initial Conclusion',
  final_conclusion: 'Final Conclusion',
}

/** Fallback option lists. Used when the config_options table is empty or
 *  unreachable (e.g. before migration 014 runs), and kept in sync with the
 *  migration seed so behavior is identical to the old hardcoded arrays. */
export const CONFIG_DEFAULTS: Record<ConfigField, string[]> = {
  conclusion: [
    'Bypass', 'Conclusion', 'Good', 'Link_dead', 'M_ByPass', 'Need deeper testing', 'Skip',
    'Wait for PlayTest', 'Priority IV: Idea', 'Priority III: Watchlist for next phase',
    'Check Market Data', 'Watchlist for next milestone', 'Priority II', 'Priority I',
    'Need Direction', 'List_Idea', 'Playtest & Bypass',
  ],
  final_conclusion: [
    'Priority V', 'Priority IV', 'Bypass', 'Theme/Art', 'Insight', 'Watch List', 'Not Found',
  ],
}

/** Active option values for a field, ordered. Falls back to CONFIG_DEFAULTS if
 *  the table has no rows for the field or the query fails. */
export async function getConfigValues(field: ConfigField): Promise<string[]> {
  try {
    const rows = await sql<{ value: string }[]>`
      SELECT value FROM config_options
      WHERE field = ${field} AND active = true
      ORDER BY sort_order ASC, id ASC
    `
    if (rows.length) return rows.map(r => r.value)
  } catch {
    /* table may not exist yet — fall through to defaults */
  }
  return CONFIG_DEFAULTS[field]
}
