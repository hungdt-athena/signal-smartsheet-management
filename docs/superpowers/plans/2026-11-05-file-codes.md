# File Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each game a demo code and a record code that people use as the Drive file name, so n8n matches the video to the game by code, renames the file to the right name, and carries on.

**Architecture:** Two nullable unique columns on `game_info` (`demo_code`, `record_code`) filled by an idempotent helper. The demo code is filled when Initial conclusion becomes `List_Idea`, the record code when a record bucket is Confirmed. The app shows the code with a Copy chip. Two n8n workflows (demo folder, record folder) look the code up, rename the Drive file, and continue the existing flow. Work happens on a new branch cut from `origin/main` (the current worktree branch is behind main: it lacks migration 051 and the per-bucket confirm).

**Tech Stack:** Next.js 14 App Router, TypeScript, `postgres` (`sql` from `@/lib/db`), Jest + Testing Library, n8n cloud (JSON patched by a Python script), Google Drive API.

**Spec:** `docs/superpowers/specs/2026-11-05-file-codes-design.md`

## Global Constraints

- Code: 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, CSPRNG, matched case-insensitively.
- Two separate codes per game, stored on `game_info` (`demo_code`, `record_code`), each with its own partial unique index. Codes never change once set.
- File name counts as a code only if the whole name (extension and a browser ` (1)` suffix stripped) is 6 characters of that alphabet.
- n8n never overwrites an existing `drive_link` (`COALESCE(drive_link,'')=''`). Existing link: leave the file as is, `flow_log` status `link_exists`, notify Chat.
- Record: recorder and bucket come from the DB when the file is processed. A game with a live YouTube upload for that bucket is not uploaded again; the file waits and Chat is told.
- `flow_log` statuses: `code_not_found`, `wrong_folder`, `link_exists`. Google Chat space `spaces/AAQAYTKWM1I`. Credentials: Postgres `KBZC0RGIJsc8d7GK`, Google Sheets `UMl5XCc7aOcf9yi3`.
- Timezone `Asia/Ho_Chi_Minh`. UI copy plain and direct (no humanizer).
- Migrations are not applied by the plan. The next free number is 052 (051 is `record_per_bucket` on main): check `git ls-tree origin/main migrations/` first.
- `app/api/evaluations/route.ts` contains a NUL byte: read it with `grep -a`, diff with `git diff --text`.
- Verify builds with `NEXT_DIST_DIR=.next-check`, then `git checkout tsconfig.json`. 16 jest tests already fail on origin/main without `.env.local`; compare against that baseline, do not fix them.

## Review Focus

1. A real game title that is 6 letters from the alphabet (e.g. `Racket.mp4`) looks like a code. If the lookup misses, the demo workflow falls back to title matching instead of reporting an error. Test in Task 1 (classification) and Task 6 (fallthrough).
2. Two requests generate a code for the same game at once. Exactly one code wins and both callers get that same code. Test in Task 2.
3. A game with no `game_info` row (or a NULL `game_id`). The helper returns `null`, nothing throws, the UI shows no chip. Test in Task 2 and Task 5.
4. File names people really produce: `k7m2qx.MP4`, `K7M2QX (1).mp4`, `K7M2QX .mp4` (trailing space), `K7M2QX.mp4.mp4`, `K7M2QX_20mins.mp4`. Only the first three are codes. Test in Task 1.
5. Clipboard blocked (non-HTTPS or permission denied). The chip still shows the code as selectable text and the click does not throw. Test in Task 5.

---

### Task 1: Code generator and file-name parser

**Files:**
- Create: `lib/short-code.ts`
- Test: `__tests__/lib/short-code.test.ts`

**Interfaces:**
- Produces: `CODE_ALPHABET: string`, `generateCode(): string`, `isCode(s: string): boolean`, `codeFromFileName(fileName: string): string | null` (returns the upper-cased code or `null`).

- [ ] **Step 1: Write the failing tests.** `generateCode` returns 6 chars, every char in `CODE_ALPHABET`, none of `0O1IL`; 1,000 calls give no malformed value. `codeFromFileName`: `'K7M2QX.mp4'`→`'K7M2QX'`, `'k7m2qx.MP4'`→`'K7M2QX'`, `'K7M2QX (1).mp4'`→`'K7M2QX'`, `'K7M2QX .mp4'`→`'K7M2QX'`, `'K7M2QX.mp4.mp4'`→`null`, `'K7M2QX_20mins.mp4'`→`null`, `'K7M2Q.mp4'`→`null`, `'K7M2QXA.mp4'`→`null`, `'K7M2O1.mp4'`→`null` (contains excluded chars), `'Racket.mp4'`→`'RACKET'` (this one is a code by form; Task 6 handles the miss).
- [ ] **Step 2: Run** `npx jest __tests__/lib/short-code.test.ts` — expected FAIL (module not found).
- [ ] **Step 3: Implement** the four exports in `lib/short-code.ts`. Use `crypto.randomInt` per character. Strip one extension, then one ` (n)` suffix, then trim, before testing the pattern.
- [ ] **Step 4: Run** the same command — expected PASS.
- [ ] **Step 5: Commit** `feat(codes): short code generator and file-name parser`.

