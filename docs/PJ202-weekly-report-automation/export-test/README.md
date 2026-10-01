# PJ202 export feasibility test

Approach under test: copy the Master Template into the Draft folder, duplicate slides as needed, then fill each slide (text, hyperlinks, icons) through the Slides API. Nothing here writes to the Signal database.

## One-time setup (HungDT)
1. In Google Cloud, create a service account for Weekly Report (do not reuse the notification one), enable the Slides API and Drive API, create a JSON key.
2. Keep the key outside the repo, for example `~/.secrets/pj202-sa.json`. The project `.gitignore` only covers keys named like `*.iam.gserviceaccount.json` or `<project>-<12 hex>.json`, so a file such as `secrets/pj202-sa.json` would NOT be ignored.
3. Share with the service account email: the Master Template (Viewer is enough) and the Draft Drive folder (Editor).
4. Prefer a Shared Drive for the Draft folder. Files created by a service account are owned by it, so on a personal My Drive they count against the service account's own storage quota and can fail later with a quota error. Step 1 of the test records the owner and any quota error.

## Run
```
cd <project root>
export SA_KEY=$HOME/.secrets/pj202-sa.json TEMPLATE_ID=1hY8RWjEnjrAmZ7WEJgZLqq-vj9CZYPatNwFXhhtrAWo DRAFT_FOLDER_ID=<folder id>
node docs/PJ202-weekly-report-automation/export-test/feasibility.mjs inspect   # writes template-structure.json (slide, shape ids, text, size)
node docs/PJ202-weekly-report-automation/export-test/feasibility.mjs test      # writes feasibility-report.json, trashes its test copy
```

## What `test` checks
| # | Check | Why |
| --- | --- | --- |
| 1 | Drive copy of the template into the Draft folder | R-EX1; owner and quota behaviour of a service account |
| 2–3 | Read the copy; duplicate the Insight slide twice and move the copies | more than 8 Insight games, one detail slide per Top Pick |
| 4 | Write text into a shape by object id | fallback when a token is missing |
| 5 | `replaceAllText` limited to one slide | the same token names repeat on every duplicated slide |
| 6 | Hyperlink on text | game name to store link, "Gameplay" to the 5' video |
| 7 | `createImage` from an Apple and a Google Play icon URL | icons must come from a URL Slides can fetch |
| 8 | `createImage` with a bad URL | error shape for E27 (delete the partial file, report the error) |
| 9 | 24 duplicated slides in one batch, timed | a full deck is about 3 Insight + 21 detail slides; time and quota headroom |
| 10–11 | Read-after-write, then trash the copy | no leftover test files |

Pass criteria for the spec: 1 to 8 pass, and step 9 completes in one batch well under the per-minute write quota (60 writes per minute per user).

## Tokens to add to a copy of the template ("Weekly Template")
The Master Template only has sample text ("The game name", "Mech"…), so the export needs tokens. Keep the Master Template untouched and make a copy for the export. Same token names repeat on every duplicated slide of a type, and the export replaces them slide by slide (`pageObjectIds`).

| Slide type | Tokens (per slide) | Images |
| --- | --- | --- |
| Cover | `{{period}}`, `{{report_type}}` | none |
| Insight (8 cards) | `{{i1_like}}` `{{i1_name}}` `{{i1_mech}}` `{{i1_genre}}` `{{i1_theme}}` `{{i1_publisher}}` … up to `i8_` | shape named `i1_icon` … `i8_icon` |
| Top Picks list (18 slots) | `{{p1_name}}` … `{{p18_name}}` | `p1_icon` … `p18_icon` |
| Top Pick detail (3 components) | `{{name}}`, `{{release}}`, `{{core_1}}`…`{{core_5}}`, `{{c1_control}}` `{{c1_mech}}` `{{c1_board}}` `{{c1_theme}}` `{{c1_game}}` (same for c2, c3) | none |
| Top Pick detail (2 components / NEW GAMEPLAY) | same subset | none |

Open points to decide with NhiLV before the tokens are fixed: how a game with 1 component section is laid out (the template has 3-, 2-component and NEW GAMEPLAY variants only); how a chip with no value is removed (R-SL3 says only chips with a value are shown, so the export must delete the shape rather than leave an empty box); the Trending slide is Monthly only and is dropped from Weekly.
