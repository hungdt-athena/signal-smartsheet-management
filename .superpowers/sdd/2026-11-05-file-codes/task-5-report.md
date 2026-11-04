# Task 5 report

Implemented CodeChip (components/CodeChip.tsx, also exports fetchDemoCode) and CSS in app/globals.css beside .rq-list.
- EvalDetailPanel: chip with label "Code" under "Demo Video (Drive)" when conclusion state is List_Idea and driveLink state empty; lazy POST demo-code once per game if ev.demo_code null (ref guard, no retry).
- MissingDemoPrompt: chip left of link input; sequential one-try-per-row fill for rows with null demo_code.
- Record tab: new Code column after Recorder; chip only when status recording/recorded; header, SkeletonRows widths, cols (5/6) and confirm-remove colSpan (3/4) updated.
- RecordQueueBadge: chip per row (record_code), none when null.
Chip click stopPropagation; tooltip "Name the file with this code"; code is user-select: all.

TDD: RED = code-chip suite failed (module missing) and queue-badge test failed (no code shown); GREEN after implementation.
Tests: code-chip (6), record-queue-badge (+1), missing-demo-prompt (+2). Touched-component suites (code-chip, record-queue-badge, missing-demo-prompt, youtube-record-page): 4 suites, 57 tests pass. No existing test for EvalDetailPanel, so the panel wiring is untested by jest.
tsc: no errors in touched files. eslint: 0 errors; 6 warnings (img element, one exhaustive-deps) in EvalDetailPanel/page, not from this change.
Build: `NEXT_DIST_DIR=.next-check next build` fails with "Can't resolve 'exceljs'" (lib/shortlist-export/xlsx.ts, symlinked node_modules lacks it): unrelated to this task. tsconfig.json restored, .next-check removed.
Visual check not done.
Concerns: EvalDetailPanel wiring and Record table column not covered by jest; no screenshots. Record table row `record_code` is typed optional on ShortListItem.
