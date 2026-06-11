# Manual Screenshots (Supabase Storage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the team attach manual store screenshots (paste / drag / pick, explicit Save) to games whose StoreKit images haven't arrived, persisted in a public Supabase Storage bucket and auto-deleted once StoreKit data shows up.

**Architecture:** A thin server-side storage helper (`lib/supabase-storage.ts`) wraps the Supabase Storage SDK. New `POST`/`DELETE` routes under `app/api/evaluations/[gameId]/screenshots/` handle upload/removal and keep `game_info.metadata->'manual_screenshot_urls'` in sync. The existing game-detail GET returns manual URLs when StoreKit is absent and lazily fire-and-forgets cleanup when both exist. The UI is a new `components/ManualScreenshotsCard.tsx` rendered by `EvalDetailPanel` in place of the StoreKit card.

**Tech Stack:** Next.js 14 App Router, `@supabase/supabase-js` (new dependency), postgres.js tagged templates (`lib/db.ts`), Jest (node env, mock-by-module).

**Spec:** `docs/superpowers/specs/2026-06-11-manual-screenshots-design.md`

**Operational prerequisites (user, not code):** create public bucket `game-screenshots` in the Supabase dashboard; set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` env vars on Replit/local `.env.local`.

---

### Task 1: Storage helper `lib/supabase-storage.ts`

**Files:**
- Create: `lib/supabase-storage.ts`
- Create: `__tests__/lib/supabase-storage.test.ts`
- Modify: `package.json` (new dependency)

- [ ] **Step 1: Install the SDK**

Run: `npm install @supabase/supabase-js`
Expected: added to `dependencies` in package.json, no peer warnings that block install.

- [ ] **Step 2: Write the failing tests**

Create `__tests__/lib/supabase-storage.test.ts`:

```typescript
/**
 * @jest-environment node
 */
import { isStorageConfigured, pathFromPublicUrl } from '@/lib/supabase-storage'

describe('supabase-storage helpers', () => {
  const OLD_ENV = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY }
  afterEach(() => {
    process.env.SUPABASE_URL = OLD_ENV.url
    process.env.SUPABASE_SERVICE_KEY = OLD_ENV.key
  })

  it('isStorageConfigured requires both env vars', () => {
    process.env.SUPABASE_URL = 'https://x.supabase.co'
    delete process.env.SUPABASE_SERVICE_KEY
    expect(isStorageConfigured()).toBe(false)
    process.env.SUPABASE_SERVICE_KEY = 'svc'
    expect(isStorageConfigured()).toBe(true)
    delete process.env.SUPABASE_URL
    expect(isStorageConfigured()).toBe(false)
  })

  it('pathFromPublicUrl extracts the object path from our bucket URLs', () => {
    expect(pathFromPublicUrl(
      'https://x.supabase.co/storage/v1/object/public/game-screenshots/game123/1717000000-0.png'
    )).toBe('game123/1717000000-0.png')
  })

  it('pathFromPublicUrl rejects foreign URLs', () => {
    expect(pathFromPublicUrl('https://x.supabase.co/storage/v1/object/public/other-bucket/a.png')).toBeNull()
    expect(pathFromPublicUrl('https://evil.com/storage/v1/object/public/game-screenshots/')).toBeNull()
    expect(pathFromPublicUrl('not a url')).toBeNull()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest __tests__/lib/supabase-storage.test.ts`
Expected: FAIL — module `@/lib/supabase-storage` not found.

- [ ] **Step 4: Implement `lib/supabase-storage.ts`**

```typescript
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const BUCKET = 'game-screenshots'

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
}

export function isStorageConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
}

let client: SupabaseClient | null = null
function getClient(): SupabaseClient {
  if (!client) {
    client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!, {
      auth: { persistSession: false },
    })
  }
  return client
}

/** Uploads one image under <gameId>/ and returns its public URL. */
export async function uploadScreenshot(gameId: string, buffer: Buffer, ext: string, index: number): Promise<string> {
  const path = `${gameId}/${Date.now()}-${index}.${ext}`
  const { error } = await getClient().storage.from(BUCKET).upload(path, buffer, {
    contentType: EXT_MIME[ext] || 'application/octet-stream',
    upsert: false,
  })
  if (error) throw new Error(error.message)
  return getClient().storage.from(BUCKET).getPublicUrl(path).data.publicUrl
}

