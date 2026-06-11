# Smartsheet Sync v2 Implementation Plan (images + demo drive + update flow)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Smartsheet→DB sync so it carries StoreKit cell images (→ Supabase manual screenshots), the Drive Video demo link (→ `drive_link`), and keeps the DB updated daily while the team still edits Smartsheet.

**Architecture:** A new app endpoint ingests image URL batches (n8n holds the Smartsheet token and resolves temporary URLs via `POST /2.0/imageurls`). Flow 1 (existing `smartsheet-to-db-evaluations.json`, modified) does the one-time full rebuild: DELETE category → insert with `drive_link` → image branch. Flow 2 (new) runs daily with `rowsModifiedSince=now−48h` and upserts (`ON CONFLICT DO UPDATE`, Smartsheet wins on sync-able fields; app-only fields untouched) + the same image branch. The detail panel gains a Demo Video field bound to the already-wired `driveLink` state.

**Tech Stack:** Next.js 14 route handler, `lib/supabase-storage.ts`, postgres.js `sql.json`, Jest (node), n8n workflow JSON.

**Spec:** `docs/superpowers/specs/2026-06-12-smartsheet-screenshot-fallback-design.md`

**Grounding facts (verified):**
- Flow 1 file `workflows/smartsheet-to-db-evaluations.json`: manualTrigger → `Sheet IDs` code (ONE id per run; big sheets OOM n8n) → `Get Sheet` (httpRequest 4.2, `includeAll=true`, httpHeaderAuth cred placeholder `REPLACE_WITH_YOUR_SMARTSHEET_HEADER_AUTH_CRED_ID`) → `Build SQL` (json_to_recordset with `$jrows$` dollar-quoting) → `Insert Rows` (postgres cred id `KBZC0RGIJsc8d7GK`).
- flow_log: Google Sheets node v4.5, documentId `1yb558PpmunJcdDYCyVzdDpBfKDiIArMBG4IBI-eR0dg`, sheetName `flow_log` (date, name, status, note, sheet_id), cred `googleSheetsOAuth2Api` id `UMl5XCc7aOcf9yi3` name `HandoverRequest-HungDT` (shape in `workflows/smartsheet-delete-monitor.json`).
- Sheet ids: puzzle `2184120410001284` (puzzle spans ~6 sheets — user appends the rest), arcade `3926172768358276`, simulation `7899099241074564`.
- `game_evaluations` has `drive_link` and `updated_at`; unique key `(game_id, category_group)`; FK to `game_info(game_id)`.
- App auth pattern (`x-webhook-secret` OR admin session): `app/api/admin/import-evaluations/route.ts:50-59`.
- jsonb writes MUST use `${sql.json(value)}` — `JSON.stringify(...)::jsonb` double-encodes (bug fixed in commit b51aceb).
- `EvalDetailPanel.tsx` already holds `driveLink` state synced from `ev.drive_link` and `save()` sends `body.drive_link` when changed — only the input JSX is missing.

---

### Task 1: `POST /api/admin/import-screenshots` (TDD)

**Files:**
- Create: `__tests__/api/import-screenshots.test.ts`
- Create: `app/api/admin/import-screenshots/route.ts`

- [ ] **Step 1: Write the failing tests** — create `__tests__/api/import-screenshots.test.ts`:

