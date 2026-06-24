# Weekly Feedback — Google Sheets one-time import + multi-group game-alike

**Date:** 2026-06-24
**Branch:** feat/weekly-feedback
**Status:** Design approved, pending spec review

## Goal

Two coupled changes to the Weekly Feedback feature:

1. **Multi-group game alike.** A section currently has exactly one game-alike block
   (`Section.alike: { name, games[] }`). Real data (the source spreadsheet) puts
   *multiple* named groups in a single week's "Game Alike" cell — e.g.
   `Category Match-Card:`, `Match-3:`, `Arrow:`, `Card:` — each with its own list
   of games. The model must hold `Section.alikes: AlikeBlock[]`.

2. **One-time import from Google Sheets.** Seed `weekly_feedback` from the existing
   per-member spreadsheet (one tab per evaluator, one row per week). After import,
   **the app is the source of truth** — members stop editing the sheet and use the
   app editor. No ongoing sync, no conflict handling.

## Decisions (locked)

| Topic | Decision |
|-------|----------|
| Sync model | **One-time import, app becomes source of truth.** Sheets retired after. |
| Week labels | User **manually normalizes** the sheet to `W<x> <Month>, <Year>` first. Importer trusts column A verbatim; flags rows not matching the format. |
| Game matching | Match by `app_link` URL via `parseStoreLink()`; fall back to `manual:true`. |
| Matched titles | Use **DB title** on match (consistent with editor); unmatched keep sheet text. |
| Evaluator identity | User provides a `tabName → evaluatorName` mapping. Unmapped tabs skipped + logged. |
| Mechanism | **One-off Node/TS script** in `scripts/`, Sheets API with grid data, direct DB upsert. Re-runnable, idempotent. |
| Sheets auth | **Service account JSON** (sheet shared to the SA email; path via env). |

## Source data shape (observed)

- Each **tab = one evaluator** (short codes: `HuyDD`, `KietCD`, `MyTL`, `ThuDT`, …).
- Each **row = one week**. Columns:
  - `A` — week label (post-normalization: `W1 MAY, 2026`).
  - `B` — Feedback: free text, multi-line, often `- `-prefixed bullets.
  - `C` — Game Alike: **multiple named groups**. Group headers are **bold lines**
    (often ending in `:`); games are **hyperlinked runs** (display text + URL).
    Some cells are a flat list of links with no headers. Some links carry trailing
    non-link text like `(animation ổn)`.

## Part 1 — Model change: `alike` → `alikes[]`

### Types (`components/weekly-feedback/types.ts`)

```ts
export interface AlikeBlock { name: string; games: GameAlikeGame[] }
export interface Section { id: string; feedback: unknown; alikes: AlikeBlock[] }

export const newSection = (): Section => ({
  id: /* unchanged uuid logic */,
  feedback: null,
  alikes: [],
})
```

`GameHit`, `GameAlikeGame`, `hitToGame`, `searchGames` unchanged.

### Read-time backward compat (no SQL migration)

`sections` is already JSONB, so no `ALTER TABLE`. Normalization happens on read so
already-saved single-`alike` rows keep rendering:

- In the API's `sanitizeSections`: accept either shape — if a section has `alike`
  (object) and no `alikes`, fold to `alikes: alike.name||alike.games?.length ? [alike] : []`.
  Always emit `alikes` (array) outward.
- `legacyToSections` (pre-018 rows): the single collected block becomes
  `alikes: block ? [block] : []`.
- `rowToSections`: when reading `row.sections`, pass each through the same fold so
  old persisted `{alike}` shapes are upgraded in-flight.

No destructive backfill. (Optional future cleanup: a one-time UPDATE rewriting stored
`alike`→`alikes`; **out of scope** — read-time fold is sufficient and safer.)

### Editor (`SectionEditor.tsx`)

Right column (`.wf-section-alike`) renders a list over `section.alikes`:

- For each block `bi`: name `<input>` + game chips `<ul>` + a `<GameSearch>` that
  adds to *that* block, plus a "✕ remove group" control.
- A "+ Add group" button appends `{ name:'', games:[] }`.
- Helpers operate per-block index: `setBlock(bi, patch)`, `addGame(bi, g)`,
  `removeGame(bi, gi)`, `removeBlock(bi)`, `addBlock()` — each calls
  `onChange({ alikes: nextAlikes })`.
- Empty-state: if `alikes` is empty, show just the "+ Add group" button.

### Read views (`FeedbackView.tsx`)

- `AlikeView` takes `alikes: AlikeBlock[]`, renders each block (name `<strong>` +
  `<ul>` of games) stacked, skipping empty blocks. Returns null if all empty.
- `AlikeCell` / `FeedbackView` pass `s.alikes` instead of `s.alike`.

### List rendering (`WeeklyFeedbackTab.tsx`)

`AlikeCell alike={...}` call site updated to `alikes={row.section?.alikes}`. The
flatten-per-section logic is unchanged (still one display row per section).

