// lib/genre-config-db.ts — server-only persistence + availability lookup for the
// genre gate. Split from lib/genre-config.ts because that module is imported by a
// client component; anything touching `sql` must stay out of the browser bundle.

import { sql } from '@/lib/db'
import type { Bucket } from '@/lib/buckets'
import {
  GENRE_CONFIG_KEY,
  parseGenreConfig,
  resolveGenreTargets,
  type GenreConfig,
  type GenreTarget,
} from '@/lib/genre-config'

export async function loadGenreConfig(): Promise<GenreConfig> {
  const rows = await sql`SELECT value FROM app_config WHERE key = ${GENRE_CONFIG_KEY}`
  return parseGenreConfig(rows[0]?.value as string | undefined)
}

export async function saveGenreConfig(cfg: GenreConfig): Promise<void> {
  await sql`
    INSERT INTO app_config (key, value, updated_at)
    VALUES (${GENRE_CONFIG_KEY}, ${JSON.stringify(cfg)}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `
}

/**
 * The single answer to "does this genre run today". Every caller — both cron
 * routes, the n8n target list and the Assign Setup toggles — reads this, so there
 * is no second place where a genre can be decided to be live.
 */
export async function loadGenreTargets(): Promise<GenreTarget[]> {
  const [config, counts] = await Promise.all([
    loadGenreConfig(),
    sql<{ category_group: string; available: string }[]>`
      SELECT category_group, count(*) FILTER (WHERE today_available) AS available
      FROM evaluator_roster
      WHERE list_type = 'initial'
      GROUP BY category_group
    `,
  ])
  const availability: Partial<Record<Bucket, number>> = {}
  for (const row of counts) {
    availability[row.category_group as Bucket] = Number(row.available) || 0
  }
  return resolveGenreTargets(config, availability)
}
