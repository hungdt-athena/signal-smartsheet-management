# Task 4 report
Implemented: demo_code / record_code (string|null) on read endpoints, joined from game_info by game_id. No writes in GETs; PATCH untouched.
- missing-demo/route.ts: `gi.demo_code` in both queries, item `demo_code: r.demo_code ?? null`.
- evaluations/route.ts GET (also feeds the Record tab rows): `gi.demo_code, gi.record_code` (NUL file edited byte-wise; git diff --text shows 1 added line).
- evaluations/[gameId]/route.ts (panel by-gameId read): `gi.demo_code, gi.record_code`.
- lib/record-view-games.ts RecordViewRow + query: `gi.record_code`; lib/record-queue.ts RecordQueueGame.record_code (`?? null`); my-queue route needed no change. record-games route outputs YtGame only, left alone.
TDD: RED = 4 failed (new tests) before impl; GREEN after.
Baseline (6 touched-route suites): 59 pass. After: record-my-queue 9, evaluations-missing-demo 12 (one strict-equality expectation got demo_code: null), evaluations 25, eval-detail 8, record-scope 3, current-batch-readers 3, new missing-demo-code 3: all pass.
tsc -p tsconfig.check.json: only pre-existing exceljs errors (module missing in worktree), none from my files.
Concerns: list/detail rows are passthrough so codes are null only if DB is NULL (pg returns null, not undefined). Tests for evaluations list/detail assert SQL text.
