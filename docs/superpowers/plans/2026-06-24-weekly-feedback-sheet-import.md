# Weekly Feedback — Sheet Import + Multi-Group Game-Alike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a week's section hold multiple named game-alike groups, and seed `weekly_feedback` once from the per-member Google Sheet (one tab per evaluator).

**Architecture:** Two parts. (1) Model: `Section.alike` (single block) → `Section.alikes: AlikeBlock[]`, with a read-time fold so already-saved single-`alike` rows keep rendering. The server-side sanitize/fold helpers move out of the API route into a testable `lib/weekly-feedback.ts`. (2) Importer: a one-off `tsx` script reads each tab via the Sheets API with grid data (the only path preserving hyperlink URLs + bold runs), feeds cells through pure parsers in `lib/weekly-feedback-import.ts`, matches games against `game_info` by store link, and upserts. App becomes source of truth; no ongoing sync.

**Tech Stack:** Next 14 (App Router), TypeScript, `postgres` (tagged-template SQL), `googleapis`, Tiptap (feedback docs), Jest + ts-jest + React Testing Library.

## Global Constraints

- **XSS sanitize is mandatory and must be preserved.** Feedback Tiptap docs and game links can be written via the API directly; link marks / `gameMention` nodes / `app_link` / `icon_url` with non-`^(https?:\/\/|mailto:|tel:|\/|#)` hrefs must be stripped before persisting and on render. Do not weaken this when moving the helpers.
- **Write path stays own-only** in the API route (admins included). The importer is the *only* writer of other people's feedback and does so by direct DB upsert in a script, never through the PUT route.
- **Canonical week-label format:** `W<x> <Month>, <Year>` — regex `^W\d+\s+[A-Za-z]+,\s*\d{4}$`. Rows failing it are skipped and reported, never guessed.
- **`game_info` matching** reuses `parseStoreLink()` from `@/lib/game-link` and the exact lookup `(game_id = storeId OR app_link ILIKE %storeId%) AND is_active = true` — identical to `app/api/games/search`.
- Jest tests import via the `@/` alias (mapped to repo root). Tests live under `__tests__/` mirroring source paths.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `components/weekly-feedback/types.ts` | **Modify** — `Section.alikes: AlikeBlock[]`; `newSection` seeds `alikes: []`. |
| `lib/weekly-feedback.ts` | **Create** — pure server-side normalization moved from the route: href safety, doc/game/section sanitize, the `alike`→`alikes` fold, legacy folding, `rowToSections`. |
| `app/api/weekly-feedback/route.ts` | **Modify** — delete the inline helpers; import them from `lib/weekly-feedback.ts`. HTTP/auth/SQL only. |
| `components/weekly-feedback/SectionEditor.tsx` | **Modify** — right column renders N blocks; add/remove group; per-block GameSearch. |
| `components/weekly-feedback/FeedbackView.tsx` | **Modify** — `AlikeView`/`AlikeCell` loop over `alikes`. |
| `components/weekly-feedback/WeeklyFeedbackTab.tsx` | **Modify** — `AlikeCell` call site `alikes={…}`. |
| `app/globals.css` | **Modify** — minimal styles for `.wf-alike-block` / `.wf-alike-head` / `.wf-addgroup` / `.wf-alike-del`. |
| `lib/weekly-feedback-import.ts` | **Create** — pure parsers: `isValidWeekLabel`, `parseFeedbackDoc`, `parseAlikeCell` (+ `RichCell`/`TextRun`/`RawGame`/`RawBlock` types). No IO. |
| `scripts/import-weekly-feedback.ts` | **Create** — one-off IO glue: Sheets API read → pure parsers → game match → upsert → report. Deleted after import accepted. |
| `config/evaluator-map.example.json` | **Create** — committed sample tab→name map; real `config/evaluator-map.json` is gitignored. |

> **Build-green note:** Task 1 changes `types.ts` (the `Section` field rename), so the *components* won't typecheck until Task 2 completes. Within Task 1 only the new lib's Jest tests are run; the full `npx tsc --noEmit` gate is at the **end of Task 2**.

---

## Task 1: Server model — fold to `alikes[]` in `lib/weekly-feedback.ts`

**Files:**
- Modify: `components/weekly-feedback/types.ts`
- Create: `lib/weekly-feedback.ts`
- Modify: `app/api/weekly-feedback/route.ts`
- Test: `__tests__/lib/weekly-feedback.test.ts`

**Interfaces:**
- Produces: `sanitizeSections(input: unknown): Section[]`, `legacyToSections(feedback: unknown, gameAlike: unknown): Section[]`, `rowToSections(row: { sections?: unknown; feedback?: unknown; game_alike?: unknown }): Section[]`, `isSafeHref(href: unknown): boolean`. `Section = { id: string; feedback: unknown; alikes: AlikeBlock[] }`, `AlikeBlock = { name: string; games: GameAlikeGame[] }`.
- Consumes: types from `@/components/weekly-feedback/types` (type-only import).

- [ ] **Step 1: Update the types**

In `components/weekly-feedback/types.ts`, replace the `Section` interface and `newSection`:

