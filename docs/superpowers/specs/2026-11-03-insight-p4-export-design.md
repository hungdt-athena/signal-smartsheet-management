# Export Insight / Priority IV games — design

Date: 2026-11-03 · Status: draft for approval

## Why

Report owners build the weekly / monthly report deck and a game list by hand:
they filter Insight and Priority IV games on the Signal Playtest site, then copy
each game's name, icon, release date and YouTube link into a copy of the Master
Template, and the store links into a sheet. The export removes that copying.
The deck is a **starting point**: everything that needs judgement (game-alike,
mechanic, genre, theme, core gameplay, sections) stays as template sample text
for the report owner to edit by hand.

## Goals

- One **Export** button on the site, manager tier only.
- Choose: game type (Insight only / Priority IV only / Both), period (Week or
  Month, then which one), format (Google Slides / Google Sheets / xlsx).
- Slides and Sheets are created by a **service account** in Drive folder
  `1R5nipvRfobP7V_6zM1-GBvNaAmTvGwzY` ("generated", on a Shared Drive); the
  site shows a link to the new file. xlsx downloads straight in the browser.

## Non-goals

- No AI-filled fields (core gameplay, game-alike, tags, sections). That is
  PJ202's full pipeline; this export is the manual-edit version.
- No writing back to the database, no versioning, no confirm/lock flow.
- No cross-store merging: one `game_id` = one row / one card.
- Evaluators never see the button.

## Anti-goals (would be a failure even if it "works")

- Overwriting or editing the Master Template itself.
- Silently exporting the wrong set (e.g. empty predicate → all-time, or batch
  labels from another month).
- Leaving `{{token}}` text or broken empty boxes in the deck.

## Who and where

- Button: **Short List tab** (`ShortListEvalTab` in
  `app/(manager)/evaluations/page.tsx`, the `category=short_list` view) — user
  decision 2026-11-03. Evaluators also open Short List (own-only), so the
  button must be hidden for them, not just blocked.
- Permission: manager tier (`requireManager()` in `lib/auth-guard.ts` on the
  API route; `isManagerRole()` to hide the button). User said "manager/admin
  only"; confirmed 2026-11-03 that this means admin + moderator.

## Dialog

| Step | Options |
|---|---|
| Game type | Insight only · Priority IV only · Both |
| Period | Week · Month |
| Which | Week: batch labels from the `batches` table only (starts at W2 Jul 2026; newest first, default = current batch). Month: months that have such batches (e.g. "Oct 2026"). **Older labels (Jan–Jun 2026) are not offered** — user decision 2026-11-03 |
| Format | Google Slides · Google Sheets · xlsx |

Show the game count for the selection before the user presses Export (e.g.
"8 Insight · 21 Priority IV"). Zero games → Export disabled with "No games in
this period".

## Which games

- Source: `game_evaluations` where `final_conclusion IN ('Insight','Priority IV')`.
- **Week = batch: `ge.batch`, plain.** A game is in the export of whatever
  batch it is labelled with at export time (user decision 2026-11-03). Do not
  use `record_5min_batch` / `record_20min_batch`.
- Only labels present in `batches` are exportable (402 of the 887 rows today;
  the rest are pre-July labels).
- **Month = every batch whose label is in that month** (`W1 Oct…W4 Oct, 2026`).
  Use the label's month, not `batches.starts_on` (W1 Nov starts 2026-10-27).
- Dedupe by `game_id` (cross-genre duplicate rows exist — see
  `game_evaluations_dup_backup_*`). If one game has both conclusions in the
  period, *my call*: keep the latest evaluation.
- Order: by batch, then evaluate time, so a monthly deck reads week by week.
- Joins: `game_info` (title, icon_url, initial_release, os, app_link),
  `developer` via `gi.publisher_id = dev.id` (`developer_name`).

Data coverage on prod (2026-11-03): icon 887/887, release date 872/887,
store link 887/887, YouTube link Insight 244/247, Priority IV 533/640.

## Google Slides

