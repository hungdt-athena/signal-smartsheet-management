# Role tiers + in-panel tag review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Khôi phục tier `moderator` (bằng admin trừ ba khoản), cho admin tag thẳng vào Signal Sense không qua queue, và cho manager duyệt tag ngay trong Evaluate panel.

**Architecture:** Quyền vẫn do route giữ (`lib/auth-guard.ts`), UI chỉ quyết định cái gì đáng vẽ. Logic sync tag được tách khỏi `confirm/route.ts` thành `lib/playtest-tags-sync.ts` để đường confirm thủ công và đường auto-sync của admin dùng chung một luật.

**Tech Stack:** Next.js 14 App Router, TypeScript, postgres.js (`lib/db.ts`), NextAuth, Jest (`npm test`), `npm run typecheck`.

**Spec:** `docs/superpowers/specs/2026-08-20-role-tiers-and-tag-review-design.md`

## Global Constraints

- Role hợp lệ: `'admin' | 'moderator' | 'evaluator'`. Không còn giá trị nào khác.
- Manager tier = admin + moderator. Ba khoản admin-only: auto-sync tag, Final Conclusion + Final Note, đổi role/xoá user.
- Moderator **được** tự confirm tag của chính mình. Không viết guard self-review.
- Moderator invite được `evaluator` và `moderator`, không invite `admin`.
- Timezone mọi timestamp: `Asia/Ho_Chi_Minh` (UTC+7); dùng `timestamptz`.
- `SKIP_AUTH=true` phải tiếp tục bypass mọi guard (dev cục bộ).
- Không chạy `npm run build` khi dev server đang chạy (hỏng `.next`).
- Chạy `npm test` và `npm run typecheck` trước mỗi commit.

---

### Task 1: Role thứ ba trong DB và trong guard

**Files:**
- Create: `migrations/038_moderator_role.sql`
- Modify: `lib/auth-guard.ts`
- Test: `__tests__/lib/auth-guard.test.ts` (create)

**Interfaces:**
- Produces: `type Role = 'admin' | 'moderator' | 'evaluator'`; `requireManager(): Promise<NextResponse | null>` (admin + moderator); `requireAdmin(): Promise<NextResponse | null>` (admin only).

- [ ] **Step 1: Viết migration**

```sql
-- Migration 038: moderator trở lại thành một tier riêng.
--
-- Migration 032 đã xoá role này bằng cách UPDATE mọi moderator thành admin, nên
-- người làm triage buộc phải là admin đầy đủ. Moderator nay bằng admin ở mọi
-- màn hình, trừ ba khoản: tag của họ vẫn qua queue, Final Conclusion + Final
-- Note là của admin, và họ không đổi được role hay xoá user.
--
-- Không backfill: không ai tự nhiên thành moderator, admin gán tay ở Users
-- Management. Các row đã bị 032 nâng lên admin ở lại admin — không có cách nào
-- biết row nào từng là moderator, và đoán thì nguy hiểm hơn là để nguyên.

ALTER TABLE dashboard_users DROP CONSTRAINT IF EXISTS dashboard_users_role_check;
ALTER TABLE dashboard_users ADD CONSTRAINT dashboard_users_role_check
  CHECK (role IN ('admin', 'moderator', 'evaluator'));
```

- [ ] **Step 2: Viết test thất bại cho guard**

```ts
/**
 * @jest-environment node
 */
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
import { requireAdmin, requireManager, requireRole } from '@/lib/auth-guard'
import { getServerSession } from 'next-auth'

const sessionMock = getServerSession as unknown as jest.Mock

describe('auth-guard tiers', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  it('requireManager accepts admin and moderator, rejects evaluator', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin' } })
    expect(await requireManager()).toBeNull()
    sessionMock.mockResolvedValue({ user: { role: 'moderator' } })
    expect(await requireManager()).toBeNull()
    sessionMock.mockResolvedValue({ user: { role: 'evaluator' } })
    expect((await requireManager())?.status).toBe(403)
  })

  it('requireAdmin rejects moderator', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'moderator' } })
    expect((await requireAdmin())?.status).toBe(403)
    sessionMock.mockResolvedValue({ user: { role: 'admin' } })
    expect(await requireAdmin()).toBeNull()
  })

  it('returns 401 with no session at all', async () => {
    sessionMock.mockResolvedValue(null)
    expect((await requireRole('admin'))?.status).toBe(401)
  })
})
```