```ts
// A week is an ordered list of sections. Each section is one 70/30 row: a Tiptap
// feedback doc on the left, and one or more named "game alike" groups on the right.
export interface AlikeBlock { name: string; games: GameAlikeGame[] }
export interface Section { id: string; feedback: unknown; alikes: AlikeBlock[] }

export const hitToGame = (h: GameHit): GameAlikeGame => ({ ...h, manual: false })

export const newSection = (): Section => ({
  id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `s_${Date.now()}_${Math.round(Math.random() * 1e6)}`,
  feedback: null,
  alikes: [],
})
```

(`GameHit`, `GameAlikeGame`, `searchGames` are unchanged.)

- [ ] **Step 2: Write the failing test**

Create `__tests__/lib/weekly-feedback.test.ts`:

```ts
import { sanitizeSections, legacyToSections, rowToSections, isSafeHref } from '@/lib/weekly-feedback'

describe('lib/weekly-feedback', () => {
  it('folds a legacy single `alike` object into `alikes[]`', () => {
    const out = sanitizeSections([
      { id: 'a', feedback: null, alike: { name: 'Match-3', games: [{ title: 'X', app_link: 'https://x', manual: true }] } },
    ])
    expect(out).toEqual([
      { id: 'a', feedback: null, alikes: [{ name: 'Match-3', games: [{ game_id: null, title: 'X', app_link: 'https://x', icon_url: null, manual: true }] }] },
    ])
  })

  it('passes through a new `alikes[]` array and drops fully-empty blocks', () => {
    const out = sanitizeSections([
      { id: 'b', feedback: null, alikes: [{ name: '', games: [] }, { name: 'Arrow', games: [] }] },
    ])
    expect(out[0].alikes).toEqual([{ name: 'Arrow', games: [] }])
  })

  it('strips a link mark with an unsafe href (regression)', () => {
    const doc = { type: 'doc', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }
    const out = sanitizeSections([{ id: 'c', feedback: doc, alikes: [] }])
    const marks = (out[0].feedback as any).content[0].marks
    expect(marks).toEqual([])
    expect(isSafeHref('javascript:alert(1)')).toBe(false)
    expect(isSafeHref('https://ok')).toBe(true)
  })

  it('legacyToSections wraps collected games into one block', () => {
    const out = legacyToSections({ type: 'doc', content: [] }, [{ games: [{ title: 'G', app_link: 'https://g', manual: false }] }])
    expect(out[0].alikes).toEqual([{ name: '', games: [{ game_id: null, title: 'G', app_link: 'https://g', icon_url: null, manual: true }] }])
  })

  it('rowToSections prefers sections and folds legacy alike on read', () => {
    expect(rowToSections({ sections: [{ id: 's', feedback: null, alike: { name: 'N', games: [] } }] })[0].alikes).toEqual([{ name: 'N', games: [] }])
    expect(rowToSections({ feedback: null, game_alike: [{ games: [] }] })).toEqual([])
  })
})
```

