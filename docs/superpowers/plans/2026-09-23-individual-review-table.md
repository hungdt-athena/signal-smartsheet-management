# Individual tab: fewer blocks, plainer sentences, and a review table

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut three blocks from the Individual tab that describe shape rather than action, rewrite the Leaderboard and Individual chips so a manager can read them without decoding, and add a review table at the bottom where one evaluator's actual judged games can be checked one by one, with screenshots.

**Architecture:** The table is assembled from parts that already exist. `GET /api/evaluations` already filters by evaluator, initial conclusion, date range and category, and already paginates with a total count; the repo already has an IntersectionObserver sentinel idiom in three places. Two things are genuinely new: the list endpoint must be able to return screenshot URLs (behind a flag, so the existing Evaluations page does not start paying for them), and the lightbox currently living inside `EvalDetailPanel` must become a reusable component so the table and the panel share one zoom.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, Postgres via `@/lib/db`, Jest + Testing Library (jsdom).

**Design authority:** this document. It follows the action-system spec at `docs/superpowers/specs/2026-09-22-report-actions-redesign-design.md`, whose lexicon and laws still bind.

**Working tree:** `~/Desktop/athena/n8n-anti/athena-n8n-signal-auto/signal-smartsheet-management`, branch `feat/report-action-system`.

---

## Design

### A. Sentences

The action-system spec already established the rule on Overview: **the number is bold and the sentence around it carries the meaning.** It was never applied to the other two tabs, which still print shorthand written for someone who already knows.

| Tab | Now | Becomes |
|---|---|---|
| Leaderboard `cal` | `NhiLV keeps nothing, QuangVN 1 in 11` | **NhiLV** shortlists none of the games they judge; **QuangVN** keeps 1 in every 11 |
| Leaderboard `people` | `9 of 11 people judged games` | **9 of 11 people** judged anything this week |
| Leaderboard `top` | `ThuDT judged 16% of all games` | **ThuDT** judged **16%** of everything the team got through |
| Individual `net` | `Backlog +33 this week` | **33 games** joined their backlog this week |
| Individual `wait` | `Backlog 763, oldest 13d` | **763 games** waiting, the oldest sat **13 days** |
| Individual `share` | `Judged 16% of the team's games this week` | keep, it is already a sentence |

Zero and negative get their own wording rather than a sign in front of the same clause, the way Overview's chips already do. Both voices (admin third person, contractor second person) must read correctly.

### B. Blocks removed

Three, all for one reason: they describe a distribution and cannot be acted on.

- **Radar, "Shape - what they are strong and weak at"** (`ReportView.tsx` ~2740-2749). Individual is its only reader. `d.radar` stays in the payload because the Leaderboard's Overall score and the Config preview both consume it.
- **Pick funnel** (~2750-2758). Three numbers, two of which are already KPIs (Evaluated, Shortlist rate). The third, final priority, moves into the Shortlist rate KPI's sub-line.
- **Daily breakdown modal** (~2706-2708, and its trigger button in the person row). It counts conclusions per day; the new table lists the games themselves, filtered by day and by conclusion. The table is strictly more informative.

### C. The review table

**Placement.** Last block on the tab, after the recording list.

**Separator, and why it exists.** Every other block on the tab obeys the window and genre filter at the top of the page. This one does not. So it is introduced by a full-width rule and a section title, with one line underneath saying so in plain words: *"This table has its own filters and ignores the window and genre at the top of the page."* Without that line the reader will assume the table is the same selection as the charts above it and read a contradiction.

**Filters**, its own, defaulting to the newest work rather than the selected window:

| Filter | Default |
|---|---|
| Date range | the newest 3 days that have any rows |
| Category | `puzzle` |
| Initial conclusion | `List_Idea` |
| Evaluator | fixed to the person being viewed, not a control |

"The newest 3 days that have any rows" rather than "the last 3 calendar days": a person who did not work over a weekend would otherwise open an empty table and conclude it is broken.

**A row** carries: icon, title, developer, release date, platform, store link, the initial conclusion, the date it was judged, and a horizontal strip of StoreKit screenshots. **No country** — no such column exists anywhere in this database, and inventing one is a separate piece of work.

**Screenshots** are shorter than the reference mock, scroll horizontally inside the row, and open a full-size lightbox on click, the same zoom the Eval panel uses.

**Expand** widens the table out of the page's content column; the rest of the tab is unaffected.

**Paging** is the repo's existing sentinel idiom. Page size is 20, not the Evaluations page's 200, because these rows carry images.

