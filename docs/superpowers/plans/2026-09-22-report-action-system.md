# Report Action System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every action line on the Report's three tabs belong to exactly one tab, speak one vocabulary, and carry a button that lands on a screen already configured to do the thing the line described.

**Architecture:** The Report payload gains a top-level `rescue` block built from the real Rescue scan, so Overview and the Rescue panel can never disagree about which games are stale. The three duplicated "Do this" JSX blocks collapse into one `DoBlock` component rendering the three-card layout. Actions gain two optional fields — `payoff` (what the reader gets) and `cta` (where to go) — and the destination screens (Rescue, Reassign, Leaderboard) learn to read URL params and flash the rows the action named, reusing the `?highlight=` pattern already shipped on the Config page.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, Postgres via `@/lib/db` tagged templates (Neon), Jest + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-09-22-report-actions-redesign-design.md`

**Working tree:** `~/Desktop/athena/n8n-anti/athena-n8n-signal-auto/signal-smartsheet-management`, branch `feat/report-action-system`. This is the main checkout, NOT an orca worktree — the Report redesign lives here as uncommitted work and the branch was cut carrying it.

## Global Constraints

**Lexicon — screen text only, code identifiers unchanged.** One concept, one word:

| Concept | Use | Never use on screen |
|---|---|---|
| Unevaluated games held right now | `Backlog` | queue, pile, waiting games, stock |
| A game held past the configured threshold by one person | `Stale` | old work, aged, the tail, old games |
| Days a game sits with someone before judgement | `Days waiting` | turnaround, wait, time to evaluation |
| How long the backlog takes to drain | `Days to clear` | days of work in the pile |
| Kept after the initial judgement | `Shortlist rate` | survival, Survival |
| Reached Priority IV or Insight | `Hit rate` | Signal rate |
| Weighting for sample size | `Sample weight` | Credibility |

**Seven laws** (from the spec, enforced by tests):

1. One altitude per tab: Overview = system, Leaderboard = person vs person, Individual = one person.
2. A story is concluded at exactly one altitude; other tabs may only point at it.
3. Overview may name a person only as the coordinate of games, never as a judgement.
4. An action's button must be an operation the reader of that tab may run.
5. At most three lines per tab, severity desc, then one per topic, then cheaper remedy wins.
6. No fallback actions — nothing crosses a threshold, nothing prints.
7. Several ways out of one problem print cheapest first: rebalance → raise the pace → add people → drop work. Every line after the first opens with "Or".

**Other standing rules:**

- Window-independent figures go at the **top level** of the payload, never inside `pipeline` (which is null on batch view).
- Age bands (0-3 / 4-7 / 8-14 / 15+) are a ruler. `staleDays` is a threshold. Never derive one from the other.
- Evidence (`why`) copy budget: **150 characters**, because layout C's cards are narrow.
- No em dashes in screen copy (existing house style in this file).
- Run `npx jest <file>` for a single suite; `npm test` for all; `npm run typecheck` before each commit.
- Baseline at the start of this plan: `report-overview` 27 tests pass, `report-leaderboard` + `report-individual` + `report-scope` + `rescue` 54 tests pass.

---

### Task 1: Lexicon rename across the Report screen text

**Files:**
- Modify: `components/report/ReportView.tsx` (screen text only)
- Test: `__tests__/components/report-lexicon.test.tsx` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: no new exports. Every later task writes copy in this vocabulary.

- [ ] **Step 1: Write the failing test**

Create `__tests__/components/report-lexicon.test.tsx`:

```tsx
import fs from 'fs'
import path from 'path'

// The Report told one story in four words - queue, backlog, pile, waiting - and two
// tabs disagreed about what each meant. This guards the settlement. It reads the
// SOURCE rather than a rendered tab because a banned word can hide in a branch no
// fixture reaches.
const SRC = fs.readFileSync(
  path.join(process.cwd(), 'components/report/ReportView.tsx'), 'utf8',
)

