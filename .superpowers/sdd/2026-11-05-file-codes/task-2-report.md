# Task 2 report
Implemented migrations/052_game_file_codes.sql (demo_code, record_code, partial unique indexes), lib/file-codes.ts (ensureDemoCode/ensureRecordCode on shared ensureCode, column allow-list, sql(col) identifier helper), __tests__/lib/file-codes.test.ts (6 tests, in-memory fake of game_info).
Verified game_info is keyed by game_id (JOIN game_info gi ON ge.game_id = gi.game_id; 001_initial). Migration NOT applied.
TDD: RED = suite failed "Cannot find module '@/lib/file-codes'". GREEN = 6/6 pass; tsc shows no errors in file-codes files.
Test (d): both calls read NULL, both UPDATE; loser gets 0 rows, re-reads, returns winner code; asserts 2 UPDATEs + 3 SELECTs.
Concerns: sql(col) identifier helper is mocked in tests (not run against real postgres.js); standard postgres.js usage.
