import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { getYtbUploaded } from '@/lib/ytb-cache'
import { buildYtMap, ytLookup, normalizeName, type Bucket } from '@/lib/ytb-match'

export const dynamic = 'force-dynamic'

// POST /api/evaluations/reconcile-recorders
//
// A game confirmed-assigned to recorder A is often actually recorded by someone
// else (B) who uploads to YouTube directly. The `ytb_uploaded` sheet's `pic`
// column holds who really uploaded. This route reconciles the DB recorder
// (record_5min_assignee / record_20min_assignee) against that `pic`, per bucket.
//
// Body: { mode: 'dry' | 'apply', category?, batch?, ids?: number[] }
//   - mode 'dry'  → report mismatches, write nothing (used for the audit review)
//   - mode 'apply' → write the mapped recorder; if `ids` given, only those rows
//   - no `batch`  → all batches (audit of past batches); a batch → that batch
//                   plus manually-bucketed games (mirrors the Record view)
//
// Only a `pic` that maps (accent/case-insensitively) to a dashboard_users.name
// is applied — an unknown `pic` is reported under `unmatched`, never written.
//
// The same pass also persists the matched upload's YouTube link into
// `game_evaluations.youtube_link` (20min upload preferred over 5min). The link
// shown on the Record card is matched live from the sheet and never stored, so
// downstream consumers joining by game_id (Signal Sense's playtest overlay)
// would otherwise see NULL.

interface Change {
  id: number
  game_id: string
  title: string
  batch: string | null
  bucket: Bucket
  from: string | null   // current DB recorder
  to: string            // canonical dashboard_users.name the pic maps to
  pic: string           // raw sheet value
  uploaded_at: string   // sheet `time` of the earliest upload
}

interface Unmatched {
  id: number
  game_id: string
  title: string
  batch: string | null
  bucket: Bucket
  from: string | null
  pic: string           // sheet value that matched no user
  uploaded_at: string
}

interface LinkChange {
  id: number
  game_id: string
  title: string
  batch: string | null
  bucket: Bucket        // which upload's link is used (20min preferred)
  from: string | null   // current DB youtube_link
  to: string            // https://youtu.be/<id> of the matched upload
  uploaded_at: string | null  // own-bucket record video, VN local; null = none
}

const VN = 'Asia/Ho_Chi_Minh'

// Bare 11-char YouTube id from any stored form (youtu.be/…, watch?v=…, embed,
// shorts, or already-bare id) — used to compare stored links by identity so a
// format difference alone doesn't count as a change.
function extractYtId(link: string): string | null {
  const s = (link || '').trim()
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s
  const m = s.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/)
  return m ? m[1] : null
}

// The sheet `time` is a bare local timestamp ("2026-08-07 15:52:41", hour
// sometimes unpadded) in VN time; normalised to 'YYYY-MM-DD HH:MM:SS' so it
// compares equal to the stored value read back with to_char. Anything that
// doesn't look like one is NULL rather than guessed: a wrong completion date
// would move the row into the wrong Report window.
function vnStamp(raw: string | undefined): string | null {
  const m = (raw || '').trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  return m ? `${m[1]} ${m[2].padStart(2, '0')}:${m[3]}:${m[4] ?? '00'}` : null
}

