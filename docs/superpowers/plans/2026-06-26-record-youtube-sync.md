# Record YouTube Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Record 5/20-min cards + "Video Uploaded" milestone reflect YouTube uploads live from the `ytb_uploaded` sheet, matched by title + duration.

**Architecture:** A new client helper `lib/ytb-match.ts` owns title normalization, duration→bucket mapping, and building a duration-aware `Map<"title|bucket", youtubeId>`. The Record grid (`youtube/page.tsx`) is refactored onto it (duration-correct). `EvalDetailPanel.tsx` fetches the sheet itself via a `useYtbUploads()` hook and drives the cards, status badges, and the progress-tracker milestone from the match.

**Tech Stack:** Next.js 14, React 18, TypeScript, Jest (jsdom).

## Global Constraints

- UI-only — no DB migration, no schema change, no n8n.
- 5/20-min Record cards are **YouTube** links; the demo-video Drive field is untouched.
- `tsconfig` has no `target`: avoid `\p{...}` regex escapes (use `[̀-ͯ]`).
- Module alias `@/` → repo root.
- Commit messages end with the Co-Authored-By trailer.

---

### Task 1: Shared matching helper `lib/ytb-match.ts`

**Files:**
- Create: `lib/ytb-match.ts`
- Test: `__tests__/lib/ytb-match.test.ts`

**Interfaces:**
- Produces:
  - `normalizeTitle(s: string): string`
  - `durationBucket(duration: string): '5min' | '20min'`
  - `ytKey(title: string, bucket: '5min' | '20min'): string`
  - `buildYtMap(rows: Array<{ gameTitle: string; youtubeId: string; duration: string }>): Map<string, string>`
  - `ytLookup(map: Map<string, string>, title: string, bucket: '5min' | '20min'): string | undefined`

- [ ] **Step 1: Write the failing test** — `__tests__/lib/ytb-match.test.ts`

```ts
import { normalizeTitle, durationBucket, ytKey, buildYtMap, ytLookup } from '@/lib/ytb-match'

describe('lib/ytb-match', () => {
  it('normalizeTitle strips accents/case/extra spaces', () => {
    expect(normalizeTitle('  Screw  Jaming ')).toBe('screw jaming')
    expect(normalizeTitle('Yàrrów')).toBe('yarrow')
  })
  it('durationBucket parses leading number, >=15 → 20min', () => {
    expect(durationBucket('5')).toBe('5min')
    expect(durationBucket('5mins')).toBe('5min')
    expect(durationBucket('20')).toBe('20min')
    expect(durationBucket('20mins')).toBe('20min')
    expect(durationBucket('')).toBe('5min')
  })
  it('buildYtMap keys by title+bucket and prefers rows with an id', () => {
    const map = buildYtMap([
      { gameTitle: 'A', youtubeId: '', duration: '5mins' },
      { gameTitle: 'A', youtubeId: 'abc', duration: '5mins' },
      { gameTitle: 'A', youtubeId: 'xyz', duration: '20mins' },
      { gameTitle: '', youtubeId: 'skip', duration: '5mins' },
    ])
    expect(ytLookup(map, 'a', '5min')).toBe('abc')
    expect(ytLookup(map, 'A', '20min')).toBe('xyz')
    expect(map.has(ytKey('', '5min'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npm test -- ytb-match` → FAIL (module not found).

- [ ] **Step 3: Implement** — `lib/ytb-match.ts`

```ts
export type Bucket = '5min' | '20min'

export function normalizeTitle(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
}

// Sheet duration is hand-entered ("5", "5mins", "20", "20mins"). Parse the
// leading integer; >=15 → 20min, otherwise 5min (unparseable → 5min).
export function durationBucket(duration: string): Bucket {
  const n = parseInt(String(duration || '').trim(), 10)
  return Number.isFinite(n) && n >= 15 ? '20min' : '5min'
}

export function ytKey(title: string, bucket: Bucket): string {
  return `${normalizeTitle(title)}|${bucket}`
}

export function buildYtMap(
  rows: Array<{ gameTitle: string; youtubeId: string; duration: string }>,
): Map<string, string> {
  const m = new Map<string, string>()
  for (const row of rows) {
    if (!row.gameTitle) continue
    const key = ytKey(row.gameTitle, durationBucket(row.duration))
    if (row.youtubeId && (!m.has(key) || !m.get(key))) m.set(key, row.youtubeId)
    else if (!m.has(key)) m.set(key, row.youtubeId || '')
  }
  for (const [k, v] of Array.from(m.entries())) if (!v) m.delete(k)
  return m
}

export function ytLookup(
  map: Map<string, string>,
  title: string,
  bucket: Bucket,
): string | undefined {
  return map.get(ytKey(title, bucket))
}
```