- [ ] **Step 3: Chạy test, phải fail**

Run: `npx jest __tests__/lib/auth-guard.test.ts`
Expected: FAIL — `requireAdmin` chưa tồn tại.

- [ ] **Step 4: Sửa `lib/auth-guard.ts`**

```ts
type Role = 'admin' | 'moderator' | 'evaluator'
```

`requireManager` đổi thân thành `requireRole(['admin', 'moderator'])` và sửa
comment (moderator không còn "retired"). Thêm:

```ts
/** Admin only: đổi role, xoá user, Final Conclusion/Note, và mọi job hệ thống
 *  (cron, backfill, import). Moderator bằng admin ở mọi chỗ khác. */
export function requireAdmin(): Promise<NextResponse | null> {
  return requireRole(['admin'])
}
```

- [ ] **Step 5: Chạy test, phải pass**

Run: `npx jest __tests__/lib/auth-guard.test.ts` → PASS

- [ ] **Step 6: Commit**

```bash
git add migrations/038_moderator_role.sql lib/auth-guard.ts __tests__/lib/auth-guard.test.ts
git commit -m "feat(auth): moderator is a tier again"
```

---

### Task 2: Manager tier chạy suốt middleware, nav và các route review

**Files:**
- Modify: `middleware.ts`, `app/(manager)/layout.tsx`
- Modify: `app/api/evaluations/record-bucket/route.ts`, `assign-records/route.ts`, `add-to-record/route.ts`, `confirm-records/route.ts`, `reconcile-recorders/route.ts`, `app/api/operations/history/route.ts`, `app/api/operations/realtime/route.ts`
- Modify: `app/api/evaluations/route.ts` (dòng ~24, `isManager` của GET)

**Interfaces:**
- Consumes: `requireManager()` từ Task 1.

- [ ] **Step 1: middleware**

`middleware.ts`: `const isManager = role === 'admin' || role === 'moderator'`.
Ba nhánh `if (role !== 'admin')` (category `arcade`/`simulation`, tab
`short_list`/`record_video`) đổi thành `if (!isManager)`. `/admin` và `/config`
vẫn nằm trong `managerPaths` — phân quyền bên trong `/admin` là việc của route
(Task 3), không phải của middleware.

- [ ] **Step 2: nav**

`app/(manager)/layout.tsx`: mọi mảng `roles` chứa `'admin'` thêm `'moderator'`
(`Rescue`, `Config`, và các mảng `['admin','evaluator']`).

- [ ] **Step 3: các route review**

Bảy route liệt kê ở trên: `requireRole(['admin'])` → `requireManager()`, và sửa
import cho khớp. **Không** đụng `cron/*`, `admin/backfill-sheets`,
`admin/import-evaluations`, `admin/import-screenshots`, `admin/push-split`,
`admin/sync-evaluators`, `admin/sync-roster` — vẫn admin thuần, đổi sang
`requireAdmin()` cho đúng tên gọi.

- [ ] **Step 4: GET evaluations**

`app/api/evaluations/route.ts` dòng ~24:
`const isManager = skipAuth || session?.user?.role === 'admin' || session?.user?.role === 'moderator'`.
Đây là cờ quyết định người dùng thấy eval của cả team hay chỉ của mình.

- [ ] **Step 5: Kiểm tra**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add middleware.ts "app/(manager)/layout.tsx" app/api
git commit -m "feat(auth): moderator sees every manager surface"
```

---

### Task 3: Users Management — moderator invite được, không đổi role được

**Files:**
- Modify: `app/api/admin/users/route.ts`
- Test: `__tests__/api/admin-users-tiers.test.ts` (create)

- [ ] **Step 1: Viết test thất bại**

```ts
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => {
  const fn = jest.fn() as jest.Mock & { json: jest.Mock; begin: jest.Mock }
  fn.json = jest.fn((v: unknown) => v)
  fn.begin = jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(fn)))
  return { sql: fn }
})
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

