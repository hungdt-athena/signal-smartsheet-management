# Smartsheet Cell-Image Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull screenshots that evaluators pasted into the StoreKit column cells on the games Smartsheets into Supabase as each game's manual screenshots, for games that have neither StoreKit nor manual images yet.

**Architecture:** The Smartsheet token lives only in n8n, so an n8n workflow (one sheet per run — the DB is composed from several Smartsheets) collects `{game_id, imageId}` pairs from StoreKit cells, resolves temporary image URLs via `POST /2.0/imageurls`, and POSTs `{items: [{game_id, image_urls}]}` batches to a new app endpoint. The endpoint downloads each image server-side and reuses the existing manual-screenshots machinery (`uploadScreenshot`, `sql.json` jsonb append, skip rules). Idempotent: games already having StoreKit or manual screenshots are skipped, so re-runs and future scheduled syncs are safe.

**Tech Stack:** Next.js 14 App Router route handler, `lib/supabase-storage.ts` (existing), postgres.js `sql.json`, Jest (node), n8n workflow JSON (manual trigger).

**Spec:** `docs/superpowers/specs/2026-06-12-smartsheet-screenshot-fallback-design.md`

**Grounding facts (verified in repo):**
- Reference n8n flow: `workflows/smartsheet-to-db-evaluations.json` — manual trigger, ONE sheet id per run (big sheets OOM n8n), Smartsheet HTTP header-auth credential placeholder `REPLACE_WITH_YOUR_SMARTSHEET_HEADER_AUTH_CRED_ID`.
- flow_log convention: Google Sheets node, documentId `1yb558PpmunJcdDYCyVzdDpBfKDiIArMBG4IBI-eR0dg`, sheetName `flow_log` (columns date, name, status, note, sheet_id), credential `googleSheetsOAuth2Api` id `UMl5XCc7aOcf9yi3` name `HandoverRequest-HungDT` (see `workflows/smartsheet-delete-monitor.json`).
- Sheet ids: puzzle `2184120410001284`, arcade `3926172768358276`, simulation `7899099241074564` (puzzle is additionally split across ~6 sheets — the Config node holds one id, swapped per run).
- App-side auth pattern: `x-webhook-secret` header OR admin session — copy from `app/api/admin/import-evaluations/route.ts:50-59`.
- jsonb writes MUST use `${sql.json(value)}` — `JSON.stringify(...)::jsonb` double-encodes in postgres.js (bug already hit and fixed in the screenshots route).

---

### Task 1: `POST /api/admin/import-screenshots` (TDD)

**Files:**
- Create: `__tests__/api/import-screenshots.test.ts`
- Create: `app/api/admin/import-screenshots/route.ts`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/api/import-screenshots.test.ts`:

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

- [ ] **Step 3: Implement `app/api/admin/import-screenshots/route.ts`**

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

- [ ] **Step 4: Run `npx jest __tests__/api/import-screenshots.test.ts` → 8 tests PASS**

- [ ] **Step 5: Lint + typecheck + full feature suites**

Run: `npx tsc --noEmit && npx next lint --file app/api/admin/import-screenshots/route.ts && npx jest __tests__/api/ __tests__/lib/`
Expected: clean; only the 3 pre-existing evaluators/workflows-trigger failures remain.

- [ ] **Step 6: Commit (only the two named files — dirty tree)**

```bash
git add app/api/admin/import-screenshots/route.ts __tests__/api/import-screenshots.test.ts
git commit -m "feat: import-screenshots API ingesting Smartsheet cell images as manual screenshots"
```

---

### Task 2: n8n workflow `workflows/smartsheet-storekit-images.json`

**Files:**
- Create: `workflows/smartsheet-storekit-images.json`

Read `workflows/smartsheet-to-db-evaluations.json` first (the conventions: manual trigger, one-sheet-per-run Config code node, Smartsheet header-auth credential placeholder) and the flow_log Google Sheets node in `workflows/smartsheet-delete-monitor.json`.

- [ ] **Step 1: Write the workflow file** with this exact node graph (positions are layout-only; keep the JSON valid for n8n import):

`Run (manual)` → `Config (swap per run)` → `Get Sheet` → `Collect Cell Images` → `Has Images?` (IF) → `Get Image URLs` → `Build Items` → `Has Items?` (IF) → `Send To App` → `Summary` → `Log flow_log`

Node specs:

1. **Run (manual)** — `n8n-nodes-base.manualTrigger`.

2. **Config (swap per run)** — `n8n-nodes-base.code`:
```javascript
// ONE sheet per run (big sheets OOM n8n — same rule as smartsheet-to-db-evaluations).
// Swap these two lines per run. Sheets: puzzle 2184120410001284 (split across ~6 ids),
// arcade 3926172768358276, simulation 7899099241074564.
const sheetId = '2184120410001284';
const category = 'puzzle';
return [{ json: { sheetId, category } }];
```

3. **Get Sheet** — `n8n-nodes-base.httpRequest` v4.2: `=https://api.smartsheet.com/2.0/sheets/{{ $json.sheetId }}?includeAll=true`, `genericCredentialType`/`httpHeaderAuth`, credentials id `REPLACE_WITH_YOUR_SMARTSHEET_HEADER_AUTH_CRED_ID` name `Smartsheet Authorization Header` (same placeholder convention as the reference flow — the user wires the real credential on import).

