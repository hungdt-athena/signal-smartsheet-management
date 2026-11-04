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