- [ ] **Step 4: Run to verify it passes** — `npm test -- ytb-match` → PASS.
- [ ] **Step 5: Commit** — `feat(record): duration-aware ytb-match helper`.

---

### Task 2: Refactor Record grid onto the helper + badge affordance

**Files:**
- Modify: `app/(manager)/youtube/page.tsx` (local `normalizeTitle` ~924, `recordStatus` ~968, `RecordStatusBadge` ~987, ytMap build ~1342)

**Interfaces:**
- Consumes: `normalizeTitle`, `durationBucket`, `buildYtMap`, `ytLookup`, `Bucket` from Task 1.

- [ ] **Step 1:** Import from `@/lib/ytb-match` and delete the local `normalizeTitle` definition (lines ~924-935). Keep `effectiveBucket`.

- [ ] **Step 2:** Replace the `recordStatus` lookup so it is duration-aware:

```ts
function recordStatus(item: ShortListItem, ytMap: Map<string, string>): { status: RecordStatus; youtubeId?: string } {
  const bucket = effectiveBucket(item)
  const assignee = bucket === '20min' ? item.record_20min_assignee : item.record_5min_assignee
  const yt = ytLookup(ytMap, item.title, bucket)
  if (yt) return { status: 'recorded', youtubeId: yt }
  if (!assignee) return { status: 'pending' }
  if (item.record_confirmed_at) return { status: 'recording' }
  return { status: 'draft' }
}
```

- [ ] **Step 3:** Replace the inline ytMap build (lines ~1343-1353) with `setYtMap(buildYtMap(rows))`.

- [ ] **Step 4:** Add clickable affordance to the recorded `<a>` badge (`RecordStatusBadge`): add `cursor: 'pointer'` and underline-on-hover. Use a `title="Open on YouTube"` and keep `▶`.

```tsx
<a href={`https://www.youtube.com/watch?v=${youtubeId}`} target="_blank" rel="noopener noreferrer"
   onClick={e => e.stopPropagation()} title="Open on YouTube"
   className={`badge ${s.cls} yt-link`} style={{ textDecoration: 'none', cursor: 'pointer', ...s.style }}>
  ▶ {s.label}
</a>
```

Add to `app/globals.css`: `.yt-link:hover { text-decoration: underline !important; }`.

- [ ] **Step 5:** `npm run build` (or `npm run lint`) → no type errors. Manually confirm grid still shows `▶ Recorded`.
- [ ] **Step 6: Commit** — `refactor(record): grid uses shared duration-aware ytb-match`.

---

### Task 3: Detail panel cards + milestone synced to YouTube

**Files:**
- Modify: `components/EvalDetailPanel.tsx` — `ProgressTracker` (~234-246), Record 5-min card (~1061-1099), Record 20-min card (~1101-1139).

**Interfaces:**
- Consumes: `useYtbUploads` (added here), `ytLookup`, `Bucket` from Task 1.

- [ ] **Step 1:** Add a `useYtbUploads()` hook near the top of `EvalDetailPanel.tsx`:

```tsx
import { ytLookup, buildYtMap } from '@/lib/ytb-match'

