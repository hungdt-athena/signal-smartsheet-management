// lib/people-config-db.ts — server-only persistence for the people config.
// Split from lib/people-config.ts because that module is imported by a client
// component; anything touching `sql` must stay out of the browser bundle.

import { sql } from '@/lib/db'
import { parsePeopleConfig, PEOPLE_CONFIG_KEY, type PeopleConfig } from '@/lib/people-config'
import { SYSTEM_LABEL_KEY_LIST } from '@/lib/system-accounts'

export async function loadPeopleConfig(): Promise<PeopleConfig> {
  try {
    const rows = await sql`SELECT value FROM app_config WHERE key = ${PEOPLE_CONFIG_KEY}`
    return parsePeopleConfig(rows[0]?.value as string | undefined)
  } catch {
    // A dropdown must never 500 because this row is unreachable — show everyone.
    return { hiddenInFilters: [] }
  }
}

export async function savePeopleConfig(cfg: PeopleConfig): Promise<void> {
  await sql`
    INSERT INTO app_config (key, value, updated_at)
    VALUES (${PEOPLE_CONFIG_KEY}, ${JSON.stringify(cfg)}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `
}

/** Names of users an admin has deactivated in Users Management. Deactivating is
 *  the strong form of hiding: no sign-in, gone from Config › People, and gone
 *  from every dropdown — so these keys join the per-person Filter toggle. */
export async function loadInactiveUserKeys(): Promise<string[]> {
  try {
    const rows = await sql<{ key: string }[]>`
      SELECT DISTINCT lower(name) AS key FROM dashboard_users
      WHERE active = false AND name IS NOT NULL AND name <> ''
    `
    return rows.map(r => r.key)
  } catch {
    return []
  }
}

/** Everything the evaluator dropdowns must leave out: the people turned off in
 *  Config › People, every deactivated user, and the system labels — those are
 *  not people, so they are never offered and never configurable. */
export async function loadHiddenEvaluatorKeys(): Promise<string[]> {
  const [cfg, inactive] = await Promise.all([loadPeopleConfig(), loadInactiveUserKeys()])
  return Array.from(new Set([...cfg.hiddenInFilters, ...inactive, ...SYSTEM_LABEL_KEY_LIST]))
}