### API (`app/api/weekly-feedback/route.ts`)

- `interface Section` → `alikes: AlikeBlock[]`.
- `sanitizeSections` emits `alikes` (with the fold above). `sanitizeGame` unchanged.
- PUT/GET otherwise unchanged. History snapshots store whatever shape is current;
  restore runs through `sanitizeSections` so old snapshots fold too.

## Part 2 — Importer: `scripts/import-weekly-feedback.ts`

### Inputs (env / args)

- `GOOGLE_APPLICATION_CREDENTIALS` — service account JSON path (sheet shared to SA email).
- `SPREADSHEET_ID` — the source spreadsheet.
- `DATABASE_URL` — same Postgres the app uses (reuse `@/lib/db` or a `pg`/`postgres` client).
- A `tabName → evaluatorName` mapping object (committed in the script or a small JSON).

### Read

`sheets.spreadsheets.get` with
`fields=sheets(properties.title,data.rowData.values(formattedValue,textFormatRuns,hyperlink))`.
This is the **only** path preserving both hyperlink URIs and bold runs (n8n's Sheets
node and CSV export drop hyperlinks). Skip header row (row 1).

### Per row

1. **Evaluator** — `mapping[tabTitle]`. Missing → skip row, log `UNKNOWN_TAB`.
2. **Batch** — `colA.trim()`. Validate `/^W\d+\s+\w+,\s*\d{4}$/i`. Fail → skip, log
   `BAD_WEEK_LABEL` with the raw value.
3. **Feedback (col B)** → minimal Tiptap doc:
   - Split on `\n`. A line matching `^\s*-\s+` → bullet list item; consecutive
     bullets group into one `bulletList`. Other non-empty lines → `paragraph`.
   - Empty cell → `feedback: null`.
4. **Game Alike (col C)** → `AlikeBlock[]`:
   - Reconstruct per-character (bold, linkUri) from `formattedValue` + `textFormatRuns`
     (each run = `startIndex` + `format.bold` + `format.link.uri`). Cell-level
     `hyperlink` applies when there are no runs.
   - Walk line by line:
     - A **bold line** OR a no-link line ending `:` → open a new block, `name` =
       line text minus trailing `:`.
     - A **run with a link URI** → a game in the current block (or an unnamed block
       `name:''` created lazily if no header yet). `title` = run text (trimmed),
       `app_link` = URI. Trailing non-link text on the line is ignored.
   - Drop empty blocks.
5. **Game match** — per game: `parseStoreLink(app_link)`; query `game_info` by
   `game_id = storeId OR app_link ILIKE %storeId%` AND `is_active`.
   - Hit → `{ game_id, title: db.title, app_link: db.app_link, icon_url: db.icon_url, manual:false }`.
   - Miss → `{ game_id:null, title: sheetText, app_link: uri, icon_url:null, manual:true }`.
6. **Section** — `{ id: uuid, feedback, alikes }`. One section per sheet row.
7. **Upsert** —
   ```sql
   INSERT INTO weekly_feedback (batch, evaluator, sections, updated_at)
   VALUES (...) ON CONFLICT (batch, evaluator)
   DO UPDATE SET sections = EXCLUDED.sections, updated_at = NOW()
   ```

### Report (stdout, end of run)

- Tabs processed; rows imported; rows skipped by reason (`UNKNOWN_TAB`,
  `BAD_WEEK_LABEL`) with raw values.
- Games matched vs `manual` counts (so the reviewer knows the link-match hit rate).

### Properties

- **Idempotent / re-runnable** — `ON CONFLICT DO UPDATE`. Safe to fix labels in the
  sheet and re-run during the transition.
- **No silent data loss** — every skipped row is logged with its raw value.
- **One-off** — script is deleted after the import is accepted.

## Out of scope (YAGNI)

- Ongoing / two-way sync, conflict resolution.
- Game-alike per-game notes (model has no note field; trailing text dropped).
- Destructive `alike`→`alikes` data backfill (read-time fold covers it).
- n8n workflow path (loses hyperlinks).

## Affected files

| File | Change |
|------|--------|
| `components/weekly-feedback/types.ts` | `alike` → `alikes[]`, `newSection` |
| `components/weekly-feedback/SectionEditor.tsx` | multi-block right column + add/remove group |
| `components/weekly-feedback/FeedbackView.tsx` | `AlikeView`/`AlikeCell` loop blocks |
| `components/weekly-feedback/WeeklyFeedbackTab.tsx` | `AlikeCell` call site `alikes=` |
| `app/api/weekly-feedback/route.ts` | `Section.alikes`, fold in sanitize/legacy/rowToSections |
| `scripts/import-weekly-feedback.ts` | **new** one-off importer |

## Verification

- Existing single-`alike` rows still render in List + Week + read-only views (fold works).
- Editor: add/remove multiple groups, each with its own GameSearch; auto-save round-trips `alikes`.
- Importer dry-run on one tab: correct block split, matched vs manual counts plausible,
  bad-label rows reported not imported.
