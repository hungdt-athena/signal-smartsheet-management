# DB → Smartsheet Eval Sync (Puzzle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an n8n flow that pushes evaluation results from `game_evaluations` (Postgres) back to the Puzzle Smartsheet — only filling in cells that are currently empty on the sheet (fill-in-blanks, no overwrite).

**Architecture:** Manual trigger → GET full Puzzle sheet → Query DB for puzzle rows with eval data → match by GameID → per field: only write if DB has value AND Smartsheet cell is empty → PUT batch update → log to flow_log.

**Tech Stack:** n8n cloud (autoai9.app.n8n.cloud), Smartsheet REST API v2, Postgres (credential id `KBZC0RGIJsc8d7GK`), Google Sheets (flow_log, credential id `UMl5XCc7aOcf9yi3`), Smartsheet Token credential id `vAGuEElrZVb7OOoI`.

---

## Key Constants

| Name | Value |
|------|-------|
| Puzzle sheet ID | `2184120410001284` |
| Smartsheet API base | `https://api.smartsheet.com/2.0` |
| Smartsheet credential | id `vAGuEElrZVb7OOoI`, name `Smartsheet Token` |
| Postgres credential | id `KBZC0RGIJsc8d7GK` |
| Google Sheets credential | id `UMl5XCc7aOcf9yi3` |
| flow_log sheet | `1yb558PpmunJcdDYCyVzdDpBfKDiIArMBG4IBI-eR0dg`, tab `flow_log` |
| Flow name | `db-to-smartsheet-eval-sync` |

## Fields to Sync

| DB column | Smartsheet column title |
|-----------|------------------------|
| `initial_conclusion` | `Initial Conclusion` |
| `initial_note` | `Initial Evaluator note` |
| `genre_1` | `Genre 1` |
| `genre_2` | `Genre 2` |
| `evaluate_date` | `Evaluate Date` |

---

## Task 1: Create the n8n workflow skeleton

**Files:**
- Create: `workflows/db-to-smartsheet-eval-sync.json`

- [ ] **Step 1: Create a new workflow in n8n cloud**

Go to `autoai9.app.n8n.cloud`, create a new workflow named `db-to-smartsheet-eval-sync`.

- [ ] **Step 2: Add Manual Trigger node**

Add a **Manual Trigger** node. This is the only trigger — no schedule.

- [ ] **Step 3: Add Config Code node**

Add a **Code** node named `Config` connected after Manual Trigger. Set mode to "Run Once for All Items". Use this JS:

```javascript
const PUZZLE_SHEET_ID = '2184120410001284';

return [{
  json: {
    sheetId: PUZZLE_SHEET_ID,
    fieldsMap: {
      'Initial Conclusion': 'initial_conclusion',
      'Initial Evaluator note': 'initial_note',
      'Genre 1': 'genre_1',
      'Genre 2': 'genre_2',
      'Evaluate Date': 'evaluate_date',
    }
  }
}];
```

- [ ] **Step 4: Export and save workflow JSON**

After building in n8n UI, export and save to `workflows/db-to-smartsheet-eval-sync.json`.

- [ ] **Step 5: Commit**

```bash
git add workflows/db-to-smartsheet-eval-sync.json
git commit -m "feat: db-to-smartsheet-eval-sync skeleton"
```

---

## Task 2: GET Puzzle Sheet

**Files:**
- Modify: `workflows/db-to-smartsheet-eval-sync.json`

- [ ] **Step 1: Add HTTP Request node — GET sheet**

Add an **HTTP Request** node named `Get Puzzle Sheet` after `Config`.

Settings:
- Method: `GET`
- URL: `=https://api.smartsheet.com/2.0/sheets/{{ $json.sheetId }}?includeAll=true`
- Authentication: Generic Credential Type → `httpHeaderAuth` → credential `Smartsheet Token` (id `vAGuEElrZVb7OOoI`)
- No body

This returns the full sheet with all columns and all rows.

- [ ] **Step 2: Add Code node — Parse Sheet**

Add a **Code** node named `Parse Sheet` after `Get Puzzle Sheet`. Mode: Run Once for All Items.