/** Derives the bucket object path from a public URL; null if it isn't ours. */
export function pathFromPublicUrl(url: string): string | null {
  const marker = `/storage/v1/object/public/${BUCKET}/`
  const idx = url.indexOf(marker)
  if (idx === -1) return null
  const path = url.slice(idx + marker.length)
  return path || null
}

export async function deleteScreenshotByUrl(url: string): Promise<void> {
  const path = pathFromPublicUrl(url)
  if (!path) throw new Error('URL does not belong to the screenshots bucket')
  const { error } = await getClient().storage.from(BUCKET).remove([decodeURIComponent(path)])
  if (error) throw new Error(error.message)
}

/** Removes every object under the game's prefix. No-op when the prefix is empty. */
export async function deleteGameScreenshots(gameId: string): Promise<void> {
  const { data, error } = await getClient().storage.from(BUCKET).list(gameId)
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) return
  const paths = data.map(f => `${gameId}/${f.name}`)
  const { error: rmErr } = await getClient().storage.from(BUCKET).remove(paths)
  if (rmErr) throw new Error(rmErr.message)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest __tests__/lib/supabase-storage.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add lib/supabase-storage.ts __tests__/lib/supabase-storage.test.ts package.json package-lock.json
git commit -m "feat: supabase storage helper for manual game screenshots"
```

---

### Task 2: Upload/delete API route

**Files:**
- Create: `app/api/evaluations/[gameId]/screenshots/route.ts`
- Create: `__tests__/api/screenshots.test.ts`

The route follows the codebase idiom: `requireAuth()` guard first, `getServerSession` for role checks (skipped when `SKIP_AUTH=true`), postgres.js tagged templates from `@/lib/db`. Permission rule (from spec): admin/moderator, or session user name equals the game's `initial_evaluator` in `game_evaluations`.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/api/screenshots.test.ts`:

