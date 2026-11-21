# Unified game trong Playtest (đợt 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cặp Android + iOS đã nối là 1 game trong Playtest: lưu 1 lần ghi cả 2 dòng, giao và đếm là 1, list 1 dòng, panel có nút chuyển store.

**Architecture:** Migration 054 thêm `pair_eval_id` / `pair_back` và các trigger PL/pgSQL làm việc nối và chép dữ liệu (phương án A). Code app chỉ lo: bỏ dòng sau khỏi list và số đếm, assign theo cặp, log `pair_scope`, mã dùng chung, API trả thông tin store, và giao diện theo canvas.

**Tech Stack:** Next.js 14 app router, postgres.js (`lib/db.ts`), PostgreSQL 16 PL/pgSQL, Jest (DB mock), bash + psql cho test SQL.

**Spec:** `docs/superpowers/specs/2026-11-21-unified-game-playtest-design.md` (đọc trước, plan dẫn theo các mục 6.x của spec). Mockup: canvas https://claude.ai/artifact/CMk9zTqNQno33i8Mj5Kqwx trang "List B + Panel A" (artboard 1-5, 7). HTML/CSS mockup ở `/private/tmp/claude-501/-Users-anhhung-orca-workspaces-signal-smartsheet-management-gourami/ee37c0c8-383c-4656-882f-9f68d129be3d/scratchpad/canvas/project/*.dc.html` và `.../scratchpad/build.py` (class `store-ico`, `store-tabs`, `pair-note`, `shared-hint`, `sw-dead`, `slg`).

## Global Constraints

- Không bao giờ dùng `DATABASE_URL` trong `.env.local` (đó là prod). Mọi lệnh DB chạy trên DB tạm của script test hoặc DB mẫu `postgres://127.0.0.1:54330/sample`. App local: `DATABASE_URL=postgres://anhhung@127.0.0.1:54331/sample` (proxy SSL đang chạy).
- Không push, merge, deploy, không chạy migration trên prod. Commit local trên branch `feat/unified-playtest`.
- Không `pkill`/`kill` postgres. Không `git stash` trần.
- Migration: `migrations/054_eval_pairs.sql`, chạy lại nhiều lần không lỗi, có khối `-- ROLLBACK:` ở đầu file.
- Kết quả riêng store = `initial_conclusion IN ('Link_dead','Stale_release')`.
- List bỏ dòng sau bằng `NOT ge.pair_back`. Số đếm công việc bỏ bằng helper `notPairCopy`. Hai helper ở `lib/eval-pairs.ts` (Task 4), không viết tay lại điều kiện ở route.
- UI copy tiếng Anh, không em dash. Chuỗi cố định: `Saved to both stores`, `saves Android and iOS together`, `Android link dead` / `iOS link dead`, `Android only while the iOS link is dead` (đổi store theo ngữ cảnh), `Counts as 1 game`, `linked iOS to the pair`, `N games`.
- Câu báo đỏ trong panel (đổi tên store theo ngữ cảnh): "The iOS link is dead, so iOS keeps **Link dead**. The evaluation on the right is Android only. When the iOS link works again, iOS reopens and takes the pair's result."
- Test chạy bằng `rtk proxy npx jest <path>`; typecheck `rtk proxy npm run typecheck`; build `NEXT_DIST_DIR=.next-check NODE_OPTIONS=--max-old-space-size=6144 rtk proxy npx next build` (không dùng `.next` chung). `app/api/evaluations/route.ts` có byte NUL: xem diff bằng `git diff --text`.
- Mỗi task kết thúc bằng 1 commit, message tiếng Anh, có dòng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Hai người lưu 2 cột khác nhau của cùng 1 cặp gần như cùng lúc: không ai bị đè (chỉ chép cột vừa đổi). Test ở Task 2.
2. Push thêm cả 2 store của 1 cặp mới trong cùng 1 lệnh INSERT: vẫn nối đúng 1 lần, đúng 1 dòng `pair_back`. Test ở Task 1.
3. Mở panel bằng `game_id` của dòng sau (từ search, từ link cũ, từ Tagging): ra đúng cặp, chọn sẵn store đó, lưu ghi vào dòng sống. Test ở Task 7.
4. n8n ghi drive link vào dòng của store `Link_dead`: link vẫn sang dòng sống (nhóm media luôn đồng bộ). Test ở Task 2.
5. Evaluator không phải manager chỉ thấy game của mình: cặp vẫn hiện 1 dòng với người giữ cặp, và tắt/bật link dead store kia được phép vì cùng người giữ. Test ở Task 6.

---

### Task 1: Migration 054 phần schema + nối khi thêm dòng + nối cặp an toàn có sẵn

**Files:**
- Create: `migrations/054_eval_pairs.sql`
- Create: `scripts/verify-eval-pairs.sh` (copy cấu trúc `scripts/verify-evaluation-log.sh`: Postgres tạm, cổng `VERIFY_PG_PORT` mặc định 54328, không đọc env)
- Create: `scripts/sql-verify/pairs-schema.sql` (game_info tối thiểu: `game_id text PK, os text, family_id text, family_unlinked boolean DEFAULT false, is_active boolean DEFAULT true, demo_code text UNIQUE, record_code text UNIQUE, title text`; `game_evaluations` đủ cột lấy từ `pg_dump -s -t game_evaluations postgres://127.0.0.1:54330/sample` bỏ owner/grants; `evaluation_log` qua migration 046 + 047; trigger record slots qua migration 051 phần function + trigger)
- Create: `scripts/sql-verify/pairs-link-checks.sql`