(Note: `sanitizeGame` coerces a missing `game_id` to `null` and a missing `icon_url` to `null`, and `manual` to boolean — hence the expected normalized games above.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest __tests__/lib/weekly-feedback.test.ts`
Expected: FAIL — `Cannot find module '@/lib/weekly-feedback'`.

- [ ] **Step 4: Create `lib/weekly-feedback.ts`**

Move the helpers out of the route and add the fold. Create `lib/weekly-feedback.ts`:

```ts
import type { Section, AlikeBlock, GameAlikeGame } from '@/components/weekly-feedback/types'

// Tiptap's Link extension only sanitizes hrefs at editor-input time, not when
// generateHTML serializes stored JSON. Feedback can be written via the API
// directly, so strip link marks with unsafe href protocols before persisting —
// otherwise a crafted javascript:/data: href would XSS an admin viewing it.
const SAFE_HREF = /^(https?:\/\/|mailto:|tel:|\/|#)/i

export function isSafeHref(href: unknown): boolean {
  return typeof href === 'string' && SAFE_HREF.test(href.trim())
}

function sanitizeNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node
  const n = node as { marks?: unknown; content?: unknown; [k: string]: unknown }
  const out: Record<string, unknown> = { ...n }
  if (Array.isArray(n.marks)) {
    out.marks = (n.marks as unknown[]).filter((m) => {
      const mark = m as { type?: string; attrs?: { href?: unknown } }
      if (mark?.type !== 'link') return true
      return isSafeHref(mark?.attrs?.href)
    })
  }
  const typed = n as { type?: string; attrs?: { href?: unknown } }
  if (typed.type === 'gameMention') {
    const attrs = (typed.attrs ?? {}) as Record<string, unknown>
    out.attrs = { ...attrs, href: isSafeHref(attrs.href) ? attrs.href : null }
  }
  if (Array.isArray(n.content)) {
    out.content = (n.content as unknown[]).map(sanitizeNode)
  }
  return out
}

function sanitizeDoc(doc: unknown): unknown {
  if (!doc || typeof doc !== 'object') return doc
  return sanitizeNode(doc)
}

function sanitizeGame(g: unknown): GameAlikeGame {
  const x = (g ?? {}) as Record<string, unknown>
  return {
    game_id: typeof x.game_id === 'string' ? x.game_id : null,
    title: typeof x.title === 'string' ? x.title : '',
    app_link: isSafeHref(x.app_link) ? (x.app_link as string) : null,
    icon_url: isSafeHref(x.icon_url) ? (x.icon_url as string) : null,
    manual: !!x.manual,
  }
}

function sanitizeAlike(raw: unknown): AlikeBlock {
  const a = (raw ?? {}) as Record<string, unknown>
  return {
    name: typeof a.name === 'string' ? a.name : '',
    games: Array.isArray(a.games) ? a.games.map(sanitizeGame) : [],
  }
}

// Accept the new `alikes` array; fold a legacy single `alike` object into a
// one-element array. Drop fully-empty blocks (no name, no games) so an old
// blank `alike` doesn't surface as a stray empty group.
function sanitizeAlikes(x: Record<string, unknown>): AlikeBlock[] {
  const raw = Array.isArray(x.alikes) ? x.alikes : (x.alike != null ? [x.alike] : [])
  return raw.map(sanitizeAlike).filter((b) => b.name || b.games.length)
}

export function sanitizeSections(input: unknown): Section[] {
  if (!Array.isArray(input)) return []
  return input.map((s, i) => {
    const x = (s ?? {}) as Record<string, unknown>
    return {
      id: typeof x.id === 'string' && x.id ? x.id : `s_${i}`,
      feedback: sanitizeDoc(x.feedback ?? null),
      alikes: sanitizeAlikes(x),
    }
  })
}

// Pre-018 rows store `feedback` (Tiptap doc) + `game_alike` (an old structured
// [{name,games}] array or a Tiptap doc) in separate columns. Fold them into a
// single section so old records keep rendering after the migration.
export function legacyToSections(feedback: unknown, gameAlike: unknown): Section[] {
  const games: GameAlikeGame[] = []
  if (Array.isArray(gameAlike)) {
    for (const sec of gameAlike) {
      const gs = (sec as { games?: unknown })?.games
      if (Array.isArray(gs)) for (const g of gs) games.push(sanitizeGame(g))
    }
  }
  const fb = feedback ?? (!Array.isArray(gameAlike) ? (gameAlike ?? null) : null)
  if (!fb && !games.length) return []
  return [{ id: 'legacy', feedback: fb ?? null, alikes: games.length ? [{ name: '', games }] : [] }]
}

export function rowToSections(row: { sections?: unknown; feedback?: unknown; game_alike?: unknown }): Section[] {
  if (Array.isArray(row.sections)) return sanitizeSections(row.sections)
  return legacyToSections(row.feedback, row.game_alike)
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest __tests__/lib/weekly-feedback.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Rewire the API route to import from the lib**

In `app/api/weekly-feedback/route.ts`: delete lines defining `SAFE_HREF`, `isSafeHref`, `sanitizeNode`, `sanitizeDoc`, `interface GameAlikeGame`, `interface Section`, `sanitizeGame`, `sanitizeSections`, `legacyToSections`, `rowToSections` (everything from the first comment block down through `rowToSections`, i.e. the current lines 9–100). Replace the `import { sql }` line region by adding, alongside the existing imports near the top:

```ts
import { sql } from '@/lib/db'
import { sanitizeSections, rowToSections } from '@/lib/weekly-feedback'
import type { Section } from '@/components/weekly-feedback/types'
```

The remaining route body (`resolveSession`, `GET`, `PUT`) is unchanged — it already calls `rowToSections(...)` and `sanitizeSections(body.sections)`. The `sql.json(sections ...)` cast in PUT keeps the `Section` type via the new import.

- [ ] **Step 7: Verify the route still typechecks in isolation**

Run: `npx tsc --noEmit 2>&1 | grep -E 'weekly-feedback/route|lib/weekly-feedback' || echo "route+lib clean"`
Expected: `route+lib clean` (component errors elsewhere are expected until Task 2).

- [ ] **Step 8: Commit**

```bash
git add components/weekly-feedback/types.ts lib/weekly-feedback.ts app/api/weekly-feedback/route.ts __tests__/lib/weekly-feedback.test.ts
git commit -m "refactor(weekly-feedback): Section.alikes[] + extract server sanitize/fold to lib"
```

---

## Task 2: Client model — multi-group editor + views

**Files:**
- Modify: `components/weekly-feedback/SectionEditor.tsx`
- Modify: `components/weekly-feedback/FeedbackView.tsx`
- Modify: `components/weekly-feedback/WeeklyFeedbackTab.tsx`
- Modify: `app/globals.css`
- Test: `__tests__/components/weekly-feedback/FeedbackView.test.tsx`

**Interfaces:**
- Consumes: `Section.alikes: AlikeBlock[]` (Task 1), `GameSearch` (`onPick: (g: GameAlikeGame) => void`), `FeedbackEditor` (`value`, `onChange`).
- Produces: `AlikeCell({ alikes: AlikeBlock[] | undefined; no: number | null })`, `FeedbackCell` (unchanged signature), `FeedbackView({ sections })`.

- [ ] **Step 1: Rewrite `SectionEditor.tsx` to render N blocks**

Replace the whole file with:

```tsx
'use client'
import { Section, AlikeBlock, GameAlikeGame } from './types'
import { FeedbackEditor } from './FeedbackEditor'
import { GameSearch } from './GameSearch'

// One section = one 70/30 row. Left: a Tiptap feedback editor. Right: one or
// more named "game alike" groups, each a name + a list of games. Reorder (↑/↓)
// and remove the whole section live in the row's left rail.
export function SectionEditor({ section, index, total, onChange, onMove, onRemove }: {
  section: Section
  index: number
  total: number
  onChange: (patch: Partial<Section>) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}) {
  const alikes = section.alikes
  const setAlikes = (next: AlikeBlock[]) => onChange({ alikes: next })
  const patchBlock = (bi: number, patch: Partial<AlikeBlock>) =>
    setAlikes(alikes.map((b, i) => (i === bi ? { ...b, ...patch } : b)))
  const addBlock = () => setAlikes([...alikes, { name: '', games: [] }])
  const removeBlock = (bi: number) => setAlikes(alikes.filter((_, i) => i !== bi))
  const addGame = (bi: number, g: GameAlikeGame) => patchBlock(bi, { games: [...alikes[bi].games, g] })
  const removeGame = (bi: number, gi: number) => patchBlock(bi, { games: alikes[bi].games.filter((_, i) => i !== gi) })

  return (
    <div className="wf-section-row">
      <div className="wf-section-rail">
        <button type="button" title="Move up" disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
        <button type="button" title="Move down" disabled={index === total - 1} onClick={() => onMove(1)}>↓</button>
        <button type="button" className="wf-section-del" title="Remove section" onClick={onRemove}>✕</button>
      </div>

      <div className="wf-section-feedback">
        <FeedbackEditor value={section.feedback} onChange={v => onChange({ feedback: v })} />
      </div>

      <div className="wf-section-alike">
        {alikes.map((block, bi) => (
          <div key={bi} className="wf-alike-block">
            <div className="wf-alike-head">
              <input
                className="wf-alike-name"
                value={block.name}
                onChange={e => patchBlock(bi, { name: e.target.value })}
                placeholder="Game Alike"
              />
              <button type="button" className="wf-alike-del" title="Remove group" onClick={() => removeBlock(bi)}>✕</button>
            </div>
            <ul className="wf-chips">
              {block.games.map((g, gi) => (
                <li key={gi} className="wf-chip">
                  {g.icon_url && <img src={g.icon_url} alt="" width={18} height={18} />}
                  {g.app_link
                    ? <a href={g.app_link} target="_blank" rel="noopener noreferrer">{g.title}</a>
                    : <span>{g.title}</span>}
                  {g.manual && <span className="wf-manual" title="Not in DB">·manual</span>}
                  <button type="button" title="Remove game" onClick={() => removeGame(bi, gi)}>✕</button>
                </li>
              ))}
            </ul>
            <GameSearch onPick={g => addGame(bi, g)} />
          </div>
        ))}
        <button type="button" className="wf-addgroup" onClick={addBlock}>+ Add group</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Rewrite `AlikeView`/`AlikeCell` in `FeedbackView.tsx` to loop blocks**

In `components/weekly-feedback/FeedbackView.tsx`, replace the `AlikeView` function and the `AlikeCell` export, and the `<AlikeView .../>` call inside `FeedbackView`:

```tsx
function AlikeView({ alikes }: { alikes: AlikeBlock[] }) {
  const blocks = (alikes || []).filter(b => b?.name || b?.games?.length)
  if (!blocks.length) return null
  return (
    <div className="wf-alike-view">
      {blocks.map((b, bi) => (
        <div key={bi} className="wf-alike-view-block">
          {b.name && <strong className="wf-alike-view-name">{b.name}</strong>}
          {!!b.games?.length && (
            <ul>
              {b.games.map((g, i) => (
                <li key={i}>
                  {g.icon_url && <img src={g.icon_url} alt="" width={16} height={16} />}
                  {g.app_link
                    ? <a href={g.app_link} target="_blank" rel="noopener noreferrer">{g.title}</a>
                    : <span>{g.title}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

export function AlikeCell({ alikes, no }: { alikes: AlikeBlock[] | undefined; no: number | null }) {
  const body = alikes?.length ? <AlikeView alikes={alikes} /> : null
  return (
    <div className="wf-cell">
      {no != null && <span className="wf-sec-no">{no}</span>}
      <div className="wf-cell-body">{body || <span className="wf-faint">—</span>}</div>
    </div>
  )
}
```

And in `FeedbackView` replace `<AlikeView alike={s.alike} />` with `<AlikeView alikes={s.alikes} />`. (`FeedbackCell` is unchanged.)

- [ ] **Step 3: Update the `AlikeCell` call site in `WeeklyFeedbackTab.tsx`**

In `components/weekly-feedback/WeeklyFeedbackTab.tsx`, the list table cell currently reads:

```tsx
<td className={cls}><AlikeCell alike={row.section?.alike} no={no} /></td>
```

Replace with:

```tsx
<td className={cls}><AlikeCell alikes={row.section?.alikes} no={no} /></td>
```

- [ ] **Step 4: Add styles in `app/globals.css`**

Append near the other `.wf-*` rules:

```css
.wf-alike-block { margin-bottom: 10px; }
.wf-alike-block + .wf-alike-block { border-top: 1px dashed var(--border, #e3e3e3); padding-top: 8px; }
.wf-alike-head { display: flex; align-items: center; gap: 6px; }
.wf-alike-head .wf-alike-name { flex: 1; }
.wf-alike-del { border: none; background: none; cursor: pointer; color: #b00; line-height: 1; padding: 2px 4px; }
.wf-addgroup { border: 1px dashed var(--border, #ccc); background: none; cursor: pointer; border-radius: 6px; padding: 4px 8px; font-size: 12px; }
.wf-alike-view-block + .wf-alike-view-block { margin-top: 6px; }
```

- [ ] **Step 5: Write the render test**

Create `__tests__/components/weekly-feedback/FeedbackView.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { AlikeCell } from '@/components/weekly-feedback/FeedbackView'

describe('AlikeCell', () => {
  it('renders every group name and its game links', () => {
    render(<AlikeCell no={null} alikes={[
      { name: 'Match-3', games: [{ game_id: null, title: 'Wildlife Flip', app_link: 'https://x/wildlife', icon_url: null, manual: true }] },
      { name: 'Arrow', games: [{ game_id: 'g2', title: 'Get out my way', app_link: 'https://x/arrow', icon_url: null, manual: false }] },
    ]} />)
    expect(screen.getByText('Match-3')).toBeInTheDocument()
    expect(screen.getByText('Arrow')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Wildlife Flip' })).toHaveAttribute('href', 'https://x/wildlife')
    expect(screen.getByRole('link', { name: 'Get out my way' })).toHaveAttribute('href', 'https://x/arrow')
  })

  it('shows the em dash when there are no groups', () => {
    render(<AlikeCell no={null} alikes={[]} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})
```

- [ ] **Step 6: Run the render test**

Run: `npx jest __tests__/components/weekly-feedback/FeedbackView.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 7: Full typecheck gate (build is green now)**

Run: `npx tsc --noEmit`
Expected: no errors. (Both the model rename and all consumers are now consistent.)

- [ ] **Step 8: Commit**

```bash
git add components/weekly-feedback/SectionEditor.tsx components/weekly-feedback/FeedbackView.tsx components/weekly-feedback/WeeklyFeedbackTab.tsx app/globals.css __tests__/components/weekly-feedback/FeedbackView.test.tsx
git commit -m "feat(weekly-feedback): multiple game-alike groups per section"
```

---

## Task 3: Importer pure parsers — `lib/weekly-feedback-import.ts`

**Files:**
- Create: `lib/weekly-feedback-import.ts`
- Test: `__tests__/lib/weekly-feedback-import.test.ts`

**Interfaces:**
- Produces:
  - `isValidWeekLabel(label: string): boolean`
  - `parseFeedbackDoc(text: string): unknown | null` — a Tiptap doc node or null.
  - `parseAlikeCell(cell: RichCell): RawBlock[]`
  - `interface TextRun { start: number; bold: boolean; link: string | null }`
  - `interface RichCell { text: string; runs: TextRun[]; cellLink: string | null }`
  - `interface RawGame { title: string; app_link: string }`
  - `interface RawBlock { name: string; games: RawGame[] }`
- Consumes: nothing (pure, no imports). The script (Task 4) builds `RichCell` from Google's grid data and matches `RawGame`s against the DB.

- [ ] **Step 1: Write the failing test**

Create `__tests__/lib/weekly-feedback-import.test.ts`:

```ts
import { isValidWeekLabel, parseFeedbackDoc, parseAlikeCell, RichCell } from '@/lib/weekly-feedback-import'

describe('isValidWeekLabel', () => {
  it('accepts the canonical W<x> <Month>, <Year> form', () => {
    expect(isValidWeekLabel('W1 MAY, 2026')).toBe(true)
    expect(isValidWeekLabel('  W12 June, 2025 ')).toBe(true)
  })
  it('rejects un-normalized labels', () => {
    expect(isValidWeekLabel('May W2')).toBe(false)
    expect(isValidWeekLabel('W2/ Nov')).toBe(false)
    expect(isValidWeekLabel('')).toBe(false)
  })
})

describe('parseFeedbackDoc', () => {
  it('returns null for empty text', () => {
    expect(parseFeedbackDoc('')).toBeNull()
    expect(parseFeedbackDoc('   ')).toBeNull()
  })
  it('turns "- " lines into a bullet list and plain lines into paragraphs', () => {
    const doc = parseFeedbackDoc('Intro line\n- first\n- second') as any
    expect(doc.type).toBe('doc')
    expect(doc.content[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Intro line' }] })
    expect(doc.content[1].type).toBe('bulletList')
    expect(doc.content[1].content).toHaveLength(2)
    expect(doc.content[1].content[0]).toEqual({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] })
  })
})

// Helper: build a RichCell from segments [text, bold, link].
function cell(segments: [string, boolean, string | null][]): RichCell {
  let text = ''
  const runs = segments.map(([t, bold, link]) => {
    const run = { start: text.length, bold, link }
    text += t
    return run
  })
  return { text, runs, cellLink: null }
}

describe('parseAlikeCell', () => {
  it('splits bold header lines into separate named blocks', () => {
    const c = cell([
      ['Category Match-Card:\n', true, null],
      ['Category Tiles', false, 'https://x/tiles'],
      ['\n', false, null],
      ['Stamp Match', false, 'https://x/stamp'],
      ['\n\n', false, null],
      ['Match-3:\n', true, null],
      ['Wildlife Flip', false, 'https://x/wildlife'],
    ])
    expect(parseAlikeCell(c)).toEqual([
      { name: 'Category Match-Card', games: [
        { title: 'Category Tiles', app_link: 'https://x/tiles' },
        { title: 'Stamp Match', app_link: 'https://x/stamp' },
      ] },
      { name: 'Match-3', games: [{ title: 'Wildlife Flip', app_link: 'https://x/wildlife' }] },
    ])
  })

  it('puts a flat list of links (no headers) into one unnamed block', () => {
    const c = cell([
      ['Roll It On!', false, 'https://x/roll'],
      ['\n', false, null],
      ['Sushi Marge', false, 'https://x/sushi'],
    ])
    expect(parseAlikeCell(c)).toEqual([
      { name: '', games: [
        { title: 'Roll It On!', app_link: 'https://x/roll' },
        { title: 'Sushi Marge', app_link: 'https://x/sushi' },
      ] },
    ])
  })

  it('treats a no-link line ending with ":" as a header even when not bold', () => {
    const c = cell([
      ['Arrow:\n', false, null],
      ['Arrows Flow', false, 'https://x/flow'],
    ])
    expect(parseAlikeCell(c)).toEqual([
      { name: 'Arrow', games: [{ title: 'Arrows Flow', app_link: 'https://x/flow' }] },
    ])
  })

  it('handles a whole-cell hyperlink with no runs as a single game', () => {
    expect(parseAlikeCell({ text: 'Solo Game', runs: [], cellLink: 'https://x/solo' })).toEqual([
      { name: '', games: [{ title: 'Solo Game', app_link: 'https://x/solo' }] },
    ])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest __tests__/lib/weekly-feedback-import.test.ts`
Expected: FAIL — `Cannot find module '@/lib/weekly-feedback-import'`.

- [ ] **Step 3: Create `lib/weekly-feedback-import.ts`**

```ts
// Pure parsers for the one-off Google Sheets → weekly_feedback import. No IO:
// the script (scripts/import-weekly-feedback.ts) reads the sheet, builds the
// RichCell inputs, matches games against the DB, and persists.

export const WEEK_LABEL_RE = /^W\d+\s+[A-Za-z]+,\s*\d{4}$/

export function isValidWeekLabel(label: string): boolean {
  return WEEK_LABEL_RE.test((label || '').trim())
}

export interface TextRun { start: number; bold: boolean; link: string | null }
export interface RichCell { text: string; runs: TextRun[]; cellLink: string | null }
export interface RawGame { title: string; app_link: string }
export interface RawBlock { name: string; games: RawGame[] }

function para(text: string) {
  return text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' }
}

// Column B free text → minimal Tiptap doc. "- "/"• " lines become bullet list
// items (consecutive bullets merge into one list); other non-empty lines become
// paragraphs. Empty input → null.
export function parseFeedbackDoc(text: string): unknown | null {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n')
  const content: unknown[] = []
  let bullets: unknown[] | null = null
  const flush = () => { if (bullets) { content.push({ type: 'bulletList', content: bullets }); bullets = null } }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    const m = line.match(/^\s*[-•]\s+(.*)$/)
    if (m) {
      const t = m[1].trim()
      ;(bullets ??= []).push({ type: 'listItem', content: [para(t)] })
      continue
    }
    flush()
    if (line.trim()) content.push(para(line.trim()))
  }
  flush()
  return content.length ? { type: 'doc', content } : null
}

// The run covering character index i = the last run whose start <= i.
function runAt(runs: TextRun[], i: number): TextRun | null {
  let found: TextRun | null = null
  for (const r of runs) { if (r.start <= i) found = r; else break }
  return found
}

// Maximal sub-segments of [from,to) that carry the same non-null link → games.
function linkedSegments(text: string, runs: TextRun[], from: number, to: number): RawGame[] {
  const out: RawGame[] = []
  let i = from
  while (i < to) {
    const link = runAt(runs, i)?.link ?? null
    if (!link) { i++; continue }
    let j = i
    while (j < to && (runAt(runs, j)?.link ?? null) === link) j++
    const title = text.slice(i, j).trim()
    if (title) out.push({ title, app_link: link })
    i = j
  }
  return out
}

// A line is "bold" when all its non-whitespace characters fall in bold runs.
function lineIsBold(runs: TextRun[], from: number, line: string): boolean {
  let any = false
  for (let i = 0; i < line.length; i++) {
    if (/\s/.test(line[i])) continue
    any = true
    if (!runAt(runs, from + i)?.bold) return false
  }
  return any
}

// Column C → named game-alike blocks. Bold lines (or no-link lines ending ":")
// open a new block; linked runs are games added to the current block (an
// unnamed block is created lazily if a game appears before any header).
export function parseAlikeCell(cell: RichCell): RawBlock[] {
  const text = (cell.text || '').replace(/\r\n/g, '\n')
  if ((!cell.runs || cell.runs.length === 0) && cell.cellLink && text.trim()) {
    return [{ name: '', games: [{ title: text.trim(), app_link: cell.cellLink }] }]
  }
  const runs = cell.runs ?? []
  const blocks: RawBlock[] = []
  let current: RawBlock | null = null

  let lineStart = 0
  for (const line of text.split('\n')) {
    const lineEnd = lineStart + line.length
    const games = linkedSegments(text, runs, lineStart, lineEnd)
    if (games.length === 0) {
      const trimmed = line.trim()
      if (trimmed && (lineIsBold(runs, lineStart, line) || trimmed.endsWith(':'))) {
        current = { name: trimmed.replace(/:\s*$/, '').trim(), games: [] }
        blocks.push(current)
      }
      // plain non-link, non-header line → ignored
    } else {
      if (!current) { current = { name: '', games: [] }; blocks.push(current) }
      for (const g of games) current.games.push(g)
    }
    lineStart = lineEnd + 1 // + the consumed "\n"
  }
  return blocks.filter(b => b.name || b.games.length)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest __tests__/lib/weekly-feedback-import.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/weekly-feedback-import.ts __tests__/lib/weekly-feedback-import.test.ts
git commit -m "feat(weekly-feedback): pure parsers for sheet import"
```

---

## Task 4: Importer script — `scripts/import-weekly-feedback.ts`

**Files:**
- Create: `scripts/import-weekly-feedback.ts`
- Create: `config/evaluator-map.example.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `isValidWeekLabel`, `parseFeedbackDoc`, `parseAlikeCell`, `RichCell`, `TextRun`, `RawGame` from `../lib/weekly-feedback-import`; `parseStoreLink` from `../lib/game-link`.
- Produces: a runnable script (no exports). Verified by `--dry-run`, not Jest — it does live IO (Sheets API + DB).

> **Runtime inputs (you provide at run time — these are config, not code):**
> - `GOOGLE_APPLICATION_CREDENTIALS` — path to the service-account JSON (share the sheet with the SA's email, read access).
> - `SPREADSHEET_ID` — the source spreadsheet id.
> - `DATABASE_URL` — same Postgres the app uses.
> - `config/evaluator-map.json` — real `{ "TabCode": "Evaluator Name as stored in DB" }` mapping (copy the example, fill in names).

- [ ] **Step 1: Create the example evaluator map**

Create `config/evaluator-map.example.json` (tab codes observed in the sheet; replace the values with the exact `evaluator` names used elsewhere in the app):

```json
{
  "HuyDD": "REPLACE_WITH_DB_NAME",
  "KietCD": "REPLACE_WITH_DB_NAME",
  "MyDV": "REPLACE_WITH_DB_NAME",
  "MiTT": "REPLACE_WITH_DB_NAME",
  "GabrielTran": "REPLACE_WITH_DB_NAME",
  "MyTL": "REPLACE_WITH_DB_NAME",
  "ThuDT": "REPLACE_WITH_DB_NAME",
  "NhiLV": "REPLACE_WITH_DB_NAME",
  "NgocTT": "REPLACE_WITH_DB_NAME",
  "TriD": "REPLACE_WITH_DB_NAME"
}
```

- [ ] **Step 2: Gitignore the real map**

Append to `.gitignore`:

```
config/evaluator-map.json
```

- [ ] **Step 3: Create the script**

Create `scripts/import-weekly-feedback.ts`:

```ts
// One-off: import per-member weekly feedback from the Google Sheet into
// weekly_feedback. App is the source of truth afterward; delete this script once
// the import is accepted.
//
// Run (dry run first):
//   GOOGLE_APPLICATION_CREDENTIALS=./sa.json \
//   SPREADSHEET_ID=<id> DATABASE_URL=<url> \
//   npx tsx scripts/import-weekly-feedback.ts --dry-run
// Then drop --dry-run to write.
import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { google } from 'googleapis'
import postgres from 'postgres'
import { parseStoreLink } from '../lib/game-link'
import { isValidWeekLabel, parseFeedbackDoc, parseAlikeCell, type RichCell, type TextRun, type RawGame } from '../lib/weekly-feedback-import'

const DRY = process.argv.includes('--dry-run')
const SPREADSHEET_ID = process.env.SPREADSHEET_ID
const MAP_PATH = process.env.EVALUATOR_MAP || './config/evaluator-map.json'
if (!SPREADSHEET_ID) { console.error('SPREADSHEET_ID is required'); process.exit(1) }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1) }

const evaluatorMap: Record<string, string> = JSON.parse(readFileSync(MAP_PATH, 'utf8'))
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' })

// Google CellData → RichCell. Google omits startIndex on the first run; ensure a
// run starting at 0 exists so runAt() covers the whole string.
function toRichCell(cell: any): RichCell {
  const text: string = cell?.formattedValue ?? ''
  const cellLink: string | null = cell?.hyperlink ?? null
  const runs: TextRun[] = (cell?.textFormatRuns ?? []).map((r: any) => ({
    start: r.startIndex ?? 0,
    bold: !!r?.format?.bold,
    link: r?.format?.link?.uri ?? null,
  }))
  if (runs.length && runs[0].start !== 0) runs.unshift({ start: 0, bold: false, link: null })
  return { text, runs, cellLink }
}

async function matchGame(g: RawGame) {
  const parsed = parseStoreLink(g.app_link)
  if (parsed) {
    const rows = await sql`
      SELECT game_id, title, app_link, icon_url FROM game_info
      WHERE (game_id = ${parsed.storeId} OR app_link ILIKE ${'%' + parsed.storeId + '%'}) AND is_active = true
      LIMIT 1`
    if (rows[0]) return { game_id: rows[0].game_id, title: rows[0].title, app_link: rows[0].app_link, icon_url: rows[0].icon_url, manual: false }
  }
  return { game_id: null, title: g.title, app_link: g.app_link, icon_url: null, manual: true }
}

async function main() {
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] })
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() as any })
  const res = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    includeGridData: true,
    fields: 'sheets(properties.title,data.rowData.values(formattedValue,hyperlink,textFormatRuns(startIndex,format(bold,link/uri))))',
  })

  const report = { imported: 0, skippedTab: [] as string[], skippedLabel: [] as string[], matched: 0, manual: 0 }

  for (const sheet of res.data.sheets ?? []) {
    const tab = sheet.properties?.title ?? ''
    const evaluator = evaluatorMap[tab]
    if (!evaluator || evaluator.startsWith('REPLACE_')) { report.skippedTab.push(tab); continue }
    const rows = sheet.data?.[0]?.rowData ?? []
    for (let r = 1; r < rows.length; r++) { // row 0 is the header
      const cells = rows[r]?.values ?? []
      const label = (cells[0]?.formattedValue ?? '').trim()
      if (!label) continue
      if (!isValidWeekLabel(label)) { report.skippedLabel.push(`${tab}: "${label}"`); continue }

      const feedback = parseFeedbackDoc(cells[1]?.formattedValue ?? '')
      const rawBlocks = parseAlikeCell(toRichCell(cells[2]))
      const alikes = []
      for (const b of rawBlocks) {
        const games = []
        for (const rg of b.games) {
          const m = await matchGame(rg)
          games.push(m)
          if (m.manual) report.manual++; else report.matched++
        }
        alikes.push({ name: b.name, games })
      }
      const sections = [{ id: randomUUID(), feedback, alikes }]

      if (!DRY) {
        await sql`
          INSERT INTO weekly_feedback (batch, evaluator, sections, updated_at)
          VALUES (${label}, ${evaluator}, ${sql.json(sections as any)}, NOW())
          ON CONFLICT (batch, evaluator)
          DO UPDATE SET sections = EXCLUDED.sections, updated_at = NOW()`
      }
      report.imported++
    }
  }

  console.log(`${DRY ? '[DRY RUN] ' : ''}import report:`)
  console.log(JSON.stringify(report, null, 2))
  await sql.end()
}

main().catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 4: Typecheck the script**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Dry-run against the real sheet**

Fill `config/evaluator-map.json` (copy from the example, real names), then run:

```bash
GOOGLE_APPLICATION_CREDENTIALS=./sa.json SPREADSHEET_ID=<id> DATABASE_URL=<url> \
  npx tsx scripts/import-weekly-feedback.ts --dry-run
```

Expected: a `[DRY RUN] import report:` JSON. **Review it:**
- `imported` ≈ total week rows across mapped tabs.
- `skippedTab` lists only tabs you intentionally left unmapped (else fix the map).
- `skippedLabel` lists rows whose column A isn't `W<x> <Month>, <Year>` — go normalize those in the sheet and re-run.
- `matched` vs `manual` — a high `manual` count means many links didn't resolve to `game_info`; spot-check a few URLs before the real write.

- [ ] **Step 6: Real import**

When the dry-run report looks right, run the same command **without** `--dry-run`. Then sanity-check in the app: open List view, confirm a few weeks per member show the right groups + links.

- [ ] **Step 7: Commit the script + example (not the real map)**

```bash
git add scripts/import-weekly-feedback.ts config/evaluator-map.example.json .gitignore
git commit -m "feat(weekly-feedback): one-off Google Sheets importer"
```

---

## Self-Review

**Spec coverage:**
- Multi-group model (`alikes[]`) — Tasks 1 (server) + 2 (client). ✓
- Read-time fold / backward compat — Task 1 `sanitizeAlikes` + `rowToSections` running `sanitizeSections`. ✓
- XSS sanitize preserved — Task 1 moves it verbatim; Task 1 Step 2 has a regression test. ✓
- Week-label validation + skip/report — Task 3 `isValidWeekLabel`, Task 4 `skippedLabel`. ✓
- Feedback → Tiptap, bullets — Task 3 `parseFeedbackDoc`. ✓
- Column C multi-block parse (bold/`:` headers, flat lists, whole-cell link) — Task 3 `parseAlikeCell`. ✓
- Game match by `app_link`, DB title on hit, manual fallback — Task 4 `matchGame`. ✓
- Evaluator tab→name map, unmapped skipped — Task 4 `evaluatorMap` + `skippedTab`. ✓
- Service-account auth, Sheets API grid data with hyperlinks — Task 4 `GoogleAuth` + `fields=...textFormatRuns(...link/uri)`. ✓
- Idempotent upsert, app source of truth — Task 4 `ON CONFLICT DO UPDATE`. ✓
- Report (imported/skipped/matched-vs-manual) — Task 4 `report`. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/vague steps; every code step has full code. The `REPLACE_WITH_DB_NAME` values are runtime config the user fills (and the script guards against importing them), not plan placeholders.

**Type consistency:** `Section.alikes`, `AlikeBlock { name, games }`, `GameAlikeGame` shape, and `sanitizeSections`/`rowToSections`/`legacyToSections` signatures match across Tasks 1–2. `RichCell`/`TextRun`/`RawGame`/`RawBlock` and `parseAlikeCell`/`parseFeedbackDoc`/`isValidWeekLabel` match between Task 3 (definition) and Task 4 (consumption). `matchGame` output matches `GameAlikeGame`.