```typescript
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/supabase-storage', () => ({
  isStorageConfigured: jest.fn(() => true),
  uploadScreenshot: jest.fn(),
  deleteScreenshotByUrl: jest.fn(),
  deleteGameScreenshots: jest.fn(),
}))

import { POST, DELETE } from '@/app/api/evaluations/[gameId]/screenshots/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'
import {
  isStorageConfigured, uploadScreenshot, deleteScreenshotByUrl, deleteGameScreenshots,
} from '@/lib/supabase-storage'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as jest.Mock
const PARAMS = { params: { gameId: 'game123' } }

function pngFile(name = 'shot.png', bytes = 100): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' })
}

function postReq(files: File[]): NextRequest {
  const form = new FormData()
  files.forEach(f => form.append('files', f))
  return new NextRequest('http://localhost/api/evaluations/game123/screenshots', {
    method: 'POST',
    body: form,
  })
}

function deleteReq(body?: object): NextRequest {
  return new NextRequest('http://localhost/api/evaluations/game123/screenshots', {
    method: 'DELETE',
    body: JSON.stringify(body ?? {}),
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('screenshots route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env.SKIP_AUTH = 'false'
    ;(isStorageConfigured as jest.Mock).mockReturnValue(true)
    // default: admin session
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'Boss' } })
    // default sql behavior: evaluator lookup + metadata update both succeed
    sqlMock.mockImplementation((strings: unknown) => {
      if (!Array.isArray(strings)) return Promise.resolve([])
      const q = (strings as string[]).join(' ')
      if (q.includes('SELECT initial_evaluator')) return Promise.resolve([{ initial_evaluator: 'Nam' }])
      if (q.includes('UPDATE game_info')) return Promise.resolve([{ urls: ['u1', 'u2'] }])
      if (q.includes('SELECT metadata')) return Promise.resolve([{ urls: [] }])
      return Promise.resolve([])
    })
  })

  it('401 without a session', async () => {
    sessionMock.mockResolvedValue(null)
    const res = await POST(postReq([pngFile()]), PARAMS)
    expect(res.status).toBe(401)
  })

  it('403 for an evaluator who is not assigned', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'SomeoneElse' } })
    const res = await POST(postReq([pngFile()]), PARAMS)
    expect(res.status).toBe(403)
  })

  it('allows the assigned evaluator', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Nam' } })
    ;(uploadScreenshot as jest.Mock).mockResolvedValue('https://x/u1.png')
    const res = await POST(postReq([pngFile()]), PARAMS)
    expect(res.status).toBe(200)
  })

  it('503 when storage is not configured', async () => {
    ;(isStorageConfigured as jest.Mock).mockReturnValue(false)
    const res = await POST(postReq([pngFile()]), PARAMS)
    expect(res.status).toBe(503)
  })

  it('400 when more than 10 files', async () => {
    const res = await POST(postReq(Array.from({ length: 11 }, (_, i) => pngFile(`s${i}.png`))), PARAMS)
    expect(res.status).toBe(400)
  })

  it('rejects oversized and wrong-type files into failed[] without uploading them', async () => {
    ;(uploadScreenshot as jest.Mock).mockResolvedValue('https://x/ok.png')
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })
    const gif = new File([new Uint8Array(10)], 'anim.gif', { type: 'image/gif' })
    const res = await POST(postReq([pngFile('ok.png'), big, gif]), PARAMS)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(uploadScreenshot).toHaveBeenCalledTimes(1)
    expect(json.failed.map((f: { name: string }) => f.name).sort()).toEqual(['anim.gif', 'big.png'])
  })

  it('appends uploaded URLs to metadata and returns the full array', async () => {
    ;(uploadScreenshot as jest.Mock)
      .mockResolvedValueOnce('https://x/u1.png')
      .mockResolvedValueOnce('https://x/u2.png')
    const res = await POST(postReq([pngFile('a.png'), pngFile('b.png')]), PARAMS)
    const json = await res.json()
    expect(json.urls).toEqual(['u1', 'u2'])
    expect(json.failed).toEqual([])
    const updateCall = sqlMock.mock.calls.find(c => Array.isArray(c[0]) && (c[0] as string[]).join(' ').includes('UPDATE game_info'))
    expect(updateCall).toBeTruthy()
  })

  it('a failed upload lands in failed[] while successes persist', async () => {
    ;(uploadScreenshot as jest.Mock)
      .mockResolvedValueOnce('https://x/u1.png')
      .mockRejectedValueOnce(new Error('storage down'))
    const res = await POST(postReq([pngFile('a.png'), pngFile('b.png')]), PARAMS)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.failed).toEqual([{ name: 'b.png', error: 'storage down' }])
  })

  it('DELETE with url removes one object and filters metadata', async () => {
    const res = await DELETE(deleteReq({ url: 'https://x/storage/v1/object/public/game-screenshots/game123/1-0.png' }), PARAMS)
    expect(res.status).toBe(200)
    expect(deleteScreenshotByUrl).toHaveBeenCalledWith('https://x/storage/v1/object/public/game-screenshots/game123/1-0.png')
  })

  it('DELETE without url clears everything', async () => {
    const res = await DELETE(deleteReq(), PARAMS)
    expect(res.status).toBe(200)
    expect(deleteGameScreenshots).toHaveBeenCalledWith('game123')
  })

  it('DELETE is forbidden for a non-assigned evaluator', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'SomeoneElse' } })
    const res = await DELETE(deleteReq(), PARAMS)
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest __tests__/api/screenshots.test.ts`
Expected: FAIL — route module not found.

- [ ] **Step 3: Implement the route**