**Interfaces:**
- Produces (SQL): cột `game_evaluations.pair_eval_id integer`, `game_evaluations.pair_back boolean NOT NULL DEFAULT false`, `evaluation_log.pair_scope text`; hàm `eval_store_specific(c text) RETURNS boolean`; `eval_pair_valid(a integer, b integer) RETURNS boolean`; `eval_pair_refresh_back(a integer, b integer) RETURNS void` (đặt `pair_back` theo luật dòng trước/sau của spec 6.1); `link_eval_pair(a integer, b integer) RETURNS boolean` (nối 2 chiều, chép từ dòng đã có vào dòng mới theo spec 6.2b chỉ vào cột NULL, ghi log `pair_link`, trả false nếu không hợp lệ hoặc đã nối); trigger `trg_eval_pair_link_insert` (AFTER INSERT FOR EACH ROW).
- Danh sách cột 2 nhóm (spec 6.1) viết đúng 1 lần, dạng 2 hàm `eval_pair_eval_cols() RETURNS text[]` và `eval_pair_media_cols() RETURNS text[]`, phần chép dùng dynamic SQL (`format('%I')`) đọc từ 2 hàm này.

- [ ] **Step 1: Viết `pairs-link-checks.sql`** gồm các khối `DO $$ ... ASSERT ... $$`, mỗi khối tự tạo dữ liệu game_info (`family_id='fam.N'`) rồi kiểm:
  - `insert_twin_judged`: T (android) `initial_conclusion='List_Idea', initial_evaluator='ThuDT', batch='W4 Nov', initial_note='abcdefghijk'`; INSERT N (ios, category khác). Kỳ vọng: `N.pair_eval_id=T.id`, `T.pair_eval_id=N.id`, `N.pair_back` true, `T.pair_back` false, `N.initial_conclusion='List_Idea'`, `N.category_group=T.category_group`, có 1 dòng `evaluation_log` kind `pair_link` actor `System` game_id = N.game_id, `pair_scope='store'`.
  - `insert_twin_pending`: T `initial_evaluator='QuangVN'`, chưa chấm. Kỳ vọng N nhận `initial_evaluator`, `assigned_date`, `first_assigned_date`, `batch`; `N.initial_conclusion IS NULL`; N là dòng sau.
  - `insert_twin_dead`: T `Link_dead`. Kỳ vọng nối, N không nhận cột đánh giá nào, N là dòng trước (`N.pair_back=false`, `T.pair_back=true`).
  - `insert_keeps_own_values`: N được INSERT kèm `record_bucket='5min'`; T có `record_bucket='20min'`. Kỳ vọng `N.record_bucket='5min'`.
  - `insert_both_same_statement`: 1 lệnh `INSERT ... VALUES (android), (ios)` cho family mới. Kỳ vọng 2 dòng nối nhau, đúng 1 dòng `pair_back`.
  - `insert_no_link`: twin `family_unlinked=true`; twin có 2 dòng game_evaluations; game không family. Kỳ vọng `pair_eval_id IS NULL`, không có log.
  - `safe_backfill`: chạy lại phần (d) của migration (hàm `link_safe_eval_pairs() RETURNS integer`) trên: cặp cả 2 chưa chấm cùng người (nối), 1 bên có người (nối, bên kia nhận người), 2 người khác nhau (không), khác `category_group` (không), `batch` khác nhau (không), 1 bên đã chấm (không). Kỳ vọng trả 2 và đúng các cặp đó.
- [ ] **Step 2: Viết `verify-eval-pairs.sh`**: initdb, áp `pairs-schema.sql`, `migrations/054_eval_pairs.sql` 2 lần (kiểm chạy lại được), rồi `pairs-link-checks.sql`, in `eval pairs SQL checks: OK`.
- [ ] **Step 3: Chạy `bash scripts/verify-eval-pairs.sh`**. Expected: FAIL vì `054_eval_pairs.sql` chưa có.
- [ ] **Step 4: Viết `054_eval_pairs.sql` phần này**: cột + index (`UNIQUE (pair_eval_id) WHERE pair_eval_id IS NOT NULL`, `ON DELETE SET NULL`), các hàm trên, trigger insert, `link_safe_eval_pairs()` và lệnh `SELECT link_safe_eval_pairs()` có `RAISE NOTICE` số cặp. Insert trigger dùng `pg_advisory_xact_lock(hashtext(family_id))` để 2 dòng cùng lệnh không nối chéo. Mọi UPDATE nội bộ chạy ở depth > 1 nên trigger chép (Task 2) sẽ bỏ qua.
- [ ] **Step 5: Chạy lại script**. Expected: `eval pairs SQL checks: OK`.
- [ ] **Step 6: Commit** `feat(db): migration 054 links a game's two store rows on insert`.

