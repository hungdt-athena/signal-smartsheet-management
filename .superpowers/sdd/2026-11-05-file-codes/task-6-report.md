# Task 6 report: n8n demo workflow reads the code

Status: DONE_WITH_CONCERNS. Commit `ab949dd feat(n8n): drive-video-link-sync matches demo files by code`.

## What was built
- `scripts/patch-drive-sync-by-code.py` (run with `python3 -I`; deterministic, two runs give the same md5). It reads `workflows/drive-video-link-sync.json` (unchanged) and writes `workflows/drive-video-link-sync-by-code.json` (23 nodes, 9 original + 14 new; committed with `git add -f`).
- `__tests__/workflows/drive-sync-by-code.test.ts` (37 tests).
- New n8n workflow `drive-video-link-sync [by-code]`, id `oA27SA3ikkJ7Wxya`, created INACTIVE (GET back confirms `active: false`, 23 nodes).

## Flow, node by node
`Google Drive Trigger -> Config2 -> List Drive Files2 -> Split Code Files -> Lookup Codes -> Classify Codes`, which fans out (in this order, so the title path always runs first and a code-path failure cannot stop it):
1. `Title Files -> Parse File Names2 -> ...` the existing title path, node parameters byte-identical to the base file (test asserts it). `Title Files` emits an empty placeholder item when there are no title files so `Parse File Names2` still logs its "0 files" row as before.
2. `Write Code Links -> Plan Renames -> Names Taken -> Resolve Names -> Rename Drive File -> Code Result -> Log Code Result`.
3. `Code Notices -> Log Code Notices` (Google Sheet flow_log, config copied from `Log flow_log2`) and `-> Chat Code Notice` (googleChat v1, space `spaces/AAQAYTKWM1I`, credential `HungDT-Minisoos` id `5MOpxh9U04GXBIJp`, copied from the Upload Youtube / daily-eval-noti workflows).

- Split Code Files: re-implements `codeFromFileName` (alphabet constant identical, tested equal to `CODE_ALPHABET`; parity tested on 15 names against the lib function). Builds one lookup query over all codes (LEFT JOIN `game_info` on `demo_code` and on `record_code`; returns `can_write` = some `game_evaluations` row of that game has empty link, `link_is_this_file`).
- Classify Codes: known demo code with empty link -> write; code in neither table -> stays on title path, no status (Review Focus); game already has link -> `link_exists`; only in `record_code` -> `wrong_folder`; second file with same known code in a run -> `link_exists`.
- Write SQL: `UPDATE game_evaluations ge SET drive_link, drive_date = NOW(), updated_at = NOW() FROM v WHERE ge.game_id::text = v.game_id AND COALESCE(ge.drive_link,'')=''` for every evaluation row of the game (cast to text because I could not see the `game_id` column type; migrations do not define it). Returns the updated game ids.
- Plan Renames / Names Taken / Resolve Names: renames only games that were really updated (plus retries). Title is sanitised (`/ \ : * ? " < > |` become a space, spaces collapsed), extension kept. One Drive query checks all planned names in the folder; a taken name, or the same title twice in one run, gets `_<game_id>`. Empty title falls back to game_id.
- Rename Drive File: Drive node v3 `file/update` with `newUpdatedFileName` (parameter name confirmed in n8n source), same credential as the listing, `onError: continueRegularOutput`. `Code Result` logs `code_linked` or `rename_failed`.
- Extra (not in brief): if the DB link already points at this very file (rename failed last run), the rename is retried instead of reporting `link_exists`. This makes the spec's "rename failed after DB write" case self-healing.

## Repo vs live diff
Live `drive-video-link-sync` (M7zaWUQxsjqAJxfG, active) has 4 chains. Chain 3 (`...3`, triggered by `Google Drive Trigger1`) has Parse File Names and Build Update SQL code IDENTICAL to the repo file. Chains 1 and 2 (unsuffixed and `1`, triggered by `Hourly (schedule)` nodes) run OLD logic: Parse File Names uses `driveLink/fileName` names and Build Update SQL is the pre-suggestion version ("drive_link IS NULL" comment, no `drive_link_suggestions`); chain `2` (trigger `Google Drive Trigger`) has the current Build Update SQL but a slightly different Parse File Names (24 lines differ: field naming). Summary nodes in 1/2/3 are older/different; `List Drive Files` (unsuffixed) filters by folder id instead of the query. So the repo file is trustworthy as the current title logic (matches chain 3), but live is NOT uniform: two hourly chains still run the older title logic, and two schedule triggers. Controller should know that switching to the by-code workflow also drops those old chains.

## TDD evidence
- RED: test run before the JSON existed failed with ENOENT on `workflows/drive-video-link-sync-by-code.json` (0 tests run).
- GREEN: after the script, one failing test (my own test bug: the link written comes from the Drive file, not the lookup row); fixed the test; `npx jest __tests__/workflows` -> 2 suites, 46 tests pass (the original 9-test suite for drive-video-link-sync still passes).

## API calls made
GET `/workflows/M7zaWUQxsjqAJxfG`, GET `/workflows?limit=250`, GET of 3 other workflows (Upload Youtube, daily-eval-noti, and a bulk read of all workflows to look for a Drive rename example, none found), POST `/workflows` once (body: name, nodes, connections, settings `{executionOrder: 'v1'}`; succeeded first try), GET back. No PUT/PATCH/DELETE, nothing activated or executed. The key was only read from the two env vars.