Create `app/api/evaluations/[gameId]/screenshots/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireAuth } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'
import {
  isStorageConfigured, uploadScreenshot,
  deleteScreenshotByUrl, deleteGameScreenshots,
} from '@/lib/supabase-storage'

export const dynamic = 'force-dynamic'

const MAX_FILES = 10
const MAX_SIZE = 5 * 1024 * 1024
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** Allowed: admin/moderator, or the game's assigned initial evaluator. Null when allowed. */
async function checkPermission(gameId: string): Promise<NextResponse | null> {
  if (process.env.SKIP_AUTH === 'true') return null
  const session = await getServerSession(authOptions)
  const role = session?.user?.role
  if (role === 'admin' || role === 'moderator') return null
  const rows = await sql`SELECT initial_evaluator FROM game_evaluations WHERE game_id = ${gameId}`
  if (rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (rows[0].initial_evaluator !== session?.user?.name) {
    return NextResponse.json({ error: 'Forbidden: not your evaluation' }, { status: 403 })
  }
  return null
}

export async function POST(req: NextRequest, { params }: { params: { gameId: string } }) {
  const guard = await requireAuth()
  if (guard) return guard

  try {
    const gameId = params.gameId
    const denied = await checkPermission(gameId)
    if (denied) return denied
    if (!isStorageConfigured()) {
      return NextResponse.json({ error: 'Storage not configured' }, { status: 503 })
    }

    const form = await req.formData()
    const files = form.getAll('files').filter((f): f is File => typeof f !== 'string')
    if (files.length === 0) return NextResponse.json({ error: 'No files' }, { status: 400 })
    if (files.length > MAX_FILES) {
      return NextResponse.json({ error: `Max ${MAX_FILES} files per save` }, { status: 400 })
    }

    const uploaded: string[] = []
    const failed: { name: string; error: string }[] = []
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const ext = MIME_EXT[f.type]
      if (!ext) { failed.push({ name: f.name, error: 'Unsupported type' }); continue }
      if (f.size > MAX_SIZE) { failed.push({ name: f.name, error: 'Larger than 5MB' }); continue }
      try {
        const buf = Buffer.from(await f.arrayBuffer())
        uploaded.push(await uploadScreenshot(gameId, buf, ext, i))
      } catch (e) {
        failed.push({ name: f.name, error: e instanceof Error ? e.message : 'Upload failed' })
      }
    }

    let urls: string[] = []
    if (uploaded.length > 0) {
      const rows = await sql`
        UPDATE game_info
        SET metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{manual_screenshot_urls}',
          COALESCE(metadata->'manual_screenshot_urls', '[]'::jsonb) || ${JSON.stringify(uploaded)}::jsonb
        )
        WHERE game_id = ${gameId}
        RETURNING metadata->'manual_screenshot_urls' AS urls
      `
      if (rows.length === 0) return NextResponse.json({ error: 'Game not found' }, { status: 404 })
      urls = rows[0].urls || []
    } else {
      const rows = await sql`SELECT metadata->'manual_screenshot_urls' AS urls FROM game_info WHERE game_id = ${gameId}`
      urls = rows[0]?.urls || []
    }

    return NextResponse.json({ urls, failed })
  } catch (err) {
    console.error('POST /api/evaluations/[gameId]/screenshots error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { gameId: string } }) {
  const guard = await requireAuth()
  if (guard) return guard

  try {
    const gameId = params.gameId
    const denied = await checkPermission(gameId)
    if (denied) return denied
    if (!isStorageConfigured()) {
      return NextResponse.json({ error: 'Storage not configured' }, { status: 503 })
    }

    const body = await req.json().catch(() => ({}))
    const url: string | undefined = body.url

    if (url) {
      await deleteScreenshotByUrl(url)
      const rows = await sql`
        UPDATE game_info
        SET metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{manual_screenshot_urls}',
          COALESCE((
            SELECT jsonb_agg(u)
            FROM jsonb_array_elements(COALESCE(metadata->'manual_screenshot_urls', '[]'::jsonb)) AS u
            WHERE u != ${JSON.stringify(url)}::jsonb
          ), '[]'::jsonb)
        )
        WHERE game_id = ${gameId}
        RETURNING metadata->'manual_screenshot_urls' AS urls
      `
      return NextResponse.json({ urls: rows[0]?.urls || [] })
    }

    await deleteGameScreenshots(gameId)
    await sql`UPDATE game_info SET metadata = metadata - 'manual_screenshot_urls' WHERE game_id = ${gameId}`
    return NextResponse.json({ urls: [] })
  } catch (err) {
    console.error('DELETE /api/evaluations/[gameId]/screenshots error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
```

Note on the 401 test: `requireAuth()` (lib/auth-guard.ts) calls the mocked `getServerSession` and returns 401 when it resolves null — no extra wiring needed. If `req.formData()` misbehaves under the jest node environment (File/FormData come from undici in Node ≥18 and normally work with Next 14), report DONE_WITH_CONCERNS rather than hacking around it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest __tests__/api/screenshots.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Lint and commit**

