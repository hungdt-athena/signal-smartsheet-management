# SDD ledger — plan: docs/superpowers/plans/2026-11-05-file-codes.md
Worktree: /Users/anhhung/orca/workspaces/signal-smartsheet-management/file-codes (branch feat/file-codes from origin/main, docs commit 36fbd82)
Spec: docs/superpowers/specs/2026-11-05-file-codes-design.md (approved by user 2026-11-05)

## Pre-flight scan
| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1 -> T2 | generateCode() | consistent |
| T2 -> T3 | ensureDemoCode/ensureRecordCode(gameId) | consistent |
| T3 and T4 both edit app/api/evaluations/route.ts | T3 = PATCH after-write hook, T4 = GET select | different regions, no clash; T4 must not touch PATCH |
| T3 -> T5 | POST /api/evaluations/demo-code | consistent |
| T4 -> T5 | demo_code / record_code fields | consistent; T5 test file record-queue-badge.test.tsx exists on main |
| T1 -> T6 | alphabet duplicated in n8n node | test asserts equality; OK |
| T2 -> T6,T7 | game_info.demo_code/record_code | consistent |
| T6 vs T7 | independent workflows | OK |
| T1 own text | spec regex [A-Za-z2-9] vs plan alphabet | plan stricter (excludes 0 O 1 I L); fine |
| T6 own text | plan says patch workflows/drive-video-link-sync.json | LIVE cloud workflow M7zaWUQxsjqAJxfG has 4 duplicated chains, repo file has 1 -> see Ruling 1 |
| T7 own text | "existing record workflow" unidentified | candidates on cloud: Nho8gCiPzOqZsGZS "Upload Game Testing Video on Youtube" (active), gFnZgEix9Phn3m37 "Upload Youtube" (active, sheet PENDING rows) -> see Ruling 3 |

## Rulings
Ruling 1: Task 6 builds from the repo workflows/drive-video-link-sync.json (single chain) plus the code branch, and creates it as a NEW INACTIVE workflow via the n8n API; it diffs the node code against the live chains to prove title-matching behaviour is unchanged. — live copy has 4 duplicated chains from repeated imports, patching it in place is risky — cost if wrong: repo JSON drifted from live logic; mitigated by the diff.
Ruling 2: n8n API access: key lives in /Users/anhhung/Desktop/athena-pickleball/.env (N8N_URL, N8N_API_KEY), user told me to use it. Subagents source it in the shell, never print or commit it. Allowed: GET anything; POST a NEW workflow created inactive. Forbidden: PUT/PATCH/DELETE existing workflows, activate/deactivate anything. — production n8n is shared — cost if wrong: none, nothing live changes.
Ruling 3: Task 7 implementer identifies the record intake workflow itself from the two candidates above (read-only), and records which one in its report; the patched copy is created as a NEW INACTIVE workflow too.
Ruling 4: Task 8 steps 2-4 (apply prod migration, push to main, Republish, activate/deactivate n8n workflows) are stop-and-ask items for the user, not executed by subagents.

## Progress
Task 1: minor (deferred): isCode is case-sensitive (doc comment), no direct isCode negative tests, no no-extension tests
Task 1: complete (commits 36fbd82..7cea5de, review clean)
Task 2: minor (deferred): no test that non-23505 errors are not retried; COLUMNS.includes check is dead code given type
Task 2: caveat for Task 8: game_info.game_id uniqueness not provable from repo; before applying migration 052 run SELECT game_id,count(*) FROM game_info GROUP BY 1 HAVING count(*)>1
Task 2: complete (commits 7cea5de..8efc271, review clean)
Task 3: minor (deferred): confirm-records reads result[0]?.game_ids outside the try/catch (theoretical TypeError after commit); no test for helper throw -> 500 in demo-code route; no PATCH test with missing game_id
Task 3: complete (commits 8efc271..69631fa, review clean)
Task 4: minor (deferred): list/by-gameId code tests only match SQL text; demo_code? optional in missing-demo Row type
Task 4: complete (commits 69631fa..66a7bef, review clean)
Task 5: minor (deferred): needsDemoCode reads live driveLink input not stored ev.drive_link (chip hides while typing; also fetches when List_Idea picked in dropdown); no tests for EvalDetailPanel wiring / Record table Code column; no screenshots; next build cannot run in this worktree (exceljs missing from symlinked node_modules, unrelated) -> run build in a real checkout before push; record_code optional (?:) vs contract
Task 5: complete (commits 66a7bef..7d91ec1, review clean)
Task 6: review found 1 Important (Lookup Codes failure kills the title path) -> fix round 1/5 dispatched
Task 6: minor (deferred): link_exists/wrong_folder notice repeats on every later upload event for 7 days (needs static-data dedupe in Code Notices); report overstated it as every 10-min poll (trigger is fileCreated); ge.game_id::text cast defeats index; no test for Lookup Codes failing or K7M2Q0 end to end; LIKE on file id
Ruling 5: the implementer may PUT/update ONLY workflow oA27SA3ikkJ7Wxya (the inactive one it created) to apply the fix; every other workflow stays read-only. — needed to apply fix without making a duplicate — cost if wrong: none, inactive workflow.