### Task 2: Trigger chép khi sửa, mở lại, dòng trước/sau, xoá

**Files:**
- Modify: `migrations/054_eval_pairs.sql`
- Create: `scripts/sql-verify/pairs-sync-checks.sql`; Modify: `scripts/verify-eval-pairs.sh` (chạy thêm file này)

**Interfaces:**
- Consumes: hàm và cột từ Task 1.
- Produces: trigger `trg_eval_pair_sync` (AFTER UPDATE FOR EACH ROW, bỏ qua khi `pg_trigger_depth() > 1`), `trg_eval_pair_delete` (AFTER DELETE: dòng còn lại `pair_eval_id=NULL, pair_back=false`).

- [ ] **Step 1: Viết `pairs-sync-checks.sql`**, mỗi khối dựng 1 cặp đã nối bằng `link_eval_pair`:
  - `sync_changed_only`: cặp chưa chấm; UPDATE R set `initial_note='note from A 123'`; UPDATE T set `final_note='final from B'` (mô phỏng 2 người). Kỳ vọng cả 2 dòng có cả 2 giá trị.
  - `sync_full_result`: UPDATE R `initial_conclusion='List_Idea', evaluate_date=now(), batch='W4 Nov', game_alike='[{"name":"x"}]'`. Kỳ vọng T bằng R ở mọi cột nhóm đánh giá; `T.genre_1` không đổi.
  - `sync_media_when_dead`: T `Link_dead`; UPDATE T `drive_link='https://drive/x'` (n8n ghi nhầm dòng chết). Kỳ vọng `R.drive_link='https://drive/x'`; R không nhận `initial_conclusion`.
  - `no_sync_into_dead`: T `Link_dead`; UPDATE R `initial_conclusion='Bypass'`. Kỳ vọng `T.initial_conclusion='Link_dead'`.
  - `mark_dead_no_copy`: UPDATE T `initial_conclusion='Link_dead'` khi R đang `List_Idea`. Kỳ vọng R vẫn `List_Idea`; `pair_back`: R false, T true.
  - `reopen_takes_pair_result`: T `Link_dead`, R `List_Idea` note `'pair note 12345'`; UPDATE T `initial_conclusion=NULL`. Kỳ vọng T có `List_Idea`, note, evaluator của R; T là dòng sau.
  - `reopen_pending_takes_holder`: R chưa chấm, người giữ `ThuDT`; T `Link_dead` người giữ `QuangVN`; mở T. Kỳ vọng `T.initial_evaluator='ThuDT'`.
  - `both_dead`: cả 2 `Link_dead`. Kỳ vọng dòng id nhỏ là dòng trước; UPDATE note ở 1 dòng không chép.
  - `record_slots_converge`: UPDATE R `record_bucket='20min', final_conclusion='Priority IV', record_20min_assignee='VinhTD'`. Kỳ vọng các cột `record_*` và `record_20min_batch` của T bằng R.
  - `unlink_on_invalid`: set `family_unlinked=true` trên game_info của T (không có trigger game_info ở task này), UPDATE R note. Kỳ vọng 2 dòng gỡ nối, T không nhận note.
  - `delete_front`: DELETE R. Kỳ vọng `T.pair_eval_id IS NULL`, `T.pair_back=false`.
- [ ] **Step 2: Chạy script**. Expected: FAIL ở `sync_changed_only`.
- [ ] **Step 3: Viết hàm `eval_pair_sync()`** theo spec 6.2a: so `NEW` với `OLD` theo 2 danh sách cột (dùng `to_jsonb(NEW)`/`to_jsonb(OLD)` để lấy cột đổi), UPDATE T 1 lệnh duy nhất bằng dynamic SQL, rồi `eval_pair_refresh_back`. Trigger `trg_game_evaluations_record_slots` (BEFORE UPDATE) vẫn chạy trên T; test `record_slots_converge` bảo đảm kết quả khớp, nếu lệch thì chép `record_5min_batch`/`record_20min_batch` sau cùng.
- [ ] **Step 4: Viết trigger delete.**
- [ ] **Step 5: Chạy script**. Expected: OK cả 2 file.
- [ ] **Step 6: Commit** `feat(db): keep a linked pair in sync on every write`.

### Task 3: Trigger trên `game_info` gỡ nối khi Unlink + khối ROLLBACK

**Files:**
- Modify: `migrations/054_eval_pairs.sql`
- Create: `scripts/sql-verify/pairs-unlink-checks.sql`; Modify: `scripts/verify-eval-pairs.sh`

**Interfaces:**
- Produces: trigger `trg_game_info_eval_pair_unlink` (AFTER UPDATE OF family_id, family_unlinked ON game_info FOR EACH ROW WHEN old/new khác nhau), hàm `game_info_eval_pair_unlink()` bọc `BEGIN ... EXCEPTION WHEN OTHERS THEN RAISE WARNING` (spec 6.2c).