// Strip the things that are not screen text: line comments, block comments, and
// identifiers (a word touching a letter, digit, underscore or dot on either side).
function screenText(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

const BANNED: Array<[string, RegExp]> = [
  ['queue', /(^|[^\w.])queue(s)?([^\w(]|$)/i],
  ['pile', /(^|[^\w.])pile(s)?([^\w(]|$)/i],
  ['waiting games', /waiting games/i],
  ['Signal rate', /Signal rate/],
  ['Credibility', /Credibility/],
  ['turnaround', /(^|[^\w.])turnaround([^\w(]|$)/i],
]

describe('Report lexicon', () => {
  const text = screenText(SRC)
  it.each(BANNED)('never says %s on screen', (_word, re) => {
    const hits = text.split('\n')
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => re.test(l))
    expect(hits.map(([n, l]) => `${n}: ${l.trim()}`)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest __tests__/components/report-lexicon.test.tsx`
Expected: FAIL, listing well over a hundred lines.

- [ ] **Step 3: Do the rename**

Work through the failures. Rules:

- `queue` / `pile` as a noun for unevaluated games → `backlog`. Watch the articles: "the queue" → "the backlog", "their pile" → "their backlog", "a queue" → "a backlog".
- `queue` where it means the *recording* queue (Individual's recording card) → keep the concept but say `recording list`; the lexicon's `Backlog` is about evaluations only.
- `turnaround` in visible text → `days waiting`. `TIP.turnaround` keeps its key (identifier) but its prose changes.
- `Signal rate` → `Hit rate`, every label, tooltip and action. Includes `TIP.signal`, the Leaderboard column header, the Individual radar axis label, and `ALL_ROUNDER_AXES` labels in `lib/report-config.ts` if they carry screen strings.
- `Credibility` → `Sample weight`.
- `survival` / `Survival` in prose → `shortlist rate`. Identifier `survivalRate` untouched.
- `old work` / `aged` / `the tail` when describing held games → `stale`.

Do NOT rename: `survivalRate`, `signalRate`, `turnaround` as object keys, `backlogBy`, SQL column aliases, `data-rp-focus` keys, CSS class names, test ids.

- [ ] **Step 4: Run the lexicon test and the three tab suites**

Run: `npx jest __tests__/components/report-lexicon.test.tsx __tests__/components/report-overview.test.tsx __tests__/components/report-leaderboard.test.tsx __tests__/components/report-individual.test.tsx`
Expected: PASS. Existing tab tests that assert on renamed strings will fail — update the assertion to the new word; do not weaken the assertion to a regex.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add components/report/ReportView.tsx lib/report-config.ts __tests__/components/
git commit -m "refactor(report): one word per concept across the three tabs"
```

---

### Task 2: A `rescue` block in the report payload

**Files:**
- Modify: `app/api/report/route.ts` (around lines 236, 501-793, 1284-1305, 1325-1361)
- Test: `__tests__/api/report-rescue-block.test.ts` (create)

**Interfaces:**
- Consumes: `loadRescueConfig()` from `@/lib/rescue-config-db`, `scanRoster()` from `@/lib/rescue-core`, `classifyRoster()` from `@/lib/rescue-rules`.
- Produces, on the payload, for manager scope only:

```ts
rescue: {
  staleDays: number
  sources: Array<{ name: string; stale: number; movable: number }>
  receivers: Array<{ name: string; pending: number; evaluatedRecent: number }>
  movableTotal: number
} | null
```

  and, on every scope including an evaluator's own:

```ts
staleDays: number          // top level, so a contractor can name the threshold
selfStale: number | null   // that person's games past staleDays; null when not scoped
```

- [ ] **Step 1: Write the failing test**

Create `__tests__/api/report-rescue-block.test.ts`, following the shape of `__tests__/api/report-scope.test.ts` (read it first for the mocking conventions this repo uses for `@/lib/db`, `@/lib/auth-guard` and `@/lib/session`).

```ts
// The Report used to call a game stale at 8 days while Rescue called it stale at 14,
// so the two screens pointed at different games with the same word. The payload now
// carries the Rescue scan itself. These are the three things that must hold.
describe('report payload: rescue block', () => {
  it('is present for a manager and reports the configured threshold', async () => {
    const body = await getReport({ role: 'admin', rescueConfig: { staleDays: 11 } })
    expect(body.staleDays).toBe(11)
    expect(body.rescue).not.toBeNull()
    expect(Array.isArray(body.rescue.sources)).toBe(true)
  })

  it('is absent for an evaluator, who still gets the threshold and their own count', async () => {
    const body = await getReport({ role: 'evaluator', self: 'phuongnt1' })
    expect(body.rescue).toBeNull()
    expect(body.staleDays).toBe(14)
    expect(typeof body.selfStale).toBe('number')
  })

  it('survives a batch window, where pipeline is null', async () => {
    const body = await getReport({ role: 'admin', view: 'batch' })
    expect(body.pipeline).toBeNull()
    expect(body.rescue).not.toBeNull()
    expect(body.stock).toBeDefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest __tests__/api/report-rescue-block.test.ts`
Expected: FAIL with `body.rescue` undefined.

- [ ] **Step 3: Implement**

In `app/api/report/route.ts`:

a. Import at the top:

```ts
import { loadRescueConfig } from '@/lib/rescue-config-db'
import { scanRoster } from '@/lib/rescue-core'
import { classifyRoster } from '@/lib/rescue-rules'
```

b. The roster query at line 236 is already awaited on its own. Pair the config with it so the extra read costs no round trip — the app and the database are on different continents and each trip is about 225ms:

```ts
// Rescue's threshold, fetched alongside the roster because that await already
// exists. Everything on the Report that says "stale" reads this number, so the
// tab and the Rescue panel can never point at different games.
const [rosterRows, rescueCfg] = await Promise.all([
  sql`...the existing roster query, unchanged...`,
  loadRescueConfig(),
])
```

c. Add the scan to the existing `Promise.all` (line 501-793) as one more entry, guarded so an evaluator never pays for it:

```ts
isManager ? scanRoster({ category, config: rescueCfg }) : Promise.resolve([]),
```

Destructure it as `rescueStats` at the end of the destructuring list.

d. Build the block next to where `stock` is built (line 1299):

```ts
// Top level, NOT inside `pipeline`: the scan reads "right now" and has no window
// in it at all. `stock` was hoisted out of `pipeline` for exactly this reason on
// 2026-09-21, and the batch view lost three chips the day it was not.
const rescueRows = isManager ? classifyRoster(rescueStats, rescueCfg) : []
const rescue = isManager ? {
  staleDays: rescueCfg.staleDays,
  sources: rescueRows.filter(r => r.role === 'source')
    .map(r => ({ name: r.name, stale: r.stale, movable: r.movable }))
    .sort((a, b) => b.movable - a.movable),
  receivers: rescueRows.filter(r => r.role === 'receiver')
    .map(r => ({ name: r.name, pending: r.pending, evaluatedRecent: r.evaluatedRecent })),
  movableTotal: rescueRows.reduce((s, r) => s + (r.role === 'source' ? r.movable : 0), 0),
} : null
```

e. For `selfStale`, extend the `backlogBy` query (lines 777-791) with one more filtered count using the configured threshold, so the contractor's number is the same number:

```sql
count(*) FILTER (WHERE CURRENT_DATE - ge.assigned_date > ${rescueCfg.staleDays})::int AS stale
```

Carry `stale` through the reshape at lines 1286-1292, then `selfStale = scoped ? (backlogBy.find(b => b.key === selfKey)?.stale ?? 0) : null`.

f. Add `rescue`, `staleDays: rescueCfg.staleDays` and `selfStale` to BOTH branches of the `body` literal at line 1325.

The 3-minute response cache (line 37) is left alone: an admin changing `staleDays` sees it on the Report within three minutes, the same staleness every other number on the page already has.

- [ ] **Step 4: Run the tests**

Run: `npx jest __tests__/api/report-rescue-block.test.ts __tests__/api/report-scope.test.ts __tests__/api/rescue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add app/api/report/route.ts __tests__/api/report-rescue-block.test.ts
git commit -m "feat(report): carry the real Rescue scan in the payload"
```

---

### Task 3: One definition of stale on the client

**Files:**
- Modify: `components/report/ReportView.tsx` (line 59 `STALE`, the `Bundle` interface around lines 144-215, every `STALE.days` reader)
- Test: `__tests__/components/report-overview.test.tsx` (extend)

**Interfaces:**
- Consumes: `rescue`, `staleDays`, `selfStale` from Task 2.
- Produces: `STALE` keeps `{ min: 60, share: 0.25 }` only. A new helper in `ReportView.tsx`:

```ts
function staleDays(d: Bundle): number   // d.staleDays, falling back to 14
```

- [ ] **Step 1: Write the failing test**

Add to `__tests__/components/report-overview.test.tsx`:

```tsx
it('names the threshold the Rescue panel is configured with, not a hard-coded 8', async () => {
  await renderTab(withPatch({
    staleDays: 11,
    rescue: { staleDays: 11, sources: [], receivers: [], movableTotal: 0 },
  }))
  const block = screen.getByText('Do this').closest('.rp-do-block')!
  expect(block.textContent).toContain('11')
  expect(block.textContent).not.toMatch(/\b8\+ days\b/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest __tests__/components/report-overview.test.tsx -t 'names the threshold'`
Expected: FAIL, the block still says 8.

- [ ] **Step 3: Implement**

- Change line 59 to `const STALE = { min: 60, share: 0.25 }`.
- Add `staleDays: number`, `selfStale: number | null` and the `rescue` block to the `Bundle` interface.
- Add the helper and replace every `STALE.days` with `staleDays(d)` (or a local `const sd = staleDays(d)` at the top of each tab component).
- The per-person stale count used by Overview's `holders` and Leaderboard's `queue` currently reads `b.a2 + b.a3` from `backlogBy`. Change it to `b.stale` (Task 2 e). **Do not** keep the band arithmetic as a fallback: two definitions is the bug being fixed.
- The age-band charts keep `a0..a3` untouched. A band is a ruler.

- [ ] **Step 4: Run all three tab suites**

Run: `npx jest __tests__/components/report-overview.test.tsx __tests__/components/report-leaderboard.test.tsx __tests__/components/report-individual.test.tsx`
Expected: PASS. Fixtures need `staleDays`, `selfStale` and `rescue` added to `healthy()`.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add components/report/ReportView.tsx __tests__/components/
git commit -m "fix(report): one definition of stale, taken from the Rescue config"
```

---

### Task 4: `DoBlock` — the three-card layout, shared by all three tabs

**Files:**
- Modify: `components/report/ReportView.tsx` (lines 1013-1027, 1601-1610, 2192-2198)
- Modify: `app/globals.css` (around lines 2105-2117)
- Test: `__tests__/components/report-doblock.test.tsx` (create)

**Interfaces:**
- Produces, exported from `ReportView.tsx` for the tests (not from the module's public surface):

```ts
export type DoAct = {
  sev: number
  key: string
  kicker: string                       // TOPIC[topic] on Overview, the family on the others
  do: React.ReactNode
  why: React.ReactNode
  payoff?: React.ReactNode             // what the reader gets, in days or a date
  cta?: { label: string; href?: string; onClick?: () => void }
  onKicker?: () => void
}
function DoBlock({ acts }: { acts: DoAct[] }): JSX.Element | null
```

- [ ] **Step 1: Write the failing test**

Create `__tests__/components/report-doblock.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { DoBlock } from '@/components/report/ReportView'

const act = (over: Partial<Parameters<typeof DoBlock>[0]['acts'][number]> = {}) => ({
  sev: 3, key: 'k', kicker: 'AGE', do: <>Move 926 stale games</>,
  why: <>4 people hold 1,152 of 1,248</>, ...over,
})

describe('DoBlock', () => {
  it('renders nothing when there is nothing to do', () => {
    const { container } = render(<DoBlock acts={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders at most three cards, worst first', () => {
    render(<DoBlock acts={[
      act({ key: 'a', sev: 1 }), act({ key: 'b', sev: 3 }),
      act({ key: 'c', sev: 2 }), act({ key: 'd', sev: 3 }),
    ]} />)
    const cards = document.querySelectorAll('.rp-do')
    expect(cards).toHaveLength(3)
    expect(cards[0].className).toContain('urgent')
  })

  it('shows the payoff and the button when an action carries them', () => {
    render(<DoBlock acts={[act({
      payoff: <>Stale games gone in 6 days instead of 31</>,
      cta: { label: 'Open Rescue', href: '/team-ops?tab=rescue' },
    })]} />)
    expect(screen.getByText(/gone in 6 days/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open Rescue' }))
      .toHaveAttribute('href', '/team-ops?tab=rescue')
  })

  it('omits the button entirely when an action has no cta', () => {
    render(<DoBlock acts={[act()]} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button', { name: /open/i })).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest __tests__/components/report-doblock.test.tsx`
Expected: FAIL, `DoBlock` is not exported.

- [ ] **Step 3: Implement the component**

Add to `ReportView.tsx`, above `Overview`:

```tsx
/* One block, three cards, used by every tab. It replaces three near-identical copies
   of the same JSX, which is how the three tabs drifted apart in the first place.
   Sorting and the cap of three live HERE so no tab can quietly raise its own limit.
   `payoff` and `cta` are optional because a contractor's card has no operation to
   offer - see law 4: a button must be something the reader is allowed to run. */
export function DoBlock({ acts }: { acts: DoAct[] }) {
  const shown = [...acts].sort((a, b) => b.sev - a.sev).slice(0, 3)
  if (!shown.length) return null
  return (
    <div className="rp-do-block">
      <span className="rp-mix-label">Do this</span>
      <div className="rp-do-grid">
        {shown.map((a) => (
          <div className={'rp-do' + (a.sev >= 3 ? ' urgent' : '')} key={a.key}>
            {a.onKicker
              ? <button type="button" className="rp-do-topic" onClick={a.onKicker}>{a.kicker}</button>
              : <span className="rp-do-topic as-text">{a.kicker}</span>}
            <span className="rp-do-line">{a.do}</span>
            <span className="rp-do-why">{a.why}</span>
            {(a.payoff || a.cta) && (
              <div className="rp-do-foot">
                {a.payoff && <span className="rp-do-payoff">{a.payoff}</span>}
                {a.cta && (a.cta.href
                  ? <a className="rp-do-cta" href={a.cta.href}>{a.cta.label}</a>
                  : <button type="button" className="rp-do-cta" onClick={a.cta.onClick}>{a.cta.label}</button>)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
```

Replace all three call sites with `<DoBlock acts={acts.map(...)} />`, mapping each tab's own `Act` shape onto `DoAct`. Delete the per-tab `.slice(0, 3)` and sort — they now live in `DoBlock`.

- [ ] **Step 4: Implement the CSS**

Replace lines 2105-2117 of `app/globals.css`:

```css
.rp-do-block { margin: 12px 0 4px; }
.rp-do-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; align-items: stretch; }
.rp-do { border-left: 3px solid var(--warn); background: var(--warn-weak); border-radius: 0 8px 8px 0;
  padding: 10px 14px; display: flex; flex-direction: column; gap: 2px; }
.rp-do.urgent { border-left-color: var(--bad); background: var(--bad-weak); }
.rp-do-topic { align-self: flex-start; font-family: var(--font); font-size: 9.5px; font-weight: 800;
  letter-spacing: .08em; text-transform: uppercase; color: var(--muted); background: none;
  border: none; padding: 0; margin-bottom: 2px; cursor: pointer; }
.rp-do-topic.as-text { cursor: default; }
.rp-do-topic:hover:not(.as-text) { color: var(--text); text-decoration: underline; }
.rp-do-line { font-size: 13.5px; font-weight: 650; color: var(--text); line-height: 1.35; }
.rp-do-why { font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
/* Pushed to the bottom so the three buttons line up however tall the cards are: a
   card in a grid row is as tall as its tallest sibling, and a ragged row of buttons
   reads as three unrelated widgets rather than three prices for one problem. */
.rp-do-foot { margin-top: auto; padding-top: 8px; display: flex; flex-direction: column;
  align-items: flex-start; gap: 6px; border-top: 1px solid var(--border); }
.rp-do-payoff { font-size: 11.5px; font-weight: 600; color: var(--good); line-height: 1.35; }
.rp-do-payoff::before { content: '\2192\00a0'; }
.rp-do-cta { font-size: 11.5px; font-weight: 600; padding: 5px 10px; border-radius: 4px;
  border: 1px solid var(--border-strong); background: var(--surface); color: var(--text);
  text-decoration: none; cursor: pointer; }
.rp-do-cta:hover { border-color: var(--text); }
@media (max-width: 900px) { .rp-do-grid { grid-template-columns: 1fr; } }
```

Every token used here already exists in the `:root` block at the top of the file: `--good` #1f9d57, `--surface` #ffffff, `--border` #e7e9ee, `--border-strong` #d7dae1, and the `--warn` / `--warn-weak` / `--bad` / `--bad-weak` pairs the block already used.

- [ ] **Step 5: Run and commit**

Run: `npx jest __tests__/components/report-doblock.test.tsx __tests__/components/report-overview.test.tsx __tests__/components/report-leaderboard.test.tsx __tests__/components/report-individual.test.tsx`
Expected: PASS.

```bash
npm run typecheck
git add components/report/ReportView.tsx app/globals.css __tests__/components/report-doblock.test.tsx
git commit -m "feat(report): one Do-this block, three cards, shared by every tab"
```

---

### Task 5: URL state for the Report's inner tab

**Files:**
- Modify: `components/report/ReportView.tsx` (line 2 imports, line 258-261, line 379)
- Test: `__tests__/components/report-url-state.test.tsx` (create)

**Interfaces:**
- Produces: the Report reads `?rtab=overview|leaderboard|individual` and `?focus=<key>` from the URL. `rtab` is written back on tab change with `router.replace`. `focus` is consumed once on mount and then cleared from state (not from the URL).

`?tab=` still belongs to Team Ops and is not touched.

- [ ] **Step 1: Write the failing test**

Create `__tests__/components/report-url-state.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { ReportView } from '@/components/report/ReportView'

const replace = jest.fn()
let params = new URLSearchParams()
jest.mock('next/navigation', () => ({
  useSearchParams: () => params,
  useRouter: () => ({ replace }),
  usePathname: () => '/team-ops',
}))

beforeEach(() => { replace.mockClear(); params = new URLSearchParams() })

it('opens on the tab named in the URL', async () => {
  params = new URLSearchParams('rtab=leaderboard')
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => teamBundle() })
  render(<ReportView />)
  await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument())
  expect(screen.getByRole('button', { name: 'Leaderboard' }).className).toContain('on')
})

it('ignores a tab an evaluator may not see', async () => {
  params = new URLSearchParams('rtab=leaderboard')
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => selfBundle() })
  render(<ReportView />)
  await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument())
  expect(screen.getByRole('button', { name: 'Individual' }).className).toContain('on')
})
```

Copy `teamBundle()` / `selfBundle()` from the fixtures in `report-overview.test.tsx` and `report-individual.test.tsx`; `selfBundle()` is the one with `canSeeTeam: false`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest __tests__/components/report-url-state.test.tsx`
Expected: FAIL, the Leaderboard tab is not active.

- [ ] **Step 3: Implement**

`ReportInner` is already rendered inside a `Suspense` boundary (the file imports `Suspense`), which `useSearchParams` requires. In `ReportInner`:

```tsx
const sp = useSearchParams()
const router = useRouter()
const pathname = usePathname()
const [tab, setTabState] = useState(sp.get('rtab') || '')
// `focus` is read once. Leaving it in the URL would re-flash the card on every
// re-render, and clearing the URL would fight the browser's back button.
const [focusOnce, setFocusOnce] = useState(sp.get('focus') || '')

const setTab = (id: string) => {
  setTabState(id)
  const next = new URLSearchParams(sp.toString())
  next.set('rtab', id)
  router.replace(`${pathname}?${next.toString()}`, { scroll: false })
}
```

`activeTab` at line 317 already falls back when the id is not in `tabs`, so an evaluator arriving with `rtab=leaderboard` lands on Individual with no extra code. Pass `focusOnce` down to the tab components and have each clear it via `setFocusOnce('')` after acting on it.

- [ ] **Step 4: Run and commit**

Run: `npx jest __tests__/components/report-url-state.test.tsx __tests__/components/report-overview.test.tsx`
Expected: PASS.

```bash
npm run typecheck
git add components/report/ReportView.tsx __tests__/components/report-url-state.test.tsx
git commit -m "feat(report): put the inner tab in the URL so actions can link into it"
```

---

### Task 6: Destinations that arrive configured

**Files:**
- Modify: `components/RescuePanel.tsx` (line 110 signature, the initial-load effect at 128-150, the row table)
- Modify: `components/ReassignPanel.tsx` (line 19 signature, line 24 `from` state)
- Modify: `app/(manager)/team-ops/page.tsx` (lines 29-61)
- Modify: `app/globals.css` (reuse `.cfg-highlightable` / `.cfg-highlight`)
- Test: `__tests__/components/team-ops-deeplink.test.tsx` (create)

**Interfaces:**
- Produces:

```ts
function RescuePanel({ flash }: { flash?: string[] }): JSX.Element     // names to ring
function ReassignPanel({ initialFrom }: { initialFrom?: string }): JSX.Element
```

  Team Ops reads `?from=<name>` and `?flash=<comma,separated,names>` and passes them down. **`staleDays` is deliberately not accepted from the URL** — `POST /api/operations/rescue` with `action: 'scan'` persists whatever config it is handed, so a Report link carrying a threshold would silently rewrite the admin's saved settings. The Report reads the panel's number instead, never the other way round.

- [ ] **Step 1: Write the failing test**

Create `__tests__/components/team-ops-deeplink.test.tsx`:

```tsx
it('preselects the evaluator named in the URL on Reassign', async () => {
  params = new URLSearchParams('tab=reassign&from=PhuongNT1')
  render(<TeamOpsPage />)
  await waitFor(() => expect(screen.getByLabelText(/from/i)).toHaveValue('PhuongNT1'))
})

it('rings the rows named in the URL on Rescue', async () => {
  params = new URLSearchParams('tab=rescue&flash=PhuongNT1,ThuDT')
  render(<TeamOpsPage />)
  await waitFor(() => {
    expect(screen.getByText('PhuongNT1').closest('tr')!.className).toContain('cfg-highlight')
    expect(screen.getByText('KietCD').closest('tr')!.className).not.toContain('cfg-highlight')
  })
})

it('never lets a URL change the saved rescue threshold', async () => {
  params = new URLSearchParams('tab=rescue&staleDays=3')
  render(<TeamOpsPage />)
  await waitFor(() => expect(scanBody()).not.toHaveProperty('config.staleDays', 3))
})
```

Mock `/api/operations/rescue` and `/api/operations/reassign` with `global.fetch`; `scanBody()` reads the JSON body of the first POST.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest __tests__/components/team-ops-deeplink.test.tsx`
Expected: FAIL, neither panel accepts props.

- [ ] **Step 3: Implement**

In `app/(manager)/team-ops/page.tsx`, after line 47:

```tsx
// Same shape as the Config page's ?highlight= (app/(manager)/config/page.tsx): a
// link may say WHICH rows it meant, never what the tool's settings should be.
const flash = (searchParams.get('flash') || '').split(',').map(s => s.trim()).filter(Boolean)
const fromParam = searchParams.get('from') || undefined
```

then `<RescuePanel flash={flash} />` and `<ReassignPanel initialFrom={fromParam} />`.

In `RescuePanel`, accept `{ flash = [] }`, build `const ring = new Set(flash.map(n => n.toLowerCase()))`, and on each row's `<tr>`:

```tsx
className={ring.has(r.name.toLowerCase()) ? 'cfg-highlightable cfg-highlight' : undefined}
```

Scroll the first ringed row into view once the scan resolves, with the same 60ms timeout the Config page uses.

In `ReassignPanel`, accept `{ initialFrom }` and seed line 24: `useState(initialFrom ?? '')`. Guard it — if the name is not in the loaded evaluator list, fall back to `''` rather than leaving the select on a value it cannot show.

- [ ] **Step 4: Run and commit**

Run: `npx jest __tests__/components/team-ops-deeplink.test.tsx __tests__/api/rescue.test.ts __tests__/api/reassign.test.ts`
Expected: PASS.

```bash
npm run typecheck
git add components/RescuePanel.tsx components/ReassignPanel.tsx "app/(manager)/team-ops/page.tsx" app/globals.css __tests__/components/team-ops-deeplink.test.tsx
git commit -m "feat(team-ops): let a link say which rows it meant, never what the settings are"
```

---

### Task 7: Overview's actions

**Files:**
- Modify: `components/report/ReportView.tsx` (the `acts` construction, lines ~760-860)
- Test: `__tests__/components/report-overview.test.tsx` (extend)

**Interfaces:**
- Consumes: `DoBlock` / `DoAct` (Task 4), `d.rescue` and `staleDays(d)` (Tasks 2-3), `setTab` (Task 5).
- Produces: Overview's action keys become exactly `rebalance | holders | tail | catchup | capacity | pace | notriage`. `quality` is deleted.

- [ ] **Step 1: Write the failing tests**

Add to `__tests__/components/report-overview.test.tsx`:

```tsx
// One bundle for the whole group: sources with movable games, receivers with clean
// desks, and a backlog deep enough that the capacity ask also fires - which is the
// only state in which the ORDER of the three remedies can be observed at all.
function rebalanceable() {
  return withPatch({
    staleDays: 8,
    rescue: {
      staleDays: 8, movableTotal: 926,
      sources: [{ name: 'PhuongNT1', stale: 500, movable: 480 }, { name: 'ThuDT', stale: 300, movable: 280 }],
      receivers: [{ name: 'HaiNM', pending: 2, evaluatedRecent: 140 }, { name: 'LinhPT', pending: 1, evaluatedRecent: 120 }],
    },
    stock: { backlog: 4698, age: { a0: 900, a1: 1200, a2: 1300, a3: 1298 } },
  })
}

it('offers the free remedy before the expensive ones, in that order', async () => {
  await renderTab(rebalanceable())
  const cards = [...document.querySelectorAll('.rp-do-line')].map(n => n.textContent!)
  const move = cards.findIndex(t => /Move \d/.test(t))
  const add = cards.findIndex(t => /add \d+ (more )?pe(ople|rson)/i.test(t))
  expect(move).toBeGreaterThanOrEqual(0)
  if (add >= 0) expect(move).toBeLessThan(add)
})

it('opens with "Or" on every remedy after the first', async () => {
  await renderTab(rebalanceable())
  const lines = [...document.querySelectorAll('.rp-do-line')].map(n => n.textContent!.trim())
  lines.slice(1).forEach(t => expect(t.startsWith('Or ')).toBe(true))
})

it('does not ask for a rebalance when nobody can receive', async () => {
  await renderTab(withPatch({
    rescue: { staleDays: 8, movableTotal: 926, sources: [{ name: 'PhuongNT1', stale: 500, movable: 480 }], receivers: [] },
  }))
  expect(screen.queryByText('Open Rescue')).toBeNull()
  expect(screen.getByText(/front of the next assign run/)).toBeInTheDocument()
})

it('never judges a person by name', async () => {
  await renderTab(rebalanceable())
  const block = screen.getByText('Do this').closest('.rp-do-block')!
  expect(block.textContent).not.toMatch(/re-judge|re-read|bypassed games/i)
})

it('prints nothing at all on a healthy window', async () => {
  await renderTab(healthy())
  expect(screen.queryByText('Do this')).toBeNull()
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest __tests__/components/report-overview.test.tsx`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

Delete the `quality` action entirely (its `key: 'quality'` push). Keep `notriage`.

Add `rebalance`, ahead of `holders`:

```tsx
// The free remedy, and therefore the first one printed (law 7). Numbers come from
// the Rescue scan itself, so this sentence and the panel the button opens are the
// same measurement - the two used to disagree by six days.
const rb = d.rescue
const rbSources = rb?.sources ?? []
const rbRecv = rb?.receivers ?? []
if (rb && rbSources.length > 0 && rbRecv.length > 0 && rb.movableTotal >= STALE.min) {
  const top = rbSources.slice(0, 3)
  const names = top.length === 1 ? top[0].name
    : `${top.slice(0, -1).map(s => s.name).join(', ')} and ${top[top.length - 1].name}`
  const moving = top.reduce((s, x) => s + x.movable, 0)
  acts.push({
    sev: 3, key: 'rebalance', topic: 'age',
    do: <>Move {fmt.int(moving)} stale games from {names} to the {rbRecv.length} people with a clear desk</>,
    why: <>{rbSources.length === 1 ? 'One person holds' : `${rbSources.length} people hold`} {fmt.int(rb.movableTotal)} games past {rb.staleDays} days. {rbRecv.length} others have nothing stale and are still judging.</>,
    payoff: daysToClear != null && perDay > 0
      ? <>Stale games gone in {fmt.dec(moving / perDay)} days, with nobody added</>
      : <>Nobody added</>,
    cta: { label: 'Open Rescue', href: `/team-ops?tab=rescue&flash=${encodeURIComponent([...top.map(s => s.name), ...rbRecv.slice(0, 4).map(r => r.name)].join(','))}` },
  })
}
```

Change `holders` to fire only when a rebalance cannot: add `&& !(rb && rbSources.length && rbRecv.length)` to its condition, and rewrite its `do` to "Put the N games ... at the front of the next assign run".

Add `tail`, reading the oldest band:

```tsx
const oldest = p?.current.age.a3 ?? 0
if (oldest > 0 && perDay > 0 && oldest / perDay > T.clearDays * 4) acts.push({
  sev: 2, key: 'tail', topic: 'age',
  do: <>Or put the {fmt.int(oldest)} games past 15 days at the front, or drop them</>,
  why: <>At {perDayFmt(perDay)} a day and the current order they are not reached this quarter.</>,
  payoff: <>Frees {fmt.dec(oldest / perDay)} days of work either way</>,
})
```

Rewrite `catchup` in per-person-per-day terms and `capacity` with a date:

```tsx
// `heads` is the same divisor peopleAsk already uses (line 519). There is no
// `headcount` variable in this file - the team size is `t.evaluators`.
const heads = Math.max(1, t.evaluators || 1)
const perPersonNow = perDay / heads
const perPersonNeed = elapsedDays > 0 ? inTotal / elapsedDays / heads : 0
// ... do: <>Or each person adds {fmt.int(perPersonNeed - perPersonNow)} games a day
//          ({fmt.int(perPersonNow)} to {fmt.int(perPersonNeed)}) to break even on intake</>
// ... payoff: <>The backlog stops growing from next {winName}</>
// ... cta: { label: 'See who is under the pace', onClick: () => goLeaderboard('perday') }
```

`goLeaderboard` is `() => { setTab('leaderboard'); }` threaded down from `ReportInner`, plus `focus=perday` so Task 8's target flashes.

For `capacity`, keep the `peopleAsk` arithmetic and add a payoff naming the date: `new Date(now + daysToClear*86400e3)` formatted `d MMM`, with the honest tail `, the most expensive of the three`.

Finally, implement law 7's "Or": after sorting and capping in `DoBlock`, Overview prefixes remedies 2..n of the same problem. Simplest correct form: give each act an optional `family: 'capacity'`, and in Overview (not in `DoBlock`, which is shared) map over the sorted list prefixing every act after the first that shares a family already seen.

- [ ] **Step 4: Run and commit**

Run: `npx jest __tests__/components/report-overview.test.tsx`
Expected: PASS, all cases.

```bash
npm run typecheck
git add components/report/ReportView.tsx __tests__/components/report-overview.test.tsx
git commit -m "feat(report): Overview offers the cheap remedy first, with somewhere to go"
```

---

### Task 8: Leaderboard's actions

**Files:**
- Modify: `components/report/ReportView.tsx` (`Leaderboard`, the `queue` act around line 1465, the table header)
- Test: `__tests__/components/report-leaderboard.test.tsx` (extend)

**Interfaces:**
- Consumes: `focusOnce` (Task 5), `DoBlock` (Task 4).
- Produces: a `data-rp-focus="perday"` attribute on the Games per day column header, and the rows under the team pace carrying `rp-flash` when `focusOnce === 'perday'`.

- [ ] **Step 1: Write the failing tests**

```tsx
it('sends a stuck backlog to Reassign, not to Rescue', async () => {
  await renderTab(leaderboardBundle({ stuckPerson: 'PhuongNT1' }))
  const block = screen.getByText('Do this').closest('.rp-do-block')!
  expect(block.textContent).not.toMatch(/Rescue/)
  expect(screen.getByRole('link', { name: /Reassign/ }))
    .toHaveAttribute('href', expect.stringContaining('tab=reassign&from=PhuongNT1'))
})

it('flashes the under-pace rows when arrived at with focus=perday', async () => {
  params = new URLSearchParams('rtab=leaderboard&focus=perday')
  await renderTab(leaderboardBundle({}))
  expect(document.querySelectorAll('.rp-flash').length).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest __tests__/components/report-leaderboard.test.tsx`
Expected: FAIL, the action still says Rescue.

- [ ] **Step 3: Implement**

- `queue` act: replace the `do` with `<>Reassign {name}&apos;s backlog</>` and add
  `cta: { label: `Reassign ${name}`, href: `/team-ops?tab=reassign&from=${encodeURIComponent(name)}` }`.
  Its `why` keeps the same numbers but now reads `b.stale` (Task 3) and says "past {sd} days".
- Add `data-rp-focus="perday"` to the Games per day header cell, and when `focusOnce === 'perday'` add `rp-flash` to every row whose per-day figure is below the team's, then call the clear-once setter.
- Add no new action. Overview asked the question; the table is the answer.

- [ ] **Step 4: Run and commit**

Run: `npx jest __tests__/components/report-leaderboard.test.tsx`
Expected: PASS.

```bash
npm run typecheck
git add components/report/ReportView.tsx __tests__/components/report-leaderboard.test.tsx
git commit -m "feat(report): Leaderboard reassigns one person, and answers Overview's question"
```

---

### Task 9: Individual, read by an admin

**Files:**
- Modify: `components/report/ReportView.tsx` (`Individual`, the `acts` block around lines 2065-2110)
- Test: `__tests__/components/report-individual.test.tsx` (extend)

**Interfaces:**
- Produces: Individual's admin-facing action keys become exactly `stale | behind | callow | calhigh | rec`. `idle` is deleted.

- [ ] **Step 1: Write the failing tests**

```tsx
it('never offers to move games - that was decided on Leaderboard', async () => {
  await renderTab(individualBundle({ admin: true, stale: 40 }))
  const block = screen.getByText('Do this').closest('.rp-do-block')!
  expect(block.textContent).not.toMatch(/Rescue|Reassign|move .* queue|move .* backlog/i)
})

it('does not repeat the Leaderboard idle line', async () => {
  await renderTab(individualBundle({ admin: true, gaps: 9 }))
  expect(screen.queryByText(/whether it is leave/i)).toBeNull()
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest __tests__/components/report-individual.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Delete the `idle` act. Rewrite `stale` as coaching with no operation:

```tsx
do: <>Ask {e.name} to start each day with their 5 oldest games</>,
why: <>{fmt.int(bq.stale)} of {fmt.int(bq.n)} games have gone past {sd} days with them, oldest {bq.oldest}.</>,
payoff: <>Their stale games clear in about {fmt.dec(bq.stale / Math.max(1, e.throughput))} working days</>,
```

No `cta`. Keep `behind`, `callow`, `calhigh`, `rec` unchanged apart from lexicon.

- [ ] **Step 4: Run and commit**

Run: `npx jest __tests__/components/report-individual.test.tsx`
Expected: PASS.

```bash
npm run typecheck
git add components/report/ReportView.tsx __tests__/components/report-individual.test.tsx
git commit -m "feat(report): Individual coaches one person and moves no games"
```

---

### Task 10: Individual, read by a contractor

**Files:**
- Modify: `components/report/ReportView.tsx` (`Individual`, the `self` branch)
- Test: `__tests__/components/report-individual-self.test.tsx` (create)

**Interfaces:**
- Consumes: `d.selfStale`, `d.staleDays`, `d.prev`, `d.bench`.
- Produces: contractor action keys `oldfirst | bar | rhythm | flood | video | up`. None carries a `cta` with an `href` to an operation.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/components/report-individual-self.test.tsx`:

```tsx
it('offers no operation a contractor is not allowed to run', async () => {
  await renderTab(selfBundle({ selfStale: 34 }))
  const block = screen.getByText('Do this').closest('.rp-do-block')!
  expect(block.querySelectorAll('a[href*="tab=rescue"], a[href*="tab=reassign"], a[href*="tab=assign"]'))
    .toHaveLength(0)
})

it('carries both references on a line about output', async () => {
  await renderTab(selfBundle({ throughput: 62, prevThroughput: 78, benchThroughput: 74 }))
  const block = screen.getByText('Do this').closest('.rp-do-block')!
  expect(block.textContent).toContain('78')   // their own previous window
  expect(block.textContent).toContain('74')   // the team
})

it('triggers the bar line against the team, not against themselves', async () => {
  // Their own rate has not moved; it is the team they are far from.
  await renderTab(selfBundle({ survivalRate: 0.03, prevSurvival: 0.03, benchSurvival: 0.09, evaluated: 420 }))
  expect(screen.getByText(/send your last 5 bypasses/i)).toBeInTheDocument()
})

it('does not turn red for a freelancer working fewer days', async () => {
  await renderTab(selfBundle({ activeDays: 6, throughput: 90, prevThroughput: 90, benchThroughput: 74 }))
  const block = screen.queryByText('Do this')?.closest('.rp-do-block')
  expect(block?.textContent ?? '').not.toMatch(/slower than the team/i)
})

it('says something good when something got better', async () => {
  await renderTab(selfBundle({ throughput: 96, prevThroughput: 70 }))
  expect(screen.getByText(/up from/i)).toBeInTheDocument()
})

it('prints nothing when nothing crossed a threshold', async () => {
  await renderTab(selfBundle({}))
  expect(screen.queryByText('Do this')).toBeNull()
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest __tests__/components/report-individual-self.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

In the `self` branch of `Individual`, build the six acts. Every `why` carries both references; the *trigger* differs on purpose and the comment must say so:

```tsx
/* Both references are shown on every line, on the user's call. The TRIGGER is not
   the same one on every line, also on purpose: output and rhythm are judged against
   this person's own previous window, because a freelancer working three sessions a
   week is not doing anything wrong; the bar is judged against the team, because a
   bar that is not shared makes the data unusable downstream. */
```

- `oldfirst` — fires on `d.selfStale >= 5`. `do`: "Start each day with your 5 oldest games". `why`: "{selfStale} of your {bq.n} games have gone past {sd} days, oldest {bq.oldest}." `payoff`: "Your stale games gone in about {ceil(selfStale/5)} days".
- `bar` — fires on `evaluated >= IND_T.calMin && survivalRate < bench.survival * IND_T.calLow`. `do`: "Send your last 5 bypasses to a moderator to check the bar together". `why` carries both rates and the "about N games nobody saw again" arithmetic.
- `rhythm` — fires on `activeDays < prevActiveDays * 0.7`. `do`: "Spread the same work over more days". `why`: "You were out {n} of {m} days; on the days you worked you cleared {x}, against {prev} last {winName} and {bench} for the team."
- `flood` — fires on `(assigned - evaluated) / assigned > IND_T.intakeGap`. `do`: "Say early if this week's intake is more than you can clear". `why` with both references.
- `video` — the existing `rec` act, reworded in second person.
- `up` — fires on `throughput > prevThroughput * 1.2`. `sev: 0`, so it can never displace a red line. `do`: "Keep the change you made this {winName}". `why`: "{x} a day, up from {prev} last {winName} - the team is at {bench}."

Give none of them a `cta` with an operation href. A `cta` with `onClick` that scrolls to the evidence card is allowed.

- [ ] **Step 4: Run and commit**

Run: `npx jest __tests__/components/report-individual-self.test.tsx __tests__/components/report-individual.test.tsx`
Expected: PASS.

```bash
npm run typecheck
git add components/report/ReportView.tsx __tests__/components/report-individual-self.test.tsx
git commit -m "feat(report): a contractor's own tab tells them what to change"
```

---

### Task 11: Verify against the real payload

**Files:**
- Create: `scripts/report-dump.mjs` (throwaway; not committed)
- Test: `__tests__/components/report-real-payload.test.tsx` (create, committed)

**Interfaces:**
- Consumes: everything.
- Produces: a committed regression fixture under `__tests__/fixtures/report-prod.json`, scrubbed of names if the team prefers; the test reads it and dumps every line of screen text.

Nothing else in this repo's history has caught this class of bug. Unit tests written from the same assumptions as the code agree with the code.

- [ ] **Step 1: Capture a real payload**

Start an isolated dev build so the running dev server's `.next` is not corrupted:

```bash
NEXT_DIST_DIR=.next-probe SKIP_AUTH=1 npx next dev -p 3399
curl -s 'http://localhost:3399/api/report?view=month&category=puzzle' > __tests__/fixtures/report-prod.json
```

See `docs/` notes on probing with an isolated dist. Never start a second dev server on the default `.next`.

- [ ] **Step 2: Write the dump test**

```tsx
it('reads back as English on the real payload', async () => {
  const bundle = JSON.parse(fs.readFileSync('__tests__/fixtures/report-prod.json', 'utf8'))
  await renderTab(bundle)
  const block = screen.queryByText('Do this')?.closest('.rp-do-block')
  const lines = [...(block?.querySelectorAll('.rp-do-line, .rp-do-why, .rp-do-payoff') ?? [])]
    .map(n => n.textContent!.trim())
  console.log(lines.join('\n'))
  lines.forEach(t => {
    expect(t).not.toMatch(/\bNaN\b|\bundefined\b|\bInfinity\b/)
    expect(t).not.toMatch(/\b0 of 0\b/)
  })
  const whys = [...(block?.querySelectorAll('.rp-do-why') ?? [])].map(n => n.textContent!.trim())
  whys.forEach(t => expect(t.length).toBeLessThanOrEqual(150))
})
```

- [ ] **Step 3: Run it and READ the output**

Run: `npx jest __tests__/components/report-real-payload.test.tsx`

Read every printed line out loud. Check by hand:

- no sentence names a threshold the payload does not carry
- no two lines contradict each other
- the "Or" prefixes make one paragraph, not three unrelated ones
- names in the rebalance line match the names in its `flash=` URL

- [ ] **Step 4: Run the whole suite and the lexicon gate**

```bash
npm test
npm run typecheck
npx next lint
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add __tests__/components/report-real-payload.test.tsx __tests__/fixtures/report-prod.json
git commit -m "test(report): read the real payload back as text"
```

---

## Self-review notes

- **Spec coverage:** laws 1-3 → Tasks 7-10; law 4 → Tasks 6, 10; laws 5-6 → Task 4 (`DoBlock` owns the cap) and Tasks 7-10 (thresholds); law 7 → Task 7. Lexicon → Task 1. Tab ownership → Tasks 7-10. Navigation contract → Tasks 5, 6. `rescue` block + one stale definition + `selfStale` → Tasks 2, 3. Layout C → Task 4. Verification → Task 11.
- **Known follow-up, deliberately out of scope:** thresholds still live in code (`T`, `LB_T`, `IND_T`); only `staleDays` moved to configuration this pass.