### Task 2: Migration and idempotent code helpers

**Files:**
- Create: `migrations/052_game_file_codes.sql`, `lib/file-codes.ts`
- Test: `__tests__/lib/file-codes.test.ts`

**Interfaces:**
- Consumes: `generateCode()` from Task 1.
- Produces: `ensureDemoCode(gameId: string): Promise<string | null>` and `ensureRecordCode(gameId: string): Promise<string | null>`. Both return the existing code when set, otherwise set and return a new one; `null` when `game_info` has no row for `gameId`. Retry up to 5 times on unique violation (`23505`), then throw.

- [ ] **Step 1: Write the migration:** `ALTER TABLE game_info ADD COLUMN IF NOT EXISTS demo_code text, ADD COLUMN IF NOT EXISTS record_code text;` plus `CREATE UNIQUE INDEX IF NOT EXISTS game_info_demo_code_uq ON game_info (demo_code) WHERE demo_code IS NOT NULL;` and the same for `record_code`. Before writing, confirm `game_info` is keyed by `game_id` (look at an existing migration or `lib/db` query).
- [ ] **Step 2: Write the failing tests** following the mocking pattern of `__tests__/api/confirm-records-log.test.ts`: (a) existing code is returned without an UPDATE; (b) a missing row returns `null`; (c) a first attempt that throws code `23505` retries with a new code and returns it; (d) two concurrent calls for the same game both resolve to the same code (the second sees the code the first wrote because the UPDATE is `WHERE code IS NULL` and the helper re-reads on 0 rows updated); (e) 5 consecutive `23505` throw.
- [ ] **Step 3: Run** `npx jest __tests__/lib/file-codes.test.ts` — expected FAIL.
- [ ] **Step 4: Implement** both helpers in `lib/file-codes.ts` on one shared internal function parameterised by column name (allow-list the two column names, never interpolate input).
- [ ] **Step 5: Run** the test — expected PASS. **Commit** `feat(codes): migration 052 and ensureDemoCode/ensureRecordCode`.

### Task 3: Generate codes at the two trigger points, plus the lazy endpoint

**Files:**
- Modify: `app/api/evaluations/route.ts` (PATCH, near the big `WITH old AS` statement), `app/api/evaluations/confirm-records/route.ts`
- Create: `app/api/evaluations/demo-code/route.ts`
- Test: `__tests__/api/demo-code-on-list-idea.test.ts`, `__tests__/api/record-code-on-confirm.test.ts`, `__tests__/api/demo-code-route.test.ts`

**Interfaces:**
- Consumes: `ensureDemoCode`, `ensureRecordCode` from Task 2.
- Produces: `POST /api/evaluations/demo-code` body `{ gameId: string }` → `{ code: string | null }`. Requires a session (`requireAuth`), `Cache-Control: no-store`. Also: PATCH response and confirm response unchanged in shape.

Deviation from the spec: the spec says "same transaction". The PATCH is one large CTE statement, so the helper runs as a separate idempotent statement right after it succeeds. A failure there must not fail the save; the lazy endpoint (and the UI fetching it) covers the gap. Mention this in the PR.

- [ ] **Step 1: Write failing tests.** PATCH with `initial_conclusion: 'List_Idea'` calls `ensureDemoCode(game_id)` once; PATCH with another conclusion or without the field does not; a throwing `ensureDemoCode` still returns the normal 200. Confirm of a 5min bucket calls `ensureRecordCode` for each distinct `game_id` confirmed (not for unconfirm/`unset`). `POST /demo-code`: 401 without session, `{code}` for a valid game, `{code: null}` for an unknown one, 400 without `gameId`.
- [ ] **Step 2: Run** the three test files — expected FAIL.
- [ ] **Step 3: Implement.** In PATCH, after the statement returns a row, if `concVal === 'List_Idea'` call `ensureDemoCode(row.game_id)` inside try/catch that logs and swallows. In confirm-records, collect `game_id` of rows confirmed (read from the `upd` CTE result; re-read on `origin/main`, the per-bucket columns `record_5min_confirmed_at`/`record_20min_confirmed_at` changed this route) and call `ensureRecordCode` for each, same swallow rule. Add the POST route.
- [ ] **Step 4: Run** the tests — expected PASS. **Commit** `feat(codes): generate codes on List_Idea and on record confirm`.