import { POST, PUT } from '@/app/api/admin/users/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

function req(method: string, body: unknown) {
  return new NextRequest('http://localhost/api/admin/users', {
    method, body: JSON.stringify(body),
  } as never)
}

describe('/api/admin/users tiers', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => {
    sqlMock.mockReset()
    sqlMock.mockImplementation(() => Promise.resolve([]))
  })

  it('lets a moderator invite an evaluator', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'moderator', email: 'mod@athena.studio' } })
    sqlMock.mockImplementation(() => Promise.resolve([{ id: 1, email: 'new@athena.studio', role: 'evaluator' }]))
    expect((await POST(req('POST', { email: 'new@athena.studio', role: 'evaluator' }))).status).toBe(200)
  })

  it('stops a moderator inviting an admin', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'moderator', email: 'mod@athena.studio' } })
    expect((await POST(req('POST', { email: 'new@athena.studio', role: 'admin' }))).status).toBe(403)
  })

  it('stops a moderator changing a role', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'moderator', email: 'mod@athena.studio' } })
    expect((await PUT(req('PUT', { id: 3, role: 'admin' }))).status).toBe(403)
  })

  it('lets a moderator rename a user', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'moderator', email: 'mod@athena.studio' } })
    sqlMock.mockImplementation(() => Promise.resolve([{ id: 3, email: 'x@athena.studio', role: 'evaluator', name: 'X' }]))
    expect((await PUT(req('PUT', { id: 3, name: 'X' }))).status).toBe(200)
  })
})
```

- [ ] **Step 2: Chạy test, phải fail**

Run: `npx jest __tests__/api/admin-users-tiers.test.ts`
Expected: FAIL — moderator đang bị `requireRole('admin')` chặn 403 ở cả bốn ca.

- [ ] **Step 3: Sửa route**

- `VALID_ROLES = ['admin', 'moderator', 'evaluator']`.
- GET, POST, PUT: `requireManager()`. DELETE: `requireAdmin()`.
- Thêm helper trong file, đọc session một lần:

```ts
/** True khi người gọi là admin. Moderator dùng chung route này nhưng không
 *  được chạm tới role hay xoá user — nếu chạm được thì họ tự nâng quyền và hai
 *  giới hạn còn lại của tier này thành vô nghĩa. */
