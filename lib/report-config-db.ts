// lib/report-config-db.ts - server-only persistence for the report config.
// Split from lib/report-config.ts because that module is imported by a client
// component; anything touching `sql` must stay out of the browser bundle.

import { sql } from '@/lib/db'
import { parseReportConfig, REPORT_CONFIG_KEY, type ReportConfig } from '@/lib/report-config'

// Returns the config plus the row's updated_at, which callers fold into their cache
// key so a config change invalidates cached report bundles immediately.
export async function loadReportConfig(): Promise<{ config: ReportConfig; updatedAt: string }> {
  const rows = await sql`SELECT value, updated_at FROM app_config WHERE key = ${REPORT_CONFIG_KEY}`
  return {
    config: parseReportConfig(rows[0]?.value as string | undefined),
    updatedAt: rows[0]?.updated_at ? new Date(rows[0].updated_at as string).toISOString() : 'none',
  }
}

export async function saveReportConfig(cfg: ReportConfig): Promise<void> {
  await sql`
    INSERT INTO app_config (key, value, updated_at)
    VALUES (${REPORT_CONFIG_KEY}, ${JSON.stringify(cfg)}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `
}