```javascript
// Build: colByTitle (name→id), colTypeByTitle (name→Smartsheet type),
// rowByGameId (gameId→{rowId, cells:{colTitle: currentValue}})
const sheetData = $('Get Puzzle Sheet').first().json;
const fieldsMap = $('Config').first().json.fieldsMap;
const sheetId = $('Config').first().json.sheetId;

const columns = sheetData.columns || [];
const rows = sheetData.rows || [];

// Build maps once (avoid columns.find() in nested loops)
const colByTitle = {};
const colTypeByTitle = {};
const colById = {};
for (const c of columns) {
  const title = String(c.title).trim();
  colByTitle[title] = c.id;
  colTypeByTitle[title] = c.type;     // e.g. DATE, DATETIME, PICKLIST, TEXT_NUMBER
  colById[c.id] = title;
}

// Map GameID → { rowId, cells: {colTitle: currentValue} }
const rowByGameId = {};

for (const row of rows) {
  let gameId = null;
  const cellMap = {};

  for (const cell of (row.cells || [])) {
    const title = colById[cell.columnId];
    if (!title) continue;
    const val = cell.value != null ? cell.value : (cell.displayValue != null ? cell.displayValue : null);
    if (title === 'GameID') gameId = val ? String(val).trim() : null;
    cellMap[title] = val;
  }

  if (gameId) {
    rowByGameId[gameId] = { rowId: row.id, cells: cellMap };
  }
}

return [{
  json: {
    colByTitle,
    colTypeByTitle,
    rowByGameId,
    sheetId,
    fieldsMap,
    rowCount: rows.length,
  }
}];
```

> **Note on column types:** capturing `colTypeByTitle` lets `Build Updates` format `evaluate_date` correctly. When you run Step 3, look at the output and note the `type` of `Evaluate Date` (likely `DATE` or `DATETIME`) — Task 3's date formatting relies on it.

- [ ] **Step 3: Verify manually**

Run the flow up to `Parse Sheet`. Check the output has `rowByGameId` with entries like:
```json
{ "com.example.game": { "rowId": 123456789, "cells": { "Initial Conclusion": null, "Genre 1": "Puzzle" } } }
```

- [ ] **Step 4: Export and commit**

```bash
git add workflows/db-to-smartsheet-eval-sync.json
git commit -m "feat: get + parse puzzle sheet rows"
```

---

## Task 3: Query DB for eval data

**Files:**
- Modify: `workflows/db-to-smartsheet-eval-sync.json`

- [ ] **Step 1: Add Postgres node — Query Evals**

Add a **Postgres** node named `Query DB Evals` after `Parse Sheet`. Use credential id `KBZC0RGIJsc8d7GK`.

Operation: Execute Query

SQL:
```sql
SELECT
  game_id,
  initial_conclusion,
  initial_note,
  genre_1,
  genre_2,
  evaluate_date
FROM game_evaluations
WHERE category_group = 'puzzle'
  AND (
    initial_conclusion IS NOT NULL
    OR initial_note IS NOT NULL
    OR genre_1 IS NOT NULL
    OR genre_2 IS NOT NULL
    OR evaluate_date IS NOT NULL
  )
ORDER BY updated_at DESC;
```

- [ ] **Step 2: Add Code node — Build Updates**

Add a **Code** node named `Build Updates` after `Query DB Evals`. Mode: Run Once for All Items.

```javascript
// For each DB row: find the Smartsheet row, then per field only push
// if DB has a value AND Smartsheet cell is currently empty/null.
const parseData = $('Parse Sheet').first().json;
const { colByTitle, colTypeByTitle, rowByGameId, sheetId, fieldsMap } = parseData;

const dbRows = $('Query DB Evals').all();

function isBlank(v) {
  return v == null || String(v).trim() === '';
}

// Format a DB value for a given Smartsheet column based on its type.
// DATE columns require YYYY-MM-DD; DATETIME accepts full ISO; others pass through.
function formatVal(sheetCol, val) {
  const type = colTypeByTitle[sheetCol];
  if (type === 'DATE' || type === 'DATETIME') {
    const d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    if (type === 'DATE') {
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    }
    return d.toISOString(); // DATETIME
  }
  return val;
}

const updates = [];

for (const item of dbRows) {
  const db = item.json;
  const gameId = db.game_id;
  if (!gameId) continue;

  const sheetRow = rowByGameId[gameId];
  if (!sheetRow) continue; // game not in sheet yet — skip

  const cells = [];

  for (const [sheetCol, dbCol] of Object.entries(fieldsMap)) {
    const dbVal = db[dbCol];
    const sheetVal = sheetRow.cells[sheetCol];
    const colId = colByTitle[sheetCol];

    if (!colId) continue;
    if (isBlank(dbVal)) continue;      // nothing in DB — skip
    if (!isBlank(sheetVal)) continue;  // sheet already has data — skip

    cells.push({
      columnId: String(colId),
      value: formatVal(sheetCol, dbVal),
      strict: false, // allow values not in a PICKLIST dropdown
    });
  }

  if (cells.length > 0) {
    updates.push({ id: String(sheetRow.rowId), cells });
  }
}

if (updates.length === 0) {
  return [{ json: { updates: [], count: 0, sheetId, hasUpdates: false } }];
}

// Smartsheet PUT /rows accepts max 500 rows per call — chunk if needed
const CHUNK = 500;
const chunks = [];
for (let i = 0; i < updates.length; i += CHUNK) {
  chunks.push(updates.slice(i, i + CHUNK));
}

return [{ json: { updates, chunks, count: updates.length, sheetId, hasUpdates: true } }];
```

- [ ] **Step 3: Verify manually**