## Could NOT be verified without running it
- The lookup/write SQL against the real schema (`game_id` column type, `json_agg(DISTINCT ...)` result parsed as array by the n8n Postgres node).
- Drive rename node behaviour, the `name = '...'` query escaping against the Drive API, and `alwaysOutputData` on `Names Taken` when nothing matches.
- Google Chat message with `JSON.stringify({text})` in `messageJson`.
- n8n fan-out execution order of the three branches from `Classify Codes`.
- Credentials: referenced by id from the live workflow; they must be re-selected if the import UI complains.

## Self-review / concerns
- Spec says an unknown code -> `code_not_found`; per the controller's ruling it falls through to the title path with no status. `code_not_found` is never emitted.
- Both workflows watch the same folder: running them together would double-process. The old one must be switched off when the new one is switched on (controller's job).
- A code-named file is only re-listed for 7 days (`createdTime` filter), so a `link_exists` notice repeats every 10-minute poll for 7 days (same in Chat). Could be noisy; no dedup added.
- `Rename Drive File` failures do not stop the run; they are only visible in the `rename_failed` log row.
- `game_info` lookup is case-sensitive on uppercase codes (codes are stored uppercase, filenames upper-cased in the node).
- Matching the title path's `shared_with` logic can create a suggestion for another same-title game when the renamed file is re-listed next poll (existing behaviour of the title path, unchanged).

## Files
- /Users/anhhung/orca/workspaces/signal-smartsheet-management/file-codes/scripts/patch-drive-sync-by-code.py
- /Users/anhhung/orca/workspaces/signal-smartsheet-management/file-codes/workflows/drive-video-link-sync-by-code.json
- /Users/anhhung/orca/workspaces/signal-smartsheet-management/file-codes/__tests__/workflows/drive-sync-by-code.test.ts

---

# Fix round 1: a failing code lookup must not stop the title path

## Changes (scripts/patch-drive-sync-by-code.py, regenerated workflows/drive-video-link-sync-by-code.json)
- `Lookup Codes`: `onError: continueRegularOutput`. `Classify Codes` ignores items with `error` or no `code`, so an error or empty result means "no code known": every file (including `K7M2QX.mp4`) goes to the title path, nothing is written, no status.
- The comment is corrected: the title path first, then notices, then writes. Fan-out order is now `Title Files, Code Notices, Write Code Links` (notices used to come after the write, so a failing write would have dropped them).
- Same one-line setting on `Write Code Links` (a failed write emits an `error` item; `Plan Renames` then plans nothing).
- Extra hardening: the lookup joins read the new columns through `to_jsonb(d)->>'demo_code'` / `to_jsonb(r)->>'record_code'`, so the query no longer fails when migration 052 is not applied (it finds nothing). Cost: no index use on `game_info`, a scan per run that has a code-shaped file; acceptable at this volume. A test asserts the query never names `d.demo_code` / `r.record_code`.
- Other code-path nodes checked: `Names Taken` (Drive) and `Rename Drive File` run after the title path and after the notices, so their failure cannot stop either; `Rename Drive File` already continues on error. `Names Taken` failing would stop only the rename branch (the link is already written; the next poll retries the rename via `link_is_this_file`). Not changed.

## Tests added (all in __tests__/workflows/drive-sync-by-code.test.ts, describe "a failing code lookup falls back to title matching")
- (a) Lookup Codes and Write Code Links have `onError` continueRegularOutput (read from the generated JSON).
- (b) Classify Codes given an error item / empty result / empty item: all 4 files on the title path (including `K7M2QX.mp4`), no writes/renames/notices, `writeSql` is `SELECT 1 AS none`. Plus an end-to-end case through `Title Files` and `Parse File Names2` (`"title":"K7M2QX"`), and a failed write giving no rename.
- (c) `K7M2Q0.mp4` is not a code (0 outside the alphabet), reaches `Parse File Names2` as title `K7M2Q0`.
- Wiring test updated for the new fan-out order; lookup-SQL test updated for `to_jsonb`.
Note on RED: (a) failed before the fix. (b) and (c) already passed with the old code because `Classify Codes` filtered rows without `code`; they now pin that behaviour, plus the explicit `!r.error`.

## Command and output
`npx jest __tests__/workflows` -> `Test Suites: 2 passed, 2 total; Tests: 53 passed, 53 total`.

## n8n update (PUT on oA27SA3ikkJ7Wxya only)
PUT succeeded for connections and Code-node sources (verified via GET: fan-out order, `!r.error`, `to_jsonb` present), `active` is false. PROBLEM: the n8n server did NOT store the node-level settings (`onError`, `continueOnFail`, `alwaysOutputData`, `notes`, `retryOnFail`) that I sent for the two Postgres nodes, in 5 PUT attempts with new node ids as well. A Code node accepted `onError` on the same PUT, so it looks like the API ignores node-level settings changes on credentialed nodes. So the live copy `oA27SA3ikkJ7Wxya` does NOT have `onError` on `Lookup Codes` / `Write Code Links` (it still has it on `Rename Drive File`, set at creation). The repo JSON has them. Controller: import `workflows/drive-video-link-sync-by-code.json` via the n8n UI (or set "On Error: Continue" on those two nodes by hand) before activating. I made a temporary test PUT that set onError on `Code Notices`; the final PUT removed it (verified none left besides `Rename Drive File`). With the live copy as is, the `to_jsonb` hardening still covers the missing-column case, but not a connection error or a `game_id` type mismatch.