function useYtbUploads(): Map<string, string> {
  const [map, setMap] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    fetch('/api/sheets/ytb-uploaded', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : [])
      .then((rows: Array<{ gameTitle: string; youtubeId: string; duration: string }>) => setMap(buildYtMap(rows)))
      .catch(() => {})
  }, [])
  return map
}
```

- [ ] **Step 2:** In the main panel component, call the hook and derive matches:

```tsx
const ytMap = useYtbUploads()
const yt5  = ytLookup(ytMap, ev.title, '5min')
const yt20 = ytLookup(ytMap, ev.title, '20min')
```

Pass `yt5`/`yt20` into `<ProgressTracker ev={ev} yt5={yt5} yt20={yt20} />`.

- [ ] **Step 3:** `ProgressTracker` signature + "Video Uploaded" step:

```tsx
function ProgressTracker({ ev, yt5, yt20 }: { ev: EvalDetail; yt5?: string; yt20?: string }) {
  const recAssignees = Array.from(new Set([ev.record_5min_assignee, ev.record_20min_assignee].filter(Boolean)))
  const ytId = yt5 || yt20
  // ... steps[4]:
  { label: 'Video Uploaded', completed: !!ytId, href: ytId ? `https://www.youtube.com/watch?v=${ytId}` : null }
```

Add `href?: string | null` to the step type. In the render, when `step.href && isCompleted`, wrap the step's info block in an `<a href={step.href} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', cursor: 'pointer' }} className="yt-link">`.

- [ ] **Step 4:** Record 5-min card — replace the head badge + Drive Link field. Badge: `▶ Recorded` (clickable) when `yt5`; else `Unassigned`/`Recording`. Field: when `yt5`, read-only clickable `▶ youtu.be/<id>`; else muted "Not uploaded yet". Relabel "Drive Link" → "YouTube Link". Remove the `drive5` input + `record_5min_drive_date` line.

```tsx
<div className="card-head">
  <span className="card-label">Record 5 min</span>
  {yt5
    ? <a className="badge success yt-link" href={`https://www.youtube.com/watch?v=${yt5}`} target="_blank" rel="noopener noreferrer" title="Open on YouTube" style={{ fontSize: 10, textDecoration: 'none', cursor: 'pointer' }}>▶ Recorded</a>
    : ev.record_5min_assignee
      ? <span className="badge running" style={{ fontSize: 10 }}>Recording</span>
      : <span className="badge idle" style={{ fontSize: 10 }}>Unassigned</span>}
</div>
{/* ...assignee + assigned + FileNameField unchanged... */}
<div className="field" style={{ paddingTop: 8, borderTop: '1px solid var(--border)' }}>
  <span className="label">YouTube Link</span>
  {yt5
    ? <a className="yt-link" href={`https://www.youtube.com/watch?v=${yt5}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: 'var(--accent)' }}>▶ youtu.be/{yt5}</a>
    : <span style={{ fontSize: 13, color: 'var(--faint)' }}>Not uploaded yet</span>}
</div>
```

- [ ] **Step 5:** Record 20-min card — identical change with `yt20` and `record_20min_assignee`, label "Record 20 min".

- [ ] **Step 6:** Remove now-dead state/handlers tied to `drive5`/`drive20` if they are no longer referenced (check the `save()` body + `needsSave`/`dirty` deps). Keep assignee save logic. If `drive5`/`drive20` are still needed by `save()`, leave the state but stop rendering inputs. Verify with build.

- [ ] **Step 7:** `npm run build` → no type errors. Manual check: *Screw Jaming: Penguin Rescue* 5-min card → `▶ youtu.be/vHbkRPq3jtQ`, badge `▶ Recorded`, milestone complete + clickable. *City Connect Color Puzzle* via 20-min card.
- [ ] **Step 8: Commit** — `feat(record): detail cards + milestone synced to YouTube`.

---

## Self-Review

- **Spec coverage:** §1 helper → Task 1; §2 grid refactor → Task 2; §2 detail cards → Task 3 (4,5); §3 milestone → Task 3 (3); §4 affordance → Task 2 (4) + Task 3 (4,5). Decisions 1-4 all honored (no migration; title+duration via `ytLookup`; YouTube-only cards; legacy Drive ignored — no fallback rendered).
- **Placeholder scan:** none.
- **Type consistency:** `Bucket`, `ytLookup`, `buildYtMap`, `useYtbUploads`, `yt5`/`yt20` names consistent across tasks.
