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

