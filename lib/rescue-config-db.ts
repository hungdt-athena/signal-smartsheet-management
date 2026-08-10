// lib/rescue-config-db.ts — server-only persistence for the Rescue config.
// Split from lib/rescue-config.ts because that module is imported by a client
// component; anything touching `sql` must stay out of the browser bundle.

import { sql } from '@/lib/db'
import { parseRescueConfig, RESCUE_CONFIG_KEY, type RescueConfig } from '@/lib/rescue-config'

export async function loadRescueConfig(): Promise<RescueConfig> {
  const rows = await sql`SELECT value FROM app_config WHERE key = ${RESCUE_CONFIG_KEY}`
  return parseRescueConfig(rows[0]?.value as string | undefined)
}

export async function saveRescueConfig(cfg: RescueConfig): Promise<void> {
  await sql`
    INSERT INTO app_config (key, value, updated_at)
    VALUES (${RESCUE_CONFIG_KEY}, ${JSON.stringify(cfg)}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `
}