async function callerIsAdmin(): Promise<boolean> {
  if (process.env.SKIP_AUTH === 'true') return true
  const session = await getServerSession(authOptions)
  return session?.user?.role === 'admin'
}
```

- POST: nếu `role === 'admin'` và `!(await callerIsAdmin())` → 403
  `{ error: 'Only an admin can invite an admin' }`.
- PUT: nếu `role !== undefined` và `!(await callerIsAdmin())` → 403
  `{ error: 'Only an admin can change a role' }`. `name`/`title` không đổi.

- [ ] **Step 4: Chạy test, phải pass**

Run: `npx jest __tests__/api/admin-users-tiers.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add app/api/admin/users/route.ts __tests__/api/admin-users-tiers.test.ts
git commit -m "feat(auth): moderators invite, admins assign roles"
```

---

### Task 4: Final Conclusion và Final Note chỉ của admin

**Files:**
- Modify: `app/api/evaluations/route.ts` (PUT, quanh dòng 390-435)
- Modify: `components/EvalDetailPanel.tsx` (khối cờ quyền, dòng ~630-665, và placeholder dòng ~1274)
- Test: `__tests__/api/evaluations-final-fields.test.ts` (create)

- [ ] **Step 1: Viết test thất bại**

Test gọi PUT với session moderator, gửi `{ id, final_conclusion, final_note, game_alike }`,
rồi đọc `calls` (theo pattern `routeSql` của `__tests__/api/playtest-tags.test.ts`)
và khẳng định: bind của `final_conclusion` và `final_note` là `null`/không đổi,
còn `game_alike` mang giá trị đã gửi. Thêm ca session admin: cả hai đi qua.

- [ ] **Step 2: Chạy test, phải fail**

Run: `npx jest __tests__/api/evaluations-final-fields.test.ts`
Expected: FAIL — hôm nay moderator (đã là manager sau Task 2) ghi được cả hai.

- [ ] **Step 3: Sửa route**

Trong PUT, chỗ đang tính `isManager` (dòng ~390-401), tách đôi:

```ts
let isManager = true
let isAdmin = true
// ... trong nhánh có session:
isManager = role === 'admin' || role === 'moderator'
isAdmin = role === 'admin'
```

Nhánh strip ở dòng ~431-435: `final_conclusion` và `final_note` bị bỏ khi
`!isAdmin`; `batch` vẫn theo `isManager`.

- [ ] **Step 4: Sửa panel**

```ts
const isAdmin = role === 'admin'
const isManager = isAdmin || role === 'moderator'
// Nội dung đánh giá — manager, hoặc chính người được giao.
const canEditEval = !readOnly && (isManager || ev?.initial_evaluator === userName)
// Game Alike + Trends tags: manager, hoặc người được giao, ở mọi stage.
const canEditManagerFields = !readOnly && isManager
const canEditGameAlike = canEditEval || canEditManagerFields
// Final Note + Final Conclusion là phát ngôn cuối cùng về một game — admin.
const canEditFinalNote = !readOnly && isAdmin
```

`canEdit5` / `canEdit20` / `canEditAssignee` đổi `isAdmin` → `isManager`.
`canEditFinalConc = canEditFinalNote && !finalLocked` giữ nguyên công thức.
`canEdit` đổi `canEditFinalNote` → `canEditManagerFields || canEditFinalNote`.
Placeholder `'Final note (managers only)…'` → `'Final note (admin only)…'` (cả
hai nhánh).

- [ ] **Step 5: Chạy test + typecheck**

Run: `npx jest __tests__/api/evaluations-final-fields.test.ts && npm run typecheck` → PASS

- [ ] **Step 6: Commit**

```bash
git add app/api/evaluations/route.ts components/EvalDetailPanel.tsx __tests__/api/evaluations-final-fields.test.ts
git commit -m "feat(evaluations): final conclusion and note are admin-only"
```

---

### Task 5: Tách `lib/playtest-tags-sync.ts` (refactor thuần)

**Files:**
- Create: `lib/playtest-tags-sync.ts`
- Modify: `app/api/playtest-tags/confirm/route.ts`
- Test: `__tests__/api/playtest-tags-confirm.test.ts` (chạy lại, không sửa)

**Interfaces:**
- Produces:

```ts
export interface SyncInput {
  gameId: string
  pending: PendingTag[]
  actor: string
  overwrite: Set<number>
  notes: Map<number, string>
}
export interface SyncOutput {
  results: { id: number; result: SyncResult }[]
  skipped: { id: number; field_value: string; reason: string }[]
}
/** Sync một tập proposal đang pending vào custom_field_values, trong transaction
 *  của người gọi. Ghi cả trạng thái row playtest_tags lẫn cfv_change_log. */