- [ ] **Step 1: Viết checks**:
  - `unlink_splits`: cặp nối, `UPDATE game_info SET family_unlinked=true WHERE game_id=<T>`. Kỳ vọng 2 dòng `pair_eval_id NULL`, `pair_back=false`, dữ liệu giữ nguyên.
  - `family_change_splits`: đổi `family_id` của 1 bên. Kỳ vọng gỡ nối.
  - `unrelated_update_noop`: UPDATE `title` của game_info. Kỳ vọng vẫn nối.
  - `never_breaks_signal_sense`: trong 1 transaction, tạm `ALTER TABLE game_evaluations RENAME COLUMN pair_back TO pair_back_x`, rồi `UPDATE game_info SET family_unlinked=true` phải thành công (chỉ WARNING), rồi `ROLLBACK`.
  - `rollback_block`: chạy phần SQL trong khối `-- ROLLBACK:` (script trích bằng `sed`) trên DB tạm, kiểm không còn cột/hàm/trigger nào của 054; rồi áp lại 054.
- [ ] **Step 2: Chạy script**. Expected: FAIL `unlink_splits`.
- [ ] **Step 3: Viết hàm + trigger + khối `-- ROLLBACK:`** (DROP 4 trigger, các hàm, 2 cột ge, 1 cột log, index). Ghi chú đầu file: trigger mới trên bảng chung `game_info`, phải báo repo signal-deploy.
- [ ] **Step 4: Chạy script**. Expected: OK.
- [ ] **Step 5: Áp 054 lên DB mẫu** `psql postgres://127.0.0.1:54330/sample -v ON_ERROR_STOP=1 -f migrations/054_eval_pairs.sql`, ghi số cặp an toàn đã nối vào commit message.
- [ ] **Step 6: Commit** `feat(db): split a Playtest pair when Signal Sense unlinks it`.

### Task 4: `lib/eval-pairs.ts`: helper SQL và kiểu dữ liệu

**Files:**
- Create: `lib/eval-pairs.ts`
- Test: `__tests__/lib/eval-pairs.test.ts`

**Interfaces:**
- Produces:
  - `export const STORE_SPECIFIC = ['Link_dead', 'Stale_release'] as const`
  - `export function listRowFilter(q: Sql, alias = 'ge')`: fragment `AND NOT <alias>.pair_back`
  - `export function notPairCopy(q: Sql, alias = 'ge')`: fragment `AND NOT (<alias>.pair_back AND <alias>.initial_conclusion IS DISTINCT FROM 'Link_dead' AND <alias>.initial_conclusion IS DISTINCT FROM 'Stale_release')`
  - `export interface PairStore { os: 'ios' | 'android'; game_id: string; eval_id: number; app_link: string | null; is_active: boolean; dead: boolean }`
  - `export function storesSelect(q: Sql, alias = 'ge', giAlias = 'gi')`: fragment cột `stores` (json array `PairStore`, store của chính dòng + store của `pair_eval_id` nếu có; iOS đứng trước Android), dùng `LEFT JOIN LATERAL` 1 query, không thêm round-trip.
  - `export function sortStores(s: PairStore[]): PairStore[]` (iOS trước).
  - Theo kiểu của `lib/evaluation-log.ts`: nhận tag `q` để test bằng tag giả, không import DB lúc chạy.

- [ ] **Step 1: Test** dùng tag giả nối chuỗi: `listRowFilter` chứa `NOT ge.pair_back`; `notPairCopy(q,'x')` chứa `x.pair_back` và cả 2 tên conclusion; `storesSelect` chứa `pair_eval_id`; `sortStores` đưa ios lên đầu.
- [ ] **Step 2: Chạy** `rtk proxy npx jest __tests__/lib/eval-pairs.test.ts`. Expected: FAIL (module chưa có).
- [ ] **Step 3: Viết `lib/eval-pairs.ts`.**
- [ ] **Step 4: Chạy lại**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pairs): shared SQL helpers for linked store rows`.

### Task 5: List API, search, và các chỗ đọc kiểu list

**Files:**
- Modify: `app/api/evaluations/route.ts` (GET: `filtersNoBatch` thêm `listRowFilter`, SELECT thêm `storesSelect` và `COALESCE(gi.demo_code, twin_gi.demo_code)` / `record_code` tương tự)
- Modify: `lib/evaluations-filters.ts` (`searchFilter`: khớp `game_id` của dòng nối qua `pair_eval_id`)
- Modify: `app/api/evaluations/facets/route.ts`, `app/api/evaluations/missing-demo/route.ts`, `lib/record-view-games.ts`, `lib/record-queue.ts` (và route badge dùng nó), `lib/shortlist-export/games.ts`, `app/api/weekly-feedback/batches/route.ts`
- Test: `__tests__/api/evaluations-pairs.test.ts`, cập nhật test SQL hiện có nếu snapshot chuỗi đổi

**Interfaces:**
- Consumes: `listRowFilter`, `storesSelect`, `PairStore` (Task 4).
- Produces: mỗi dòng list có `stores: PairStore[]` (1 phần tử nếu chưa nối); `demo_code`/`record_code` là mã của cặp.

- [ ] **Step 1: Test** (mock `@/lib/db` như các test API khác, bắt chuỗi SQL): GET list có `NOT ge.pair_back` ở cả query list và query đếm; có `stores`; search `q=6822015244` sinh điều kiện có `pair_eval_id`; mỗi file đọc kiểu list ở trên có `pair_back` trong SQL.
- [ ] **Step 2: Chạy**. Expected: FAIL.
- [ ] **Step 3: Sửa các file.** Shortlist export: 1 dòng mỗi cặp, cột android/ios link lấy từ `stores`.
- [ ] **Step 4: Chạy test file mới + `rtk proxy npx jest __tests__/api __tests__/lib`**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pairs): lists show a linked pair once, with both stores`.

