# Assign một trang: Genre + Sub-genre + History matrix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gộp 3 tab genre của Assign thành một trang duy nhất có cột Genre, đổi Category thành Sub-genre, Available ghi theo người, và thay panel History cột-phải bằng matrix ngày × người full-width.

**Architecture:** Không đổi schema và không đổi thuật toán chia game. Toàn bộ logic mới nằm trong hai module thuần (`lib/assign-roster.ts` gom dòng theo người, `lib/assign-history-matrix.ts` pivot history thành matrix) để test được không cần DOM hay DB. Hai component presentational (`RosterTable`, `AssignHistoryMatrix`) chỉ nhận props, nên một page giả lập dùng fixture có thể render đúng UI thật trước khi đụng vào API. Ngữ nghĩa "Available thuộc về người" cài ở server (`UPDATE ... WHERE list_type AND name`), không cài ở UI.

**Tech Stack:** Next.js App Router, TypeScript, postgres.js, Jest + jsdom + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-08-27-assign-single-page-genre-design.md`

## Global Constraints

- **Không có migration.** Không tạo, sửa, xoá cột nào của `evaluator_roster`. Row model người × genre đã đúng PK `(list_type, category_group, name)`.
- **Không đụng `lib/assign-evaluators.ts`** và `__tests__/lib/assign-evaluators.test.ts`. Thuật toán chia game không đổi một dòng.
- **Không đụng `app/api/cron/assign-evaluators/route.ts`.** Vẫn nhận `category` đơn, n8n vẫn gọi 3 lần.
- **Từ vựng UI:** `Genre` = `category_group` = puzzle/arcade/simulation. `Sub-genre` = thành viên trong bucket (`game_category`, list từ `/api/config/categories`). Không dùng chữ "bucket" và "category" trên UI mới.
- **Số trong ô matrix chỉ là `action='assign'`.** Không bao giờ cộng reassign/handover vào — game bị reassign đã được đếm ở lần assign gốc.
- Timezone `Asia/Ho_Chi_Minh`; `run_date` là `YYYY-MM-DD` đã ở giờ VN, parse như UTC để không lệch ngày.
- Không thêm cột Load, không thêm capacity/quota, không thêm ngưỡng cảnh báo quá tải.
- Chạy `npm test` và `npm run typecheck` trước mỗi commit. **Đừng chạy `npm run build` khi dev server đang chạy** (hỏng `.next`).

---

### Task 1: `lib/assign-roster.ts` — gom dòng roster theo người

**Files:**
- Create: `lib/assign-roster.ts`
- Test: `__tests__/lib/assign-roster.test.ts`

**Interfaces:**
- Consumes: `BUCKETS`, `Bucket` từ `lib/buckets.ts` (đã có).
- Produces:
  - `interface RosterRow { id: number; name: string; category_group: Bucket; today_available: boolean; game_platform: string; game_category: string; weight: number }`
  - `interface PersonGroup { name: string; today_available: boolean; rows: RosterRow[]; missingGenres: Bucket[] }`
  - `function groupRosterByPerson(rows: RosterRow[]): PersonGroup[]`

- [ ] **Step 1: Write the failing test**

Tạo `__tests__/lib/assign-roster.test.ts`:

```ts
import { groupRosterByPerson, type RosterRow } from '@/lib/assign-roster'

const row = (o: Partial<RosterRow> & { id: number; name: string; category_group: RosterRow['category_group'] }): RosterRow => ({
  today_available: true, game_platform: 'all', game_category: 'All', weight: 100, ...o,
})