```typescript
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({
  sql: Object.assign(jest.fn(), { json: (v: unknown) => v }),
}))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/supabase-storage', () => ({
  isStorageConfigured: jest.fn(() => true),
  uploadScreenshot: jest.fn(),
}))

import { POST } from '@/app/api/admin/import-screenshots/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'
import { isStorageConfigured, uploadScreenshot } from '@/lib/supabase-storage'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as jest.Mock
const SECRET = 'test-secret'

function post(body: unknown, withSecret = true) {
  return POST(new NextRequest('http://localhost/api/admin/import-screenshots', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: withSecret
      ? { 'Content-Type': 'application/json', 'x-webhook-secret': SECRET }
      : { 'Content-Type': 'application/json' },
  }))
}

function mockStates(states: { game_id: string; has_storekit?: boolean; has_manual?: boolean }[]) {
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('SELECT game_id')) {
      return Promise.resolve(states.map(s => ({
        game_id: s.game_id, has_storekit: !!s.has_storekit, has_manual: !!s.has_manual,
      })))
    }
    return Promise.resolve([])
  })
}

function mockImageFetch(contentType = 'image/png', bytes = 100, status = 200) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    arrayBuffer: async () => new ArrayBuffer(bytes),
  })
}

describe('POST /api/admin/import-screenshots', () => {
  const realFetch = global.fetch
  const realSecret = process.env.WEBHOOK_SECRET
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.WEBHOOK_SECRET = SECRET; process.env.SKIP_AUTH = 'false' })
  afterAll(() => {
    global.fetch = realFetch
    if (realSecret === undefined) delete process.env.WEBHOOK_SECRET
    else process.env.WEBHOOK_SECRET = realSecret
    if (realSkip === undefined) delete process.env.SKIP_AUTH
    else process.env.SKIP_AUTH = realSkip
  })
  beforeEach(() => {
    jest.clearAllMocks()
    ;(isStorageConfigured as jest.Mock).mockReturnValue(true)
    sessionMock.mockResolvedValue(null)
    mockStates([])
  })

  it('401 without secret or admin session', async () => {
    const res = await post({ items: [] }, false)
    expect(res.status).toBe(401)
  })

  it('allows an admin session without the secret', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'Boss' } })
    const res = await post({ items: [] }, false)
    expect(res.status).toBe(200)
  })

  it('503 when storage unconfigured', async () => {
    ;(isStorageConfigured as jest.Mock).mockReturnValue(false)
    const res = await post({ items: [] })
    expect(res.status).toBe(503)
  })

  it('400 when items missing or too many', async () => {
    expect((await post({})).status).toBe(400)
    const many = Array.from({ length: 51 }, (_, i) => ({ game_id: `g${i}`, image_urls: ['https://t/a.png'] }))
    expect((await post({ items: many })).status).toBe(400)
  })

  it('skips not-found, has-storekit and has-manual games without downloading', async () => {
    mockStates([
      { game_id: 'sk', has_storekit: true },
      { game_id: 'man', has_manual: true },
    ])
    mockImageFetch()
    const res = await post({ items: [
      { game_id: 'sk', image_urls: ['https://t/a.png'] },
      { game_id: 'man', image_urls: ['https://t/b.png'] },
      { game_id: 'ghost', image_urls: ['https://t/c.png'] },
    ] })
    const json = await res.json()
    expect(json.skipped_has_storekit).toBe(1)
    expect(json.skipped_has_manual).toBe(1)
    expect(json.skipped_not_found).toBe(1)
    expect(json.uploaded).toBe(0)
    expect(uploadScreenshot).not.toHaveBeenCalled()
  })

  it('downloads, uploads and appends metadata with the raw URL array (sql.json)', async () => {
    mockStates([{ game_id: 'g1' }])
    mockImageFetch('image/png')
    ;(uploadScreenshot as jest.Mock).mockResolvedValue('https://supa/x.png')
    const res = await post({ items: [{ game_id: 'g1', image_urls: ['https://t/a.png'] }] })
    const json = await res.json()
    expect(json.uploaded).toBe(1)
    expect(json.failed).toEqual([])
    const updateCall = sqlMock.mock.calls.find(c =>
      Array.isArray(c[0]) && (c[0] as string[]).join(' ').includes('UPDATE game_info'))
    expect(updateCall).toBeTruthy()
    expect(updateCall!.slice(1)).toContainEqual(['https://supa/x.png'])
  })

  it('download HTTP failure lands in failed[]', async () => {
    mockStates([{ game_id: 'g1' }])
    mockImageFetch('image/png', 100, 403)
    const res = await post({ items: [{ game_id: 'g1', image_urls: ['https://t/a.png'] }] })
    const json = await res.json()
    expect(json.uploaded).toBe(0)
    expect(json.failed).toEqual([{ game_id: 'g1', error: 'download HTTP 403' }])
  })

  it('non-image content-type lands in failed[]', async () => {
    mockStates([{ game_id: 'g1' }])
    mockImageFetch('text/html')
    const res = await post({ items: [{ game_id: 'g1', image_urls: ['https://t/a.png'] }] })
    const json = await res.json()
    expect(json.failed).toEqual([{ game_id: 'g1', error: 'unsupported type text/html' }])
  })
})
```

- [ ] **Step 2: Run `npx jest __tests__/api/import-screenshots.test.ts` — verify FAIL (module not found). Record output.**