**Permissions** need no new code: `/api/evaluations` already forces an evaluator's request to their own rows server-side. Confirm it, do not re-implement it.

---

## Global Constraints

- **Lexicon** (`__tests__/components/report-lexicon.test.tsx` must stay green): unevaluated games are **Backlog** (never queue, pile, waiting games, stock); a game held past the configured threshold is **Stale**; time before judgement is **Days waiting**; drain time is **Days to clear**; kept after the first judgement is **Shortlist rate**; reaching Priority IV or Insight is **Hit rate**. No em dashes in screen copy.
- Chip and action **evidence copy budget: 150 characters**.
- **No `NaN`, `Infinity` or `undefined` on screen.** Guard every ratio.
- Both voices must read correctly wherever `self` switches them.
- **Do not widen the existing Evaluations page's payload.** Screenshots are returned only when asked for.
- `components/report/ReportView.tsx` is about 3,100 lines. The review table is a **new file**, not another section of it.
- Baseline: `npx jest` is 11 failed / 786 passed; the 11 are pre-existing, in `workflows-trigger`, `weekly-feedback`, `weekly-feedback-batches`, `evaluators`, `handover`, `reassign`.
- Commit with explicit paths, never `git add -A`.

---

### Task 1: Plainer chips on Leaderboard and Individual

**Files:** Modify `components/report/ReportView.tsx` (the two `chips` arrays, ~1920 and ~2606). Test: `__tests__/components/report-leaderboard.test.tsx`, `__tests__/components/report-individual.test.tsx`.

**Interfaces:** no signature changes. Chip `key` and `tone` stay; only `text` changes.

- [ ] **Step 1: Write the failing tests.** For each rewritten chip, assert the rendered `.rp-chip-text` reads as a sentence and names its unit. The `cal` chip must name what is kept ("shortlists", "keeps 1 in every 11") and must not print the bare shorthand "keeps nothing". Assert the Individual `net` chip's zero case and negative case have their own wording rather than a signed number. Assert both voices for `net` and `wait`.
- [ ] **Step 2: Run them, see them fail** with the current shorthand in the received string.
- [ ] **Step 3: Rewrite the six `text` fields** per the table in Design A. Keep every number that is there now; add the noun it belongs to. Stay under 150 characters.
- [ ] **Step 4: Run the three tab suites plus the lexicon gate.**
- [ ] **Step 5: Commit.** `test(report)` then `feat(report)`, or one commit; explicit paths.

---

### Task 2: Remove the three shape blocks

**Files:** Modify `components/report/ReportView.tsx`. Possibly delete `Radar` from `components/report/charts.tsx` if it has no other caller. Tests: the Individual suites.

**Interfaces:** `d.radar` stays on the payload. `DailyBreakdown`'s component may be deleted entirely if nothing else renders it.

- [ ] **Step 1: Write the failing tests.** Assert the Individual tab renders no radar, no pick funnel and no Daily breakdown trigger; assert the Shortlist rate KPI's sub-line now names the final-priority count.
- [ ] **Step 2: Run them, see them fail.**
- [ ] **Step 3: Remove the three blocks** and their now-dead locals (`radarValues`, `radarRaw`, `weakAxis`, `strongAxis`, `TIP.radar`, the `daily` state and its button). Before deleting `Radar` from `charts.tsx` or the `DailyBreakdown` component, grep for other callers and say what you found. `AXIS_LABEL` stays; the Config tab still uses it.
- [ ] **Step 4: Run the full suite.** Fixtures that supplied `radar` may keep it; the payload field is unchanged.
- [ ] **Step 5: Commit.**

---

### Task 3: Screenshots on the list endpoint, behind a flag

**Files:** Modify `app/api/evaluations/route.ts`. Test: `__tests__/api/evaluations-screenshots.test.ts` (create).

**Interfaces produced:**
- `GET /api/evaluations?with_screenshots=1` adds to each row:
  `screenshot_urls: string[] | null` and `manual_screenshot_urls: string[] | null`, read from `game_info.metadata->'screenshot_urls'` and `->'manual_screenshot_urls'`, the same source `app/api/evaluations/[gameId]/route.ts` uses.
- Without the flag the response is byte-identical to today's.

- [ ] **Step 1: Write the failing tests.** Three cases: with the flag, rows carry both arrays; without it, the keys are absent (not null, absent); a row whose game has no metadata yields `null` rather than throwing.
- [ ] **Step 2: Run them, see them fail.**
- [ ] **Step 3: Implement.** Add the two expressions to the SELECT only when the flag is set. Do not add a join; `game_info` is already joined.
- [ ] **Step 4: Run the evaluations API suites** and confirm the existing page's tests are untouched.
- [ ] **Step 5: Commit.**