### Task 4: Return the codes from the read endpoints

**Files:**
- Modify: `app/api/evaluations/missing-demo/route.ts`, `app/api/evaluations/route.ts` (GET row select, and the by-gameId read the panel uses), `app/api/evaluations/record-games/route.ts`, `lib/record-queue.ts`, `app/api/record/my-queue/route.ts` (only if the shape needs it)
- Test: extend `__tests__/api/record-my-queue.test.ts` and add `__tests__/api/missing-demo-code.test.ts`

**Interfaces:**
- Produces: `demo_code: string | null` on missing-demo items and on the panel's evaluation row; `record_code: string | null` on Record tab rows (record-games / list rows) and on `QueueGame` in my-queue. Always join `game_info` by `game_id`.

- [ ] **Step 1: Write failing tests:** my-queue games include `record_code`; missing-demo items include `demo_code`; a game with no code gives `null`, not `undefined`.
- [ ] **Step 2: Run** them — expected FAIL.
- [ ] **Step 3: Implement** the select changes. Items in missing-demo with a NULL `demo_code` (List_Idea games from before this change) are filled by the lazy endpoint from the UI in Task 5, not by a write inside the GET.
- [ ] **Step 4: Run** the tests — expected PASS. **Commit** `feat(codes): expose demo_code and record_code to the UI`.

### Task 5: `CodeChip` and the four places it appears

