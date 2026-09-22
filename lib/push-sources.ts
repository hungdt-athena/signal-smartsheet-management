import { sql } from '@/lib/db'

/* Which importers are allowed to put a game in front of an evaluator.
 
   `game_info.type` is written by whatever found the game - a scraper, the store
   sync, or a person adding one by hand - and this list is the gate on the push
   queue. It is matched with ILIKE because the column has carried suffixed
   variants of the same importer.
 
   It used to live in four hand-kept copies: the dry-run and the insert in
   /api/cron/push-evaluations, /api/admin/push-split, and /api/assign-setup/preview.
   `appranking-scraper` started producing on 2026-09-02 and by 22/09 had 1,935 live
   games with links and categories, 808 of them inside the 30-day release window -
   and not one had ever reached `game_evaluations`, because adding an importer meant
   remembering four places and nobody did. The Report's "New games by source" chart
   was right to leave it out: those games were never pushed. One list, one edit. */
export const PUSH_SOURCE_TYPES = [
  'sync',
  'top-pub-scraper',
  'apkcombo-scraper',
  'appagg-scraper',
  'appranking-scraper',
] as const

const PATTERNS = PUSH_SOURCE_TYPES.map((t) => `%${t}%`)

/** The eligibility predicate, for a query that has `game_info` aliased as `gi`.
 *  A NULL type is admitted: it predates the column, and excluding it would drop
 *  the whole pre-scraper back catalogue the sync brought in. */
export function pushSourceFilter() {
  return sql`(gi.type IS NULL OR gi.type::text ILIKE ANY(${PATTERNS}::text[]))`
}