### Task 6: Số đếm công việc tính cặp là 1

**Files:**
- Modify: `app/api/evaluations/quick-stats/route.ts`, `app/api/report/route.ts`, `app/api/report/daily/route.ts`, `app/api/cron/report-rollup/route.ts`, `app/api/operations/pending-holders/route.ts`, `lib/rescue-core.ts`, `app/api/assign-setup/preview/route.ts`, `app/api/external/effort-sessions/route.ts`, `app/api/external/effort-game-time/route.ts`, `lib/evaluation-hours.ts`
- Rà thêm: chạy `rtk proxy grep -rnE "(FROM|JOIN) game_evaluations" app lib`, mọi file còn lại ghi vào commit message là "không cần" kèm lý do 1 dòng (ví dụ ghi theo id, đọc 1 game).
- Test: `__tests__/api/pair-counts.test.ts`

**Interfaces:**
- Consumes: `notPairCopy` (Task 4).

- [ ] **Step 1: Test**: với mỗi route trên, gọi handler với DB mock, mọi câu SQL có `FROM game_evaluations` đều chứa `pair_back`. Thêm ca Review Focus 5: GET list với session evaluator thường, SQL có cả điều kiện evaluator và `NOT ge.pair_back`.
- [ ] **Step 2: Chạy**. Expected: FAIL.
- [ ] **Step 3: Thêm `${notPairCopy(sql)}` vào từng query** (Report có 24 chỗ; chỗ nào đếm theo `evaluation_log` thì không cần vì log ghi 1 lần).
- [ ] **Step 4: Chạy test mới + toàn bộ test report** `rtk proxy npx jest __tests__/api __tests__/components/report-*`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pairs): count a linked pair once in stats, report and effort APIs`.

### Task 7: Assign theo cặp

**Files:**
- Modify: `lib/assign-evaluators.ts` (`AssignableGame.os` nhận thêm `'pair'`)
- Modify: `app/api/cron/assign-evaluators/route.ts`, `lib/reassign-core.ts` (`selectPendingGames`), `lib/rescue-core.ts`, `app/api/operations/handover/resolve/route.ts`, `lib/push-preview.ts`
- Modify: `lib/assignment-history.ts` (`HistoryInput.perEvaluator` giữ nguyên; thêm `pairGameIds?: Map<string, string>` front game_id → back game_id; `game_ids` ghi cả 2, `game_count` = số front)
- Create: `lib/eval-pairs-db.ts`: `export async function twinGameIds(gameIds: string[]): Promise<Map<string, string>>` (1 query qua `pair_eval_id`)
- Test: `__tests__/lib/assign-evaluators.test.ts` (thêm ca), `__tests__/lib/assignment-history.test.ts`

**Interfaces:**
- Consumes: `listRowFilter` (Task 4).
- Produces: query ứng viên trả `CASE WHEN ge.pair_eval_id IS NOT NULL THEN 'pair' ELSE gi.os END AS os` và có `NOT ge.pair_back`; `twinGameIds`.

- [ ] **Step 1: Test `assignGames`**:
  - `pair games go to specialists too`: roster `[{A, ios, 100}, {B, android, 100}]`, games 4 `pair`. Kỳ vọng A 2, B 2.
  - `specialist short of own games fills from pairs`: roster `[{A, ios,100},{B, all,100}]`, games 1 ios + 5 pair. Kỳ vọng A 3, B 3, game ios thuộc A.
  - `single-store rule unchanged`: roster `[{A, ios}]`, games 2 android. Kỳ vọng không giao game nào cho A.
  - `last specialist not starved` (ca 2026-09-22 rút gọn): 4 ios specialist + 1 all, 8 ios + 2 pair. Kỳ vọng mỗi người ít nhất 1.
- [ ] **Step 2: Test history**: `perEvaluator {ThuDT: ['a1']}`, `pairGameIds {a1: 'i1'}` → INSERT có `game_count` 1 và `game_ids` `['a1','i1']`.
- [ ] **Step 3: Chạy**. Expected: FAIL.
- [ ] **Step 4: Sửa `assignGames`**: pool `pair` là nguồn chung; khi tính độ khan hiếm, supply của tester chuyên store p = pool p + phần pool `pair` còn lại; tester chuyên lấy pool riêng trước rồi lấy pool `pair`; tester `all` lấy phần còn lại cũ nhất trước. Giữ comment giải thích ở đầu hàm.
- [ ] **Step 5: Sửa các route/lib** dùng query ứng viên mới, ghi history có `pairGameIds` (lấy bằng `twinGameIds`).
- [ ] **Step 6: Chạy** `rtk proxy npx jest __tests__/lib __tests__/api`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(assign): a linked pair goes to any evaluator and counts as one`.