**Files:**
- Create: `components/CodeChip.tsx`
- Modify: `components/EvalDetailPanel.tsx` (the "Demo Video (Drive)" field, ~line 1578 on main; the recorder's drive-link block for 5/20 min), `components/MissingDemoPrompt.tsx`, `app/(manager)/youtube/page.tsx` (Record table header ~line 805 and row ~line 818), `components/RecordQueueBadge.tsx` (popover rows)
- Test: `__tests__/components/code-chip.test.tsx`, extend `__tests__/components/record-queue-badge.test.tsx`

**Interfaces:**
- Consumes: `demo_code`, `record_code` from Task 4; `POST /api/evaluations/demo-code` from Task 3.
- Produces: `<CodeChip code={string | null} label?: string />`. Renders nothing when `code` is null. Shows the code in monospace; click copies it and shows "Copied" for 1.5s; if `navigator.clipboard` is missing or rejects, nothing throws and the code stays selectable (`user-select: all`).

Where the code shows (decided in the spec and this plan):
- **Demo code:** (1) under the label of "Demo Video (Drive)" in the evaluation panel, only when the game is List_Idea and has no `drive_link`; (2) on each row of the missing-demo prompt next to the link input. If `demo_code` is null on a List_Idea row, call the demo-code endpoint once on mount of that row and fill it in.
- **Record code:** (3) new "Code" column in the Record tab table, right after Recorder, shown only once the bucket is Confirmed (status `recording`/`recorded`); draft rows leave it empty; (4) each game in the sidebar record-queue popover, which is where a recorder looks first.
- Not shown anywhere else (Short List, Report): YAGNI.

- [ ] **Step 1: Write failing tests.** `CodeChip`: renders nothing for `null`; renders the code; click calls `navigator.clipboard.writeText('K7M2QX')` and shows "Copied"; with `clipboard` undefined, click does not throw and the code text is still in the document; with `writeText` rejecting, same. Queue badge: each popover row shows its `record_code`, and a row without one shows no chip.
- [ ] **Step 2: Run** `npx jest __tests__/components/code-chip.test.tsx __tests__/components/record-queue-badge.test.tsx` — expected FAIL.
- [ ] **Step 3: Implement** `CodeChip` using the project's existing chip/badge classes (no new CSS file unless needed; put any new rule in `app/styles/record.css` or the file the neighbour component uses). Wire it into the four places. In the Record table add the column to the header, to `SkeletonRows` widths, and any `colSpan` of the confirm/remove row so the layout does not shift.
- [ ] **Step 4: Run** the tests — expected PASS. Run `npx tsc --noEmit -p tsconfig.check.json` and a build with `NEXT_DIST_DIR=.next-check`; then open the four places in the dev server (headless harness, see memory `verify-ui-headless-harness`) and screenshot each.
- [ ] **Step 5: Commit** `feat(codes): show demo and record codes with a Copy chip`.

### Task 6: n8n demo workflow reads the code

**Files:**
- Create: `scripts/patch-drive-sync-by-code.py` (follows the repo pattern: Python patches the workflow JSON, no hand edits)
- Modify: `workflows/drive-video-link-sync.json` (generated by the script; `git add -f`)
- Test: `__tests__/workflows/drive-sync-by-code.test.ts` (reads the JSON and runs the Code-node logic with sample file lists)

**Interfaces:**
- Consumes: the same `codeFromFileName` rules as Task 1, re-implemented inside the n8n Code node (n8n cannot import `lib/`). Keep the regex and alphabet identical; the test asserts the node source contains `CODE_ALPHABET` exactly equal to the one in `lib/short-code.ts`.
- Produces: workflow behaviour only.

- [ ] **Step 1: Write failing tests** against the patched JSON: for the file list `['K7M2QX.mp4', 'Racket.mp4', 'Some Game.mp4', 'K7M2QX_20mins.mp4']` the code branch takes `K7M2QX.mp4` and `Racket.mp4`; `Some Game` and the underscore name go to the existing title branch; a code that is not in the DB is re-sent to the title branch (Review Focus 1); a code whose game already has a link is reported `link_exists`, not written; a code found in `record_code` instead of `demo_code` is reported `wrong_folder`.
- [ ] **Step 2: Run** `npx jest __tests__/workflows/drive-sync-by-code.test.ts` — expected FAIL.
- [ ] **Step 3: Write the script.** After `Parse File Names2`, add: a Code node that splits items into code / title; a Postgres node that looks up `demo_code` (and `record_code` for the wrong-folder check) and reads existing links; a Code node building one UPDATE on `game_evaluations WHERE game_id = ... AND COALESCE(drive_link,'')=''` that also sets `drive_date = NOW()`; a Google Drive *Update* node renaming the file to `<title>` (sanitise `/ \ : * ? " < > |`, on a name clash append `_<game_id>`); `flow_log` rows for `code_not_found`, `wrong_folder`, `link_exists`; a Chat message for those three. The existing title path stays untouched.
- [ ] **Step 4: Run** the test — expected PASS. Import the JSON into n8n, turn the old workflow with the same name OFF, drop one file named by a real demo code into the test folder, confirm `drive_link` is set and the file is renamed.
- [ ] **Step 5: Commit** `feat(n8n): drive-video-link-sync matches demo files by code`.

### Task 7: n8n record workflow reads the code

**Files:**
- Create: `workflows/record-upload-by-code.json` (exported from n8n cloud first, then patched), `scripts/patch-record-upload-by-code.py`
- Test: `__tests__/workflows/record-upload-by-code.test.ts`

The existing record workflow (Append Sheet / Upload Youtube) is not in the repo. First step is to export it from `autoai9.app.n8n.cloud` into `workflows/`; if the n8n MCP is not connected, ask the user to export it.

- [ ] **Step 1: Export** the existing workflow JSON into `workflows/` and commit it unchanged (`git add -f`) so the patch diff is readable.
- [ ] **Step 2: Write failing tests:** code resolves to `game_id`, recorder and bucket from the DB for a Confirmed bucket; a game with no Confirmed bucket is held (no rename, no upload, Chat message); a game with a live `youtube_link` for that bucket is held; a demo code in this folder gives `wrong_folder`; the renamed file is `Title_Recorder_Nmins.mp4` in the old format; the sheet row includes `game_id`.
- [ ] **Step 3: Run** the test — expected FAIL.
- [ ] **Step 4: Write the patch script** adding the code lookup before the existing rename/append/upload nodes, the hold branches, and the extra `game_id` column on the sheet append (add the column to the sheet header first and say so in the PR).
- [ ] **Step 5: Run** the test — expected PASS. Import into n8n with the old workflow OFF, test with one Confirmed game in the real record folder.
- [ ] **Step 6: Commit** `feat(n8n): record upload matches files by code`.

### Task 8: Rollout and permission check

**Files:** none (checklist; record results in the PR).

- [ ] **Step 1:** In both Drive folders, confirm the n8n OAuth account has Editor, by renaming a throwaway file with the Drive node. If it fails with 403, stop and have the folder owner grant Editor before importing the workflows.
- [ ] **Step 2:** Apply migration 052 to prod (user runs it; the plan does not apply migrations). Verify: `SELECT count(*) FROM game_info WHERE demo_code IS NOT NULL` returns 0 before the app ships.
- [ ] **Step 3:** Push the branch to `main` after the user approves, Republish Replit, then import both workflows (old ones OFF).
- [ ] **Step 4:** Smoke test: set a game to List_Idea and see its demo code in the panel and the prompt; drop `<CODE>.mp4` in the demo folder and see the link and the rename; Confirm a record bucket and see the code in the Record tab and the queue popover; drop `<CODE>.mp4` in the record folder and see the rename, sheet row, YouTube upload.
- [ ] **Step 5:** Tell the evaluators and recorders the new rule: copy the chip, name the file with it.