export async function syncTags(tx: typeof sql, input: SyncInput): Promise<SyncOutput>
```

- [ ] **Step 1: Chạy bộ test hiện có, ghi lại kết quả xanh**

Run: `npx jest __tests__/api/playtest-tags-confirm.test.ts`
Expected: PASS — đây là lưới an toàn cho refactor; không sửa test nào.

- [ ] **Step 2: Chuyển thân transaction sang lib**

Cắt toàn bộ đoạn từ query `theirs` tới `await logCfvChanges(tx, log)` trong
`confirm/route.ts` sang `syncTags`. Route giữ lại: guard, parse body, đọc
session, query `pending`, mở `sql.begin`, gọi `syncTags`, trả JSON. Nhận `tx`
chứ không tự mở transaction — Task 6 cần gọi nó bên trong một transaction đã có
DELETE/INSERT của PUT.

- [ ] **Step 3: Chạy lại bộ test**

Run: `npx jest __tests__/api/playtest-tags-confirm.test.ts && npm run typecheck`
Expected: PASS, không đổi một dòng test nào. Nếu phải sửa test thì refactor đã
làm đổi hành vi — quay lại Step 2.

- [ ] **Step 4: Commit**

```bash
git add lib/playtest-tags-sync.ts app/api/playtest-tags/confirm/route.ts
git commit -m "refactor(tagging): one home for the sync rules"
```

---

### Task 6: Admin tag thì đi thẳng vào Signal Sense

**Files:**
- Modify: `app/api/playtest-tags/route.ts` (PUT)
- Test: `__tests__/api/playtest-tags.test.ts` (thêm ca)

- [ ] **Step 1: Viết test thất bại**

Ba ca mới, dùng `routeSql` sẵn có trong file:

```ts
it('syncs an admin tag straight into Signal Sense', async () => {
  sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } })
  routeSql([
    { match: /EXISTS/, rows: [{ found: true, owned: true }] },
    { match: /custom_field_definitions/, rows: [{ field_value: 'Balatro' }] },
    { match: /INSERT INTO playtest_tags/, rows: [{ id: 42 }] },
    { match: /FROM playtest_tags/, rows: [{ id: 42, field_value: 'Balatro', sub_value_id: 3 }] },
    { match: /FROM custom_field_values/, rows: [] },
    { match: /INSERT INTO custom_field_values/, rows: [{ id: 9 }] },
  ])
  const res = await PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Balatro', sub_value_id: 3 }] }))
  expect(res.status).toBe(200)
  expect(calls.some(c => /INSERT INTO custom_field_values/.test(c.text))).toBe(true)
  expect(calls.some(c => /SET status = /.test(c.text) && c.binds.includes('synced'))).toBe(true)
})