### Task 8: Ghi dữ liệu: PATCH log `pair_scope`, route link dead từng store, mã dùng chung, add-to-record

**Files:**
- Modify: `app/api/evaluations/route.ts` (PATCH: INSERT `evaluation_log` thêm `pair_scope`)
- Create: `app/api/evaluations/store-dead/route.ts`
- Modify: `lib/file-codes.ts`
- Modify: `app/api/evaluations/add-to-record/route.ts` (UPDATE theo `id` lấy từ `RETURNING`, không theo `(game_id, category_group)`)
- Test: `__tests__/api/evaluations-patch-pair.test.ts`, `__tests__/api/store-dead.test.ts`, `__tests__/lib/file-codes.test.ts` (thêm ca)

**Interfaces:**
- Produces: `POST /api/evaluations/store-dead` body `{ id: number, dead: boolean, view_s?, context? }` → `{ data: row }`. Quyền giống PATCH (manager, hoặc evaluator là `initial_evaluator` của dòng đó hoặc của dòng nối). `dead=true` đặt `initial_conclusion='Link_dead'`, `evaluate_date=COALESCE(evaluate_date, now())`; `dead=false` đặt `initial_conclusion=NULL`, `evaluate_date=NULL` (trigger mở lại sẽ chép kết quả cặp). Ghi `evaluation_log` 1 dòng `pair_scope='store'`, kind theo `logKindSql`. 400 nếu dòng không có conclusion `Link_dead` khi `dead=false`.
- `pair_scope` trong PATCH: `'pair'` khi `upd.pair_eval_id IS NOT NULL` và cả `upd` lẫn dòng nối không mang kết quả riêng store; ngược lại `'store'`.
- `ensureDemoCode` / `ensureRecordCode`: đọc mã twin (qua `game_info.family_id` + `game_evaluations.pair_eval_id`) trước; có thì trả, không cấp mới.

- [ ] **Step 1: Test PATCH**: SQL INSERT log có `pair_scope`. Test store-dead: 401/403 theo quyền, `dead=true` sinh UPDATE có `'Link_dead'`, `dead=false` khi dòng không dead trả 400. Test file-codes: twin có `record_code='EGF2W8'` → `ensureRecordCode` trả `EGF2W8` và không chạy UPDATE.
- [ ] **Step 2: Chạy**. Expected: FAIL.
- [ ] **Step 3: Sửa code.**
- [ ] **Step 4: Chạy test mới + `__tests__/api`**. Expected: PASS.
- [ ] **Step 5: Kiểm thật trên DB mẫu** (cổng 3334, xem Task 14 cách chạy app): PATCH 1 dòng của cặp đã nối bằng curl, rồi `psql` sample thấy dòng kia đổi theo và log có `pair_scope='pair'`.
- [ ] **Step 6: Commit** `feat(pairs): per-store link dead, pair-scoped log, one file code per pair`.

### Task 9: Panel API và History API theo cặp

**Files:**
- Modify: `app/api/evaluations/[gameId]/route.ts`
- Modify: `app/api/evaluations/[gameId]/history/route.ts`, `lib/evaluation-history.ts`
- Test: `__tests__/api/eval-panel-pair.test.ts`, `__tests__/lib/evaluation-history.test.ts` (thêm ca)

**Interfaces:**
- Produces (panel GET): `data` như cũ, lấy từ **dòng sống của cặp** (dòng trước), cộng `pair: null | { selected_game_id: string; stores: PanelStore[] }` với `PanelStore = PairStore & { title, icon_url, release_date, publisher_name, publisher_link, screenshot_urls, description, subtitle, content_rating, demo_code, record_code, conclusion: string | null }`. Mở bằng `game_id` của dòng sau thì `selected_game_id` là game đó nhưng `data.id` vẫn là dòng trước. Không thêm round-trip (1 query có LATERAL cho twin).
- Produces (history): `HistoryEvent.stores: ('ios'|'android')[]`. Log `pair_scope='pair'` hoặc dòng assign có cả 2 id → 2 store; còn lại store của `game_id` trên log. Kind `pair_link` → event type `seed`, verb `linked <Store> to the pair`, note `<Store> <game_id> joined <game_id của store kia>`. Dòng assign có 2 id → note `Counts as 1 game`, verb `assigned the pair to <name>`.

