// lib/push-window-db.ts — server-only persistence for the per-genre push window.
// Split from lib/push-window.ts because that module is imported by the Config
// page; anything touching `sql` must stay out of the browser bundle.
//
// Stored as one JSON blob in app_config under key 'push_window_config' — no
// migration, app_config is an existing key/value table.

import { sql } from '@/lib/db'
import {
  DEFAULT_PUSH_WINDOW_CONFIG, PUSH_WINDOW_KEY, parsePushWindowConfig,
  type PushWindowConfig,
} from '@/lib/push-window'

export async function loadPushWindowConfig(): Promise<PushWindowConfig> {
  try {
    const rows = await sql`SELECT value FROM app_config WHERE key = ${PUSH_WINDOW_KEY}`
    return parsePushWindowConfig(rows[0]?.value as string | undefined)
  } catch {
    // The daily push must never fail because this row is unreachable: fall back
    // to the window every genre used before it was configurable.
    return { ...DEFAULT_PUSH_WINDOW_CONFIG }
  }
}

export async function savePushWindowConfig(cfg: PushWindowConfig): Promise<void> {
  await sql`
    INSERT INTO app_config (key, value, updated_at)
    VALUES (${PUSH_WINDOW_KEY}, ${JSON.stringify(cfg)}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `
}