it('leaves a moderator tag pending', async () => {
  sessionMock.mockResolvedValue({ user: { role: 'moderator', name: 'Mitt', email: 'mitt@athena.studio' } })
  routeSql([
    { match: /EXISTS/, rows: [{ found: true, owned: true }] },
    { match: /custom_field_definitions/, rows: [{ field_value: 'Balatro' }] },
  ])
  expect((await PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Balatro', sub_value_id: 3 }] }))).status).toBe(200)
  expect(calls.some(c => /INSERT INTO custom_field_values/.test(c.text))).toBe(false)
})

it('leaves an evaluator tag pending', async () => {
  sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } })
  routeSql([
    { match: /EXISTS/, rows: [{ found: true, owned: true }] },
    { match: /custom_field_definitions/, rows: [{ field_value: 'Balatro' }] },
  ])
  expect((await PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Balatro', sub_value_id: 3 }] }))).status).toBe(200)
  expect(calls.some(c => /INSERT INTO custom_field_values/.test(c.text))).toBe(false)
})
```

- [ ] **Step 2: Chạy test, phải fail**

Run: `npx jest __tests__/api/playtest-tags.test.ts`
Expected: FAIL ở ca admin — hôm nay không có INSERT nào vào `custom_field_values`.

- [ ] **Step 3: Sửa PUT**

`resolveSession()` trả thêm `isAdmin`; `isManager` nay gồm moderator (dùng cho
kiểm tra own-only: manager tag được game bất kỳ).

Trong `sql.begin`, sau vòng upsert, thêm `RETURNING id` cho INSERT để gom id vừa
ghi, rồi khi `isAdmin && ids.length > 0`:

```ts
// Admin không xếp hàng chờ chính mình duyệt: tag đi thẳng, và sub-value của
// admin thắng mọi sub-value Signal Sense đang có. Overwrite ở đây là auto, khác
// với đường confirm thủ công nơi nó phải được tick — đó là đặc quyền duy nhất
// của tier admin trong luồng này.
const rows = await tx`
  SELECT id, field_value, sub_value_id FROM playtest_tags
  WHERE game_id = ${gameId} AND status = 'pending' AND id = ANY(${ids})
  ORDER BY id
` as unknown as PendingTag[]
await syncTags(tx, {
  gameId, pending: rows, actor: email,
  overwrite: new Set(rows.map(r => r.id)),
  notes: new Map(),
})
```

- [ ] **Step 4: Chạy test, phải pass**

Run: `npx jest __tests__/api/playtest-tags.test.ts && npm run typecheck` → PASS

- [ ] **Step 5: Commit**

```bash
git add app/api/playtest-tags/route.ts __tests__/api/playtest-tags.test.ts
git commit -m "feat(tagging): an admin's own tag needs no review"
```

---

### Task 7: Duyệt tag ngay trong Evaluate panel

**Files:**
- Modify: `components/TrendTagsField.tsx`, `components/EvalDetailPanel.tsx`
- Modify: `app/api/playtest-tags/route.ts` (GET trả thêm cột cho review)

**Interfaces:**
- Consumes: `POST /api/playtest-tags/confirm` (`{ game_id, ids, overwrite, notes }`), `POST /api/playtest-tags/reject` (`{ ids, notes }`), `PATCH /api/playtest-tags/[id]` (`{ field_value?, sub_value_id? }`).

- [ ] **Step 1: GET trả đủ dữ liệu để review**

`GET /api/playtest-tags` thêm vào nhánh `pending`: `pt.sub_value_id` đã có; thêm
`sv.name AS sub_value_name`, và sub-value hiện tại của Signal Sense cho cùng
(game, value) qua LEFT JOIN `custom_field_values` + `sub_value_definitions`, đặt
tên `their_sub_value_id` / `their_sub_value_name` và cờ `their_exists`. Tính
`conflict` bằng `classifyTag` y như `lib/playtest-tags-queue.ts` làm — không
viết lại luật.

- [ ] **Step 2: Panel truyền quyền và callback xuống field**

`EvalDetailPanel` truyền `canReview={isManager}` và
`onReviewed={() => loadTrendTags(currentGameId)}` cho `TrendTagsField`. Sau mỗi
hành động review, panel nạp lại tag của game để "Waiting for review" và "Already
in Signal Sense" khớp thực tế.

- [ ] **Step 3: Khu review trong `TrendTagsField`**

Khi `canReview`, khối "Waiting for review" đổi thành danh sách dòng, mỗi dòng:
tên người đề xuất, combobox trend + sub-value (gọi `PATCH`, dùng `options` và
`subValues` đã có sẵn trong props), badge conflict kèm sub-value hiện tại của
Signal Sense và ô tick overwrite, ô note (tối đa 500 ký tự, khớp `NOTE_MAX`), nút
**Confirm** và **Reject**.

Confirm gọi `POST /confirm` với `{ game_id, ids: [id], overwrite: tick ? [id] : [], notes }`;
Reject gọi `POST /reject` với `{ ids: [id], notes }` — gọi ngay lúc bấm, không
gộp vào Save của form. Xong thì gọi `onReviewed()`.

Khi `!canReview`, khối này giữ nguyên hình dạng chip như hôm nay.

- [ ] **Step 4: Kiểm tra bằng tay**

Run: `npm run dev` (cổng 3333) và mở modal một game có tag pending.
Expected: admin thấy đủ Confirm/Reject/sửa; evaluator chỉ thấy chip; sau Confirm
tag nhảy xuống "Already in Signal Sense" mà không phải reload trang.

- [ ] **Step 5: Chạy toàn bộ test + typecheck**

Run: `npm test && npm run typecheck` → PASS

- [ ] **Step 6: Commit**

```bash
git add components/TrendTagsField.tsx components/EvalDetailPanel.tsx app/api/playtest-tags/route.ts
git commit -m "feat(tagging): review a tag without leaving the game"
```

---

## Sau khi xong

- Áp `migrations/038_moderator_role.sql` lên prod bằng tay (pattern của repo này).
- Gán moderator cho đúng người ở Users Management.
- Republish trên Replit.