- [ ] **Step 3: Implement `app/api/admin/import-screenshots/route.ts`:**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { isStorageConfigured, uploadScreenshot } from '@/lib/supabase-storage'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Ingest screenshots pasted into Smartsheet StoreKit cells. n8n resolves the
// temporary image URLs (it holds the Smartsheet token) and POSTs
// { items: [{ game_id, image_urls }] }; this route downloads and persists them
// as manual screenshots for games that have neither StoreKit nor manual images.

const MAX_ITEMS = 50
const MAX_URLS_PER_GAME = 10
const MAX_SIZE = 5 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 15_000
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

function hasWebhookSecret(req: NextRequest): boolean {
  const secret = process.env.WEBHOOK_SECRET
  return !!secret && req.headers.get('x-webhook-secret') === secret
}

interface Item { game_id: string; image_urls: string[] }

export async function POST(req: NextRequest) {
  if (!hasWebhookSecret(req)) {
    const guard = await requireRole(['admin'])
    if (guard) return guard
  }

  try {
    if (!isStorageConfigured()) {
      return NextResponse.json({ error: 'Storage not configured' }, { status: 503 })
    }

    let body: { items?: { game_id?: unknown; image_urls?: unknown }[] }
    try { body = await req.json() } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 })
    }
    if (!Array.isArray(body.items)) {
      return NextResponse.json({ error: 'items array required' }, { status: 400 })
    }
    if (body.items.length > MAX_ITEMS) {
      return NextResponse.json({ error: `Max ${MAX_ITEMS} items per call` }, { status: 400 })
    }

    // Normalize + dedup by game_id (first wins).
    const byId = new Map<string, Item>()
    for (const raw of body.items) {
      const gameId = typeof raw.game_id === 'string' ? raw.game_id.trim() : ''
      const urls = Array.isArray(raw.image_urls)
        ? raw.image_urls.filter((u): u is string => typeof u === 'string' && u.length > 0).slice(0, MAX_URLS_PER_GAME)
        : []
      if (!gameId || urls.length === 0 || byId.has(gameId)) continue
      byId.set(gameId, { game_id: gameId, image_urls: urls })
    }
    const items = Array.from(byId.values())

    const counts = { uploaded: 0, skipped_has_storekit: 0, skipped_has_manual: 0, skipped_not_found: 0 }
    const failed: { game_id: string; error: string }[] = []

    if (items.length > 0) {
      const states = await sql`
        SELECT game_id,
          CASE WHEN jsonb_typeof(metadata->'screenshot_urls') = 'array'
               THEN jsonb_array_length(metadata->'screenshot_urls') ELSE 0 END > 0 AS has_storekit,
          CASE WHEN jsonb_typeof(metadata->'manual_screenshot_urls') = 'array'
               THEN jsonb_array_length(metadata->'manual_screenshot_urls') ELSE 0 END > 0 AS has_manual
        FROM game_info
        WHERE game_id IN ${sql(items.map(i => i.game_id))}
      `
      const stateById = new Map(states.map(s => [s.game_id as string, s]))

      for (const item of items) {
        const state = stateById.get(item.game_id)
        if (!state) { counts.skipped_not_found++; continue }
        if (state.has_storekit) { counts.skipped_has_storekit++; continue }
        if (state.has_manual) { counts.skipped_has_manual++; continue }

        const uploadedUrls: string[] = []
        let lastError = 'No valid images'
        for (let i = 0; i < item.image_urls.length; i++) {
          try {
            const res = await fetch(item.image_urls[i], { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
            if (!res.ok) { lastError = `download HTTP ${res.status}`; continue }
            const ct = (res.headers.get('content-type') || '').split(';')[0].trim()
            const ext = MIME_EXT[ct]
            if (!ext) { lastError = `unsupported type ${ct || 'unknown'}`; continue }
            const buf = Buffer.from(await res.arrayBuffer())
            if (buf.length > MAX_SIZE) { lastError = 'larger than 5MB'; continue }
            uploadedUrls.push(await uploadScreenshot(item.game_id, buf, ext, i))
          } catch (e) {
            lastError = e instanceof Error ? e.message : 'download failed'
          }
        }

        if (uploadedUrls.length === 0) {
          failed.push({ game_id: item.game_id, error: lastError })
          continue
        }

        await sql`
          UPDATE game_info
          SET metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{manual_screenshot_urls}',
            COALESCE(metadata->'manual_screenshot_urls', '[]'::jsonb) || ${sql.json(uploadedUrls)}
          )
          WHERE game_id = ${item.game_id}
        `
        counts.uploaded++
      }
    }

    return NextResponse.json({ ok: true, received: body.items.length, ...counts, failed })
  } catch (err) {
    console.error('POST /api/admin/import-screenshots error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
```

- [ ] **Step 4: `npx jest __tests__/api/import-screenshots.test.ts` → 8 PASS**
- [ ] **Step 5: `npx tsc --noEmit && npx next lint --file app/api/admin/import-screenshots/route.ts && npx jest __tests__/api/ __tests__/lib/`** — clean; only the 3 pre-existing evaluators/workflows-trigger failures remain.
- [ ] **Step 6: Commit**

```bash
git add app/api/admin/import-screenshots/route.ts __tests__/api/import-screenshots.test.ts
git commit -m "feat: import-screenshots API ingesting Smartsheet cell images as manual screenshots"
```

---

### Task 2: Demo Video field in `EvalDetailPanel`

**Files:**
- Modify: `components/EvalDetailPanel.tsx`

The panel already has `const [driveLink, setDriveLink] = useState('')`, `applyData` sets it from `data.drive_link`, and `save()` sends `body.drive_link = driveLink` when changed — only the input JSX is missing.

- [ ] **Step 1: Add the field.** In the Evaluation card, directly ABOVE the `{ev.youtube_link && (` block, insert:

```tsx
              <div className="field">
                <span className="label">Demo Video (Drive)</span>
                <input
                  className="input"
                  type="url"
                  value={driveLink}
                  onChange={e => { setDriveLink(e.target.value); setDirty(true) }}
                  placeholder="https://drive.google.com/..."
                  disabled={!canEditEval}
                />
                {ev.drive_link && (
                  <a href={ev.drive_link} target="_blank" rel="noopener"
                    style={{ fontSize: 12, color: 'var(--accent)', wordBreak: 'break-all' }}>
                    Open demo video
                  </a>
                )}
              </div>
```

- [ ] **Step 2: `npx tsc --noEmit && npx next lint --file components/EvalDetailPanel.tsx`** — clean (img warnings pre-existing).
- [ ] **Step 3: Commit**

```bash
git add components/EvalDetailPanel.tsx
git commit -m "feat: demo video (drive_link) field in eval detail panel"
```

---

### Task 3: Flow 1 — modify `workflows/smartsheet-to-db-evaluations.json`

**Files:**
- Modify: `workflows/smartsheet-to-db-evaluations.json`

Read the file first. Keep the existing 4 nodes/positions; make these changes:

- [ ] **Step 1: Build SQL node — add drive_link + DELETE prefix.** In the `jsCode`:
  - In the `out.push({...})` object add: `drive_link: clean(row['Drive Video']),`
  - Extend the INSERT statement: column list gains `drive_link`; the SELECT gains `v.drive_link`; the recordset definition gains `drive_link text`.
  - Prefix the statement (same string, before `INSERT`):
    `"DELETE FROM game_evaluations WHERE category_group = '" + category + "';\n"`
    (`category` is the code-node constant `'puzzle'` etc. — not user input; one DELETE per run as decided).

- [ ] **Step 2: Add the image branch** — 5 new nodes, all fed from `Get Sheet` (second connection from its output):

  a. **Collect Cell Images** (`n8n-nodes-base.code`):
  ```javascript
  // Rows whose StoreKit cell holds a pasted image → { game_id, imageId },
  // batched 50 per item for POST /imageurls.
  const out = [];
  const seen = new Set();
  for (const item of $input.all()) {
    const data = item.json || {};
    const cols = data.columns || [];
    const idByTitle = Object.fromEntries(cols.map(c => [c.title, c.id]));
    const gameIdCol = idByTitle['GameID'];
    const storeKitCol = idByTitle['StoreKit'];
    if (!gameIdCol || !storeKitCol) continue;
    for (const r of (data.rows || [])) {
      let gameId = null, imageId = null;
      for (const cell of (r.cells || [])) {
        if (cell.columnId === gameIdCol && cell.value != null) gameId = String(cell.value).trim();
        if (cell.columnId === storeKitCol && cell.image && cell.image.id) imageId = cell.image.id;
      }
      if (!gameId || !imageId || seen.has(gameId)) continue;
      seen.add(gameId);
      out.push({ game_id: gameId, imageId });
    }
  }
  const batches = [];
  for (let i = 0; i < out.length; i += 50) batches.push({ json: { batch: out.slice(i, i + 50) } });
  return batches.length ? batches : [{ json: { batch: [] } }];
  ```

  b. **Has Images?** (`n8n-nodes-base.if`): number condition `={{ $json.batch.length }}` larger than `0`; false branch ends.

  c. **Get Image URLs** (`n8n-nodes-base.httpRequest` 4.2): POST `https://api.smartsheet.com/2.0/imageurls`, same Smartsheet httpHeaderAuth credential placeholder as `Get Sheet`, `specifyBody: json`, `jsonBody`: `={{ JSON.stringify($json.batch.map(b => ({ imageId: b.imageId }))) }}`.

  d. **Build Items** (`n8n-nodes-base.code`):
  ```javascript
  // Join temporary URLs (expire ~30 min) back to game_ids by imageId; chunk 50 per app call.
  const sent = $('Has Images?').all();
  const responses = $input.all();
  const items = [];
  for (let i = 0; i < responses.length; i++) {
    const batch = (sent[i] && sent[i].json.batch) || [];
    const urlById = Object.fromEntries(((responses[i].json || {}).imageUrls || []).map(u => [u.imageId, u.url]));
    for (const b of batch) {
      const url = urlById[b.imageId];
      if (url) items.push({ game_id: b.game_id, image_urls: [url] });
    }
  }
  const chunks = [];
  for (let i = 0; i < items.length; i += 50) chunks.push({ json: { items: items.slice(i, i + 50) } });
  return chunks.length ? chunks : [{ json: { items: [] } }];
  ```

  e. **Has Items?** (`n8n-nodes-base.if`): `={{ $json.items.length }}` > 0 → **Send To App** (`n8n-nodes-base.httpRequest` 4.2): POST `=REPLACE_WITH_APP_URL/api/admin/import-screenshots`, `specifyBody: json`, `jsonBody`: `={{ JSON.stringify({ items: $json.items }) }}`, sendHeaders with header `x-webhook-secret` = `REPLACE_WITH_WEBHOOK_SECRET` (placeholder convention — user fills on import).

- [ ] **Step 3: Validate** — `python3 -c "import json; d=json.load(open('workflows/smartsheet-to-db-evaluations.json')); print(len(d['nodes']), 'nodes'); assert all(any(n['name']==k for n in d['nodes']) for k in d['connections'])"`
  Expected: `9 nodes`, no assertion error. Also verify the Build SQL code string still parses as a JSON string (no raw newlines outside `\n`).

- [ ] **Step 4: Commit**

```bash
git add workflows/smartsheet-to-db-evaluations.json
git commit -m "feat: flow 1 clears category, syncs Drive Video, catches StoreKit cell images"
```

---

### Task 4: Flow 2 — create `workflows/smartsheet-db-update-sync.json`

**Files:**
- Create: `workflows/smartsheet-db-update-sync.json`

Node graph (mirror flow 1's JSON style; read `workflows/smartsheet-delete-monitor.json` for the exact Google Sheets append node shape):

`Run (manual)` + `Daily (schedule)` → `Config` → `Get Modified Rows` → [upsert branch: `Build Upsert SQL` → `Upsert Rows`] and [image branch: `Collect Cell Images` → `Has Images?` → `Get Image URLs` → `Build Items` → `Has Items?` → `Send To App`] → both branches → `Summary` → `Log flow_log`

- [ ] **Step 1: Write the workflow.** Node specs:

1. **Run (manual)** — `n8n-nodes-base.manualTrigger`. **Daily (schedule)** — `n8n-nodes-base.scheduleTrigger` (interval: days=1, trigger at 06:00). Both connect to `Config`. The workflow JSON ships with `"active": false`.

2. **Config** — `n8n-nodes-base.code`:
```javascript
// ALL sheets in one run — rowsModifiedSince keeps payloads small.
// Add the remaining puzzle sheet ids here (puzzle spans ~6 sheets).
const LOOKBACK_HOURS = 48;
const sheets = [
  { sheetId: '2184120410001284', category: 'puzzle' },
  { sheetId: '3926172768358276', category: 'arcade' },
  { sheetId: '7899099241074564', category: 'simulation' },
];
const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
return sheets.map(s => ({ json: { ...s, since } }));
```

3. **Get Modified Rows** — `n8n-nodes-base.httpRequest` 4.2: `=https://api.smartsheet.com/2.0/sheets/{{ $json.sheetId }}?rowsModifiedSince={{ $json.since }}&includeAll=true`, Smartsheet httpHeaderAuth placeholder cred. Output: one item per sheet, only rows modified in the window (columns array still complete).

4. **Build Upsert SQL** — `n8n-nodes-base.code` (same flatten/clean/parse helpers as flow 1's Build SQL — copy them; category comes from the paired Config item):
```javascript
const out = [];
const seen = new Set();
function clean(v){ const s = v == null ? '' : String(v).trim(); return s === '' ? null : s; }
function parseTs(v){ const s = clean(v); if(!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d.toISOString(); }
function parseDate(v){ const t = parseTs(v); return t ? t.slice(0,10) : null; }

const configs = $('Config').all();
const inputs = $input.all();
for (let idx = 0; idx < inputs.length; idx++) {
  const data = inputs[idx].json || {};
  const category = configs[idx].json.category;
  const cols = data.columns || [];
  const idToTitle = Object.fromEntries(cols.map(c => [c.id, c.title]));
  for (const r of (data.rows || [])) {
    const row = {};
    for (const cell of (r.cells || [])) {
      const t = idToTitle[cell.columnId];
      if (t) row[t] = cell.value != null ? cell.value : (cell.displayValue != null ? cell.displayValue : '');
    }
    const gameId = clean(row['GameID']);
    if (!gameId) continue;
    const key = category + ':' + gameId;
    if (seen.has(key)) continue;
    seen.add(key);
    const sk = (clean(row['StoreKit']) || '').toLowerCase();
    let conclusion = clean(row['Initial Conclusion']);
    if (sk === 'x') conclusion = 'Link_dead';
    out.push({
      game_id: gameId,
      category_group: category,
      initial_evaluator: clean(row['Initial Evaluator']),
      assigned_date: parseDate(row['Assigned Date']),
      evaluate_date: parseTs(row['Evaluate Date']),
      initial_note: clean(row['Initial Evaluator note']),
      initial_conclusion: conclusion,
      genre_1: clean(row['Genre 1']),
      genre_2: clean(row['Genre 2']),
      youtube_link: clean(row['Youtube Video']),
      drive_link: clean(row['Drive Video']),
    });
  }
}

if (out.length === 0) return [{ json: { sql: 'SELECT 1;', count: 0 } }];

const jsonLit = JSON.stringify(out);
const sql =
  "INSERT INTO game_evaluations (game_id, category_group, initial_evaluator, assigned_date, evaluate_date, initial_note, initial_conclusion, genre_1, genre_2, youtube_link, drive_link)\n" +
  "SELECT v.game_id, v.category_group, v.initial_evaluator, v.assigned_date, v.evaluate_date, v.initial_note, v.initial_conclusion, v.genre_1, v.genre_2, v.youtube_link, v.drive_link\n" +
  "FROM json_to_recordset($jrows$" + jsonLit + "$jrows$::json) AS v(\n" +
  "  game_id text, category_group text, initial_evaluator text, assigned_date date,\n" +
  "  evaluate_date timestamptz, initial_note text, initial_conclusion text,\n" +
  "  genre_1 text, genre_2 text, youtube_link text, drive_link text)\n" +
  "WHERE EXISTS (SELECT 1 FROM game_info gi WHERE gi.game_id = v.game_id)\n" +
  "ON CONFLICT (game_id, category_group) DO UPDATE SET\n" +
  "  initial_evaluator = EXCLUDED.initial_evaluator,\n" +
  "  assigned_date = EXCLUDED.assigned_date,\n" +
  "  evaluate_date = EXCLUDED.evaluate_date,\n" +
  "  initial_note = EXCLUDED.initial_note,\n" +
  "  initial_conclusion = EXCLUDED.initial_conclusion,\n" +
  "  genre_1 = EXCLUDED.genre_1,\n" +
  "  genre_2 = EXCLUDED.genre_2,\n" +
  "  youtube_link = EXCLUDED.youtube_link,\n" +
  "  drive_link = EXCLUDED.drive_link,\n" +
  "  updated_at = NOW();";

return [{ json: { sql, count: out.length } }];
```
(Smartsheet wins on these fields; `final_evaluator`, `record_*`, manual screenshots untouched.)

5. **Upsert Rows** — `n8n-nodes-base.postgres` 2.6, executeQuery `={{ $json.sql }}`, credential id `KBZC0RGIJsc8d7GK` name `Postgres`.

6–10. **Image branch** — identical five nodes to flow 1 Task 3 Step 2 (Collect Cell Images / Has Images? / Get Image URLs / Build Items / Has Items? → Send To App), fed from `Get Modified Rows`'s output, with the same code and the same `REPLACE_WITH_APP_URL` / `REPLACE_WITH_WEBHOOK_SECRET` placeholders.

11. **Summary** — `n8n-nodes-base.code`, fed from BOTH `Upsert Rows` and `Send To App`:
```javascript
const agg = { upserted: 0, uploaded: 0, skipped_has_storekit: 0, skipped_has_manual: 0, skipped_not_found: 0, failed: 0 };
for (const item of $input.all()) {
  const j = item.json || {};
  if (typeof j.count === 'number') agg.upserted += j.count;       // from Build Upsert SQL passthrough
  agg.uploaded += j.uploaded || 0;
  agg.skipped_has_storekit += j.skipped_has_storekit || 0;
  agg.skipped_has_manual += j.skipped_has_manual || 0;
  agg.skipped_not_found += j.skipped_not_found || 0;
  agg.failed += (j.failed || []).length;
}
return [{ json: {
  date: new Date().toISOString(),
  name: 'smartsheet-update-sync',
  status: agg.failed === 0 ? 'success' : 'partial',
  note: JSON.stringify(agg),
  sheet_id: '',
} }];
```
Note: the Postgres node's output doesn't echo `count` — wire `Build Upsert SQL` → `Upsert Rows` → `Summary` and read the upsert count via `$('Build Upsert SQL').all()` inside Summary instead if simpler; either approach is fine as long as the note carries a real count.

12. **Log flow_log** — Google Sheets append, documentId `1yb558PpmunJcdDYCyVzdDpBfKDiIArMBG4IBI-eR0dg`, sheetName `flow_log`, columns date/name/status/note/sheet_id, cred `UMl5XCc7aOcf9yi3` `HandoverRequest-HungDT` (copy node shape from `workflows/smartsheet-delete-monitor.json`).

- [ ] **Step 2: Validate** — `python3 -c "import json; d=json.load(open('workflows/smartsheet-db-update-sync.json')); print(len(d['nodes']), 'nodes,', len(d['connections']), 'connection sources')"`
  Expected: 13 nodes (2 triggers + 11), every named connection source exists.

- [ ] **Step 3: Commit**

```bash
git add workflows/smartsheet-db-update-sync.json
git commit -m "feat: daily Smartsheet update-sync flow (rowsModifiedSince upsert + cell images)"
```

---

### Task 5: Verify + handoff

**Files:** none

- [ ] **Step 1: `npm run build`** — clean.
- [ ] **Step 2: Endpoint smoke (optional, env required):**
```bash
curl -s -X POST localhost:3333/api/admin/import-screenshots \
  -H "Content-Type: application/json" -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -d '{"items":[{"game_id":"<id-without-storekit>","image_urls":["https://picsum.photos/600/400.jpg"]}]}'
```
Expected: `uploaded: 1` or the correct skip counter; image visible in the detail modal.
- [ ] **Step 3: Handoff checklist (n8n, manual):**
1. Re-import the modified `smartsheet-to-db-evaluations.json` and the new `smartsheet-db-update-sync.json` into n8n cloud.
2. Wire the Smartsheet header-auth credential on every Smartsheet HTTP node; fill `REPLACE_WITH_APP_URL` (Replit deployment) and `REPLACE_WITH_WEBHOOK_SECRET` on both `Send To App` nodes; confirm Postgres + Google Sheets credentials resolved.
3. **Full rebuild:** run flow 1 once per sheet (swap the Sheet IDs/category constants each run: puzzle ids ×~6, arcade, simulation). Each run clears that category first.
4. Run flow 2 manually right after — it should report ~0 changes (everything just synced). Check the `flow_log` rows.
5. Activate flow 2's daily schedule. Deactivate it when the team stops working on Smartsheet (app published).