Copy the Master Template `1hY8RWjEnjrAmZ7WEJgZLqq-vj9CZYPatNwFXhhtrAWo` into
the "generated" folder, named e.g. `Oct 2026 W3 Report` / `Oct 2026 Report`.
Sample of the expected output (made by an earlier PJ202 test, "template text
kept"): `1eEo2GLt6MP5wmX5Pg4ASsWL8Ihqh7xDGzZFcd7NLL6c`.

Fill **only**:

| Slide | Filled | Kept as template text |
|---|---|---|
| Cover | month + week (`October 2026` / `W3 Report`; month export: no week line or "Monthly Report") | rest |
| Insight (8 cards / slide, duplicate the slide when > 8, delete unused cards on the last) | game name (hyperlink → store), icon, "X released by Y", "Gameplay" hyperlink → YouTube **5 min** link if any | "- Like", Mech, Genre, Theme |
| Top Picks (Priority IV) | numbered list of names, icons | — |
| Detail, one per Priority IV game (use the **2-section** layout, user decision 2026-11-03 (changed from 3-section the same day)) | game name (hyperlink → store), icon, release date (`YYYY-MM-DD`), video → YouTube **20 min** link if any; no link → keep "Add recording video" | core gameplay lines, sections (Control / Mechanic / Game board / Theme / Game Name) |

- Insight only → drop Top Picks + detail slides. Priority IV only → drop the
  Insight slide. **Trending slide: kept untouched in Month exports, dropped in
  Week exports** (user decision 2026-11-03). Other slides not listed: builder
  checks the template and keeps them as template text unless clearly
  sample-only.
- No release date → leave the template's date text. No icon (should not happen)
  → leave the grey placeholder.
- Prior art the builder should reuse, not re-derive:
  - `…/n8n-anti/athena-n8n-signal-auto/signal-smartsheet-management/docs/PJ202-weekly-report-automation/export-test/`
    (feasibility test: copy, duplicate, hyperlink, `createImage`/`replaceImage`,
    24-slide batch — all passed; `template-structure.json`, token notes).
  - `…/PJ202-weekly-report-automation/pj202-m2/export-test/gen_requests_w3oct_v3_keep_template.py`
    — the script that produced the sample deck above.
  - `…/PJ202-weekly-deck-plugin-design-vi-2026-10-21.md` §5 (rules for N games:
    capacity read from template at run time, reverse-order duplicates, batching).
- Locating shapes: builder's choice between a tokenized copy of the Master
  Template (stored in the same folder) or matching by object id / sample text
  read at run time. Must not hard-code object ids that break when the template
  is edited.
- Top Picks: always one slide, following PJ202 R-SL4 / FS 8.3 + 9.1 (user
  decision 2026-11-03): ≤ 20 games original layout; 21–30 about 75 %; 31–40
  about 60 %; > 40 warn and pack as small as it goes. Nothing silently dropped.

## Google Sheets and xlsx

Same content, two tabs, in this order: **Priority IV**, **Insight**. Columns:

| id | title | publisher | android | ios |
|---|---|---|---|---|
| `game_id` | `game_info.title` | `developer.developer_name` | `app_link` if os = android | `app_link` if os = ios |

One row per game. Links are clickable (hyperlink formula / cell hyperlink).
Header row bold + frozen. With "Insight only" / "Priority IV only", only that
tab. File name like the deck. xlsx is generated server-side and returned as a
download (library: builder's call; `exceljs` is a fine default).

## Service account

- The PJ202 service account (key kept outside the repo, e.g.
  `~/secrets/pj202-sa.json`) is reused. On Replit the key goes in a secret env
  var (e.g. `GOOGLE_SA_KEY_JSON`); never committed.
- Needs Slides, Sheets and Drive API; Viewer on the Master Template, Content
  manager on the "generated" folder. Folder is on a Shared Drive, so the SA's
  own storage quota is not an issue.
- Existing `lib/google-sheets.ts` uses an OAuth refresh token; keep that as is,
  add a separate SA client for the export.
- After creating a file, the SA shares nothing extra: the Shared Drive's members
  already see it.

## Errors

- Any Google API failure mid-build → trash the partial file, show the error.
- Slow: a monthly deck with ~110 games may take tens of seconds; show progress
  ("Building slides…") and keep the request under the Replit timeout (builder
  checks; split into batches of requests as the plugin design does).
- Image URL Slides can't fetch → keep the placeholder, list the game in a
  warning shown with the link ("3 icons could not be loaded").

## Left to the builder

Slide-locating method, xlsx library, file naming detail, Top Picks overflow
layout, API route shape, test strategy (pure `plan → requests` functions tested
without Google, as in the plugin design).

## Calls I made (not yet confirmed by the user)

1. Insight uses the 5-min YouTube link, Priority IV the 20-min link.
2. Game name hyperlinks to the store; Insight cards keep the "X released by Y" line.
3. Duplicate rows: one per `game_id`, latest evaluation wins.
4. Sheet tab order Priority IV then Insight (as the user listed them).

## Build note

The `main-3` worktree is far behind `origin/main` (missing migrations 044–051,
`batches`, `youtube_5min_link`/`youtube_20min_link`). Branch from `origin/main`.
The prior-art v3 script works on a tokenized copy with hard-coded object ids
and does not insert Insight icons — a partial reference only.
