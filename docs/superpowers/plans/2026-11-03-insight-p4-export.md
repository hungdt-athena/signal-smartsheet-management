# Short List Export (Insight / Priority IV) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Export button on the Short List tab that turns one batch's or one month's Insight / Priority IV games into a Google Slides deck (copy of the Master Template), a Google Sheet, or an xlsx download.

**Architecture:** One API route (`/api/shortlist-export`) behind `requireManager()`. Pure modules do the work that can be tested without Google: pick → batch labels, DB rows → `ExportGame[]`, games → sheet tabs, template presentation → `TemplateMap`, `TemplateMap` + games → Slides `batchUpdate` requests. Thin Google modules (service-account auth, Drive copy/create/trash, Sheets, Slides) wrap the API calls. A dialog component on the Short List tab calls the route.

**Tech Stack:** Next.js 14 route handlers, postgres.js (`sql` from `@/lib/db`), `googleapis` (already a dependency), `exceljs` (new), Jest + ts-jest, React Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-03-insight-p4-export-design.md` — read it first.

## Global Constraints

- Branch from `origin/main` (this worktree, `main-3`, is ~134 commits behind and lacks `batches`, `youtube_5min_link`, `youtube_20min_link`, `BatchPicker`, `lib/batch-month.ts`). Create a fresh worktree: `git worktree add ../export-main -b feat/shortlist-export origin/main`.
- Only `admin` and `moderator` may export: `requireManager()` on the route, `isManagerRole(role)` to render the button. Evaluators open Short List too — the button must not render for them.
- Games: `game_evaluations.final_conclusion IN ('Insight','Priority IV')`, filtered by `ge.batch` (plain label, no `record_*_batch`). One row per `game_id`, latest `evaluate_date` wins.
- Week = one batch label. Month = `batchLabelsOfMonth('YYYY-MM')` from `lib/batch-month.ts`. Only labels present in the `batches` table are offered or accepted (starts at W2 Jul 2026).
- YouTube: Insight → `youtube_5min_link`, Priority IV → `youtube_20min_link`. No fallback to `youtube_link`.
- Drive folder for Slides / Sheets: `1R5nipvRfobP7V_6zM1-GBvNaAmTvGwzY` (Shared Drive) — every Drive call passes `supportsAllDrives: true`.
- Master Template: `1hY8RWjEnjrAmZ7WEJgZLqq-vj9CZYPatNwFXhhtrAWo`. Never write to it; only `files.copy`.
- Service-account key from env `GOOGLE_SA_KEY_JSON` (the PJ202 SA's JSON, whole file as one string). Never committed. Keep `lib/google-sheets.ts` (OAuth) untouched.
- Detail slide = the template's **3-section** layout for every Priority IV game. Top Picks = always one slide, shrunk by PJ202 steps (≤20 / 21–30 75% / 31–40 60% / >40 warn).
- Slides fill **only**: cover text, game name (+ store link), icon, "X released by Y" (Insight), "Gameplay" link (Insight), Top Picks names + icons, detail release date, detail video. All other template text stays.
- Trending slide: kept untouched for Month exports, deleted for Week exports.
- Sheets / xlsx: tabs in order `Priority IV`, `Insight` (only the chosen ones); columns `id | title | publisher | android | ios`; header bold + frozen; links clickable.
- File name: week `Oct 2026 W3 Report`, month `Oct 2026 Monthly Report`; append ` (Insight)` or ` (Priority IV)` when only one type is chosen. xlsx file name = same + `.xlsx`.
- Any Google failure after the file exists → trash the file, return the error. Never leave a half-built file.
- UI copy: plain, one idea per line (see memory rule `ui-copy-plain-direct`); English, team words ("batch", "Insight", "Priority IV").
- Before calling it done: `npm test`, `npm run typecheck`, and a full `rtk proxy npm run build` with `NEXT_DIST_DIR=.next-check` (lint errors block Replit publish; a dev server sharing `.next` corrupts it).

## Review Focus

1. **A month where the template has fewer slots than games** (e.g. 30 Insight, 45 Priority IV): every game must appear — Insight slide duplicated per 8, Top Picks shrunk onto one slide, one detail slide each. Test in Task 5 (`plans 30 insight and 45 p4 without dropping a game`).
2. **One icon URL Slides cannot fetch** (dead App Store icon): the deck still builds, that slot keeps the grey placeholder, and the response lists the game in `warnings`. Test in Task 6 (`falls back to one-by-one images and reports the failures`).
3. **A pick that is not an allowed label** (`W5 Oct, 2026`, a pre-July label, `month:2026-13`, empty): 400, no DB game query, no Drive call. Test in Task 1 and Task 7.
4. **A game with both conclusions in the period, or duplicate cross-genre rows**: appears once, under the latest evaluation's conclusion. Test in Task 1 (`dedupes by game_id keeping the latest evaluation`).
5. **Missing values** (no release date, no YouTube link, no publisher, odd `os` value): template text kept / link not set / empty cell; never `null` or `undefined` in output. Tests in Task 2 and Task 5.

---

### Task 1: Export scope and game query

**Files:**
- Create: `lib/shortlist-export/types.ts`, `lib/shortlist-export/scope.ts`, `lib/shortlist-export/games.ts`
- Test: `__tests__/lib/shortlist-export-scope.test.ts`, `__tests__/lib/shortlist-export-games.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export type ExportType = 'insight' | 'priority_iv'
  export type ExportFormat = 'slides' | 'sheets' | 'xlsx'
  export interface ExportScope { kind: 'week' | 'month'; labels: string[]; monthKey: string; weekTag: string | null } // weekTag 'W3' for week, null for month
  export interface ExportGame {
    gameId: string; title: string; publisher: string | null
    platform: 'android' | 'ios' | null            // from game_info.os, lower-cased; anything else → null
    storeUrl: string | null; iconUrl: string | null
    releaseDate: string | null                     // 'YYYY-MM-DD' from game_info.initial_release
    conclusion: 'Insight' | 'Priority IV'
    batch: string; youtubeUrl: string | null
  }
  ```
- Produces (`scope.ts`): `resolveScope(pick: string, allowedLabels: string[]): ExportScope | null` — `pick` is a BatchPicker value (`'W3 Oct, 2026'` or `'month:2026-10'`). Week: label must be in `allowedLabels`. Month: keep only `batchLabelsOfMonth(key)` entries that are in `allowedLabels`; none → null. `exportFileName(scope: ExportScope, types: ExportType[]): string`.
- Produces (`games.ts`): `listExportLabels(): Promise<string[]>` (labels from `batches`, newest `starts_at` first); `loadExportGames(labels: string[], types: ExportType[]): Promise<ExportGame[]>`; `countExportGames(games: ExportGame[]): { insight: number; priorityIV: number }`.

- [ ] **Step 0: Create the worktree** — `git worktree add ../export-main -b feat/shortlist-export origin/main`, `cd ../export-main && npm install`, copy `.env.local` from `main-3`. `npm test` passes before any change.

- [ ] **Step 1: Write failing scope tests**

```ts
const ALLOWED = ['W1 Nov, 2026', 'W4 Oct, 2026', 'W3 Oct, 2026', 'W2 Oct, 2026', 'W1 Oct, 2026']
it('resolves a week', () => expect(resolveScope('W3 Oct, 2026', ALLOWED)).toEqual({ kind: 'week', labels: ['W3 Oct, 2026'], monthKey: '2026-10', weekTag: 'W3' }))
it('resolves a month to its allowed labels, W1 first', () => expect(resolveScope('month:2026-10', ALLOWED)!.labels).toEqual(['W1 Oct, 2026','W2 Oct, 2026','W3 Oct, 2026','W4 Oct, 2026']))
it.each(['', 'W5 Oct, 2026', 'W3 Feb, 2026', 'month:2026-13', 'month:2026-02'])('rejects %p', p => expect(resolveScope(p, ALLOWED)).toBeNull())
it('names files', () => {
  expect(exportFileName(resolveScope('W3 Oct, 2026', ALLOWED)!, ['insight','priority_iv'])).toBe('Oct 2026 W3 Report')
  expect(exportFileName(resolveScope('month:2026-10', ALLOWED)!, ['priority_iv'])).toBe('Oct 2026 Monthly Report (Priority IV)')
})
```

- [ ] **Step 2: Run** `npx jest __tests__/lib/shortlist-export-scope.test.ts` — FAIL (module not found).
- [ ] **Step 3: Implement `types.ts` and `scope.ts`** using `batchLabelsOfMonth`, `monthKeyOfBatch`, `monthKeyLabel` from `lib/batch-month.ts`.
- [ ] **Step 4: Write failing games tests** (mock `@/lib/db` the way `__tests__/api/evaluations-missing-demo.test.ts` does):
  - `passes labels and conclusions as binds` — for `types=['insight']` the query binds `['Insight']` and the labels array; the SQL text contains `DISTINCT ON (ge.game_id)` and `ORDER BY ge.game_id, ge.evaluate_date DESC`.
  - `dedupes by game_id keeping the latest evaluation` — asserted via the SQL text above (dedupe lives in SQL).
  - `maps rows` — a row `{ os: 'Android', initial_release: '2026-09-25T00:00:00Z', youtube_5min_link: 'https://youtu.be/a', youtube_20min_link: 'https://youtu.be/b', final_conclusion: 'Insight', developer_name: null }` → `platform: 'android'`, `releaseDate: '2026-09-25'`, `youtubeUrl: 'https://youtu.be/a'`, `publisher: null`; same row with `final_conclusion: 'Priority IV'` → `youtubeUrl: 'https://youtu.be/b'`; `os: 'web'` → `platform: null`; empty-string links → `null`.
  - `orders by batch then evaluate time` — output order follows `labels` order, then `evaluate_date` ascending (sort in JS after the DISTINCT ON query).
- [ ] **Step 5: Run** — FAIL.
- [ ] **Step 6: Implement `games.ts`.** Query joins `game_info gi USING (game_id)` and `LEFT JOIN developer dev ON gi.publisher_id = dev.id`; filter `ge.batch = ANY(${labels})` and `ge.final_conclusion = ANY(${conclusions})`. Release date: format in SQL as `to_char(gi.initial_release AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`.
- [ ] **Step 7: Run both test files** — PASS.
- [ ] **Step 8: Commit** `feat(export): resolve export scope and load Insight / Priority IV games`

---

### Task 2: Sheet tabs and xlsx

**Files:**
- Create: `lib/shortlist-export/table.ts`, `lib/shortlist-export/xlsx.ts`
- Modify: `package.json` (add `exceljs`)
- Test: `__tests__/lib/shortlist-export-table.test.ts`

**Interfaces:**
- Consumes: `ExportGame`, `ExportType` (Task 1).
- Produces: `interface SheetTab { name: 'Priority IV' | 'Insight'; header: ['id','title','publisher','android','ios']; rows: string[][] }`; `buildTabs(games: ExportGame[], types: ExportType[]): SheetTab[]`; `buildXlsx(tabs: SheetTab[]): Promise<Buffer>`.

- [ ] **Step 1: Write failing tests**
  - `orders tabs Priority IV then Insight` — `types=['insight','priority_iv']` → names `['Priority IV','Insight']`; `['insight']` → `['Insight']`.
  - `puts the store link in the column of its platform` — android game → row `[id, title, pub, storeUrl, '']`; ios → `[id, title, pub, '', storeUrl]`; `platform: null` → both empty; `publisher: null` → `''`.
  - `keeps every game in its own tab, in input order`.
  - `writes a workbook with hyperlinks` — `buildXlsx` then read back with `exceljs` (`workbook.xlsx.load`): sheet names match, row 1 bold, `views[0].state === 'frozen'`, the android cell's `.value` is `{ text: url, hyperlink: url }`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3:** `npm install exceljs`; implement both functions.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(export): build Priority IV / Insight tabs and xlsx`

---

### Task 3: Service-account Google client, Drive helpers, Google Sheets

**Files:**
- Create: `lib/shortlist-export/google.ts`, `lib/shortlist-export/gsheet.ts`
- Test: `__tests__/lib/shortlist-export-gsheet.test.ts`

**Interfaces:**
- Consumes: `SheetTab` (Task 2).
- Produces (`google.ts`):
  ```ts
  export const EXPORT_FOLDER_ID = '1R5nipvRfobP7V_6zM1-GBvNaAmTvGwzY'
  export const MASTER_TEMPLATE_ID = '1hY8RWjEnjrAmZ7WEJgZLqq-vj9CZYPatNwFXhhtrAWo'
  export function getExportAuth(): GoogleAuth   // google.auth.GoogleAuth({ credentials: JSON.parse(GOOGLE_SA_KEY_JSON), scopes: drive, presentations, spreadsheets }); throws Error('GOOGLE_SA_KEY_JSON is not set') when missing
  export async function trashFile(auth, fileId: string): Promise<void>  // files.update trashed:true, supportsAllDrives; swallows its own error (logs)
  ```
- Produces (`gsheet.ts`): `sheetRequests(tabs: SheetTab[]): { addSheets: object[]; values: { range: string; values: string[][] }[]; format: object[] }` (pure) and `createExportSheet(auth, name: string, tabs: SheetTab[]): Promise<{ fileId: string; url: string }>`.

- [ ] **Step 1: Write failing tests for `sheetRequests`**
  - one `addSheet` per tab with `title` = tab name, in order;
  - values range `'Priority IV'!A1` with header first; link cells written as `=HYPERLINK("url","url")`, empty stays `''`; a `"` inside a URL is doubled;
  - format requests: `repeatCell` bold on row 1 and `updateSheetProperties` with `gridProperties.frozenRowCount: 1` for every tab.
  - `createExportSheet trashes the file when filling fails` — mock `googleapis` (`drive.files.create` resolves `{ data: { id: 'f1' } }`, `sheets.spreadsheets.batchUpdate` rejects): expect `files.update` called with `{ fileId: 'f1', requestBody: { trashed: true }, supportsAllDrives: true }` and the original error rethrown.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Create via `drive.files.create({ requestBody: { name, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [EXPORT_FOLDER_ID] }, supportsAllDrives: true })`; one `spreadsheets.batchUpdate` adding tabs + deleting the default `Sheet1`; `values.batchUpdate` with `valueInputOption: 'USER_ENTERED'`; second `batchUpdate` for formats (needs the new sheetIds from the first reply). URL `https://docs.google.com/spreadsheets/d/${id}/edit`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(export): service-account client and Google Sheets export`

---

### Task 4: Read the Master Template (pure)

The exporter finds every slot by reading the copied deck at run time; no object id is hard-coded. Structure of the current template (9 slides) is in `…/docs/PJ202-weekly-report-automation/export-test/template-structure.json` (2026-09-29; may be stale — regenerate the fixture in Step 0).

**Files:**
- Create: `lib/shortlist-export/slides-template.ts`, `scripts/shortlist-export/dump-template.mjs`, `__tests__/fixtures/master-template.json`
- Test: `__tests__/lib/shortlist-export-template.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type Box = { x: number; y: number; w: number; h: number }          // from transform+size, in EMU
  export interface InsightCard { groupId: string; box: Box; iconId: string; nameId: string; gameplayId: string; releasedById: string | null }
  export interface TemplateMap {
    coverSlideId: string; coverTextId: string
    insight: { slideId: string; cards: InsightCard[] } | null          // cards row-major (y, then x)
    trendingSlideId: string | null
    topPicks: { slideId: string; iconIds: string[]; iconBox: Box; nameColumnIds: [string, string]; nameFontPt: number } | null  // icons row-major; iconBox = bounding box of all icon slots; nameFontPt = font size of the first run in the left column
    detail: { slideId: string; nameId: string; iconId: string; dateId: string; videoId: string | null; videoBox: Box | null } | null
    dropSlideIds: string[]                                              // every other slide
  }
  export function readTemplate(p: slides_v1.Schema$Presentation): TemplateMap
  ```

Rules (match on element text, trimmed, case-sensitive):
- Cover = first slide; `coverTextId` = its first shape with text.
- Insight slide = a slide with a shape whose text is exactly `Insight`. Card = top-level group containing a shape with text `The game name`; inside it: `iconId` = the image, `nameId` = `The game name`, `gameplayId` = `Gameplay`. `releasedById` = the shape on the same slide whose text contains `released by`, not inside any card, whose box centre x lies within the card box's x range and whose y is the smallest y ≥ card bottom; null if none.
- Trending = slide with text `Trending!`. Top Picks = slide with text `TOP PICKS!`; icons = its images inside groups; `nameColumnIds` = the two text boxes whose text starts with `Game`, left one first.
- Detail = the slide that contains `Core Gameplay`, does not contain `NEW GAMEPLAY`, and has exactly two text boxes whose text is `+` (the **3-section** layout — user decision 2026-11-03; core gameplay and all three sections keep template text). In it: `nameId` = top-level text box `Game Name` with the smallest y; `iconId` = the top-level image whose box is directly left of `nameId` (right edge within 10 % of name width of the name's x, overlapping y); `dateId` = the shape whose text matches `/^\d{4}-\d{2}-\d{2}$/`; `videoId` = the `video` page element (null if none).
- Every slide not matched above → `dropSlideIds` (Top Game - Like, Other Jam Games, 2-section detail, NEW GAMEPLAY detail).

- [ ] **Step 0: Write `scripts/shortlist-export/dump-template.mjs`** — uses `GOOGLE_SA_KEY_JSON`, `presentations.get` on `MASTER_TEMPLATE_ID` with `fields` limited to slides/pageElements (objectId, size, transform, shape.text.textElements.textRun.content, elementGroup.children, image, video), writes `__tests__/fixtures/master-template.json`. Run it once: `node --env-file=.env.local scripts/shortlist-export/dump-template.mjs`. Expected: file written, 9 slides.
- [ ] **Step 1: Write failing tests against the fixture**
  - `finds 8 insight cards row-major, each with icon, name, gameplay and its released-by line` (8 distinct `releasedById`, none null).
  - `finds 20 top-pick icons and two name columns, left first`.
  - `picks the 3-section detail slide with name, icon, date and video`.
  - `drops every other slide` — `dropSlideIds.length === 9 - 5` (cover, insight, trending, top picks, detail kept).
  - `returns null parts when a slide is missing` — fixture with the Trending slide removed → `trendingSlideId === null`, rest unchanged.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(export): locate Master Template slots at run time`

---

### Task 5: Plan the Slides requests (pure)

**Files:**
- Create: `lib/shortlist-export/slides-plan.ts`
- Test: `__tests__/lib/shortlist-export-plan.test.ts`

**Interfaces:**
- Consumes: `TemplateMap` (Task 4), `ExportGame`, `ExportScope`, `ExportType` (Task 1).
- Produces:
  ```ts
  export interface SlidesPlan { structure: slides_v1.Schema$Request[]; images: { gameId: string; title: string; request: slides_v1.Schema$Request }[]; warnings: string[] }
  export function planSlides(map: TemplateMap, games: ExportGame[], scope: ExportScope, types: ExportType[]): SlidesPlan
  export function youtubeId(url: string | null): string | null   // reuse extractYtId from lib/ytb-match.ts if it covers youtu.be / watch?v= / shorts; else wrap it
  ```

Rules:
- Duplicates use `duplicateObject` with an explicit `objectIds` map (every element id of the source slide → `${id}_x${n}`), so the planner knows new ids without re-reading. Then `updateSlidesPosition` to put slides in order: cover, Insight × ⌈I/8⌉, Trending (month only), Top Picks × 1, detail × P.
- Delete: `dropSlideIds`; Trending when `scope.kind === 'week'`; the Insight slide when no Insight games (or type not chosen); Top Picks + detail when no Priority IV games (or type not chosen); the original detail/insight/top-picks slide itself is used as copy #1, not deleted.
- Cover text → `${MonthName} ${YYYY}\n${weekTag ?? 'Monthly'} Report` (e.g. `October 2026\nW3 Report`).
- Replace text keeping style: `insertText` at the end of the existing text, then `deleteText` of the old range `{ type: 'FIXED_RANGE', startIndex: 0, endIndex: oldLength }`. Link: `updateTextStyle { style: { link: { url } }, fields: 'link', textRange: { type: 'ALL' } }`.
- Insight card i: name → title, link `storeUrl` (if any); released-by → `${title} released by ${publisher}` (publisher null → leave template text); gameplay → link `youtubeUrl` (if any, text unchanged); icon → image request `replaceImage { imageObjectId, url: iconUrl, imageReplaceMethod: 'CENTER_CROP' }` (skip if no iconUrl). Unused cards on the last Insight slide → `deleteObject` the group and its `releasedById`.
- Top Picks is **always one slide** (PJ202 R-SL4 / FS 8.3, 9.1). Scale `s` by count P: P ≤ 20 → 1 (original layout, template icon slots); 21–30 → 0.75; 31–40 → 0.6; P > 40 → the largest `s` at which a grid of icons with size `49·s pt` and pitch `61·s pt` fits `iconBox` with ≥ P cells, plus warning `More than 40 Top Picks: list packed as small as it goes, check it by hand`. When `s < 1`: delete the template icon slots and `createImage` P icons on that grid inside `iconBox` (row-major), and set both name columns' font size to `nameFontPt·s` (`updateTextStyle fontSize`, fields `fontSize`). Names: `${n}. ${title}`, one per line, left column gets ⌈P/2⌉, right column continues the numbering. P ≤ 20: unused template icon slots → `deleteObject`, icons → `replaceImage`.
- Detail per Priority IV game: name → title + store link; icon → image request; date → `releaseDate` (null → keep template text); video: youtube id → `deleteObject videoId` + `createVideo { source: 'YOUTUBE', id, elementProperties: same page + size + transform }`; no id → `deleteObject videoId` + `createShape ROUND_RECTANGLE` in `videoBox` + `insertText 'Add recording video'`.
- `structure` holds everything except images, in an order the API accepts in one `batchUpdate` (duplicates before fills, deletes last).

- [ ] **Step 1: Write failing tests** (fixture map from Task 4 + synthetic games)
  - `week deck: cover, insight, top picks, details; trending deleted` — 3 Insight, 2 P4, `kind: 'week'`: a `deleteObject` for `trendingSlideId`, 2 detail slides in final order, cover insertText `October 2026\nW3 Report`.
  - `month deck keeps trending untouched` — no request targets any element of the Trending slide, and it is not deleted.
  - `plans 30 insight and 45 p4 without dropping a game` — 4 Insight slides, 1 Top Picks slide, 45 detail slides; every game title appears in exactly the expected inserts; numbering 1–45 continuous (left 1–23, right 24–45); 2 unused cards deleted; 45 `createImage` icons on the Top Picks slide; the >40 warning returned.
  - `shrinks top picks by step` — P = 25 → icon size `49·0.75`, font `nameFontPt·0.75`; P = 35 → `0.6`; P = 20 → no createImage on Top Picks, 20 replaceImage.
  - `insight only drops top picks and detail; p4 only drops insight`.
  - `missing values keep template text` — game with `releaseDate: null, youtubeUrl: null, publisher: null, iconUrl: null`: no insert on its date / released-by, no link on gameplay, no image request, "Add recording video" shape created; no request contains `null` or `undefined` (JSON.stringify check).
  - `replaces text by insert-then-delete` — for a name: an `insertText` at index `oldLength` precedes `deleteText` 0..oldLength on the same objectId.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(export): plan Slides requests for any number of games`

---

### Task 6: Build the deck in Drive

**Files:**
- Create: `lib/shortlist-export/slides-export.ts`
- Test: `__tests__/lib/shortlist-export-slides.test.ts`

**Interfaces:**
- Consumes: `getExportAuth`, `trashFile`, `EXPORT_FOLDER_ID`, `MASTER_TEMPLATE_ID` (Task 3); `readTemplate` (Task 4); `planSlides` (Task 5).
- Produces: `exportSlides(auth, name: string, games: ExportGame[], scope: ExportScope, types: ExportType[]): Promise<{ fileId: string; url: string; warnings: string[] }>`.

Flow: `drive.files.copy({ fileId: MASTER_TEMPLATE_ID, requestBody: { name, parents: [EXPORT_FOLDER_ID] }, supportsAllDrives: true })` → `presentations.get` → `readTemplate` → `planSlides` → one `batchUpdate` with `structure` (split into chunks of ≤ 500 requests if larger) → one `batchUpdate` with all image requests; if it fails, send each image request alone and collect failures as `Icon not loaded: <title>`. Any other failure → `trashFile` and rethrow. URL `https://docs.google.com/presentation/d/${id}/edit`.

- [ ] **Step 1: Write failing tests** (mock `googleapis`; `readTemplate`/`planSlides` real, fed the fixture)
  - `copies the template into the export folder and returns the link`.
  - `falls back to one-by-one images and reports the failures` — image batch rejects; per-image calls: one rejects → `warnings` equals `['Icon not loaded: Game B']`, file not trashed.
  - `trashes the copy when the structure batch fails` — and rethrows.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(export): build the Slides deck from the Master Template`

---

### Task 7: API route

**Files:**
- Create: `app/api/shortlist-export/route.ts`
- Test: `__tests__/api/shortlist-export.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3, 6.
- Produces:
  - `GET /api/shortlist-export?pick=<BatchPicker value>` → `{ labels: string[], counts: { insight: number, priorityIV: number } | null }` (`labels` always; `counts` only when `pick` is given and valid; invalid pick → 400 `{ error: 'Pick a batch or month from W2 Jul 2026 on' }`).
  - `POST /api/shortlist-export` body `{ pick: string; types: ExportType[]; format: ExportFormat }` →
    - `slides` / `sheets`: `{ url: string; warnings: string[] }`
    - `xlsx`: the file, `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `Content-Disposition: attachment; filename*=UTF-8''<encoded name>.xlsx`.
    - 400 for bad body (empty `types`, unknown format, invalid pick) or zero games (`{ error: 'No games in this period' }`); 500 `{ error }` for Google failures (message passed through).
  - `export const maxDuration = 300` and `dynamic = 'force-dynamic'`.

- [ ] **Step 1: Write failing tests** (mock `@/lib/db`, `next-auth`, and the `lib/shortlist-export/*` Google modules)
  - `blocks an evaluator` (403) and `allows a moderator`.
  - `rejects a pick outside the batches table without querying games or Google` — `W3 Feb, 2026` → 400; only the `batches` query ran; no Google mock called.
  - `returns counts for a valid pick`.
  - `streams an xlsx with the export file name` — headers as above, body non-empty.
  - `returns the Slides link and warnings`.
  - `refuses an empty period` — 0 games → 400 `No games in this period`, no Google call.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** with `requireManager()` first. **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(export): /api/shortlist-export route`

---

### Task 8: Export dialog on the Short List tab

**Files:**
- Create: `components/ShortListExportDialog.tsx`
- Modify: `app/(manager)/evaluations/page.tsx` (`ShortListEvalTab`: an `Export` button in the existing `PageHeader` actions, rendered only when `isManager`)
- Test: `__tests__/components/shortlist-export-dialog.test.tsx`

**Interfaces:**
- Consumes: Task 7 route; `BatchPicker` (`components/ui/BatchPicker.tsx`, `allowMonth`), `Modal`, `Seg` from `components/ui/`.
- Produces: `<ShortListExportDialog open onClose defaultPick={string} />`.

Dialog rows (top to bottom): **Games** Seg `Insight · Priority IV · Both` (default Both) · **Period** `BatchPicker` with `allowMonth`, labels from GET `labels`, default = current Short List pick if allowed, else newest label · **Format** Seg `Slides · Google Sheets · xlsx` · count line `8 Insight · 21 Priority IV` from GET `counts` (reflects the Games choice) · **Export** button. States: zero games → button disabled + `No games in this period`; running → button shows `Building…` and the dialog cannot close; slides/sheets done → `Open file` link (new tab) + warnings list; xlsx done → browser download via `Blob` + `URL.createObjectURL`, then close; error → message under the button, inputs kept.

- [ ] **Step 1: Write failing tests** (mock `fetch`)
  - `shows the count for the chosen games` — counts `{insight: 8, priorityIV: 21}`: Both → `8 Insight · 21 Priority IV`; Insight → `8 Insight`.
  - `disables Export when the period has no games`.
  - `posts the choices and shows the Open file link`.
  - `downloads the xlsx` — `URL.createObjectURL` called with a Blob.
  - Page test (extend an existing evaluations page test if one renders Short List, else assert in this file by rendering the button wrapper): `hides Export for an evaluator`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(export): Export dialog on the Short List tab`

---

### Task 9: Real-run check and build

**Files:** none new (except fixes found).

- [ ] **Step 1: Setup check** — `GOOGLE_SA_KEY_JSON` in `.env.local` (PJ202 SA key); SA email is a member (Content manager) of the Shared Drive holding `1R5nipvRfobP7V_6zM1-GBvNaAmTvGwzY` and can read the Master Template. If not, stop and ask HungDT to share — do not use another account.
- [ ] **Step 2: Real exports** from the dev server (`NEXT_DIST_DIR=.next-export npm run dev -- -p 3344`, logged in as a manager or `SKIP_AUTH=true`): W3 Oct 2026 Both → Slides, Sheets, xlsx; Oct 2026 month Both → Slides. Expected: deck opens; W3 has cover `October 2026 / W3 Report`, 1 Insight slide (5 cards), no Trending, Top Picks + 17 details; month deck has Trending; Sheets has tabs `Priority IV`, `Insight` with clickable links; xlsx opens in Numbers/Excel. Export PDF of the W3 deck and check no slide shows `The game name`, `Game Name` header, or a broken empty card. Note duration of the month deck (< 120 s expected).
- [ ] **Step 3: Clean up** — trash the test files in the folder (keep one W3 deck to show the user).
- [ ] **Step 4: Full gates** — `npm test`, `npm run typecheck`, `NEXT_DIST_DIR=.next-check NODE_OPTIONS=--max-old-space-size=6144 rtk proxy npm run build` all pass; remove `.next-check` / `.next-export` afterwards.
- [ ] **Step 5: Commit any fixes**; report to the user with the kept deck link. Do not push or Republish without the user's OK. Add `GOOGLE_SA_KEY_JSON` to the Replit secrets list in the hand-over message.

---

## Cloud run notes (2026-11-03)

This plan is first executed by a cloud agent with **no** `GOOGLE_SA_KEY_JSON`, no `DATABASE_URL`, no Drive access.
- Task 0 (worktree) is done: work on branch `feat/shortlist-export`.
- Task 4 Step 0: instead of dumping the live template, build `__tests__/fixtures/master-template.json` (a `slides_v1.Schema$Presentation`-shaped object) from `__tests__/fixtures/master-template-structure.json` (inspect of the Master Template, 2026-09-29: per slide `id`, elements with `id`, `kind`, `text`, `box` in pt, `depth` for group nesting). Still write `scripts/shortlist-export/dump-template.mjs` so the fixture can be regenerated later.
- Task 9 Steps 1–3 (real Google run) are left for HungDT; do Step 4 (tests, typecheck, build) only.
