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