Run flow up to `Build Updates`. Confirm output `count` > 0 when there are DB rows with eval data and empty Smartsheet cells. Confirm `count` = 0 when no gaps.

- [ ] **Step 4: Export and commit**

```bash
git add workflows/db-to-smartsheet-eval-sync.json
git commit -m "feat: query db evals + build fill-in-blanks update list"
```

---

## Task 4: PUT updates to Smartsheet

**Files:**
- Modify: `workflows/db-to-smartsheet-eval-sync.json`

- [ ] **Step 1: Add IF node — Has Updates?**

Add an **IF** node named `Has Updates?` after `Build Updates`.

Condition: `{{ $json.hasUpdates }}` equals `true` (Boolean).

- [ ] **Step 2: Add Code node — Chunk Items (TRUE branch)**

Add a **Code** node named `Chunk Items` on the TRUE branch of `Has Updates?`. Mode: Run Once for All Items.

```javascript
// Emit one item per chunk so HTTP Request iterates over each chunk
const data = $input.first().json;
return data.chunks.map(chunk => ({
  json: { rows: chunk, sheetId: data.sheetId, count: data.count }
}));
```

- [ ] **Step 3: Add HTTP Request node — PUT Rows**

Add an **HTTP Request** node named `PUT Rows` after `Chunk Items`.

Settings:
- Method: `PUT`
- URL: `=https://api.smartsheet.com/2.0/sheets/{{ $json.sheetId }}/rows`
- Authentication: Generic Credential Type → `httpHeaderAuth` → credential `Smartsheet Token` (id `vAGuEElrZVb7OOoI`)
- Send Body: ON, Body Content Type: JSON
- JSON Body: `={{ $json.rows }}`

- [ ] **Step 4: Add Code node — Summary (TRUE branch)**

Add a **Code** node named `Summary Success` after `PUT Rows`. Mode: Run Once for All Items.

```javascript
const count = $('Build Updates').first().json.count;
return [{
  json: {
    name: 'db-eval-sync-puzzle',
    status: 'success',
    note: `Updated ${count} rows on Smartsheet`,
    sheet_id: $('Config').first().json.sheetId,
  }
}];
```

- [ ] **Step 5: Add Code node — Summary (FALSE branch)**

Add a **Code** node named `Summary No Updates` on the FALSE branch of `Has Updates?`. Mode: Run Once for All Items.

```javascript
return [{
  json: {
    name: 'db-eval-sync-puzzle',
    status: 'success',
    note: 'No rows to update (DB data already on sheet or no eval data)',
    sheet_id: $('Config').first().json.sheetId,
  }
}];
```

- [ ] **Step 6: Export and commit**

```bash
git add workflows/db-to-smartsheet-eval-sync.json
git commit -m "feat: PUT rows to smartsheet with fill-in-blanks logic"
```

---

## Task 5: Log to flow_log + Error handler

**Files:**
- Modify: `workflows/db-to-smartsheet-eval-sync.json`

- [ ] **Step 1: Add Google Sheets node — Log flow_log**

Add a **Google Sheets** node named `Log flow_log`. Connect **both** `Summary Success` and `Summary No Updates` outputs directly into this node's input (n8n allows multiple node outputs → one node input; the node runs for whichever branch fired).

> **Do NOT use a Merge node here.** A Merge node waits for data on both inputs, but the IF node only ever fires one branch — the other input never arrives, so Merge would stall and `Log flow_log` would never run.

Settings:
- Operation: Append
- Document: `1yb558PpmunJcdDYCyVzdDpBfKDiIArMBG4IBI-eR0dg`
- Sheet: `flow_log`
- Credential: Google Sheets OAuth id `UMl5XCc7aOcf9yi3`
- Mapping: Define Below

Column mappings:
```
date     = {{ $now.setZone('Asia/Ho_Chi_Minh').toFormat('yyyy-MM-dd HH:mm:ss') }}
name     = {{ $json.name }}
status   = {{ $json.status }}
note     = {{ $json.note }}
sheet_id = {{ $json.sheet_id }}
```

- [ ] **Step 2: Add Error Trigger + Google Chat notification**

Add an **Error Trigger** node. Connect it to a **Google Chat** node named `Error Notification`.

Google Chat settings (copy from existing `[unified]-database-to-smartsheet` flow):
- Space: `spaces/AAQAYTKWM1I`
- Message: `={{ 'db-eval-sync-puzzle ERROR: ' + $json.execution.error.message }}`

- [ ] **Step 3: Final manual test**

Run the full flow. Confirm:
1. Smartsheet cells that were empty and DB has data → now filled
2. Smartsheet cells that already had data → unchanged
3. `flow_log` sheet has a new row with correct count

- [ ] **Step 4: Export and commit**

```bash
git add workflows/db-to-smartsheet-eval-sync.json
git commit -m "feat: flow_log logging + error handler for db-eval-sync-puzzle"
```