4. **Collect Cell Images** — `n8n-nodes-base.code`:
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

5. **Has Images?** — `n8n-nodes-base.if`: number condition `={{ $json.batch.length }}` larger than `0`. False branch ends.

6. **Get Image URLs** — `n8n-nodes-base.httpRequest` v4.2: POST `https://api.smartsheet.com/2.0/imageurls`, same Smartsheet credential, `specifyBody: json`, `jsonBody`: `={{ JSON.stringify($json.batch.map(b => ({ imageId: b.imageId }))) }}`. (Response: `{ imageUrls: [{ imageId, url }], urlExpiresInMillis }` — URLs are temporary, so the flow continues to delivery immediately.)

7. **Build Items** — `n8n-nodes-base.code`:
```javascript
// Join temporary URLs back to game_ids by imageId; chunk 50 per app call.
const sent = $('Has Images?').all();      // batches, same order as responses
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

8. **Has Items?** — `n8n-nodes-base.if`: `={{ $json.items.length }}` larger than `0`.

9. **Send To App** — `n8n-nodes-base.httpRequest` v4.2: POST `=REPLACE_WITH_APP_URL/api/admin/import-screenshots`, `specifyBody: json`, `jsonBody`: `={{ JSON.stringify({ items: $json.items }) }}`, sendHeaders with header `x-webhook-secret` value `REPLACE_WITH_WEBHOOK_SECRET` (user fills both placeholders on import; APP_URL is the Replit deployment).

10. **Summary** — `n8n-nodes-base.code`:
```javascript
// One flow_log row per run with aggregate counts from all app responses.
const agg = { uploaded: 0, skipped_has_storekit: 0, skipped_has_manual: 0, skipped_not_found: 0, failed: 0 };
for (const item of $input.all()) {
  const j = item.json || {};
  agg.uploaded += j.uploaded || 0;
  agg.skipped_has_storekit += j.skipped_has_storekit || 0;
  agg.skipped_has_manual += j.skipped_has_manual || 0;
  agg.skipped_not_found += j.skipped_not_found || 0;
  agg.failed += (j.failed || []).length;
}
const cfg = $('Config (swap per run)').first().json;
return [{ json: {
  date: new Date().toISOString(),
  name: 'storekit-images-' + cfg.category,
  status: agg.failed === 0 ? 'success' : 'partial',
  note: JSON.stringify(agg),
  sheet_id: cfg.sheetId,
} }];
```

11. **Log flow_log** — `n8n-nodes-base.googleSheets` v4.5, operation `append`, documentId `1yb558PpmunJcdDYCyVzdDpBfKDiIArMBG4IBI-eR0dg` (mode id), sheetName `flow_log` (mode name), columns mapped from `date, name, status, note, sheet_id`, credential `googleSheetsOAuth2Api` id `UMl5XCc7aOcf9yi3` name `HandoverRequest-HungDT` (copy the exact parameter shape from the flow_log node in `workflows/smartsheet-delete-monitor.json`).

- [ ] **Step 2: Validate the JSON**

Run: `python3 -c "import json; d=json.load(open('workflows/smartsheet-storekit-images.json')); print(len(d['nodes']), 'nodes,', len(d['connections']), 'connections')"`
Expected: `11 nodes, 10 connections` (every non-trigger node referenced in `connections`; IF nodes wire their `true` output forward).

- [ ] **Step 3: Commit**

```bash
git add workflows/smartsheet-storekit-images.json
git commit -m "feat: n8n flow pulling StoreKit cell images into the screenshots API"
```

---

### Task 3: Verify + handoff

**Files:** none (verification only)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 2: Local endpoint smoke (optional, requires env)**

With the dev server running and a known game_id lacking StoreKit:
```bash
curl -s -X POST localhost:3333/api/admin/import-screenshots \
  -H "Content-Type: application/json" -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -d '{"items":[{"game_id":"<id>","image_urls":["https://picsum.photos/600/400.jpg"]}]}'
```
Expected: `uploaded: 1` (or the appropriate skip counter), image visible in the eval detail modal.

- [ ] **Step 3: Handoff checklist for the user (n8n side — manual)**

1. Import `workflows/smartsheet-storekit-images.json` into n8n cloud.
2. Wire the Smartsheet header-auth credential on `Get Sheet` + `Get Image URLs`; set `REPLACE_WITH_APP_URL` and `REPLACE_WITH_WEBHOOK_SECRET` on `Send To App`.
3. Run with the **puzzle** sheet first (smallest), check the `flow_log` row + spot-check one game in the UI, then swap the Config node per sheet (arcade, simulation, remaining puzzle sheet ids) and re-run.