describe('groupRosterByPerson', () => {
  it('gom mọi genre của một người vào một group, sort tên A→Z', () => {
    const groups = groupRosterByPerson([
      row({ id: 1, name: 'MyTL', category_group: 'puzzle' }),
      row({ id: 2, name: 'NhiLV', category_group: 'arcade' }),
      row({ id: 3, name: 'NhiLV', category_group: 'puzzle' }),
    ])
    expect(groups.map(g => g.name)).toEqual(['MyTL', 'NhiLV'])
    expect(groups[1].rows).toHaveLength(2)
  })

  it('trong một người, genre theo thứ tự puzzle → arcade → simulation', () => {
    const [g] = groupRosterByPerson([
      row({ id: 1, name: 'A', category_group: 'simulation' }),
      row({ id: 2, name: 'A', category_group: 'arcade' }),
      row({ id: 3, name: 'A', category_group: 'puzzle' }),
    ])
    expect(g.rows.map(r => r.category_group)).toEqual(['puzzle', 'arcade', 'simulation'])
  })

  it('missingGenres liệt kê genre người đó chưa có, theo thứ tự chuẩn', () => {
    const [g] = groupRosterByPerson([row({ id: 1, name: 'A', category_group: 'arcade' })])
    expect(g.missingGenres).toEqual(['puzzle', 'simulation'])
  })

  it('người đủ 3 genre thì missingGenres rỗng', () => {
    const [g] = groupRosterByPerson([
      row({ id: 1, name: 'A', category_group: 'puzzle' }),
      row({ id: 2, name: 'A', category_group: 'arcade' }),
      row({ id: 3, name: 'A', category_group: 'simulation' }),
    ])
    expect(g.missingGenres).toEqual([])
  })

  it('today_available lấy theo người: dữ liệu lệch giữa các dòng vẫn ra một giá trị', () => {
    const [g] = groupRosterByPerson([
      row({ id: 1, name: 'A', category_group: 'puzzle', today_available: false }),
      row({ id: 2, name: 'A', category_group: 'arcade', today_available: true }),
    ])
    expect(typeof g.today_available).toBe('boolean')
    expect(g.today_available).toBe(false)
  })

  it('roster rỗng ra mảng rỗng', () => {
    expect(groupRosterByPerson([])).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/lib/assign-roster.test.ts`
Expected: FAIL — `Cannot find module '@/lib/assign-roster'`

- [ ] **Step 3: Write minimal implementation**

Tạo `lib/assign-roster.ts`:

```ts
// lib/assign-roster.ts — gom dòng evaluator_roster theo người cho bảng Assign
// một trang. Một dòng DB = một cặp (người, genre); bảng hiển thị gom chúng lại
// để cột Evaluator và Available gộp cell theo người.
import { BUCKETS, type Bucket } from '@/lib/buckets'

export interface RosterRow {
  id: number
  name: string
  category_group: Bucket
  today_available: boolean
  game_platform: string
  game_category: string
  weight: number
}

export interface PersonGroup {
  name: string
  today_available: boolean
  rows: RosterRow[]
  missingGenres: Bucket[]
}

const bucketRank = (b: string): number => {
  const i = (BUCKETS as readonly string[]).indexOf(b)
  return i === -1 ? BUCKETS.length : i
}

const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' })

export function groupRosterByPerson(rows: RosterRow[]): PersonGroup[] {
  const buckets = new Map<string, RosterRow[]>()
  for (const r of rows) {
    const list = buckets.get(r.name)
    if (list) list.push(r)
    else buckets.set(r.name, [r])
  }

  return Array.from(buckets.entries())
    .sort((a, b) => byName(a[0], b[0]))
    .map(([name, list]) => {
      const sorted = [...list].sort((a, b) => bucketRank(a.category_group) - bucketRank(b.category_group))
      const have = new Set(sorted.map(r => r.category_group))
      return {
        name,
        // Available là dữ kiện cấp người. Nếu các dòng lệch nhau thì đó là dữ
        // liệu cũ từ thời 3 tab; group lấy giá trị của dòng đầu và mọi lần ghi
        // đều ghi lại toàn bộ dòng cùng tên, nên nó tự hết lệch sau lần sửa đầu.
        today_available: sorted[0].today_available,
        rows: sorted,
        missingGenres: BUCKETS.filter(b => !have.has(b)),
      }
    })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/lib/assign-roster.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add lib/assign-roster.ts __tests__/lib/assign-roster.test.ts
git commit -m "feat(assign): a person's genres are one group, not three tabs"
```

---

### Task 2: `lib/assign-history-matrix.ts` — pivot history thành matrix

**Files:**
- Create: `lib/assign-history-matrix.ts`
- Test: `__tests__/lib/assign-history-matrix.test.ts`

**Interfaces:**
- Consumes: không gì từ task trước.
- Produces:
  - `interface HistoryRow { id: number; run_date: string; run_at: string; category_group: string; action: 'assign' | 'reassign' | 'handover'; evaluator_name: string; from_evaluator: string | null; game_count: number; created_by: string | null }`
  - `interface Totals { assign: number; reassign: number; handover: number }`
  - `interface Cell extends Totals { rows: HistoryRow[] }`
  - `interface MatrixRow { name: string; inRoster: boolean; cells: Cell[]; total: Totals }`
  - `interface Matrix { days: string[]; rows: MatrixRow[]; dayTotals: Totals[]; grandTotal: Totals }`
  - `function dayRange(from: string, to: string): string[]`
  - `function buildMatrix(input: { rows: HistoryRow[]; from: string; to: string; rosterNames: string[] }): Matrix`
  - `function shadeScale(values: number[]): (n: number) => 0 | 1 | 2 | 3 | 4`
  - `function shiftWindow(from: string, to: string, days: number): { from: string; to: string }`

- [ ] **Step 1: Write the failing test**

Tạo `__tests__/lib/assign-history-matrix.test.ts`:

```ts
import {
  buildMatrix, dayRange, shadeScale, shiftWindow, type HistoryRow,
} from '@/lib/assign-history-matrix'

const h = (o: Partial<HistoryRow> & { id: number; run_date: string; evaluator_name: string }): HistoryRow => ({
  run_at: `${o.run_date}T09:00:00Z`, category_group: 'puzzle', action: 'assign',
  from_evaluator: null, game_count: 1, created_by: 'cron', ...o,
})

describe('dayRange', () => {
  it('ra ngày liên tục, cũ trước mới sau, gồm cả hai đầu', () => {
    expect(dayRange('2026-08-24', '2026-08-27')).toEqual([
      '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27',
    ])
  })
  it('vượt biên tháng vẫn đúng', () => {
    expect(dayRange('2026-07-31', '2026-08-01')).toEqual(['2026-07-31', '2026-08-01'])
  })
  it('from sau to thì rỗng', () => {
    expect(dayRange('2026-08-27', '2026-08-24')).toEqual([])
  })
})

describe('buildMatrix', () => {
  const window = { from: '2026-08-24', to: '2026-08-26' }

  it('ngày không có data vẫn ra cột, ô bằng 0', () => {
    const m = buildMatrix({
      ...window, rosterNames: ['Ann'],
      rows: [h({ id: 1, run_date: '2026-08-24', evaluator_name: 'Ann', game_count: 4 })],
    })
    expect(m.days).toEqual(['2026-08-24', '2026-08-25', '2026-08-26'])
    expect(m.rows[0].cells.map(c => c.assign)).toEqual([4, 0, 0])
    expect(m.dayTotals.map(t => t.assign)).toEqual([4, 0, 0])
  })

  it('reassign và handover KHÔNG bị cộng vào số assign', () => {
    const m = buildMatrix({
      ...window, rosterNames: ['Ann'],
      rows: [
        h({ id: 1, run_date: '2026-08-25', evaluator_name: 'Ann', action: 'assign', game_count: 2 }),
        h({ id: 2, run_date: '2026-08-25', evaluator_name: 'Ann', action: 'reassign', game_count: 5, from_evaluator: 'Bob' }),
        h({ id: 3, run_date: '2026-08-25', evaluator_name: 'Ann', action: 'handover', game_count: 7 }),
      ],
    })
    const cell = m.rows[0].cells[1]
    expect(cell.assign).toBe(2)
    expect(cell.reassign).toBe(5)
    expect(cell.handover).toBe(7)
    expect(cell.rows).toHaveLength(3)
    expect(m.rows[0].total.assign).toBe(2)
    expect(m.grandTotal.assign).toBe(2)
  })

  it('người trong roster mà 0 history vẫn ra một dòng toàn 0', () => {
    const m = buildMatrix({ ...window, rosterNames: ['Ann', 'Zed'], rows: [] })
    expect(m.rows.map(r => r.name)).toEqual(['Ann', 'Zed'])
    expect(m.rows[1].cells.every(c => c.assign === 0)).toBe(true)
    expect(m.rows[1].inRoster).toBe(true)
  })

  it('người đã rời roster nhưng còn history vẫn hiện, inRoster = false, xếp sau', () => {
    const m = buildMatrix({
      ...window, rosterNames: ['Ann'],
      rows: [h({ id: 1, run_date: '2026-08-24', evaluator_name: 'OldGuy', game_count: 3 })],
    })
    expect(m.rows.map(r => r.name)).toEqual(['Ann', 'OldGuy'])
    expect(m.rows[1].inRoster).toBe(false)
    expect(m.rows[1].total.assign).toBe(3)
  })

  it('dòng ngoài cửa sổ bị bỏ, không làm lệch tổng', () => {
    const m = buildMatrix({
      ...window, rosterNames: ['Ann'],
      rows: [
        h({ id: 1, run_date: '2026-08-20', evaluator_name: 'Ann', game_count: 9 }),
        h({ id: 2, run_date: '2026-08-26', evaluator_name: 'Ann', game_count: 4 }),
      ],
    })
    expect(m.grandTotal.assign).toBe(4)
    expect(m.rows[0].total.assign).toBe(4)
  })

  it('run_date có phần giờ vẫn khớp đúng cột', () => {
    const m = buildMatrix({
      ...window, rosterNames: ['Ann'],
      rows: [h({ id: 1, run_date: '2026-08-25T00:00:00.000Z', evaluator_name: 'Ann', game_count: 2 })],
    })
    expect(m.rows[0].cells[1].assign).toBe(2)
  })
})

describe('shadeScale', () => {
  it('0 luôn ra bậc 0, số lớn nhất ra bậc 4', () => {
    const shade = shadeScale([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(shade(0)).toBe(0)
    expect(shade(8)).toBe(4)
    expect(shade(1)).toBe(1)
  })
  it('không có số dương nào thì mọi thứ là bậc 0', () => {
    const shade = shadeScale([0, 0])
    expect(shade(0)).toBe(0)
    expect(shade(5)).toBe(0)
  })
})

describe('shiftWindow', () => {
  it('lùi cửa sổ về trước đúng số ngày', () => {
    expect(shiftWindow('2026-08-14', '2026-08-27', -14)).toEqual({ from: '2026-07-31', to: '2026-08-13' })
  })
  it('tiến cửa sổ về sau đúng số ngày', () => {
    expect(shiftWindow('2026-07-31', '2026-08-13', 14)).toEqual({ from: '2026-08-14', to: '2026-08-27' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/lib/assign-history-matrix.test.ts`
Expected: FAIL — `Cannot find module '@/lib/assign-history-matrix'`

- [ ] **Step 3: Write minimal implementation**

Tạo `lib/assign-history-matrix.ts`:

```ts
// lib/assign-history-matrix.ts — pivot assignment_history thành matrix ngày × người.
//
// Hai luật không được vi phạm, vì vi phạm là matrix nói dối:
//  1. Số "assign" không bao giờ gộp reassign/handover vào. Một game bị reassign
//     đã được đếm một lần ở lần assign gốc; cộng lại là đếm hai.
//  2. Cột là ngày liên tục theo lịch, không phải chỉ ngày có data. Giá trị của
//     matrix nằm ở những ô trống — ngày cả team không nhận gì là thông tin.

export interface HistoryRow {
  id: number
  run_date: string
  run_at: string
  category_group: string
  action: 'assign' | 'reassign' | 'handover'
  evaluator_name: string
  from_evaluator: string | null
  game_count: number
  created_by: string | null
}

export interface Totals { assign: number; reassign: number; handover: number }
export interface Cell extends Totals { rows: HistoryRow[] }
export interface MatrixRow { name: string; inRoster: boolean; cells: Cell[]; total: Totals }
export interface Matrix { days: string[]; rows: MatrixRow[]; dayTotals: Totals[]; grandTotal: Totals }

const DAY_MS = 86_400_000

const zero = (): Totals => ({ assign: 0, reassign: 0, handover: 0 })
const emptyCell = (): Cell => ({ ...zero(), rows: [] })
const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' })

function actionOf(r: HistoryRow): keyof Totals {
  return r.action === 'reassign' || r.action === 'handover' ? r.action : 'assign'
}

function add(t: Totals, r: HistoryRow): void {
  t[actionOf(r)] += r.game_count || 0
}

export function dayRange(from: string, to: string): string[] {
  const start = Date.parse(`${from.slice(0, 10)}T00:00:00Z`)
  const end = Date.parse(`${to.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end)) return []
  const days: string[] = []
  for (let t = start; t <= end; t += DAY_MS) days.push(iso(t))
  return days
}

export function shiftWindow(from: string, to: string, days: number): { from: string; to: string } {
  const shift = days * DAY_MS
  return {
    from: iso(Date.parse(`${from.slice(0, 10)}T00:00:00Z`) + shift),
    to: iso(Date.parse(`${to.slice(0, 10)}T00:00:00Z`) + shift),
  }
}

export function buildMatrix(input: {
  rows: HistoryRow[]
  from: string
  to: string
  rosterNames: string[]
}): Matrix {
  const days = dayRange(input.from, input.to)
  const dayIndex = new Map(days.map((d, i) => [d, i]))

  // Roster hiện tại trước (kể cả người 0 history — đó là thứ cần thấy), rồi
  // những người chỉ còn tồn tại trong history.
  const inRoster = new Set(input.rosterNames)
  const names: string[] = []
  const seen = new Set<string>()
  for (const n of [...input.rosterNames].sort(byName)) {
    if (!seen.has(n)) { seen.add(n); names.push(n) }
  }
  for (const n of Array.from(new Set(input.rows.map(r => r.evaluator_name))).sort(byName)) {
    if (!seen.has(n)) { seen.add(n); names.push(n) }
  }

  const rowByName = new Map<string, MatrixRow>(names.map(n => [n, {
    name: n,
    inRoster: inRoster.has(n),
    cells: days.map(() => emptyCell()),
    total: zero(),
  }]))
  const dayTotals = days.map(() => zero())
  const grandTotal = zero()

  for (const r of input.rows) {
    const i = dayIndex.get(r.run_date.slice(0, 10))
    if (i === undefined) continue
    const mr = rowByName.get(r.evaluator_name)
    if (!mr) continue
    add(mr.cells[i], r)
    mr.cells[i].rows.push(r)
    add(mr.total, r)
    add(dayTotals[i], r)
    add(grandTotal, r)
  }

  return { days, rows: names.map(n => rowByName.get(n)!), dayTotals, grandTotal }
}

// Đậm nhạt theo quantile TRONG cửa sổ đang xem, không dùng thang tuyệt đối:
// pool mỗi ngày to nhỏ khác nhau nên một thang cố định sẽ sai liên tục.
export function shadeScale(values: number[]): (n: number) => 0 | 1 | 2 | 3 | 4 {
  const nz = values.filter(v => v > 0).sort((a, b) => a - b)
  if (nz.length === 0) return () => 0
  const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))]
  const q1 = q(0.25)
  const q2 = q(0.5)
  const q3 = q(0.75)
  return (n: number) => {
    if (n <= 0) return 0
    if (n <= q1) return 1
    if (n <= q2) return 2
    if (n <= q3) return 3
    return 4
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/lib/assign-history-matrix.test.ts`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add lib/assign-history-matrix.ts __tests__/lib/assign-history-matrix.test.ts
git commit -m "feat(assign): history reads as a grid of days, and empty days count"
```

---

### Task 3: `components/RosterTable.tsx` — bảng roster presentational

**Files:**
- Create: `components/RosterTable.tsx`
- Test: `__tests__/components/roster-table.test.tsx`

**Interfaces:**
- Consumes: `PersonGroup`, `RosterRow` từ `lib/assign-roster.ts` (Task 1); `StyledSelect`, `MultiSelect` (đã có); `BUCKETS`, `Bucket` từ `lib/buckets.ts`.
- Produces:
  - `interface RosterTableProps { title: string; groups: PersonGroup[]; subGenres: Record<Bucket, string[]>; readOnly?: boolean; scroll?: boolean; onPatchRow: (id: number, field: 'game_platform' | 'game_category' | 'weight', value: unknown) => void; onPatchAvailable: (name: string, value: boolean) => void; onRemoveRow: (id: number) => void; onAddGenre: (name: string, genre: Bucket) => void; onAddEvaluator: (p: { name: string; provision: boolean; genres: Bucket[] }) => void }`
  - `function RosterTable(props: RosterTableProps): JSX.Element`
  - `const BUCKET_LABELS: Record<Bucket, string>` (export, dùng lại ở Task 5, 7, 8)

- [ ] **Step 1: Write the failing test**

Tạo `__tests__/components/roster-table.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RosterTable } from '@/components/RosterTable'
import type { PersonGroup } from '@/lib/assign-roster'

const SUB_GENRES = {
  puzzle: ['puzzle', 'word', 'trivia'],
  arcade: ['arcade', 'action'],
  simulation: ['simulation', 'strategy'],
}

const groups: PersonGroup[] = [
  {
    name: 'NhiLV',
    today_available: true,
    missingGenres: ['simulation'],
    rows: [
      { id: 1, name: 'NhiLV', category_group: 'puzzle', today_available: true, game_platform: 'all', game_category: 'All', weight: 100 },
      { id: 2, name: 'NhiLV', category_group: 'arcade', today_available: true, game_platform: 'ios', game_category: 'action', weight: 50 },
    ],
  },
  {
    name: 'MyTL',
    today_available: false,
    missingGenres: ['arcade', 'simulation'],
    rows: [
      { id: 3, name: 'MyTL', category_group: 'puzzle', today_available: false, game_platform: 'all', game_category: 'All', weight: 100 },
    ],
  },
]

function setup(over: Partial<React.ComponentProps<typeof RosterTable>> = {}) {
  const props = {
    title: 'Initial Evaluator',
    groups,
    subGenres: SUB_GENRES,
    onPatchRow: jest.fn(),
    onPatchAvailable: jest.fn(),
    onRemoveRow: jest.fn(),
    onAddGenre: jest.fn(),
    onAddEvaluator: jest.fn(),
    ...over,
  }
  render(<RosterTable {...props} />)
  return props
}

describe('RosterTable', () => {
  it('cột Genre hiện tên genre của từng dòng, cột header là Sub-genre chứ không phải Category', () => {
    setup()
    expect(screen.getByText('Puzzle')).toBeInTheDocument()
    expect(screen.getByText('Arcade')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /sub-genre/i })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: /^category$/i })).not.toBeInTheDocument()
  })

  it('tên người xuất hiện một lần cho hai genre (gộp cell)', () => {
    setup()
    expect(screen.getAllByText('NhiLV')).toHaveLength(1)
  })

  it('ô Available chỉ có một cho mỗi người, và ghi theo tên chứ không theo id dòng', async () => {
    const { onPatchAvailable } = setup()
    const avail = screen.getAllByTestId('avail-cell')
    expect(avail).toHaveLength(2) // 2 người, không phải 3 dòng

    await userEvent.click(within(avail[0]).getByRole('button'))
    await userEvent.click(screen.getByRole('option', { name: 'No' }))
    expect(onPatchAvailable).toHaveBeenCalledWith('NhiLV', false)
  })

  it('+ genre chỉ đề xuất genre người đó chưa có', async () => {
    const { onAddGenre } = setup()
    await userEvent.click(screen.getByTestId('add-genre-NhiLV'))
    expect(screen.getByRole('option', { name: 'Simulation' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Puzzle' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('option', { name: 'Simulation' }))
    expect(onAddGenre).toHaveBeenCalledWith('NhiLV', 'simulation')
  })

  it('người đủ 3 genre không có nút + genre', () => {
    setup({
      groups: [{
        name: 'Full', today_available: true, missingGenres: [],
        rows: (['puzzle', 'arcade', 'simulation'] as const).map((g, i) => ({
          id: 10 + i, name: 'Full', category_group: g, today_available: true,
          game_platform: 'all', game_category: 'All', weight: 100,
        })),
      }],
    })
    expect(screen.queryByTestId('add-genre-Full')).not.toBeInTheDocument()
  })

  it('readOnly bỏ cột Remove, bỏ + genre và + Add evaluator', () => {
    setup({ readOnly: true })
    expect(screen.queryByText('Remove')).not.toBeInTheDocument()
    expect(screen.queryByTestId('add-genre-NhiLV')).not.toBeInTheDocument()
    expect(screen.queryByText(/add evaluator/i)).not.toBeInTheDocument()
  })

  it('roster rỗng hiện empty state', () => {
    setup({ groups: [] })
    expect(screen.getByText('No evaluators yet')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/components/roster-table.test.tsx`
Expected: FAIL — `Cannot find module '@/components/RosterTable'`

- [ ] **Step 3: Write minimal implementation**

Tạo `components/RosterTable.tsx`. Ghi chú khi viết:
- `rowSpan={group.rows.length + (showAddGenre ? 1 : 0)}` cho cột Evaluator và Available.
- Ô Available bọc trong `<td data-testid="avail-cell">`.
- Nút `+ genre` có `data-testid={`add-genre-${group.name}`}`, render trong một `<tr>` phụ cuối nhóm, chỉ khi `!readOnly && group.missingGenres.length > 0`.
- Dropdown genre và Available dùng `StyledSelect` (đã render `role="option"`); Sub-genre dùng `MultiSelect` như code cũ trong `AssignSetup.tsx:167-182`, giữ nguyên quy ước rỗng ↔ `'All'`.
- Sub-genre của một dòng lấy từ `subGenres[row.category_group]`, không phải một bucket dùng chung.
- `AddEvalRow` chuyển từ `AssignSetup.tsx:186-224` sang đây, thêm multi-select genre (mặc định chọn `puzzle`), và chặn submit khi `genres.length === 0`.

```tsx
// components/RosterTable.tsx — bảng roster một trang, một dòng = một cặp
// (người, genre). Presentational: mọi thao tác đi ra ngoài qua props, nên page
// giả lập fixture và page thật dùng chung đúng một component.
'use client'
import { useEffect, useMemo, useState } from 'react'
import { StyledSelect } from '@/components/StyledSelect'
import { MultiSelect } from '@/components/MultiSelect'
import { BUCKETS, WEIGHTS, type Bucket } from '@/lib/buckets'
import type { PersonGroup, RosterRow } from '@/lib/assign-roster'

export const BUCKET_LABELS: Record<Bucket, string> = {
  puzzle: 'Puzzle', arcade: 'Arcade', simulation: 'Simulation',
}

const WEIGHT_OPTS = WEIGHTS.map(w => ({ value: String(w), label: String(w) }))
const PLATFORM_OPTS = ['all', 'ios', 'android'].map(p => ({ value: p, label: p }))
const AVAIL_OPTS = [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }]

export interface RosterTableProps {
  title: string
  groups: PersonGroup[]
  subGenres: Record<Bucket, string[]>
  readOnly?: boolean
  scroll?: boolean
  onPatchRow: (id: number, field: 'game_platform' | 'game_category' | 'weight', value: unknown) => void
  onPatchAvailable: (name: string, value: boolean) => void
  onRemoveRow: (id: number) => void
  onAddGenre: (name: string, genre: Bucket) => void
  onAddEvaluator: (p: { name: string; provision: boolean; genres: Bucket[] }) => void
}
```

Phần thân bảng, viết đúng cấu trúc này:

```tsx
export function RosterTable({
  title, groups, subGenres, readOnly = false, scroll = false,
  onPatchRow, onPatchAvailable, onRemoveRow, onAddGenre, onAddEvaluator,
}: RosterTableProps) {
  const colSpan = readOnly ? 6 : 7
  return (
    <div className="card">
      <div className="card-head"><span className="card-label">{title}</span></div>
      <div className={`tbl-wrap roster-tbl${scroll ? ' roster-scroll' : ''}`}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Evaluator Name</th>
              <th style={{ width: 110 }}>Genre</th>
              <th style={{ width: 92 }}>Available</th>
              <th style={{ width: 88 }}>Platform</th>
              <th style={{ width: 150 }}>Sub-genre</th>
              <th style={{ width: 76 }}>Weight</th>
              {!readOnly && <th style={{ width: 70 }} />}
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && <tr><td colSpan={colSpan} className="empty">No evaluators yet</td></tr>}
            {groups.map(g => {
              const showAdd = !readOnly && g.missingGenres.length > 0
              const span = g.rows.length + (showAdd ? 1 : 0)
              return (
                <PersonRows key={g.name} group={g} span={span} showAdd={showAdd} subGenres={subGenres}
                  readOnly={readOnly} onPatchRow={onPatchRow} onPatchAvailable={onPatchAvailable}
                  onRemoveRow={onRemoveRow} onAddGenre={onAddGenre} />
              )
            })}
          </tbody>
        </table>
      </div>
      {!readOnly && <AddEvalRow onAdd={onAddEvaluator} />}
    </div>
  )
}
```

`PersonRows` trả về một fragment các `<tr>`: dòng đầu mang hai `<td>` gộp cell, các dòng sau không mang.

```tsx
function PersonRows({ group, span, showAdd, subGenres, readOnly, onPatchRow, onPatchAvailable, onRemoveRow, onAddGenre }: {
  group: PersonGroup; span: number; showAdd: boolean; subGenres: Record<Bucket, string[]>; readOnly: boolean
  onPatchRow: RosterTableProps['onPatchRow']
  onPatchAvailable: RosterTableProps['onPatchAvailable']
  onRemoveRow: RosterTableProps['onRemoveRow']
  onAddGenre: RosterTableProps['onAddGenre']
}) {
  return (
    <>
      {group.rows.map((r, i) => (
        <tr key={r.id} className={i === 0 ? 'person-first' : undefined}>
          {i === 0 && <td className="cell-name" rowSpan={span}>{group.name}</td>}
          <td className="cell-genre">{BUCKET_LABELS[r.category_group]}</td>
          {i === 0 && (
            <td rowSpan={span} data-testid="avail-cell">
              <StyledSelect value={group.today_available ? 'Yes' : 'No'} options={AVAIL_OPTS} disabled={readOnly}
                onChange={v => onPatchAvailable(group.name, v === 'Yes')} />
            </td>
          )}
          <td>
            <StyledSelect value={r.game_platform || 'all'} options={PLATFORM_OPTS} disabled={readOnly}
              onChange={v => onPatchRow(r.id, 'game_platform', v)} />
          </td>
          <td>
            <SubGenrePicker value={r.game_category} options={subGenres[r.category_group] ?? []} disabled={readOnly}
              onChange={v => onPatchRow(r.id, 'game_category', v)} />
          </td>
          <td>
            <StyledSelect value={String(r.weight ?? 100)} options={WEIGHT_OPTS} disabled={readOnly}
              onChange={v => onPatchRow(r.id, 'weight', Number(v))} />
          </td>
          {!readOnly && (
            <td><button className="btn btn-sm btn-danger" onClick={() => onRemoveRow(r.id)}>Remove</button></td>
          )}
        </tr>
      ))}
      {showAdd && (
        <tr className="person-add">
          <td className="cell-genre">
            <StyledSelect value="" placeholder="+ genre"
              options={group.missingGenres.map(b => ({ value: b, label: BUCKET_LABELS[b] }))}
              onChange={v => onAddGenre(group.name, v as Bucket)} />
          </td>
          <td colSpan={4} />
        </tr>
      )}
    </>
  )
}
```

Nút `+ genre` cần `data-testid`; `StyledSelect` không nhận prop đó, nên bọc lại: `<span data-testid={`add-genre-${group.name}`}> <StyledSelect .../> </span>`.

`SubGenrePicker` là `CategoryPicker` cũ đổi tên, prop `genres` thành `options`:

```tsx
// Multi-select sub-genre trong genre của chính dòng này. Rỗng ↔ 'All'.
function SubGenrePicker({ value, options, onChange, disabled }: {
  value: string; options: string[]; onChange: (v: string) => void; disabled?: boolean
}) {
  const selected = useMemo(
    () => (value && value.toLowerCase() !== 'all' ? value.split(',').map(s => s.trim()).filter(Boolean) : []),
    [value],
  )
  return (
    <MultiSelect
      value={selected}
      placeholder="All"
      disabled={disabled}
      options={options.map(g => ({ value: g, label: g }))}
      onChange={vals => onChange(vals.length === 0 ? 'All' : vals.join(','))}
    />
  )
}
```

`AddEvalRow`, chuyển từ `AssignSetup.tsx:186-224` sang đây và thêm multi-select genre:

```tsx
// Add-eval input với autocomplete dashboard_users; id lạ → cờ provision.
// Khác bản cũ: chọn được nhiều genre một lượt, mỗi genre thành một dòng roster.
function AddEvalRow({ onAdd }: { onAdd: RosterTableProps['onAddEvaluator'] }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [genres, setGenres] = useState<Bucket[]>(['puzzle'])
  const [sugg, setSugg] = useState<{ name: string; email: string }[]>([])

  useEffect(() => {
    if (!name.trim()) { setSugg([]); return }
    let alive = true
    const t = setTimeout(async () => {
      const res = await fetch(`/api/assign-setup/recommend?q=${encodeURIComponent(name.trim())}`, { cache: 'no-store' })
      if (alive && res.ok) setSugg((await res.json()).users ?? [])
    }, 200)
    return () => { alive = false; clearTimeout(t) }
  }, [name])

  function submit(provision: boolean, value?: string) {
    const n = (value ?? name).trim()
    if (!n || genres.length === 0) return
    onAdd({ name: n, provision, genres })
    setName(''); setSugg([]); setGenres(['puzzle']); setOpen(false)
  }

  const isKnown = sugg.some(s => s.name.toLowerCase() === name.trim().toLowerCase())

  if (!open) return <button className="add-row-btn" onClick={() => setOpen(true)}>+ Add evaluator</button>

  return (
    <div style={{ marginTop: 8, position: 'relative' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="input" style={{ flex: 1 }} autoFocus value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(!isKnown) }}
          placeholder="Type a name to search, or a new id (auto @athena.studio)…" />
        <MultiSelect value={genres} placeholder="Genre" style={{ width: 190 }}
          options={BUCKETS.map(b => ({ value: b, label: BUCKET_LABELS[b] }))}
          onChange={vals => setGenres(vals.filter((v): v is Bucket => (BUCKETS as readonly string[]).includes(v)))} />
        <button className="btn btn-primary btn-sm" disabled={!name.trim() || genres.length === 0}
          onClick={() => submit(!isKnown)}>
          {isKnown ? 'Add' : 'Add + create user'}
        </button>
        <button className="btn btn-sm" onClick={() => { setOpen(false); setName(''); setSugg([]) }}>✕</button>
      </div>
      {sugg.length > 0 && (
        <div className="ssel-menu" style={{ position: 'absolute', zIndex: 50, top: '100%', left: 0, right: 0, maxHeight: 200, overflowY: 'auto' }}>
          {sugg.map(s => (
            <div key={s.email} className="ssel-opt" onClick={() => submit(false, s.name)}>
              {s.name} <span style={{ color: 'var(--faint)' }}>· {s.email}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/components/roster-table.test.tsx`
Expected: PASS, 7 tests. Nếu `StyledSelect` không phát `role="option"`, đọc `components/StyledSelect.tsx` và sửa test cho khớp selector thật thay vì sửa component.

- [ ] **Step 5: Typecheck và commit**

```bash
npm run typecheck
git add components/RosterTable.tsx __tests__/components/roster-table.test.tsx
git commit -m "feat(assign): one Available switch per person, wherever their genres are"
```

---

### Task 4: `components/AssignHistoryMatrix.tsx` + CSS

**Files:**
- Create: `components/AssignHistoryMatrix.tsx`
- Modify: `app/globals.css` (thêm block `.hist-matrix`, cuối file)
- Test: `__tests__/components/assign-history-matrix.test.tsx`

**Interfaces:**
- Consumes: `Matrix`, `Cell`, `shadeScale` từ `lib/assign-history-matrix.ts` (Task 2).
- Produces: `function AssignHistoryMatrix({ matrix }: { matrix: Matrix }): JSX.Element`

- [ ] **Step 1: Write the failing test**

Tạo `__tests__/components/assign-history-matrix.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AssignHistoryMatrix } from '@/components/AssignHistoryMatrix'
import { buildMatrix, type HistoryRow } from '@/lib/assign-history-matrix'

const h = (o: Partial<HistoryRow> & { id: number; run_date: string; evaluator_name: string }): HistoryRow => ({
  run_at: `${o.run_date}T09:00:00Z`, category_group: 'puzzle', action: 'assign',
  from_evaluator: null, game_count: 1, created_by: 'cron', ...o,
})

const matrix = buildMatrix({
  from: '2026-08-24', to: '2026-08-26', rosterNames: ['Ann', 'Zed'],
  rows: [
    h({ id: 1, run_date: '2026-08-24', evaluator_name: 'Ann', game_count: 4 }),
    h({ id: 2, run_date: '2026-08-26', evaluator_name: 'Ann', action: 'reassign', game_count: 2, from_evaluator: 'Zed', created_by: 'KhangNA' }),
  ],
})

describe('AssignHistoryMatrix', () => {
  it('vẽ đủ cột cho mọi ngày trong cửa sổ, kể cả ngày trống', () => {
    render(<AssignHistoryMatrix matrix={matrix} />)
    expect(screen.getByRole('columnheader', { name: /24/ })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /25/ })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /26/ })).toBeInTheDocument()
  })

  it('người trong roster mà 0 game vẫn có dòng', () => {
    render(<AssignHistoryMatrix matrix={matrix} />)
    expect(screen.getByText('Zed')).toBeInTheDocument()
  })

  it('ô chỉ có reassign hiện dấu ▲ chứ không hiện 2 như số assign', () => {
    render(<AssignHistoryMatrix matrix={matrix} />)
    const cell = screen.getByTestId('cell-Ann-2026-08-26')
    expect(cell).toHaveTextContent('▲')
    expect(cell).not.toHaveTextContent('2')
  })

  it('bấm một ô có data mở popover chi tiết', async () => {
    render(<AssignHistoryMatrix matrix={matrix} />)
    await userEvent.click(screen.getByTestId('cell-Ann-2026-08-24'))
    expect(screen.getByRole('dialog')).toHaveTextContent(/assign/i)
    expect(screen.getByRole('dialog')).toHaveTextContent('puzzle')
  })

  it('cửa sổ không có gì thì hiện empty state', () => {
    const empty = buildMatrix({ from: '2026-08-24', to: '2026-08-26', rosterNames: [], rows: [] })
    render(<AssignHistoryMatrix matrix={empty} />)
    expect(screen.getByText('No history in this window')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/components/assign-history-matrix.test.tsx`
Expected: FAIL — `Cannot find module '@/components/AssignHistoryMatrix'`

- [ ] **Step 3: Write minimal implementation**

Tạo `components/AssignHistoryMatrix.tsx`:

```tsx
// components/AssignHistoryMatrix.tsx — matrix ngày × người, presentational.
// Số trong ô là assign. Reassign/handover chỉ hiện bằng dấu ▲ và trong popover,
// không bao giờ cộng vào con số — game bị reassign đã đếm ở lần assign gốc.
'use client'
import { useMemo, useState } from 'react'
import { shadeScale, type Cell, type Matrix } from '@/lib/assign-history-matrix'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const dayNum = (iso: string) => iso.slice(8, 10)
const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay()
const hhmm = (runAt: string) => (runAt.includes('T') ? runAt.slice(11, 16) : '')

export function AssignHistoryMatrix({ matrix }: { matrix: Matrix }) {
  const [openKey, setOpenKey] = useState<string | null>(null)

  const shade = useMemo(
    () => shadeScale(matrix.rows.flatMap(r => r.cells.map(c => c.assign))),
    [matrix],
  )

  if (matrix.rows.length === 0) return <p className="empty">No history in this window</p>

  return (
    <div className="hist-matrix-wrap">
      <table className="tbl hist-matrix">
        <thead>
          <tr>
            <th className="hm-name">Evaluator</th>
            {matrix.days.map(d => (
              <th key={d} className={`hm-day${dow(d) % 6 === 0 ? ' hm-weekend' : ''}`}>
                {dayNum(d)}<small>{WEEKDAYS[dow(d)]}</small>
              </th>
            ))}
            <th className="hm-total">TỔNG</th>
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map(r => (
            <tr key={r.name} className={r.inRoster ? undefined : 'hm-gone'}>
              <td className="hm-name">{r.name}</td>
              {r.cells.map((c, i) => {
                const key = `${r.name}-${matrix.days[i]}`
                return (
                  <td key={key} data-testid={`cell-${key}`} className={`hm-l${shade(c.assign)}`}>
                    {c.rows.length === 0
                      ? <span className="hm-none">·</span>
                      : (
                        <button onClick={() => setOpenKey(openKey === key ? null : key)}>
                          <CellValue cell={c} />
                        </button>
                      )}
                    {openKey === key && <CellDetail cell={c} day={matrix.days[i]} onClose={() => setOpenKey(null)} />}
                  </td>
                )
              })}
              <td className="hm-total">
                {r.total.assign}
                {r.total.reassign > 0 && <small> +{r.total.reassign}R</small>}
              </td>
            </tr>
          ))}
          <tr className="hm-foot">
            <td className="hm-name">Tổng</td>
            {matrix.dayTotals.map((t, i) => <td key={matrix.days[i]}>{t.assign || <span className="hm-none">·</span>}</td>)}
            <td className="hm-total">{matrix.grandTotal.assign}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// assign > 0 thì in số. Chỉ có reassign/handover thì in ▲ — không in con số của
// chúng, vì đọc nhanh sẽ tưởng đó là game mới được chia.
function CellValue({ cell }: { cell: Cell }) {
  const marked = cell.reassign > 0 || cell.handover > 0
  if (cell.assign > 0) return <>{cell.assign}{marked && <sup>▲</sup>}</>
  return <>▲</>
}

function CellDetail({ cell, day, onClose }: { cell: Cell; day: string; onClose: () => void }) {
  return (
    <div className="hm-pop" role="dialog" aria-label={`History ${day}`}>
      <div className="hm-pop-head">
        <span>{day}</span>
        <button onClick={onClose} aria-label="Close">✕</button>
      </div>
      {cell.rows.map(r => (
        <div className="hm-pop-row" key={r.id}>
          <span className="hm-pop-time">{hhmm(r.run_at)}</span>
          <span className={`pill ${r.action === 'assign' ? 'on' : r.action === 'reassign' ? 'tag' : 'off'}`}>{r.action}</span>
          <span>{r.category_group}</span>
          <span>{r.game_count} game</span>
          {r.from_evaluator && <span className="hm-pop-from">← {r.from_evaluator}</span>}
          <span className="hm-pop-by">{r.created_by ?? '—'}</span>
        </div>
      ))}
    </div>
  )
}
```

`dow(d) % 6 === 0` đúng cho cả Chủ nhật (0) và thứ Bảy (6).

- [ ] **Step 4: Thêm CSS**

Nối vào cuối `app/globals.css`:

```css
/* ── Assign history matrix ─────────────────────────────────────────────────── */
.hist-matrix-wrap { overflow-x: auto; }
.hist-matrix { border-collapse: collapse; font-size: 12.5px; }
.hist-matrix th, .hist-matrix td { padding: 4px 6px; text-align: center; }
.hist-matrix .hm-name {
  position: sticky; left: 0; z-index: 1; text-align: left;
  background: var(--card); white-space: nowrap; padding-right: 12px;
}
.hist-matrix .hm-day { line-height: 1.15; font-weight: 600; }
.hist-matrix .hm-day small { display: block; font-weight: 400; color: var(--faint); }
.hist-matrix .hm-weekend { color: var(--faint); }
.hist-matrix .hm-none { color: var(--faint); }
.hist-matrix .hm-gone .hm-name { color: var(--faint); }
.hist-matrix .hm-total { font-weight: 600; }
.hist-matrix .hm-l1 { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.hist-matrix .hm-l2 { background: color-mix(in srgb, var(--accent) 22%, transparent); }
.hist-matrix .hm-l3 { background: color-mix(in srgb, var(--accent) 36%, transparent); }
.hist-matrix .hm-l4 { background: color-mix(in srgb, var(--accent) 52%, transparent); }
.hist-matrix button { all: unset; cursor: pointer; display: block; width: 100%; }
.hist-matrix td { position: relative; }
.hist-matrix .hm-foot td { border-top: 1px solid var(--line); font-weight: 600; }
.hm-pop {
  position: absolute; z-index: 40; top: 100%; left: 50%; transform: translateX(-50%);
  min-width: 260px; padding: 8px 10px; text-align: left; font-size: 12px;
  background: var(--card); border: 1px solid var(--line); border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .18);
}
.hm-pop-head { display: flex; justify-content: space-between; margin-bottom: 6px; font-weight: 600; }
.hm-pop-row { display: flex; align-items: center; gap: 6px; white-space: nowrap; padding: 2px 0; }
.hm-pop-time { color: var(--faint); font-variant-numeric: tabular-nums; }
.hm-pop-from, .hm-pop-by { color: var(--faint); }
```

Nếu `--accent`, `--card` hoặc `--line` không tồn tại, `grep -n "^  --" app/globals.css` lấy tên biến thật của theme và dùng tên đó.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest __tests__/components/assign-history-matrix.test.tsx`
Expected: PASS, 5 tests

- [ ] **Step 6: Typecheck và commit**

```bash
npm run typecheck
git add components/AssignHistoryMatrix.tsx app/globals.css __tests__/components/assign-history-matrix.test.tsx
git commit -m "feat(assign): a day nobody got a game is a column, not a gap"
```

---

### Task 5: Page giả lập `/team-ops/assign-preview` — cổng xem mắt

Đây là bản riêng để xem layout mà **không đụng API và không ghi DB**, theo yêu cầu. Nó dùng đúng hai component thật ở Task 3 và 4, nên không có UI nào bị viết hai lần; chỉ dữ liệu là fixture. Page và fixture **bị xoá ở Task 10**.

**Files:**
- Create: `app/(manager)/team-ops/assign-preview/page.tsx`
- Create: `app/(manager)/team-ops/assign-preview/fixture.ts`

**Interfaces:**
- Consumes: `RosterTable`, `BUCKET_LABELS` (Task 3); `AssignHistoryMatrix` (Task 4); `groupRosterByPerson` (Task 1); `buildMatrix` (Task 2).
- Produces: không gì cho task sau.

- [ ] **Step 1: Viết fixture**

`fixture.ts` phải chứa đủ các ca biên spec đã nêu: người 2 genre, người 3 genre, người 1 genre, người `Available = No`, người platform-specific, người trong roster mà 0 history, một ngày cả team trống, một ngày có reassign.

```ts
// Fixture chỉ cho page giả lập /team-ops/assign-preview. Xoá cùng page đó.
import type { RosterRow } from '@/lib/assign-roster'
import type { HistoryRow } from '@/lib/assign-history-matrix'

const r = (
  id: number, name: string, category_group: RosterRow['category_group'],
  o: Partial<RosterRow> = {},
): RosterRow => ({
  id, name, category_group, today_available: true,
  game_platform: 'all', game_category: 'All', weight: 100, ...o,
})

export const FIXTURE_INITIAL: RosterRow[] = [
  r(1, 'NhiLV', 'puzzle'),
  r(2, 'NhiLV', 'arcade', { game_platform: 'ios', game_category: 'action', weight: 50 }),
  r(3, 'MyTL', 'puzzle'),
  r(4, 'MiTT', 'puzzle', { weight: 50 }),
  r(5, 'MiTT', 'arcade', { weight: 50 }),
  r(6, 'MiTT', 'simulation', { game_category: 'strategy', weight: 30 }),
  r(7, 'GabrielTran', 'puzzle', { today_available: false, game_platform: 'ios', weight: 30 }),
  r(8, 'HuyDD', 'puzzle'),
  r(9, 'KietCD', 'arcade', { game_platform: 'android', weight: 50 }),
]

export const FIXTURE_FINAL: RosterRow[] = [
  r(20, 'ThuDT', 'puzzle'),
  r(21, 'PhuongNT1', 'puzzle', { game_platform: 'ios' }),
]

export const FIXTURE_SUB_GENRES = {
  puzzle: ['puzzle', 'word', 'trivia', 'music', 'casual'],
  arcade: ['arcade', 'adventure', 'action'],
  simulation: ['simulation', 'strategy'],
}

export const FIXTURE_WINDOW = { from: '2026-08-14', to: '2026-08-27' }

// 20/8 cố tình trống hết. 25/8 có một reassign. KietCD không có dòng nào.
export const FIXTURE_HISTORY: HistoryRow[] = (() => {
  const out: HistoryRow[] = []
  const days = ['2026-08-18', '2026-08-19', '2026-08-21', '2026-08-22', '2026-08-25', '2026-08-26', '2026-08-27']
  const per: Record<string, number> = { NhiLV: 4, MyTL: 4, MiTT: 2, HuyDD: 4 }
  let id = 1
  for (const d of days) {
    for (const [name, n] of Object.entries(per)) {
      if (d === '2026-08-19' && name === 'HuyDD') continue
      out.push({
        id: id++, run_date: d, run_at: `${d}T09:00:00Z`, category_group: 'puzzle',
        action: 'assign', evaluator_name: name, from_evaluator: null,
        game_count: d === '2026-08-22' ? n + 2 : n, created_by: 'cron',
      })
    }
  }
  out.push({
    id: id++, run_date: '2026-08-25', run_at: '2026-08-25T14:20:00Z', category_group: 'puzzle',
    action: 'reassign', evaluator_name: 'MiTT', from_evaluator: 'HuyDD',
    game_count: 1, created_by: 'KhangNA',
  })
  return out
})()
```

- [ ] **Step 2: Viết page**

```tsx
// Page GIẢ LẬP để xem layout Assign một trang trước khi đụng API thật.
// Không fetch, không ghi DB. Xoá page này và fixture.ts khi Assign thật xong.
'use client'
import { useMemo, useState } from 'react'
import { RosterTable, BUCKET_LABELS } from '@/components/RosterTable'
import { AssignHistoryMatrix } from '@/components/AssignHistoryMatrix'
import { groupRosterByPerson } from '@/lib/assign-roster'
import { buildMatrix } from '@/lib/assign-history-matrix'
import { BUCKETS, type Bucket } from '@/lib/buckets'
import {
  FIXTURE_INITIAL, FIXTURE_FINAL, FIXTURE_SUB_GENRES, FIXTURE_HISTORY, FIXTURE_WINDOW,
} from './fixture'

const noop = () => {}

export default function AssignPreviewPage() {
  const [genre, setGenre] = useState<Bucket | 'all'>('all')

  const initial = useMemo(
    () => groupRosterByPerson(FIXTURE_INITIAL.filter(r => genre === 'all' || r.category_group === genre)),
    [genre],
  )
  const final = useMemo(
    () => groupRosterByPerson(FIXTURE_FINAL.filter(r => genre === 'all' || r.category_group === genre)),
    [genre],
  )
  const matrix = useMemo(() => buildMatrix({
    ...FIXTURE_WINDOW,
    rows: FIXTURE_HISTORY.filter(r => genre === 'all' || r.category_group === genre),
    rosterNames: Array.from(new Set(FIXTURE_INITIAL.map(r => r.name))),
  }), [genre])

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h-title">Assign · preview (fixture)</h1>
      </div>
      <div className="seg-wrapper" style={{ display: 'inline-flex', gap: 4, marginBottom: 14 }}>
        {(['all', ...BUCKETS] as const).map(g => (
          <button key={g} className={`seg-btn-premium${genre === g ? ' active' : ''}`} onClick={() => setGenre(g)}>
            {g === 'all' ? 'All' : BUCKET_LABELS[g]}
          </button>
        ))}
      </div>
      <RosterTable title="Initial Evaluator" groups={initial} subGenres={FIXTURE_SUB_GENRES}
        onPatchRow={noop} onPatchAvailable={noop} onRemoveRow={noop} onAddGenre={noop} onAddEvaluator={noop} />
      <div style={{ height: 14 }} />
      <RosterTable title="Final Evaluator" groups={final} subGenres={FIXTURE_SUB_GENRES}
        onPatchRow={noop} onPatchAvailable={noop} onRemoveRow={noop} onAddGenre={noop} onAddEvaluator={noop} />
      <div style={{ height: 18 }} />
      <div className="card">
        <div className="card-head"><span className="card-label">History · 14 ngày</span></div>
        <AssignHistoryMatrix matrix={matrix} />
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Xem bằng mắt**

Chạy `npm run dev` (port 3333) và mở `http://localhost:3333/team-ops/assign-preview`.

Kiểm bằng mắt, đây là cổng của task này:
1. NhiLV và MiTT: tên hiện một lần, ô Available một cái, gộp đúng số dòng.
2. Dòng Arcade của NhiLV: dropdown Sub-genre chỉ có `arcade, adventure, action`.
3. MiTT đủ 3 genre nên không có `+ genre`; NhiLV có, và chỉ đề xuất Simulation.
4. Matrix: cột 20/8 và 24/8 toàn `·`; KietCD là một dòng toàn `·`; ô MiTT 25/8 có `▲`; bấm vào ra popover có dòng reassign ← HuyDD.
5. Cuộn ngang matrix: cột tên đứng yên.

- [ ] **Step 4: Commit**

```bash
git add "app/(manager)/team-ops/assign-preview"
git commit -m "feat(assign): a fixture page to look at before touching the real one"
```

---

### Task 6: `/api/assign-setup` — GET cả 3 genre, PATCH available theo người, POST nhiều genre

**Files:**
- Modify: `app/api/assign-setup/route.ts`
- Test: `__tests__/api/assign-setup.test.ts` (sửa file đã có)

**Interfaces:**
- Consumes: `isBucket`, `isWeight`, `normalizeCategory`, `BUCKETS` từ `lib/buckets.ts`.
- Produces (contract HTTP mà Task 7 gọi):
  - `GET /api/assign-setup` → `{ initial: RosterRow[], final: RosterRow[] }`, mỗi row có thêm `category_group`. Không nhận query param nào.
  - `PATCH` body `{ field: 'today_available', list_type: 'initial'|'final', name: string, value: boolean }` → cập nhật mọi dòng cùng `(list_type, name)`.
  - `PATCH` body `{ id: number, field: 'game_platform'|'game_category'|'weight', value: unknown }` → như cũ.
  - `POST` body `{ list_type, name, provision?, category_groups: Bucket[], weight?, game_platform?, game_category?, today_available? }` → insert N dòng.
  - `DELETE` body `{ id }` → như cũ.

- [ ] **Step 1: Write the failing tests**

Trong `__tests__/api/assign-setup.test.ts`: **xoá** hai test `GET requires a valid group` và `GET returns initial + final split by list_type`, **xoá** `POST rejects an invalid bucket`, rồi thêm:

```ts
  it('GET trả cả 3 genre trong một lần, không cần query param', async () => {
    sqlMock.mockResolvedValueOnce([
      { id: 1, name: 'Ann', category_group: 'puzzle', today_available: true, game_platform: 'all', game_category: 'All', weight: 100, list_type: 'initial' },
      { id: 2, name: 'Ann', category_group: 'arcade', today_available: true, game_platform: 'ios', game_category: 'action', weight: 50, list_type: 'initial' },
      { id: 3, name: 'Bob', category_group: 'puzzle', today_available: false, game_platform: 'ios', game_category: 'word', weight: 70, list_type: 'final' },
    ])
    const res = await GET(req('/api/assign-setup'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.initial).toHaveLength(2)
    expect(json.final).toHaveLength(1)
    expect(json.initial[0].category_group).toBe('puzzle')
  })

  it('PATCH today_available ghi theo (list_type, name), không theo id', async () => {
    sqlMock.mockResolvedValue([])
    const res = await PATCH(req('/api/assign-setup', {
      method: 'PATCH',
      body: JSON.stringify({ field: 'today_available', list_type: 'initial', name: 'Ann', value: false }),
    }))
    expect(res.status).toBe(200)
    const stmt = sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? (c[0] as string[]).join(' ') : '')).join('\n')
    expect(stmt).toContain('list_type')
    expect(stmt).toContain('name')
    expect(stmt).not.toContain('WHERE id')
    expect(sqlMock.mock.calls.length).toBe(1) // một câu, không loop từng genre
  })

  it('PATCH today_available đòi name và list_type hợp lệ', async () => {
    const noName = await PATCH(req('/api/assign-setup', {
      method: 'PATCH', body: JSON.stringify({ field: 'today_available', list_type: 'initial', value: false }),
    }))
    expect(noName.status).toBe(400)
    const badList = await PATCH(req('/api/assign-setup', {
      method: 'PATCH', body: JSON.stringify({ field: 'today_available', list_type: 'both', name: 'Ann', value: false }),
    }))
    expect(badList.status).toBe(400)
  })

  it('PATCH các field khác vẫn đòi id', async () => {
    const res = await PATCH(req('/api/assign-setup', {
      method: 'PATCH', body: JSON.stringify({ field: 'weight', value: 50 }),
    }))
    expect(res.status).toBe(400)
  })

  it('POST category_groups tạo một dòng cho mỗi genre', async () => {
    sqlMock.mockResolvedValue([])
    const res = await POST(req('/api/assign-setup', {
      method: 'POST',
      body: JSON.stringify({ list_type: 'initial', name: 'Ann', category_groups: ['puzzle', 'arcade'] }),
    }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, inserted: 2 })
  })

  it('POST rejects khi category_groups rỗng hoặc toàn genre lạ', async () => {
    const empty = await POST(req('/api/assign-setup', {
      method: 'POST', body: JSON.stringify({ list_type: 'initial', name: 'Ann', category_groups: [] }),
    }))
    expect(empty.status).toBe(400)
    const bogus = await POST(req('/api/assign-setup', {
      method: 'POST', body: JSON.stringify({ list_type: 'initial', name: 'Ann', category_groups: ['rpg'] }),
    }))
    expect(bogus.status).toBe(400)
  })
```

Sửa test `POST with provision …` cho khớp body mới: đổi `category_group: 'puzzle'` thành `category_groups: ['puzzle']`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest __tests__/api/assign-setup.test.ts`
Expected: FAIL — GET trả 400 vì thiếu `group`, PATCH available trả 400 vì thiếu `id`, POST trả 400 vì thiếu `category_group`.

- [ ] **Step 3: Sửa route**

Trong `app/api/assign-setup/route.ts`:

`GET` — bỏ đọc và validate `group`, bỏ `WHERE`, thêm `category_group` vào SELECT và đổi ORDER BY:

```ts
export async function GET() {
  const guard = await requireRole(['admin', 'moderator', 'evaluator'])
  if (guard) return guard

  const rows = await sql<RosterRow[]>`
    SELECT id, name, category_group, today_available, game_platform, game_category, weight, list_type
    FROM evaluator_roster
    ORDER BY name ASC,
             array_position(ARRAY['puzzle','arcade','simulation']::text[], category_group)
  `
  let initial = rows.filter(r => r.list_type === 'initial')
  let final = rows.filter(r => r.list_type === 'final')
  // ...phần scope evaluator giữ nguyên y hệt
}
```

Nhớ thêm `category_group: string` vào `interface RosterRow` trong file này, và đổi signature `GET(req: NextRequest)` thành `GET()` — nếu ESLint đòi giữ param thì để `GET(_req: NextRequest)`.

`PATCH` — chuyển nhánh available lên trước và bỏ ràng buộc `id` cho riêng nó:

```ts
export async function PATCH(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  const { id, field, value, name, list_type: listType } = await req.json()

  try {
    // Available là dữ kiện cấp người, nên ghi theo (list_type, name) — mọi genre
    // của người đó, một câu. Đây là chỗ duy nhất ngữ nghĩa "theo người" tồn tại;
    // để nó ở server nên UI không thể tạo ra trạng thái lệch giữa các genre.
    if (field === 'today_available') {
      const who = typeof name === 'string' ? name.trim() : ''
      if (!who) return NextResponse.json({ error: 'name is required' }, { status: 400 })
      if (listType !== 'initial' && listType !== 'final') {
        return NextResponse.json({ error: 'Invalid list_type' }, { status: 400 })
      }
      await sql`
        UPDATE evaluator_roster
        SET today_available = ${value === true || value === 'Yes'}, updated_at = NOW()
        WHERE list_type = ${listType} AND name = ${who}
      `
      return NextResponse.json({ ok: true })
    }

    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    if (field === 'game_platform') {
      // ...ba nhánh còn lại giữ nguyên
    }
```

`POST` — nhận nhiều genre, insert một câu, kế thừa available:

```ts
  const groups: Bucket[] = Array.isArray(b.category_groups)
    ? b.category_groups.filter(isBucket)
    : isBucket(b.category_group) ? [b.category_group] : []
  if (groups.length === 0) return NextResponse.json({ error: 'category_groups is required' }, { status: 400 })
```

Chỗ insert, thay câu cũ bằng:

```ts
    // Available kế thừa từ dòng đã có của người này (nếu có), để thêm một genre
    // mới cho người đang nghỉ không âm thầm bật họ trở lại.
    const [existing] = await sql<{ today_available: boolean }[]>`
      SELECT today_available FROM evaluator_roster
      WHERE list_type = ${b.list_type} AND name = ${name} LIMIT 1
    `
    const avail = existing ? existing.today_available : (b.today_available === false ? false : true)

    const values = groups.map(g => ({
      list_type: b.list_type, category_group: g, name,
      today_available: avail, game_platform: platform, game_category: category, weight,
    }))
    await sql`
      INSERT INTO evaluator_roster ${sql(values, 'list_type', 'category_group', 'name', 'today_available', 'game_platform', 'game_category', 'weight')}
      ON CONFLICT (list_type, category_group, name) DO NOTHING
    `
    return NextResponse.json({ ok: true, inserted: groups.length })
```

Thêm `import { BUCKETS, type Bucket, isBucket, ... } from '@/lib/buckets'` cho khớp. Bỏ dòng `const available = ...` cũ. Giữ nguyên khối `provision`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest __tests__/api/assign-setup.test.ts`
Expected: PASS. Test `POST with provision` giờ có 3 câu SQL (SELECT available, INSERT users, INSERT roster) — nếu assertion cũ đếm số câu thì nới ra.

- [ ] **Step 5: Typecheck và commit**

```bash
npm run typecheck
git add app/api/assign-setup/route.ts __tests__/api/assign-setup.test.ts
git commit -m "fix(assign): a person's availability is written once, for every genre"
```

---

### Task 7: Nối `AssignSetup` vào API mới + filter chip genre

**Files:**
- Modify: `components/AssignSetup.tsx` (viết lại phần lớn)

**Interfaces:**
- Consumes: `RosterTable`, `BUCKET_LABELS` (Task 3); `groupRosterByPerson`, `RosterRow` (Task 1); contract HTTP ở Task 6; `useCategoryMappings` (đã có).
- Produces: `function AssignSetup({ isEvaluator, userName, genre, onRosterNames }: { isEvaluator?: boolean; userName?: string; genre: Bucket | 'all'; onRosterNames?: (names: string[]) => void }): JSX.Element`

`onRosterNames` là cách Task 8 lấy danh sách tên roster để matrix biết ai đang trong roster mà 0 history.

- [ ] **Step 1: Viết lại AssignSetup**

Thay thân file `components/AssignSetup.tsx`:

```tsx
// components/AssignSetup.tsx — roster một trang: một dòng = một cặp (người, genre).
// Không còn prop bucket; genre là filter view do page truyền xuống. Render uỷ
// cho RosterTable, ở đây chỉ còn fetch và bốn thao tác ghi.
'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RosterTable } from '@/components/RosterTable'
import { useCategoryMappings } from '@/hooks/useCategoryMappings'
import { groupRosterByPerson, type RosterRow } from '@/lib/assign-roster'
import type { Bucket } from '@/lib/buckets'

type ListType = 'initial' | 'final'

export function AssignSetup({ isEvaluator = false, userName = '', genre, onRosterNames }: {
  isEvaluator?: boolean; userName?: string; genre: Bucket | 'all'
  onRosterNames?: (names: string[]) => void
}) {
  const { data: subGenres } = useCategoryMappings()
  const [initial, setInitial] = useState<RosterRow[]>([])
  const [final, setFinal] = useState<RosterRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/assign-setup', { cache: 'no-store' })
      if (!res.ok) throw new Error()
      const json = await res.json()
      setInitial(json.initial ?? []); setFinal(json.final ?? [])
    } catch { setError('Failed to load roster.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Tên roster của list Initial, cho matrix History biết ai đang trong roster.
  useEffect(() => {
    onRosterNames?.(Array.from(new Set(initial.map(r => r.name))))
  }, [initial, onRosterNames])

  const visible = useCallback(
    (rows: RosterRow[]) => rows.filter(r => genre === 'all' || r.category_group === genre),
    [genre],
  )

  // Evaluator chỉ thấy dòng của chính họ ở Initial (server cũng đã lọc).
  const initialGroups = useMemo(() => groupRosterByPerson(
    visible(isEvaluator ? initial.filter(r => r.name.toLowerCase() === userName.toLowerCase()) : initial),
  ), [visible, isEvaluator, initial, userName])
  const finalGroups = useMemo(() => groupRosterByPerson(visible(final)), [visible, final])
```

Bốn thao tác ghi, đều `refresh()` sau khi ok:

```tsx
  const send = useCallback(async (method: string, body: unknown, msg: string) => {
    const res = await fetch('/api/assign-setup', {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    if (res.ok) refresh(); else setError(msg)
  }, [refresh])

  const patchRow = (id: number, field: string, value: unknown) =>
    send('PATCH', { id, field, value }, 'Update failed.')
  const patchAvailable = (list_type: ListType) => (name: string, value: boolean) =>
    send('PATCH', { field: 'today_available', list_type, name, value }, 'Update failed.')
  const removeRow = (id: number) => send('DELETE', { id }, 'Delete failed.')
  const addGenre = (list_type: ListType) => (name: string, g: Bucket) =>
    send('POST', { list_type, name, category_groups: [g] }, 'Add failed.')
  const addEvaluator = (list_type: ListType) => (p: { name: string; provision: boolean; genres: Bucket[] }) =>
    send('POST', { list_type, name: p.name, provision: p.provision, category_groups: p.genres }, 'Add failed.')
```

Phần render:

```tsx
  return (
    <div className="assign-setup">
      <div className="roster-head">
        <span className="card-label">Roster</span>
        <button className="btn btn-sm" onClick={refresh} disabled={loading}>
          <span className={loading ? 'spin' : ''}>↻</span>{loading ? '...' : 'Refresh'}
        </button>
      </div>
      {error && <p className="msg-err">{error}</p>}

      <RosterTable title="Initial Evaluator" groups={initialGroups} subGenres={subGenres} scroll
        readOnly={isEvaluator}
        onPatchRow={patchRow} onPatchAvailable={patchAvailable('initial')} onRemoveRow={removeRow}
        onAddGenre={addGenre('initial')} onAddEvaluator={addEvaluator('initial')} />
      {!isEvaluator && (
        <RosterTable title="Final Evaluator" groups={finalGroups} subGenres={subGenres}
          onPatchRow={patchRow} onPatchAvailable={patchAvailable('final')} onRemoveRow={removeRow}
          onAddGenre={addGenre('final')} onAddEvaluator={addEvaluator('final')} />
      )}
    </div>
  )
}
```

Xoá khỏi file: `RosterTable` cũ, `CategoryPicker`, `AddEvalRow`, `WEIGHT_OPTS`, `PLATFORM_OPTS`, `AVAIL_OPTS`, import `StyledSelect`/`MultiSelect`/`WEIGHTS` — tất cả đã chuyển sang `components/RosterTable.tsx` ở Task 3.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: lỗi duy nhất còn lại là `app/(manager)/team-ops/page.tsx` vẫn truyền prop `bucket` — Task 9 sửa. Nếu có lỗi khác, sửa ngay ở đây.

- [ ] **Step 3: Run test suite**

Run: `npm test`
Expected: PASS toàn bộ (không test nào render `AssignSetup` trực tiếp).

- [ ] **Step 4: Commit**

```bash
git add components/AssignSetup.tsx
git commit -m "refactor(assign): the roster loads once for every genre"
```

---

### Task 8: Nối `AssignHistory` vào matrix

**Files:**
- Modify: `components/AssignHistory.tsx` (viết lại)

**Interfaces:**
- Consumes: `buildMatrix`, `shiftWindow`, `HistoryRow` (Task 2); `AssignHistoryMatrix` (Task 4). API `/api/admin/assignment-history` **đã** hỗ trợ `from`/`to` và bỏ `category` là được cả 3 genre — không sửa route đó.
- Produces: `function AssignHistory({ genre, rosterNames }: { genre: Bucket | 'all'; rosterNames: string[] }): JSX.Element`

- [ ] **Step 1: Viết lại AssignHistory**

Thay toàn bộ `components/AssignHistory.tsx`. Bỏ `groupRows`, `YearGroup`/`MonthGroup`/`DayGroup`, `RunsGames`, `openMonths`/`openDays`/`seeded` — cả khối year → month → day không còn dùng.

```tsx
// components/AssignHistory.tsx — assignment_history dạng matrix ngày × người.
// Cửa sổ 14 ngày, lùi/tiến bằng ◀ ▶. Số trong ô là assign; reassign/handover
// không bao giờ được cộng vào (game bị reassign đã đếm ở lần assign gốc).
'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AssignHistoryMatrix } from '@/components/AssignHistoryMatrix'
import { buildMatrix, shiftWindow, type HistoryRow } from '@/lib/assign-history-matrix'
import type { Bucket } from '@/lib/buckets'

const WINDOW_DAYS = 14

// Cửa sổ mặc định: 14 ngày tính đến hôm nay theo giờ VN.
function defaultWindow(): { from: string; to: string } {
  const vn = new Date(Date.now() + 7 * 3600_000)
  const to = vn.toISOString().slice(0, 10)
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (WINDOW_DAYS - 1) * 86_400_000)
    .toISOString().slice(0, 10)
  return { from, to }
}

export function AssignHistory({ genre, rosterNames }: { genre: Bucket | 'all'; rosterNames: string[] }) {
  const [win, setWin] = useState(defaultWindow)
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const qs = new URLSearchParams({ from: win.from, to: win.to, limit: '1000' })
      const res = await fetch(`/api/admin/assignment-history?${qs}`, { cache: 'no-store' })
      if (!res.ok) throw new Error()
      setRows((await res.json()).rows ?? [])
    } catch { setError('Failed to load history.') }
    finally { setLoading(false) }
  }, [win])

  useEffect(() => { refresh() }, [refresh])

  const matrix = useMemo(() => buildMatrix({
    ...win,
    rows: rows.filter(r => genre === 'all' || r.category_group === genre),
    rosterNames,
  }), [win, rows, genre, rosterNames])

  return (
    <div className="card hist-card">
      <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span className="card-label">History</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button className="btn btn-sm" onClick={() => setWin(w => shiftWindow(w.from, w.to, -WINDOW_DAYS))}>◀</button>
          <span className="hist-sub">{win.from} → {win.to}</span>
          <button className="btn btn-sm" onClick={() => setWin(w => shiftWindow(w.from, w.to, WINDOW_DAYS))}>▶</button>
          <button className="btn btn-sm" onClick={refresh} disabled={loading}>
            <span className={loading ? 'spin' : ''}>↻</span>{loading ? '...' : 'Refresh'}
          </button>
        </div>
      </div>
      {error && <p className="msg-err" style={{ margin: '8px 0' }}>{error}</p>}
      <AssignHistoryMatrix matrix={matrix} />
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: chỉ còn lỗi ở `team-ops/page.tsx` (prop cũ), Task 9 sửa.

- [ ] **Step 3: Kiểm CSS còn dùng**

Run: `grep -n "hist-year\|hist-month\|hist-day\|hist-row\|hist-move\|hist-caret\|hist-n-assign" app/globals.css components -r`
Nếu không component nào còn dùng mấy class đó, xoá các rule tương ứng trong `app/globals.css`. Giữ `.hist-card`, `.hist-sub`, `.empty`.

- [ ] **Step 4: Commit**

```bash
git add components/AssignHistory.tsx app/globals.css
git commit -m "feat(assign): history is a grid of days and people, not a tree of dates"
```

---

### Task 9: `team-ops/page.tsx` xếp dọc + đổi label Config

**Files:**
- Modify: `app/(manager)/team-ops/page.tsx:68-90`
- Modify: `app/(manager)/config/page.tsx:146,183,247`
- Modify: `app/globals.css` (`.assign-grid`, `.assign-right`)

**Interfaces:**
- Consumes: `AssignSetup` (Task 7), `AssignHistory` (Task 8), `BUCKET_LABELS` (Task 3).
- Produces: không gì cho task sau.

- [ ] **Step 1: Sửa AssignTab**

Thay hàm `AssignTab` trong `app/(manager)/team-ops/page.tsx`:

```tsx
// Assign tab: một trang cho cả 3 genre. Roster trên, history matrix dưới.
// Filter chip chỉ lọc view — nó không quyết định cái gì được load, khác hẳn
// bộ tab genre cũ mà nó thay thế.
function AssignTab() {
  const { data: session } = useSession()
  const isEvaluator = session?.user?.role === 'evaluator'
  const userName = session?.user?.name || ''
  const [genre, setGenre] = useState<Bucket | 'all'>('all')
  const [rosterNames, setRosterNames] = useState<string[]>([])
  const onRosterNames = useCallback((names: string[]) => {
    setRosterNames(prev => (prev.join('|') === names.join('|') ? prev : names))
  }, [])

  return (
    <div>
      <div className="seg-wrapper" style={{ display: 'inline-flex', gap: 4, marginBottom: 14 }}>
        {(['all', ...BUCKETS] as const).map(g => (
          <button key={g} className={`seg-btn-premium${genre === g ? ' active' : ''}`} onClick={() => setGenre(g)}>
            {g === 'all' ? 'All' : BUCKET_LABELS[g]}
          </button>
        ))}
      </div>
      <AssignSetup isEvaluator={isEvaluator} userName={userName} genre={genre} onRosterNames={onRosterNames} />
      <div style={{ height: 18 }} />
      <AssignHistory genre={genre} rosterNames={rosterNames} />
    </div>
  )
}
```

`onRosterNames` phải so sánh rồi mới set, không thì `AssignSetup` set state của cha mỗi lần render và thành vòng lặp vô hạn.

Sửa import ở đầu file: bỏ `BUCKET_LABELS` khai báo tại chỗ (dòng 20), thay bằng `import { RosterTable ... }` — chính xác là `import { BUCKET_LABELS } from '@/components/RosterTable'`; thêm `useCallback` vào import từ `react`.

- [ ] **Step 2: Sửa CSS**

Trong `app/globals.css`, xoá `.assign-grid`, `.assign-right`, `.assign-right > .hist-card` và các override của chúng trong media query (dòng ~270-308). Roster và history giờ là hai block xếp dọc bình thường. Giữ `.roster-tbl`, `.roster-scroll`, `.hist-card`.

- [ ] **Step 3: Đổi label Config**

Trong `app/(manager)/config/page.tsx`:
- dòng 146: comment `// ── Genre → Bucket section` thành `// ── Genre → Sub-genre section`
- dòng 183: `<span className="card-label">Genre → Bucket</span>` thành `Genre → Sub-genre`
- dòng 247: `placeholder={`Add genre to ${label.toLowerCase()}…`}` thành `` placeholder={`Add sub-genre to ${label.toLowerCase()}…`} ``

Chỉ đổi chữ. Không đổi tên biến, không đổi payload API, không đổi `category_group`.

- [ ] **Step 4: Typecheck + test + xem bằng mắt**

```bash
npm run typecheck
npm test
```
Expected: cả hai PASS, 0 lỗi.

Chạy `npm run dev`, mở `http://localhost:3333/team-ops?tab=assign`, đối chiếu với `/team-ops/assign-preview`: layout phải giống, khác duy nhất là dữ liệu thật. Thử ba việc ghi thật: đổi Available của một người có 2 genre (cả hai dòng phải đổi theo, và reload vẫn đúng), thêm một genre cho một người, đổi weight một dòng.

- [ ] **Step 5: Commit**

```bash
git add "app/(manager)/team-ops/page.tsx" "app/(manager)/config/page.tsx" app/globals.css
git commit -m "feat(assign): one page for every genre, history underneath"
```

---

### Task 10: Xoá page giả lập, gate cuối

**Files:**
- Delete: `app/(manager)/team-ops/assign-preview/page.tsx`
- Delete: `app/(manager)/team-ops/assign-preview/fixture.ts`

**Interfaces:**
- Consumes: mọi thứ đã xong.
- Produces: không gì.

- [ ] **Step 1: Xoá page giả lập**

```bash
git rm -r "app/(manager)/team-ops/assign-preview"
```

Page này không phải feature flag và không phải bản song song để bảo trì — nó đã làm xong việc của nó ở Task 5.

- [ ] **Step 2: Kiểm không còn tham chiếu**

```bash
grep -rn "assign-preview\|fixture" --include="*.ts" --include="*.tsx" app components lib | grep -v node_modules
grep -rn "AssignSetup\|AssignHistory" --include="*.tsx" app components | grep -v node_modules
```
Expected: không dòng nào nhắc `assign-preview`; `AssignSetup`/`AssignHistory` chỉ xuất hiện ở `team-ops/page.tsx` và chính hai file đó.

- [ ] **Step 3: Gate cuối**

```bash
npm run typecheck
npm test
```
Expected: typecheck 0 lỗi; toàn bộ suite PASS. Ghi lại con số thật (số test pass/fail) — không tuyên bố xong khi chưa đọc output.

- [ ] **Step 4: Kiểm cron không bị ảnh hưởng**

```bash
npx jest __tests__/lib/assign-evaluators.test.ts __tests__/api/assign-evaluators.test.ts
git diff main --stat -- lib/assign-evaluators.ts "app/api/cron/assign-evaluators"
```
Expected: test PASS; `git diff` ra rỗng — thuật toán chia game và cron không bị đụng, đúng Global Constraints.

- [ ] **Step 5: Commit**

```bash
git commit -m "chore(assign): drop the fixture page now the real one is live"
```
