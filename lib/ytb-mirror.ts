import { sql } from '@/lib/db'
import { getYtbUploaded } from '@/lib/ytb-cache'
import type { YtbMatchRow } from '@/lib/ytb-match'

// The `ytb_uploaded` sheet, mirrored into Postgres.
//
// Why mirror at all. Opening an evaluation panel needs to know whether a game's
// 5-min / 20-min videos exist. That answer lived only in the sheet, so every
// panel open cost a full Sheets read. Recording happens well AFTER final
// conclusion, so an evaluator reading a slightly stale answer costs nothing —
// which makes this exactly the kind of data that belongs behind a mirror.
//
// The sheet stays the source of truth. Writes (PATCH/POST/DELETE in
// app/api/sheets/ytb-uploaded) still go straight to it; this table is derived,
// never authoritative, and is replaced wholesale on each sync.

/** How old the mirror may get before a read pulls the sheet itself. */
const STALE_MS = 15 * 60_000

export interface YtbMirrorResult {
  rows: number
  synced_at: string
}

let inflightSync: Promise<YtbMirrorResult> | null = null

/**
 * Pull the sheet and replace the mirror.
 *
 * Replace-all rather than upsert: the sheet has no stable key (file_id is blank
 * on hand-added rows) and rows get deleted by position, so diffing would leave
 * orphans. At a few hundred rows the whole table is cheaper than getting that
 * wrong.
 */
export async function mirrorYtbUploads(): Promise<YtbMirrorResult> {
  if (inflightSync) return inflightSync

  inflightSync = (async () => {
    const sheetRows = await getYtbUploaded(true)
    const syncedAt = new Date()

    const rows = sheetRows.map(r => ({
      row_index: r.row_index,
      file_id: r.fileId,
      // Sheet `time` is hand-entered and occasionally unparseable; a bad value
      // must not abort the whole sync, so it lands as NULL.
      uploaded_at: parseSheetTime(r.time),
      status: r.status.slice(0, 30),
      file_name: r.fileName,
      youtube_id: r.youtubeId,
      game_title: r.gameTitle,
      pic: r.pic.slice(0, 100),
      duration: r.duration.slice(0, 20),
      synced_at: syncedAt,
    }))

    await sql.begin(async txRaw => {
      // postgres.js TransactionSql typings omit the call signature; cast for the
      // tagged-template + bulk-insert helpers (both valid at runtime). Same
      // idiom as app/api/admin/backfill-sheets.
      const tx = txRaw as unknown as typeof sql
      await tx`DELETE FROM ytb_uploads`
      if (rows.length) {
        await tx`INSERT INTO ytb_uploads ${tx(
          rows,
          'row_index', 'file_id', 'uploaded_at', 'status', 'file_name',
          'youtube_id', 'game_title', 'pic', 'duration', 'synced_at',
        )}`
      }
    })

    // The cron path syncs without going through readYtbMirror, so drop the memo
    // here rather than there — otherwise a completed sync stays invisible for up
    // to MEMO_MS.
    invalidateMemo()
    return { rows: rows.length, synced_at: syncedAt.toISOString() }
  })().finally(() => { inflightSync = null })

  return inflightSync
}

/** Sheet `time` → Date, or null when it is blank or not a real date. */
function parseSheetTime(raw: string): Date | null {
  const s = (raw || '').trim()
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Mirror rows in the shape lib/ytb-match consumes, re-syncing first if the
 * mirror has gone past STALE_MS.
 *
 * The self-heal matters more than it looks: this table already rotted silently
 * once (see migration 043) because its only writer was a manual admin route.
 * Reading it can no longer depend on someone remembering to wire the cron.
 */
// In-process memo in FRONT of the mirror read.
//
// Measured on a warm dev process: the DB read costs a round trip to us-east-2
// (~300ms) on every panel open, while an in-process hit costs nothing — the
// mirror alone was measurably SLOWER than just caching the sheet. The two are
// complementary rather than alternatives, so use both: the memo removes the
// round trip while a process stays warm, and the mirror keeps the floor at one
// DB read instead of a multi-second Sheets call when it does not (cold start,
// a fresh Cloud Run instance, quota trouble).
//
// Deliberately shorter than STALE_MS: this only decides how fast a completed
// mirror sync becomes visible, never how stale the mirror itself may get.
const MEMO_MS = 60_000

let memo: { rows: YtbMatchRow[]; synced_at: string | null } | null = null
let memoAt = 0

/** Drop the memo. Called after a sync so the new rows are not shadowed by it. */
function invalidateMemo(): void {
  memo = null
  memoAt = 0
}

export async function readYtbMirror(): Promise<{ rows: YtbMatchRow[]; synced_at: string | null; refreshed: boolean }> {
  if (memo && Date.now() - memoAt < MEMO_MS) return { ...memo, refreshed: false }

  const batch = await selectMirror()

  if (batch.syncedAt === null || Date.now() - batch.syncedAt.getTime() > STALE_MS) {
    try {
      await mirrorYtbUploads()
      const fresh = shape(await selectMirror())
      memo = fresh
      memoAt = Date.now()
      return { ...fresh, refreshed: true }
    } catch (e) {
      // Serving a stale mirror beats serving nothing. Only a mirror that is
      // both stale AND empty is useless, and that case falls through to an
      // empty list, which the panel already renders as "no video yet".
      console.error('[ytb-mirror] refresh failed, serving stale:', (e as Error).message)
    }
  }

  memo = shape(batch)
  memoAt = Date.now()
  return { ...memo, refreshed: false }
}

interface MirrorBatch {
  rows: Array<{ game_title: string | null; youtube_id: string | null; duration: string | null; uploaded_at: Date | null; pic: string | null }>
  syncedAt: Date | null
}

/**
 * Rows and mirror freshness in ONE round trip.
 *
 * Freshness rides along as a window function rather than its own
 * `SELECT max(synced_at)` because that second query cost a full round trip to
 * us-east-2 (measured ~320ms) to fetch a single timestamp — as much as fetching
 * every row. Checking staleness after the read rather than before costs nothing:
 * a stale read is discarded and redone, and stale is the rare case.
 */
async function selectMirror(): Promise<MirrorBatch> {
  const rows = await sql<Array<{ game_title: string | null; youtube_id: string | null; duration: string | null; uploaded_at: Date | null; pic: string | null; synced_at: Date | null }>>`
    SELECT game_title, youtube_id, duration, uploaded_at, pic,
           max(synced_at) OVER () AS synced_at
    FROM ytb_uploads
    WHERE game_title IS NOT NULL AND game_title <> ''
    -- Sheet row order is load-bearing, not cosmetic: buildYtMap breaks ties on
    -- equal (or unparseable) upload times by keeping the first row it sees. An
    -- unordered read would let that winner change between identical requests.
    -- NULLS LAST keeps pre-mirror backfill rows, which have no row_index, from
    -- outranking real ones.
    ORDER BY row_index NULLS LAST, id
  `
  return { rows, syncedAt: rows[0]?.synced_at ?? null }
}

function shape(batch: MirrorBatch): { rows: YtbMatchRow[]; synced_at: string | null } {
  return {
    rows: batch.rows.map(r => ({
      gameTitle: r.game_title ?? '',
      youtubeId: r.youtube_id ?? '',
      duration: r.duration ?? '',
      // ytb-match parses this with Date.parse and only needs ordering, so ISO is
      // both sufficient and stable across timezones.
      time: r.uploaded_at ? r.uploaded_at.toISOString() : '',
      pic: r.pic ?? '',
    })),
    synced_at: batch.syncedAt ? batch.syncedAt.toISOString() : null,
  }
}