---

### Task 4: One lightbox, shared

**Files:** Create `components/Lightbox.tsx`. Modify `components/EvalDetailPanel.tsx` (state at ~486, portal at ~1607-1638, thumbnails at ~1159-1169) and `components/ManualScreenshotsCard.tsx` if its `onExpand` contract changes. Test: `__tests__/components/lightbox.test.tsx` (create).

**Interfaces produced:**

```ts
export function Lightbox({ url, onClose }: { url: string | null; onClose: () => void }): JSX.Element | null
export function useLightbox(): { open: (url: string) => void; node: JSX.Element | null }
```

`Lightbox` renders nothing when `url` is null, otherwise a `createPortal` backdrop into `document.body`, closing on backdrop click and on Escape.

- [ ] **Step 1: Write the failing tests.** Renders nothing when closed; renders the image when open; closes on backdrop click; closes on Escape; does not close when the image itself is clicked.
- [ ] **Step 2: Run them, see them fail.**
- [ ] **Step 3: Extract** the existing markup and behaviour from `EvalDetailPanel` verbatim into the new component, then have the panel use it. This is a lift: the panel's behaviour must not change. Keep the existing `lightbox-backdrop` class so the CSS is untouched.
- [ ] **Step 4: Run the Eval panel's own suites** and confirm nothing about its zoom changed.
- [ ] **Step 5: Commit.**

---

### Task 5: The review table component

**Files:** Create `components/report/ReviewTable.tsx`. Modify `app/globals.css` for its styles. Test: `__tests__/components/report-review-table.test.tsx` (create).

**Interfaces produced:**

```ts
export function ReviewTable({ evaluator, canSeeTeam }: { evaluator: string; canSeeTeam: boolean }): JSX.Element
```

It owns its own filter state and fetches `GET /api/evaluations` with `evaluator`, `category`, `conclusion`, `from`, `to`, `date_basis=evaluated`, `page`, `limit=20`, `with_screenshots=1`.

- [ ] **Step 1: Write the failing tests.** Defaults are the newest 3 days with rows, `puzzle`, `List_Idea`. Changing a filter refetches from page 1. The sentinel loads page 2 and appends rather than replacing. A game with no screenshots renders its row without an empty strip. Clicking a screenshot opens the lightbox. The expand control widens the container and can be toggled back. An empty result renders a sentence saying so, naming the filters, not a blank area.
- [ ] **Step 2: Run them, see them fail.**
- [ ] **Step 3: Implement.** Use the IntersectionObserver sentinel idiom from `app/(manager)/evaluations/page.tsx:1258-1270` — same shape, `rootMargin: '200px'`, guarded on `hasMore && !loading`. Use `Lightbox` from Task 4. Screenshots scroll horizontally within the row at a reduced height.
- [ ] **Step 4: Run the new suite and the lexicon gate.**
- [ ] **Step 5: Commit.**

---

### Task 6: Wire it into the Individual tab

**Files:** Modify `components/report/ReportView.tsx` (after the recording list). Modify `app/globals.css` for the separator. Test: `__tests__/components/report-individual.test.tsx`.

- [ ] **Step 1: Write the failing tests.** The table renders last, after the recording list; the separator and its sentence are present and say the table has its own filters; the contractor view renders it for their own name; changing the person switcher re-targets it.
- [ ] **Step 2: Run them, see them fail.**
- [ ] **Step 3: Implement.** A full-width rule, a section title, and one muted line: *"This table has its own filters and ignores the window and genre at the top of the page."* Then `<ReviewTable evaluator={e.name} canSeeTeam={d.canSeeTeam} />`.
- [ ] **Step 4: Run the Individual suites and the real-payload suite.**
- [ ] **Step 5: Commit.**

---

### Task 7: Read it back

**Files:** Modify `__tests__/components/report-real-payload.test.tsx`.

- [ ] **Step 1** Extend the real-payload dump so the Individual tab's rendered text is read back with the three blocks gone and the rewritten chips in place. Assert no removed block's heading survives.
- [ ] **Step 2** Run it and **read every line of the output**. Check the chips read as English in both voices, that no sentence names a removed block, and that the separator line actually appears above the table.
- [ ] **Step 3** Run `npm test`, `npm run typecheck`, `npx next lint`. Land on 11 failed, the pre-existing set.
- [ ] **Step 4: Commit.**