- [ ] **Step 1: Test** panel: mở bằng back id trả `data.id` = front id và `pair.selected_game_id` = back game_id; game chưa nối trả `pair: null`. History: `mergeHistory` với log `pair_scope:'pair'` ra `stores` 2 phần tử; log NULL scope ra 1; `pair_link` ra đúng verb/note.
- [ ] **Step 2: Chạy**. Expected: FAIL.
- [ ] **Step 3: Sửa code.** History đọc `evaluation_log WHERE game_id = ANY($ids)` và `assignment_history WHERE game_ids && $ids` với `$ids` = 2 game_id của cặp; trả kèm `os` của từng log row qua join `game_info`.
- [ ] **Step 4: Chạy**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pairs): panel and history read the whole pair`.

### Task 10: Component dùng chung: icon store, cột Stores, game icon 2 dấu, switch đỏ

**Files:**
- Create: `components/ui/StoreIcons.tsx`
- Modify: `components/ui/GameIcon.tsx` (prop `oses?: string[]` vẽ nhiều dấu; iOS bên trái Android; `os` cũ giữ nguyên hành vi; prop `hideMark?: boolean`)
- Modify: `components/ui/Switch.tsx` (prop `tone?: 'default' | 'danger'` thêm class `sw-dead`)
- Modify: `app/globals.css` (class `store-icons`, `store-ico`, `.store-ico.dead::after`, `.store-ico.removed::before`, `.sw-dead.sw-on .sw-track{background:var(--bad)}`, `.sw-dead.sw-on .sw-text{color:var(--bad)}`, `store-tabs`, `pair-note`, `shared-hint`, `slg`, `slg-chips`: copy giá trị từ `EXTRA_CSS` trong `build.py`)
- Test: `__tests__/components/store-icons.test.tsx`

**Interfaces:**
- Produces:
  - `export function StoreMark({ os, size = 12 }: { os: 'ios' | 'android'; size?: number })` (cùng path và màu với `PlatformMark`: iOS `var(--text)`, Android `var(--good)`; đưa 2 path ra export `APPLE_PATH`, `PLAY_PATH` từ `GameIcon.tsx`)
  - `export function StoresCell({ stores, asLinks = false }: { stores: PairStore[]; asLinks?: boolean })`: `<div class="store-icons">` mỗi store 1 ô 28x28; `title` = `iOS · 6822015244` + ` · Link dead` / ` · Removed`; class `dead` khi `dead`, `removed` khi `!is_active`; `asLinks` thì là `<a href={app_link} target="_blank" rel="noreferrer">`.
  - `Switch` thêm `tone`.

- [ ] **Step 1: Test**: StoresCell 2 store render 2 ô, thứ tự iOS trước; dead có class `dead` và title chứa `Link dead`; removed có class `removed`; `asLinks` render thẻ `a` đúng href. GameIcon `oses={['android','ios']}` render 2 dấu. Switch `tone="danger"` có class `sw-dead`.
- [ ] **Step 2: Chạy**. Expected: FAIL.
- [ ] **Step 3: Viết component + CSS.**
- [ ] **Step 4: Chạy**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): store icons, dual platform marks and a red link-dead switch`.

### Task 11: Evaluate và Short List

**Files:**
- Modify: `app/(manager)/evaluations/page.tsx` (Evaluate: `EvalRow` khoảng dòng 1345-1414 và thead tương ứng; Short List: `ShortListEvalTab` thead 1156-1173, dòng 1188-1245)
- Modify: `components/ui/GameCell.tsx` nếu cần prop ẩn dấu store
- Test: `__tests__/components/evaluations-pairs.test.tsx`

**Interfaces:**
- Consumes: `StoresCell`, `GameIcon` (Task 10), `stores` trên dòng list (Task 5).

- [ ] **Step 1: Test** (render trang với fetch mock như `evaluations-first-load.test.tsx`): Evaluate có header `Stores` ngay sau `Game`; dòng cặp có 2 ô store; icon game không có `.game-icon-plat`; dòng đếm là `N games`. Short List: không còn header `Link`; có `Stores` dạng link; ô Game có 3 dòng: tên, chip batch + chip evaluator (`.slg-chips`), `Publisher · dd/mm/yy`; nút copy nằm trong `.slg` với `position:absolute`.
- [ ] **Step 2: Chạy**. Expected: FAIL.
- [ ] **Step 3: Sửa UI** theo artboard 1 và 7 (copy cấu trúc HTML từ `EvaluateB.dc.html`, `ShortList2.dc.html`). Bỏ hàm `osLabel` nếu không còn ai dùng.
- [ ] **Step 4: Chạy test mới + `__tests__/components/evaluations-*`**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): Stores column on Evaluate and Short List, compact Short List game cell`.

### Task 12: Record tab

**Files:**
- Modify: `app/(manager)/youtube/page.tsx` (`RecordTable` khoảng dòng 989-1100, icon ở 1069)
- Test: `__tests__/components/record-pairs.test.tsx`

**Interfaces:**
- Consumes: `GameIcon oses` (Task 10), `stores` + mã cặp (Task 5).

- [ ] **Step 1: Test**: dòng cặp render 1 dòng, icon có 2 dấu store, ô mã hiện mã cặp (dòng có `record_code` null nhưng twin có thì vẫn hiện mã twin vì API đã COALESCE). Không có cột Stores.
- [ ] **Step 2: Chạy**. Expected: FAIL.
- [ ] **Step 3: Sửa UI** theo artboard 5.
- [ ] **Step 4: Chạy**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): Record shows a pair as one row with both store marks`.

### Task 13: Panel chi tiết + History modal