Run: `npx next lint --file "app/api/evaluations/[gameId]/screenshots/route.ts" && npx tsc --noEmit`
Expected: clean

```bash
git add "app/api/evaluations/[gameId]/screenshots/route.ts" __tests__/api/screenshots.test.ts
git commit -m "feat: upload/delete API for manual game screenshots"
```

---

### Task 3: Detail GET returns manual URLs + lazy cleanup

**Files:**
- Modify: `app/api/evaluations/[gameId]/route.ts`
- Create: `__tests__/api/eval-detail.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/api/eval-detail.test.ts`:

```typescript
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('@/lib/supabase-storage', () => ({
  isStorageConfigured: jest.fn(() => true),
  deleteGameScreenshots: jest.fn().mockResolvedValue(undefined),
}))

import { GET } from '@/app/api/evaluations/[gameId]/route'
import { sql } from '@/lib/db'
import { isStorageConfigured, deleteGameScreenshots } from '@/lib/supabase-storage'

const sqlMock = sql as unknown as jest.Mock
const PARAMS = { params: { gameId: 'game123' } }

function setupRow(row: Record<string, unknown>) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('SELECT ge.id')) return Promise.resolve([row])
    return Promise.resolve([])
  })
}

function metadataClearCalled(): boolean {
  return sqlMock.mock.calls.some(c =>
    Array.isArray(c[0]) && (c[0] as string[]).join(' ').includes("- 'manual_screenshot_urls'"))
}

const flush = () => new Promise(r => setTimeout(r, 0))

describe('GET /api/evaluations/[gameId] manual screenshots', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { jest.clearAllMocks() })

  const req = new NextRequest('http://localhost/api/evaluations/game123')

  it('returns manual URLs when StoreKit is absent', async () => {
    setupRow({ game_id: 'game123', screenshot_urls: null, manual_screenshot_urls: ['m1', 'm2'] })
    const res = await GET(req, PARAMS)
    const json = await res.json()
    expect(json.data.manual_screenshot_urls).toEqual(['m1', 'm2'])
    expect(deleteGameScreenshots).not.toHaveBeenCalled()
  })

  it('returns StoreKit and triggers cleanup when both exist', async () => {
    setupRow({ game_id: 'game123', screenshot_urls: ['s1'], manual_screenshot_urls: ['m1'] })
    const res = await GET(req, PARAMS)
    const json = await res.json()
    expect(json.data.screenshot_urls).toEqual(['s1'])
    expect(json.data.manual_screenshot_urls).toBeNull()
    await flush()
    expect(deleteGameScreenshots).toHaveBeenCalledWith('game123')
    expect(metadataClearCalled()).toBe(true)
  })

  it('does not clean up when storage is unconfigured', async () => {
    ;(isStorageConfigured as jest.Mock).mockReturnValue(false)
    setupRow({ game_id: 'game123', screenshot_urls: ['s1'], manual_screenshot_urls: ['m1'] })
    const res = await GET(req, PARAMS)
    const json = await res.json()
    expect(json.data.manual_screenshot_urls).toBeNull()
    await flush()
    expect(deleteGameScreenshots).not.toHaveBeenCalled()
    expect(metadataClearCalled()).toBe(false)
  })

  it('plain StoreKit-only games are untouched', async () => {
    setupRow({ game_id: 'game123', screenshot_urls: ['s1'], manual_screenshot_urls: null })
    const res = await GET(req, PARAMS)
    const json = await res.json()
    expect(json.data.screenshot_urls).toEqual(['s1'])
    await flush()
    expect(deleteGameScreenshots).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest __tests__/api/eval-detail.test.ts`
Expected: FAIL — `manual_screenshot_urls` undefined in response (and no cleanup calls).

- [ ] **Step 3: Modify the GET**

In `app/api/evaluations/[gameId]/route.ts`:

Add imports:
```typescript
import { isStorageConfigured, deleteGameScreenshots } from '@/lib/supabase-storage'
```

