# Record tab — sync 5/20-min cards with YouTube

**Date:** 2026-06-26
**Status:** Approved (design)

## Problem

A game's Record 5-min / 20-min video is uploaded straight to YouTube, and that
upload is tracked in the `ytb_uploaded` Google Sheet (surfaced as the "Drive
Videos" table). But the **detail panel** Record cards
(`EvalDetailPanel.tsx:1061-1139`) compute their status purely from
`record_5min_drive` / `record_5min_assignee` — they have no awareness of
YouTube. So a game whose video is already on YouTube still shows **Pending**
with an empty "Drive Link", e.g. *Screw Jaming: Penguin Rescue* (5-min,
`youtu.be/vHbkRPq3jtQ`) and *City Connect Color Puzzle* (20-min,
`youtu.be/3VN7juYCukl`).

The Record **grid** already does the right thing — `recordStatus()` +
`RecordStatusBadge` (`youtube/page.tsx:968-1004`) derive a clickable
`▶ Recorded` badge from a `ytMap`. The detail panel and the progress tracker do
not.

## Conceptual model (confirmed with user)

- **Demo video** = a Google **Drive** link (`drive_link` / "Demo Video (Drive)"
  field). Belongs to the evaluation step. **Unchanged.**
- **Record 5-min / 20-min** = **always YouTube links**, fed live from the
  `ytb_uploaded` sheet. They currently show "Drive Link" only because nobody
  updated them — these cards should be YouTube-link fields.

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Detect/store "recorded" | **UI-only, derived live** from the `ytb_uploaded` sheet. No DB migration, no n8n. |
| 2 | Match granularity | **Title + duration.** A 20-min upload must not mark a 5-min card recorded. |
| 3 | Record card link type | 5/20-min cards are **always YouTube**; show a read-only clickable link, not an editable Drive input. |
| 4 | Legacy `record_*_drive` with no YT match | **Ignore.** Show "Not uploaded yet". Old data stays in the DB but is not shown in these cards. |

## Components

### 1. Shared matching helper — new `lib/ytb-match.ts` (client)

Extract the title-matching logic currently embedded in `youtube/page.tsx` so the
detail panel can reuse it, and make it duration-aware:

- `normalizeTitle(s: string): string` — moved out of `youtube/page.tsx`
  (NFD decompose, strip `̀-ͯ`, lowercase, collapse whitespace). The
  page imports it from here.
- `durationBucket(duration: string): '5min' | '20min'` — parse the leading
  integer from the sheet's `duration` field; `>= 15 → '20min'`, else `'5min'`.
  Tolerates `"5"`, `"5mins"`, `"20"`, `"20mins"`.
- `buildYtMap(rows: YtbRow[]): Map<string, string>` — key is
  `` `${normalizeTitle(gameTitle)}|${durationBucket(duration)}` `` → `youtubeId`.
  Skips rows without a `gameTitle`; prefers rows that have a real `youtubeId`;
  drops keys that never resolve to an id (mirrors current dedup at
  `youtube/page.tsx:1343-1353`).
- `ytLookup(map, title, bucket): string | undefined` — convenience wrapper.
- `useYtbUploads(): Map<string,string>` — React hook that fetches
  `/api/sheets/ytb-uploaded` (`cache: 'no-store'`) once on mount and returns the
  built map (empty map until loaded). Used by the detail panel.

### 2. Record grid refactor — `youtube/page.tsx`

- Import `normalizeTitle`, `durationBucket`, `buildYtMap`, `ytLookup` from
  `lib/ytb-match.ts`; delete the local `normalizeTitle` and inline map-build.
- `recordStatus(item, ytMap)` looks up `` `${normalizeTitle(item.title)}|${effectiveBucket(item)}` ``
  instead of title-only. Behavior is unchanged except it is now duration-correct.
- `RecordStatusBadge` (recorded case) gains a clearer **clickable affordance**:
  pointer cursor + underline on hover, keeping the `▶` glyph. (User point 2.)

### 3. Detail panel Record cards — `EvalDetailPanel.tsx:1061-1139`

The panel calls `useYtbUploads()` and derives, per card:

```
yt5  = ytLookup(map, ev.title, '5min')
yt20 = ytLookup(map, ev.title, '20min')
```

For each card (5-min and 20-min, `yt` = its bucket's match):

- **Field relabel:** "Drive Link" → **"YouTube Link"**.
- **Matched (`yt` present):**
  - Replace the editable Drive `<input>` with a read-only, clickable
    `▶ youtu.be/<id>` link (`href` → `https://www.youtube.com/watch?v=<id>`,
    `target="_blank"`).
  - Card-head badge → clickable **`▶ Recorded`** (success style, same affordance
    as the grid badge).
- **Not matched:**
  - Badge → `Unassigned` (no assignee) / `Recording` (assignee set). The legacy
    `record_*_drive`-based "Done" / "Pending" is removed (decision 4).
  - Link area shows muted **"Not uploaded yet"** — no input.

The assignee selector, "Assigned" date, and `FileNameField` are unchanged.
The bottom "Save Changes" button no longer needs the drive-link fields; assignee
edits still save as before.

### 4. Progress tracker "Video Uploaded" milestone — `ProgressTracker`, line 246

- `ProgressTracker` receives the same `yt5` / `yt20` matches (pass the map in, or
  the two ids as props).
- The "Video Uploaded" step's `completed` switches from
  `recDrives` (`record_*_drive`) to **`!!(yt5 || yt20)`**.
- When completed, the step renders as a **clickable link** to the matched video
  (`yt5 || yt20`), opening YouTube in a new tab.

## Data flow

```
ytb_uploaded sheet ──/api/sheets/ytb-uploaded──> useYtbUploads()
                                                      │ buildYtMap (title|bucket → id)
                                                      ▼
                          ┌──────────────── EvalDetailPanel ────────────────┐
                          │  Record 5-min card  ← ytLookup(title,'5min')     │
                          │  Record 20-min card ← ytLookup(title,'20min')    │
                          │  ProgressTracker "Video Uploaded" ← yt5 || yt20  │
                          └──────────────────────────────────────────────────┘

Record grid (youtube/page.tsx) ── existing ytMap, now duration-aware ──> ▶ Recorded badge
```

## Out of scope / not doing

- No DB migration; `youtube_link`, `record_*_drive` columns untouched in schema.
- No n8n workflow / server-side sync. (Could be a later step if Smartsheet
  consumers need the YouTube link persisted — explicitly deferred.)
- No change to the demo-video Drive field or the evaluation steps.
- No manual YouTube-link override input (uploads flow through the sheet).

## Risks / notes

- The `duration` field in `ytb_uploaded` is hand-entered; `durationBucket`'s
  numeric parse must tolerate `"5"`/`"5mins"`/`"20"`/`"20mins"`. Anything
  unparseable defaults to `'5min'`.
- Title mismatches (sheet `gameTitle` vs DB `title`) will leave a card showing
  "Not uploaded yet" even though a video exists — same failure mode the grid
  already has; `normalizeTitle` mitigates accent/case/whitespace drift.
- The detail panel now does one extra fetch when opened; it is `no-store` and
  small, fired once per mount.

## Testing

- `durationBucket` unit cases: `"5" → 5min`, `"5mins" → 5min`,
  `"20" → 20min`, `"20mins" → 20min`, `"" → 5min`.
- `buildYtMap` keys a 5-min and 20-min upload of the same title to distinct
  entries; prefers rows with a real `youtubeId`.
- Manual: open *Screw Jaming: Penguin Rescue* → 5-min card shows
  `▶ youtu.be/vHbkRPq3jtQ`, badge `▶ Recorded`, "Video Uploaded" milestone
  complete + clickable. *City Connect Color Puzzle* → same via the 20-min card.
- A confirmed-but-not-yet-uploaded game shows `Recording` + "Not uploaded yet".
