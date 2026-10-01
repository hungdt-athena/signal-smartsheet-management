# PJ202 – Sample audit (before Functional Spec)

Run: 2026-09-30, read-only SELECTs on the Neon DB shared with Signal Sense (no writes).
Scope: the 4 checks in handoff section 4.2. "Record set" = games in `game_evaluations` with `record_confirmed_at` set (= confirmed recording), bucket = `record_bucket` override, else Insight → 5min, Priority IV → 20min.
Snapshot: 330 games, 13 batches (W4 Jun – W4 Sep 2026): 105 Insight (5'), 225 Top Pick (20').

## 1. Store description (feeds R-DA2 and the AI input)

| Check | Result |
| --- | --- |
| `game_info.metadata->>'description'` exists | 647,872 of 648,171 games (99.95%); 100% of active games |
| Record set with description | 330 / 330 |
| Average length | about 1,100 characters |
| Record set with store screenshots (`metadata.screenshot_urls`) | 283 / 330 (missing: 39 Top Pick, 8 Insight = 14%) |

Conclusion: description is reliable as AI input. Screenshots are missing for 14% of games, so the "no video → description + screenshots" fallback (D42) would run description-only for about 1 game in 7.

## 2. Insight / Top Pick per batch (feeds R-SL3, R-SL4)

| Batch | Insight | Top Pick |
| --- | --- | --- |
| W4 Sep | 13 | 18 |
| W3 Sep | 7 | 21 |
| W2 Sep | 10 | 14 |
| W1 Sep | 8 | 16 |
| W4 Aug | 8 | 13 |
| W3 Aug | 12 | 25 |
| W2 Aug | 11 | 16 |
| W1 Aug | 9 | 22 |
| W4 Jul | 7 | 21 |
| W3 Jul | 8 | 14 |
| W2 Jul | 3 | 12 |
| W1 Jul | 5 | 12 |
| W4 Jun | 4 | 21 |
| Mean / min / max | 8.1 / 3 / 13 | 17.3 / 12 / 25 |

- Insight has more than 8 games in 5 of 13 batches (max 13), so the extra Insight slide is routine, not an edge case.
- Top Pick has more than 18 in 5 of 13 batches (max 25): the "19–27 → about 75%" step of R-SL4 is used in about 40% of batches. No batch reached 28, so the 28–36 and 36+ steps are safety nets only.
- W1 Apr sample report (10 Insight / 21 Top Picks) is consistent with these ranges.

## 3. Missing data on Record-set games (feeds R-DA3 / R-DA5)

Current DB state, so this is a lower bound of what is missing when a report is built (data is filled in progressively).

| Field | Missing (all 330) | Insight (105) | Top Pick (225) | Last 3 batches (83) |
| --- | --- | --- | --- | --- |
| Icon | 0 | 0 | 0 | 0 |
| Store link | 0 | 0 | 0 | not queried |
| Publisher (via `developer`) | 0 | 0 | 0 | 0 |
| Release date | 10 (3%) | 9 (8.6%) | 1 | 9 (11%) |
| Video link (`game_evaluations.youtube_link`) | 13 (3.9%) | 5 | 8 | 8 (W2 Sep 5, W4 Sep 3) |

Notes on video:
- `game_evaluations.youtube_link` is the only well-filled video source (317 / 330). `record_5min_drive` and `record_20min_drive` are empty for the whole Record set, so they are not usable. `drive_link` has 270.
- `ytb_uploads` (sync sheet mirror) matches a game by exact title for only about 80% (last 3 batches: 64 / 83), and matching in the app is fuzzy by title. Prefer `youtube_link` and use `ytb_uploads` (it has a 5 / 20 minute `duration` field) as a cross-check.
- Open point: `youtube_link` does not say whether it is the 5' or the 20' video. Verify against `ytb_uploads.duration` before the Functional Spec fixes which link feeds "Video 5'" and "Video 20'".

Conclusion: manual fill-in will be rare. Release date (mostly Insight, about 1 in 12) and video link (about 1 in 25) are the fields to pre-flag; icon, publisher and store link can be treated as always present.

## 4. Game-alike pairs (feeds B5: offline review vs a site screen)

| Source | Result |
| --- | --- |
| `game_evaluations.game_alike` | 823 games have at least one alike game; 842 distinct (game → alike game) pairs |
| `weekly_feedback.game_alike` | 241 rows, but only 1 row holds titles (2 mentions): this source is almost empty |
| `game_evaluations.final_note` / `initial_note` | 126 / 74,201 non-empty (free text, would need AI extraction) |
| Game refs in past reports (Slides) | not counted yet: needs the Slides API (see export test) |

Conclusion so far: about 850 pairs in the DB, likely 1,000–1,500 once past reports are added. That is the "hundreds to about a thousand" range, so an offline one-time review in a sheet is enough and no site screen is needed (consistent with R-LB2: no manual review step at all).

## Open items after this audit
- Count game refs in past reports (needs Slides API access).
- Confirm what `youtube_link` holds (5' vs 20').
- Re-run the completeness check on a fresh batch at report-build time to get real (not current-state) missing rates.