In the SELECT, after the line `gi.metadata->'screenshot_urls' AS screenshot_urls,` add:
```sql
        gi.metadata->'manual_screenshot_urls' AS manual_screenshot_urls,
```

Add above the GET function:
```typescript
/** Fire-and-forget: StoreKit arrived, so drop the temporary manual copies.
 *  Idempotent — any later view retries if this run fails. */
function cleanupManualScreenshots(gameId: string) {
  if (!isStorageConfigured()) return
  Promise.resolve().then(async () => {
    await deleteGameScreenshots(gameId)
    await sql`UPDATE game_info SET metadata = metadata - 'manual_screenshot_urls' WHERE game_id = ${gameId}`
  }).catch(err => console.error('manual screenshot cleanup failed:', gameId, err))
}
```

Replace the final `return NextResponse.json({ data: rows[0] })` with:
```typescript
    const row = rows[0]
    const hasStoreKit = Array.isArray(row.screenshot_urls) && row.screenshot_urls.length > 0
    const hasManual = Array.isArray(row.manual_screenshot_urls) && row.manual_screenshot_urls.length > 0
    if (hasStoreKit) {
      if (hasManual) cleanupManualScreenshots(gameId)
      row.manual_screenshot_urls = null
    }
    return NextResponse.json({ data: row })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest __tests__/api/eval-detail.test.ts __tests__/api/screenshots.test.ts __tests__/api/evaluations.test.ts`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add "app/api/evaluations/[gameId]/route.ts" __tests__/api/eval-detail.test.ts
git commit -m "feat: serve manual screenshots in game detail with lazy StoreKit cleanup"
```

---

### Task 4: `ManualScreenshotsCard` component + panel integration

**Files:**
- Create: `components/ManualScreenshotsCard.tsx`
- Modify: `components/EvalDetailPanel.tsx`

No jest UI tests (repo has no component-test setup for complex interactions); verification is typecheck + lint + the manual smoke check in Task 5.

- [ ] **Step 1: Create `components/ManualScreenshotsCard.tsx`**

```tsx
'use client'
import { useState, useEffect, useRef, useCallback } from 'react'

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp']
const MAX_FILES = 10
const MAX_SIZE = 5 * 1024 * 1024

interface Staged { file: File; preview: string }

interface Props {
  gameId: string
  urls: string[]
  canEdit: boolean
  /** Reports the authoritative URL array after every save/delete. */
  onChange: (urls: string[]) => void
  onExpand: (url: string) => void
  onToast: (msg: string, err?: boolean) => void
}