export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  try {
    const body = await req.json().catch(() => ({}))
    const mode: 'dry' | 'apply' = body.mode === 'apply' ? 'apply' : 'dry'
    const category: string | undefined = body.category || undefined
    const batch: string | undefined = body.batch || undefined
    const idFilter: Set<number> | null = Array.isArray(body.ids)
      ? new Set(body.ids.map((n: unknown) => Number(n)).filter(Number.isFinite))
      : null

    // 1. Uploads → map keyed by title+bucket, keeping the earliest upload's pic.
    const ytRows = await getYtbUploaded()
    const ytMap = buildYtMap(ytRows)

    // 2. Canonical recorder names (normalized → exact DB name).
    const users = await sql`SELECT name FROM dashboard_users WHERE name IS NOT NULL AND name <> ''`
    const nameMap = new Map<string, string>()
    for (const u of users) nameMap.set(normalizeName(u.name), u.name)

    // 3. Candidate rows: Record-view membership, optional category/batch scope.
    //    A batch scope still includes manually-bucketed games regardless of batch
    //    (they may belong to another batch), matching /api/evaluations record view.
    const categoryFilter = category ? sql`AND ge.category_group = ${category}` : sql``
    const batchFilter = batch
      ? sql`AND (ge.batch = ${batch} OR ge.record_bucket IN ('5min','20min'))`
      : sql``
    const rows = await sql`
      SELECT ge.id, ge.game_id, ge.batch, gi.title, ge.record_bucket, ge.final_conclusion,
        ge.record_5min_assignee, ge.record_20min_assignee, ge.youtube_link,
        to_char(ge.youtube_uploaded_at AT TIME ZONE ${VN}, 'YYYY-MM-DD HH24:MI:SS') AS uploaded_local
      FROM game_evaluations ge
      JOIN game_info gi ON ge.game_id = gi.game_id
      WHERE (ge.record_bucket IN ('5min','20min')
             OR (ge.record_bucket IS NULL AND ge.final_conclusion IN ('Insight','Priority IV')))
        ${categoryFilter}
        ${batchFilter}
    `

    const changes: Change[] = []
    const unmatched: Unmatched[] = []
    const linkChanges: LinkChange[] = []

    for (const row of rows) {
      // The bucket the game sits in, same rule as the Record tab.
      const bucket: Bucket = row.record_bucket === '5min' || row.record_bucket === '20min'
        ? row.record_bucket
        : (row.final_conclusion === 'Priority IV' ? '20min' : '5min')
      const own = ytLookup(ytMap, row.title, bucket)

      // Demo link: 20min preferred (the full gameplay record beats the 5-min clip).
      // Matched by title, so Android and iOS share one demo, which is fine.
      // youtube_uploaded_at is NOT the demo's time: it is the game's OWN record
      // video (its bucket), the one the Record tab shows as Recorded, and NULL
      // when that video doesn't exist. Report counts a recording by it, so a
      // same-title game's video on the other OS must not mark this one done.
      const yt20 = ytLookup(ytMap, row.title, '20min')
      const yt5 = ytLookup(ytMap, row.title, '5min')
      const ytLink = yt20 || yt5
      const ownAt = own ? vnStamp(own.time) : null
      if (ytLink?.id && (extractYtId(row.youtube_link || '') !== ytLink.id || (row.uploaded_local ?? null) !== ownAt)) {
        linkChanges.push({
          id: row.id, game_id: row.game_id, title: row.title, batch: row.batch,
          bucket: yt20 ? '20min' : '5min',
          from: row.youtube_link || null,
          to: `https://youtu.be/${ytLink.id}`,
          uploaded_at: ownAt,
        })
      }
      // Recorder: only the bucket the game sits in. Uploads are matched by title
      // alone (the sheet has no OS), so an Android and an iOS row sharing a title
      // would otherwise each take the other's uploader into their empty bucket,
      // and Extract Chat then lists the game under both 5' and 20'.
      {
        const yt = own
        if (!yt) continue                       // no upload in this bucket
        const pic = (yt.pic || '').trim()
        if (!pic) continue                       // upload with no owner recorded
        const current: string | null =
          bucket === '5min' ? row.record_5min_assignee : row.record_20min_assignee
        const canonical = nameMap.get(normalizeName(pic))
        if (!canonical) {
          // pic doesn't map to any user — only worth flagging if it disagrees
          // with whoever is currently assigned (can't safely auto-fix).
          if (normalizeName(current || '') !== normalizeName(pic)) {
            unmatched.push({
              id: row.id, game_id: row.game_id, title: row.title, batch: row.batch,
              bucket, from: current, pic, uploaded_at: yt.time,
            })
          }
          continue
        }
        if (normalizeName(current || '') === normalizeName(canonical)) continue  // already correct
        changes.push({
          id: row.id, game_id: row.game_id, title: row.title, batch: row.batch,
          bucket, from: current, to: canonical, pic, uploaded_at: yt.time,
        })
      }
    }

    if (mode === 'dry') {
      return NextResponse.json({ mode, changes, unmatched, link_changes: linkChanges, applied: 0, links_applied: 0 })
    }

    // 4. Apply — write the mapped recorder for each change (optionally filtered by
    //    ids). Stamp the bucket date if unset; leave record_confirmed_at alone so
    //    the row's recorded status (derived from the upload) is unaffected.
    let applied = 0
    const appliedChanges: Change[] = []
    for (const c of changes) {
      if (idFilter && !idFilter.has(c.id)) continue
      const res = c.bucket === '5min'
        ? await sql`
            UPDATE game_evaluations
            SET record_5min_assignee = ${c.to},
                record_5min_date = COALESCE(record_5min_date, NOW())
            WHERE id = ${c.id}`
        : await sql`
            UPDATE game_evaluations
            SET record_20min_assignee = ${c.to},
                record_20min_date = COALESCE(record_20min_date, NOW())
            WHERE id = ${c.id}`
      applied += res.count
      if (res.count > 0) appliedChanges.push(c)
    }

    let linksApplied = 0
    const appliedLinks: LinkChange[] = []
    for (const lc of linkChanges) {
      if (idFilter && !idFilter.has(lc.id)) continue
      const res = await sql`
        UPDATE game_evaluations
        SET youtube_link = ${lc.to},
            youtube_uploaded_at = ${lc.uploaded_at}::timestamp AT TIME ZONE ${VN}
        WHERE id = ${lc.id}`
      linksApplied += res.count
      if (res.count > 0) appliedLinks.push(lc)
    }

    return NextResponse.json({
      mode, applied, changes: appliedChanges, unmatched,
      links_applied: linksApplied, link_changes: appliedLinks,
    })
  } catch (err) {
    console.error('POST /api/evaluations/reconcile-recorders error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
