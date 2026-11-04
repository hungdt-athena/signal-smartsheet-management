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