export default function ManualScreenshotsCard({ gameId, urls, canEdit, onChange, onExpand, onToast }: Props) {
  const [staged, setStaged] = useState<Staged[]>([])
  const [saving, setSaving] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const stageFiles = useCallback((files: File[]) => {
    setStaged(prev => {
      const next = [...prev]
      for (const f of files) {
        if (!ACCEPTED.includes(f.type)) { onToast(`${f.name}: chỉ nhận PNG/JPEG/WebP`, true); continue }
        if (f.size > MAX_SIZE) { onToast(`${f.name}: vượt quá 5MB`, true); continue }
        if (next.length >= MAX_FILES) { onToast(`Tối đa ${MAX_FILES} ảnh mỗi lần lưu`, true); break }
        next.push({ file: f, preview: URL.createObjectURL(f) })
      }
      return next
    })
  }, [onToast])

  // Ctrl+V paste — active while this card is mounted, except when typing in a field.
  useEffect(() => {
    if (!canEdit) return
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return
      const files = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/'))
      if (files.length > 0) { e.preventDefault(); stageFiles(files) }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [canEdit, stageFiles])

  // Revoke object URLs on unmount.
  useEffect(() => () => { staged.forEach(s => URL.revokeObjectURL(s.preview)) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const unstage = (preview: string) => {
    setStaged(prev => {
      const hit = prev.find(s => s.preview === preview)
      if (hit) URL.revokeObjectURL(hit.preview)
      return prev.filter(s => s.preview !== preview)
    })
  }

  const save = async () => {
    if (staged.length === 0 || saving) return
    setSaving(true)
    try {
      const form = new FormData()
      staged.forEach(s => form.append('files', s.file, s.file.name || 'pasted.png'))
      const res = await fetch(`/api/evaluations/${encodeURIComponent(gameId)}/screenshots`, {
        method: 'POST', body: form,
      })
      const json = await res.json()
      if (!res.ok) {
        onToast(json.error || 'Lưu ảnh thất bại', true)
      } else {
        onChange(json.urls || [])
        const failedNames = new Set((json.failed || []).map((f: { name: string }) => f.name))
        setStaged(prev => {
          prev.filter(s => !failedNames.has(s.file.name)).forEach(s => URL.revokeObjectURL(s.preview))
          return prev.filter(s => failedNames.has(s.file.name))
        })
        if (failedNames.size > 0) onToast(`${failedNames.size} ảnh lỗi — thử lưu lại`, true)
        else onToast('Đã lưu ảnh')
      }
    } catch { onToast('Network error', true) }
    setSaving(false)
  }

  const removeSaved = async (url: string) => {
    try {
      const res = await fetch(`/api/evaluations/${encodeURIComponent(gameId)}/screenshots`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const json = await res.json()
      if (!res.ok) onToast(json.error || 'Xoá thất bại', true)
      else { onChange(json.urls || []); onToast('Đã xoá ảnh') }
    } catch { onToast('Network error', true) }
  }

  return (
    <div className="card" style={{ margin: 0 }}>
      <div className="card-head">
        <span className="card-label">
          Screenshots <span className="pill muted" style={{ fontSize: 9, marginLeft: 6 }}>manual</span>
          {urls.length > 0 && ` (${urls.length})`}
        </span>
        {urls.length > 0 && (
          <button className="btn btn-sm btn-ghost" onClick={() => onExpand(urls[0])}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
            Expand
          </button>
        )}
      </div>

      {urls.length > 0 && (
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4, marginBottom: canEdit ? 10 : 0 }}>
          {urls.map((url, i) => (
            <div key={url} style={{ position: 'relative', flexShrink: 0 }}>
              <img src={url} alt={`Manual screenshot ${i + 1}`}
                onClick={() => onExpand(url)}
                className="screenshot-item"
                style={{ height: 220, borderRadius: 10, border: '1px solid var(--border)', cursor: 'pointer' }}
                loading="lazy"
                onError={e => { e.currentTarget.style.display = 'none' }} />
              {canEdit && (
                <button onClick={() => removeSaved(url)} title="Xoá ảnh này"
                  style={{
                    position: 'absolute', top: 6, right: 6, width: 24, height: 24, borderRadius: 12,
                    background: 'rgba(0,0,0,.55)', color: '#fff', border: 'none', cursor: 'pointer',
                    display: 'grid', placeItems: 'center', fontSize: 13, lineHeight: 1,
                  }}>
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canEdit && (
        <>
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => {
              e.preventDefault(); setDragOver(false)
              stageFiles(Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/')))
            }}
            style={{
              border: `1.5px dashed ${dragOver ? 'var(--accent)' : 'var(--border-strong)'}`,
              background: dragOver ? 'var(--accent-weak)' : 'var(--surface-2)',
              borderRadius: 10, padding: '18px 12px', textAlign: 'center', cursor: 'pointer',
              fontSize: 12, color: 'var(--muted)',
            }}>
            Dán ảnh (Ctrl+V), kéo thả, hoặc bấm để chọn — PNG/JPEG/WebP, ≤5MB
            <input ref={fileInputRef} type="file" multiple accept={ACCEPTED.join(',')}
              style={{ display: 'none' }}
              onChange={e => {
                stageFiles(Array.from(e.target.files ?? []))
                e.target.value = ''
              }} />
          </div>

          {staged.length > 0 && (
            <>
              <div style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '10px 0 4px' }}>
                {staged.map(s => (
                  <div key={s.preview} style={{ position: 'relative', flexShrink: 0 }}>
                    <img src={s.preview} alt={s.file.name}
                      style={{ height: 120, borderRadius: 8, border: '1.5px dashed var(--warn)' }} />
                    <button onClick={() => unstage(s.preview)} title="Bỏ ảnh này"
                      style={{
                        position: 'absolute', top: 4, right: 4, width: 20, height: 20, borderRadius: 10,
                        background: 'rgba(0,0,0,.55)', color: '#fff', border: 'none', cursor: 'pointer',
                        display: 'grid', placeItems: 'center', fontSize: 11, lineHeight: 1,
                      }}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <button className="btn btn-primary" onClick={save} disabled={saving}
                style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}>
                {saving ? 'Đang lưu...' : `Save screenshots (${staged.length})`}
              </button>
            </>
          )}
        </>
      )}

      {!canEdit && urls.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--faint)', textAlign: 'center', padding: '12px 0' }}>
          Chưa có screenshot
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Integrate into `components/EvalDetailPanel.tsx`**

a. Add to the `EvalDetail` interface, after `screenshot_urls: string[] | null`:
```typescript
  manual_screenshot_urls: string[] | null
```

b. Add the import:
```typescript
import ManualScreenshotsCard from '@/components/ManualScreenshotsCard'
```

c. Below the existing `const screenshots = ev.screenshot_urls || []` line add:
```typescript
  const manualShots = ev.manual_screenshot_urls || []
  // Manual uploads: admin/moderator or the assigned evaluator (matches the API rule).
  const canEditShots = !readOnly && (isManager || ev.initial_evaluator === userName)
```

d. Replace the StoreKit screenshots block:
```tsx
          {/* StoreKit screenshots */}
          {screenshots.length > 0 && (
```
…keeping that card exactly as is, and append right after its closing `)}`:
```tsx
          {/* Manual screenshots — only when StoreKit hasn't arrived */}
          {screenshots.length === 0 && (
            <ManualScreenshotsCard
              gameId={ev.game_id}
              urls={manualShots}
              canEdit={canEditShots}
              onChange={updateManualShots}
              onExpand={setExpandedImg}
              onToast={showToast}
            />
          )}
```

e. Add the state-sync handler near `showToast`:
```typescript
  const updateManualShots = (urls: string[]) => {
    setEv(prev => {
      if (!prev) return prev
      const next = { ...prev, manual_screenshot_urls: urls }
      cacheRef.current.set(prev.game_id, next)
      return next
    })
  }
```

f. The lightbox (the `createPortal` block at the bottom of the component) currently maps `screenshots` when expanding a non-QR image. Make it use whichever set is displayed: in the lightbox JSX, replace `screenshots.map((url, i) => (` with:
```typescript
              (screenshots.length > 0 ? screenshots : manualShots).map((url, i) => (
```
(`const screenshots = ev.screenshot_urls || []` itself stays unchanged.)

- [ ] **Step 3: Typecheck, lint**

Run: `npx tsc --noEmit && npx next lint --file components/ManualScreenshotsCard.tsx --file components/EvalDetailPanel.tsx`
Expected: clean (img-element warnings acceptable — matches existing code style)

- [ ] **Step 4: Run the API test suite (panel types feed from it)**

Run: `npx jest __tests__/api/ __tests__/lib/`
Expected: all new suites pass; only the pre-existing `evaluators`/`workflows-trigger` failures remain.

- [ ] **Step 5: Commit**

```bash
git add components/ManualScreenshotsCard.tsx components/EvalDetailPanel.tsx
git commit -m "feat: manual screenshots card (paste/drag/upload + save) in eval detail"
```

---

### Task 5: Build + smoke check

**Files:** none (verification only)

- [ ] **Step 1: Production build**

Run: `npm run build`
Expected: compiles clean.

- [ ] **Step 2: Manual smoke check (requires DB + Supabase env)**

Pre-req: bucket `game-screenshots` (public) exists; `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` set in `.env.local`.

`npm run dev` → open a game with no StoreKit screenshots:
- Manual card shows dropzone; Ctrl+V a screenshot → pending preview appears
- Drag an image file in → second preview; remove one with ✕
- Save → toast, images render from `supabase.co` URLs; reload → still there
- Delete one saved image → gone after refresh
- As a non-assigned evaluator → images visible, no dropzone/delete buttons
- Open a game with StoreKit screenshots → behaves exactly as before

- [ ] **Step 3: Remind the user**

Operational checklist to hand back: create the public bucket `game-screenshots`, set the two env vars on Replit, and note that manual images are public-by-link.