**Files:**
- Modify: `components/EvalDetailPanel.tsx` (card Game Info ~1310-1440, công tắc dead ~1476, gợi ý cột phải ở nhãn `Initial Evaluation`, thanh save ~1759, logic save ~1030 và 1040-1135)
- Create: `components/StoreTabs.tsx` (`StoreTabs({ stores, selected, onSelect })`: nút icon + `Android`/`iOS`, id ở `title`, ô store dead có chấm đỏ như `store-ico.dead`)
- Modify: `components/EvalHistoryModal.tsx` (mỗi event hiện `StoreMark` theo `event.stores`)
- Test: `__tests__/components/eval-panel-pair.test.tsx`, cập nhật `__tests__/components/eval-history-modal.test.tsx`

**Interfaces:**
- Consumes: `pair` từ panel API (Task 9), `POST /api/evaluations/store-dead` (Task 8), `Switch tone` + `StoreMark` (Task 10), `HistoryEvent.stores` (Task 9).

- [ ] **Step 1: Test panel** (fetch mock):
  - `pair: null`: không có `StoreTabs`, công tắc nhãn `Dead link` như cũ.
  - cặp: có 2 tab, tab chọn sẵn theo `selected_game_id`; đổi tab thì link store, publisher, ngày phát hành, `StoreKit · iOS (6)` đổi; form bên phải không đổi.
  - công tắc nhãn `iOS link dead` có class `sw-dead`; bật rồi Save gọi `POST /api/evaluations/store-dead` với `id` dòng iOS trước, rồi PATCH với `id` dòng Android.
  - store đang chọn dead: có `.pair-note` đúng câu trong Global Constraints; gợi ý cột phải `Android only while the iOS link is dead`.
  - cặp bình thường: gợi ý `Saved to both stores`; có thay đổi chưa lưu thì thanh save có `saves Android and iOS together`.
  - mở bằng back game_id: Save PATCH `data.id` (dòng trước).
  - bật `Android link dead` trên cặp mà iOS đang sống: Save gọi store-dead cho dòng Android, rồi PATCH form với `id` dòng iOS (dòng sống sau khi áp công tắc). Cả 2 store dead: form PATCH vào `data.id`.
- [ ] **Step 2: Test History modal**: event `stores:['android','ios']` render 2 mark; `['ios']` render 1; note `Counts as 1 game` hiện.
- [ ] **Step 3: Chạy**. Expected: FAIL.
- [ ] **Step 4: Sửa panel + modal** theo artboard 2, 3, 4 (copy markup từ `PanelAndroid.dc.html`, `PanelIosDead.dc.html`, `HistoryPair.dc.html`). Trạng thái dead của từng store lấy từ `pair.stores[].conclusion`; công tắc chỉ đổi state cục bộ, gửi khi Save như các trường khác (popup "chưa lưu" vẫn bắt được: thêm field vào `lib/unsaved-fields.ts`).
- [ ] **Step 5: Chạy test mới + `__tests__/components/eval-*`**. Expected: PASS.
- [ ] **Step 6: Commit** `feat(ui): pair panel with a store switcher and per-store link dead`.

### Task 14: Chạy thật ở local, build, ghi chú rollout

**Files:**
- Create: `docs/superpowers/runbooks/2026-11-21-unified-game-playtest-rollout.md` (bản nháp: kiểm trước trên prod chỉ đọc, thứ tự áp 054 rồi Pull + Deploy, rollback, kiểm sau; ghi chú cho signal-deploy về trigger trên `game_info`)

- [ ] **Step 1: Chạy toàn bộ** `bash scripts/verify-eval-pairs.sh`, `rtk proxy npx jest`, `rtk proxy npm run typecheck`. Expected: tất cả PASS.
- [ ] **Step 2: Build** bằng lệnh trong Global Constraints. Expected: exit 0, không lỗi lint. Xoá `.next-check` sau đó.
- [ ] **Step 3: Chạy app trên DB mẫu**: `DATABASE_URL=postgres://anhhung@127.0.0.1:54331/sample SKIP_AUTH=true NEXTAUTH_SECRET=local-mock NEXTAUTH_URL=http://localhost:3334 NEXT_DIST_DIR=.next-mock rtk proxy ./node_modules/.bin/next dev -p 3334` (nếu `tsconfig.json` bị next sửa thì `git checkout tsconfig.json`).
- [ ] **Step 4: Kịch bản tay trên DB mẫu**, mỗi bước kiểm bằng UI và `psql` sample:
  1. Tạo 1 cặp game_info mới (2 dòng, cùng `bundle_id`, trigger Signal Sense tự nối family), gọi push dry-run rồi push thật cho genre đó: 2 dòng ge nối nhau.
  2. Gọi assign: cặp vào 1 người, `assignment_history.game_count` 1, `game_ids` 2 id.
  3. Mở Evaluate: 1 dòng, cột Stores 2 ô. Mở panel, chấm `List_Idea` ở tab Android: dòng iOS có cùng kết quả, mã demo chỉ 1.
  4. Bật `iOS link dead`, Save: iOS `Link_dead`, Android giữ kết quả, list có chấm đỏ ở ô iOS. Tắt lại, Save: iOS nhận lại kết quả cặp.
  5. History hiện đúng icon từng dòng. Record và Short List hiện cặp 1 dòng.
  6. `UPDATE game_info SET family_unlinked=true` 1 bên: list tách 2 dòng.
- [ ] **Step 5: Commit runbook** `docs(runbook): unified game rollout draft (not applied)`.
