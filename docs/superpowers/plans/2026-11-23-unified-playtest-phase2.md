# Unified Playtest Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link the ~5,700 old Android + iOS eval pairs on prod by the rules the user chose, without changing any old per-person number except the group A/B "assigned" drop the user accepted.

**Architecture:** Migration `055` adds a frozen `credit` copy on secondary rows, a snapshot table, a sticky front rule, a `eval_stats_rows` view that every counting route reads, and three SQL functions: `plan` (read-only classification), `apply` (batched, idempotent), `rollback` (per run, column-exact). App code swaps counting routes to the view and teaches History the `pair_merge` event. Nothing runs on prod until the user says go per step.

**Tech Stack:** Postgres 16 (Neon), plpgsql, Next.js 14 route handlers, postgres.js, Jest (DB mocked), SQL checks on a throwaway PG16 cluster (`scripts/verify-eval-pairs.sh`).

**Spec:** `docs/superpowers/specs/2026-11-23-unified-playtest-phase2-design.md` (phase 1: `docs/superpowers/specs/2026-11-21-unified-game-playtest-design.md`, `migrations/054_eval_pairs.sql`).

## Global Constraints

- Local only: app on the sample DB `postgres://127.0.0.1:54330/sample` (SSL proxy :54331). Prod is read-only (SELECT, pg_dump, COPY TO STDOUT) until the user says go for that exact step.
- No push, merge, deploy or prod migration without the user's go. Never `pkill`/`kill` postgres. No bare `git stash`. Commit only on `feat/unified-playtest-phase2`.
- Migration file `migrations/055_eval_pairs_phase2.sql`: hand-applied, idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`), `-- ROLLBACK:` ... `-- END ROLLBACK` block at the top, does not apply phase 2 by itself.
- PG16 binaries: `/usr/local/opt/postgresql@16/bin`.
- Jest baseline on main: 10 suites / 18 tests already fail (9 old suites + `__tests__/workflows/record-upload-by-code.test.ts`); typecheck baseline 3 errors in test files. Compare against this list, never against zero.
- `next build` must pass (`NEXT_DIST_DIR=.next-check NODE_OPTIONS=--max-old-space-size=6144 rtk proxy npx next build`, then delete `.next-check`).
- UI copy English, short, no em dash. Vietnamese in docs is fine.
- Group letters A..G exactly as spec section 4/5. Results: E -> `List_Idea`, F -> `Playtest & Bypass`.

## Review Focus

1. A row someone saves between `plan` and `apply` (group changes under us): apply must reclassify inside its transaction and still follow the rules; test it.
2. A credited secondary row that later becomes front, is unlinked, or is marked Link_dead: counted exactly once, with its credit values; test all three.
3. Per-person per-month numbers (evaluations, conclusions, signal rate, finals, noted, recordings, assigned) before vs after a full run on the sample DB: identical except the assigned drop of the A/B secondary stores; this is the acceptance test.
4. Rollback after someone edited a merged pair: edited columns keep the new value and are reported; untouched columns return exactly.
5. Re-running `apply` on an already processed DB does nothing (no new logs, no new snapshots).

---

### Task 1: Migration 055 schema, sticky front, stats view

**Files:**
- Create: `migrations/055_eval_pairs_phase2.sql`
- Create: `scripts/sql-verify/phase2-schema.sql`
- Modify: `scripts/verify-eval-pairs.sh` (apply 055 after 054, run the new check files)

**Interfaces:**
- Produces: `game_evaluations.credit jsonb` (NULL by default); table `eval_pair_merge_snapshots(id bigserial, run_id text, game_evaluation_id int, family_id text, pair_group text, row_before jsonb, written jsonb, created_at timestamptz default now())`, index on `(run_id)` and `(game_evaluation_id)`; view `eval_stats_rows`; `eval_pair_refresh_back(a,b)` replaced with the sticky rule.
- `eval_stats_rows`: every column of `game_evaluations` by name (explicit list, comment that a new column must be added here), where a row with `credit IS NOT NULL` takes each column from `credit` (`(credit->>'col')::type`), and rows are kept when `NOT pair_back OR eval_store_specific(initial_conclusion) OR credit IS NOT NULL`. Media columns follow the same override, so recordings counted per recorder also keep old numbers.

- [ ] **Step 1:** Write `phase2-schema.sql` checks: column, table, view exist; view row count on a fixture = front rows + store-specific back rows + credited rows; a credited back row shows its credit evaluator/conclusion/date in the view; sticky front: link a pair, mark the front Link_dead (front flips to the live store, as in 054), reopen it (front does NOT flip back to the lower id); a fresh link with both rows non-store-specific still picks the lower id.
- [ ] **Step 2:** Run `bash scripts/verify-eval-pairs.sh`; expect the new checks to fail (055 missing).
- [ ] **Step 3:** Write 055 transaction 1 (columns, table, indexes) and transaction 2 (sticky `eval_pair_refresh_back`, view). Sticky rule: if exactly one of the two rows is store-specific, the other is front; otherwise if exactly one row already has `pair_back = true`, keep it; otherwise `LEAST(a, b)`. ROLLBACK block restores 054's `eval_pair_refresh_back` body verbatim, drops the view, table and column.
- [ ] **Step 4:** Run `bash scripts/verify-eval-pairs.sh`; all old and new checks pass; also apply the ROLLBACK block in the script and compare schema to post-054 (extend the existing schema diff step).
- [ ] **Step 5:** Commit `feat(db): 055 credit column, merge snapshots, sticky front, eval_stats_rows`.

### Task 2: `eval_pair_phase2_plan()` (read-only classification)

**Files:**
- Modify: `migrations/055_eval_pairs_phase2.sql`
- Create: `scripts/sql-verify/phase2-plan-checks.sql`

**Interfaces:**
- Produces: `eval_pair_phase2_plan() RETURNS TABLE(family_id text, grp text, front_id int, back_id int, result_conclusion text, holder text, holder_row int, final_from int, flags text[])`. `STABLE`, no writes. One row per clean family (exactly 2 `game_info` rows, neither `family_unlinked`, each store exactly 1 eval row, not linked yet); group `G` rows are returned with `front_id/back_id` NULL and flag `multi_row` so the preview lists them.
- Rules exactly as spec section 5: release-first default (`COALESCE(initial_release, temp_release)::date`, then `first_assigned_date`, then id); exceptions C live store, E List_Idea store, F P&B store, D downstream rank (final > record assignee 5'/20' > drive_link) only when one side ranks higher. Group A holder: fewer pending games (unjudged, front rows, by `initial_evaluator`) among active users (`dashboard_users.active`, matched by `lower(name)`); both inactive -> earlier `assigned_date`, flag `both_holders_inactive`. Flags also: `two_demo_codes`, `two_record_codes`, `final_conflict`, `media_conflict`, `group_differs`.

- [ ] **Step 1:** Fixtures + checks, one family per case: A (holder by backlog; inactive holder skipped; both inactive), B (judged row source, release-first front), C (Link_dead store front is the live one; unjudged other keeps holder), D Bypass tie (release-first), D List_Idea with final only on the later store (that store is front), E (List_Idea front, result List_Idea), F (P&B front, result P&B), G (multi_row flag), family with 3 game_info rows (absent), unlinked family (absent), already linked pair (absent).
- [ ] **Step 2:** Run the checks; expect failure.
- [ ] **Step 3:** Implement the function in 055.
- [ ] **Step 4:** Checks pass. Also run the plan on the local sample DB (`psql ... -c "SELECT grp, count(*) FROM eval_pair_phase2_plan() GROUP BY 1"`) and record the counts in the task report.
- [ ] **Step 5:** Commit `feat(db): phase 2 plan function`.

### Task 3: `eval_pair_phase2_apply(run_id, max_pairs)`

**Files:**
- Modify: `migrations/055_eval_pairs_phase2.sql`
- Create: `scripts/sql-verify/phase2-apply-checks.sql`

**Interfaces:**
- Consumes: `eval_pair_phase2_plan()`, 054's `eval_pair_copy`, `eval_pair_fill`, `eval_pair_eval_cols()`, `eval_pair_media_cols()`.
- Produces: `eval_pair_phase2_apply(p_run_id text, p_max_pairs int DEFAULT 500) RETURNS TABLE(grp text, linked int, flagged int)`. Per pair, inside one transaction for the batch: `pg_advisory_xact_lock(54, hashtext(family_id))`, lock both rows in id order, re-run the plan for that family (it may have changed), snapshot both rows into `eval_pair_merge_snapshots` with `written` = the columns and values this run sets on that row, then:
  - A: holder/assigned dates/batch/group of the chosen row onto both; link.
  - B: copy the judged row's `eval_pair_eval_cols()` onto the waiting row; link.
  - C: link like 054 (`link_eval_pair` path: media only).
  - D/E/F: set `credit = to_jsonb(back row as it was)` on the back row; front row: set result conclusion (E/F), fill empty media from back; copy front's `eval_pair_eval_cols()` + media onto back; link.
  - Set `pair_eval_id` both ways and `pair_back` per plan (sticky rule keeps it). `updated_at` unchanged on both rows (restore it in the same statement path, or set a local GUC the touch trigger honors; builder's choice, tested).
  - Log one `evaluation_log` row on the back row: kind `pair_merge` when any shared value of that row changed, else `pair_link`; actor `System`, `pair_scope 'store'`, before/after conclusion, final, batch, owner.
  - Idempotent: pairs already linked are skipped by the plan, so a second run returns zero rows.

- [ ] **Step 1:** Checks per group (state after apply for both rows, credit content, snapshot `written`, log row), plus: E credit keeps the Bypass verdict and evaluator; main row's final untouched when both had one; media filled from back when front empty; `updated_at` unchanged; second run links 0; a row edited between plan and apply (simulate by changing a conclusion before calling apply on one family) is processed by its new group.
- [ ] **Step 2:** Run checks; expect failure.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Checks pass, old 054 checks still pass.
- [ ] **Step 5:** Commit `feat(db): phase 2 apply, batched and idempotent`.

### Task 4: `eval_pair_phase2_rollback(run_id)`

**Files:**
- Modify: `migrations/055_eval_pairs_phase2.sql`
- Create: `scripts/sql-verify/phase2-rollback-checks.sql`, `scripts/phase2-rollback.sh`

**Interfaces:**
- Produces: `eval_pair_phase2_rollback(p_run_id text) RETURNS TABLE(game_evaluation_id int, kept_columns text[])`: for each snapshot of the run, unlink the pair (no `pair_unlink` log), clear `credit`, delete that run's `pair_merge`/`pair_link` logs, and for each column in `written` restore `row_before`'s value only where the current value still equals the written one; columns that differ are returned in `kept_columns`.
- `scripts/phase2-rollback.sh RUN_ID`: takes the DB URL from `$DATABASE_URL`, prints the function's result as a table, refuses to run without a run id.

- [ ] **Step 1:** Checks: full rollback returns every row to `row_before` (compare `to_jsonb` minus `updated_at`); an edit after the run keeps the new value and is reported; rollback of an unknown run is a no-op.
- [ ] **Step 2:** Fail. **Step 3:** Implement. **Step 4:** Pass. **Step 5:** Commit `feat(db): phase 2 rollback by run`.

### Task 5: Counting routes read `eval_stats_rows`

**Files:**
- Modify: `lib/eval-pairs.ts` (doc comment: which helper for what), `app/api/report/route.ts`, `app/api/cron/report-rollup/route.ts`, `app/api/report/daily/route.ts`, `app/api/evaluations/quick-stats/route.ts`, `app/api/external/effort-sessions/route.ts`, `app/api/external/effort-game-time/route.ts`, plus any other route the builder finds that counts per person / per date / per conclusion (grep `notPairCopy`, `mediaRowFilter`, `initial_evaluator` with `count(`). Queue routes (assign, assign-setup preview, rescue, pending-holders, config/people, audit-evaluators) stay on `notPairCopy`.
- Test: `__tests__/api/eval-stats-rows.test.ts` (new) + existing route tests updated.

**Interfaces:**
- Consumes: view `eval_stats_rows` (Task 1).
- Each converted query reads `FROM eval_stats_rows ge` and drops its `notPairCopy` / `mediaRowFilter` fragment for that alias (the view already applies the row rule).

- [ ] **Step 1:** Jest: for each converted route, the counting SQL reads `eval_stats_rows` and no longer carries `pair_back` for that alias; queue routes still carry `notPairCopy`.
- [ ] **Step 2:** Fail. **Step 3:** Convert. **Step 4:** Jest + typecheck at baseline.
- [ ] **Step 5:** On the local sample DB, call each converted route before/after the conversion with no phase 2 run yet: same JSON (the view equals the old filter when no row has credit). Record in the report.
- [ ] **Step 6:** Commit `refactor(stats): counting routes read eval_stats_rows`.

### Task 6: History shows `pair_merge`

**Files:**
- Modify: `lib/evaluation-history.ts`, `app/api/evaluations/[gameId]/history/route.ts` (or wherever History is served), `components/EvalHistoryModal.tsx` if the note needs a toggle.
- Test: `__tests__/lib/evaluation-history.test.ts`, history route test.

**Interfaces:**
- `pair_merge` event: verb `merged {Store} into the pair`, note `was {conclusion_before} by {owner}`, changes chips as other events, `stores` = that store only. Old note text read from `eval_pair_merge_snapshots.row_before->>'initial_note'` for that row and run, shown collapsed under the event (one line, `Old note`).

- [ ] **Step 1:** Tests for the verb, note, store mark and old-note field. **Step 2:** Fail. **Step 3:** Implement. **Step 4:** Pass. **Step 5:** Commit `feat(history): pair_merge event with the old note`.

### Task 7: Preview, stats equality check, local full run, runbook

**Files:**
- Create: `scripts/phase2-preview.sql` (read-only: plan joined to titles, holders, stores; `\copy ... TO STDOUT CSV`), `scripts/phase2-stats-snapshot.sql` (per person x month x category: evaluations, each conclusion, finals by type, noted, recordings 5'/20', assigned, from the same SQL the converted routes use or from `eval_stats_rows`), `docs/superpowers/runbooks/2026-11-23-unified-playtest-phase2-rollout.md` (Vietnamese, every prod step marked `[CẦN USER ĐỒNG Ý]`).

- [ ] **Step 1:** On the local sample DB: backup (`pg_dump -Fc` of `game_evaluations`, `evaluation_log`), apply 055, take stats snapshot A, run `apply` in batches until it returns nothing, take snapshot B, diff A vs B. Expected: identical except `assigned` for the A/B secondary stores, and that difference equals those stores exactly. Any other difference is a bug to fix before going on.
- [ ] **Step 2:** Run rollback for every run id, snapshot C, diff A vs C: identical. Re-apply to leave the sample DB in the phase 2 state for UI checks.
- [ ] **Step 3:** UI on the local dev server: a D pair, an E pair (List_Idea, History shows the merged Bypass and old note), a C pair, Report / Quick stats load.
- [ ] **Step 4:** Write the runbook: read-only checks, preview to the review sheet (new tab), backup, apply 055, apply in batches with counts, post checks (invariants of 054 + view row counts + stats snapshot diff on prod), rollback steps.
- [ ] **Step 5:** Commit `docs(runbook): phase 2 rollout` and the scripts.
