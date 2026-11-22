# Runbook: đưa "unified game" (cặp Android + iOS) lên prod

> **TRẠNG THÁI: BẢN NHÁP, CHƯA ÁP DỤNG.** Chưa có gì chạy trên prod. Mỗi bước có nhãn
> **[CẦN USER ĐỒNG Ý]** chỉ được làm khi user nói "go" rõ ràng cho đúng bước đó. Đồng ý
> bước trước không có nghĩa là đồng ý bước sau.

- Spec: `docs/superpowers/specs/2026-11-21-unified-game-playtest-design.md` (mục 6.6)
- Migration: `migrations/054_eval_pairs.sql` (3 transaction, chạy lại nhiều lần không lỗi, khối `-- ROLLBACK:` ở đầu file)
- Code: branch `feat/unified-playtest` (đi trước `origin/main` = `b971df0`, fast-forward được ở lần fetch gần nhất)
- App prod: `https://signal-playtest-management.replit.app` (Replit, deploy target Cloud Run)

## 0. Thứ tự

| # | Bước | Ai | Prod bị ghi? |
|---|------|----|--------------|
| 1 | Kiểm trước, chỉ đọc (mục 1) | dev | Không |
| 2 | Áp 054 **[CẦN USER ĐỒNG Ý]** (mục 2) | dev | Có: schema + nối các cặp an toàn |
| 3 | Kiểm sau 054, app cũ vẫn chạy (mục 3) | dev | Không |
| 4 | Merge vào `main` + push **[CẦN USER ĐỒNG Ý]** (mục 4) | dev | Không (chỉ git) |
| 5 | User bấm Pull ở tab Git của Replit, rồi Deploy **[CẦN USER ĐỒNG Ý]** | user | App mới |
| 6 | Xác nhận prod chạy JS mới + kiểm sau deploy (mục 5, 6) | dev + user | Không |

054 PHẢI chạy trước bản build mới: build mới đọc `pair_back`, `pair_eval_id`, `pair_scope`. Không có
các cột này thì mọi list trả 500. Ngược lại build cũ chạy được trên DB đã có 054 (nó bỏ qua cột mới,
dòng sau của 1 cặp là bản chép đầy đủ nên list cũ chỉ thấy 2 dòng giống nhau như hôm nay).

Gửi ghi chú ở mục 8 cho repo `signal-deploy` (Signal Sense) TRƯỚC bước 2.

## 1. Kiểm trước trên prod (chỉ đọc)

Chuỗi kết nối prod lấy từ Replit Secrets, gán vào biến shell `PROD_URL` ngay trong terminal. Không ghi
nó vào file, không dùng `.env`/`.env.local` của repo. Mọi lệnh ở mục này chạy với
`default_transaction_read_only=on`, Postgres tự từ chối mọi lệnh ghi:

```bash
export PGOPTIONS='-c default_transaction_read_only=on'
psql "$PROD_URL" -X -v ON_ERROR_STOP=1 -f preflight.sql   # preflight.sql = các khối P1..P7 dưới đây
```

(Bộ P1..P7 đã chạy thử chỉ đọc trên DB mẫu ngày 21/11; P6 cho kết quả trùng từng cặp với hàm
`eval_pair_safe()` thật của 054.)

```sql
\echo '--- P1. who am I, who owns the tables 054 alters'
SELECT current_user AS me,
       (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'game_evaluations') AS owner_game_evaluations,
       (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'evaluation_log')   AS owner_evaluation_log,
       (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'game_info')        AS owner_game_info,
       has_table_privilege('public.game_info', 'TRIGGER') AS can_trigger_game_info;

\echo '--- P2. names 054 adds must not exist yet (expect 0 rows)'
SELECT 'column' AS kind, table_name || '.' || column_name AS name
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND ((table_name = 'game_evaluations' AND column_name IN ('pair_eval_id', 'pair_back'))
     OR (table_name = 'evaluation_log' AND column_name = 'pair_scope'))
UNION ALL
SELECT 'function', p.proname FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('eval_store_specific', 'eval_pair_eval_cols', 'eval_pair_media_cols', 'eval_pair_valid',
                     'eval_pair_refresh_back', 'eval_pair_fill', 'link_eval_pair', 'eval_pair_link_on_insert',
                     'game_evaluations_touch_updated', 'eval_pair_copy', 'unlink_eval_pair', 'eval_pair_sync',
                     'eval_pair_on_delete', 'eval_pair_safe', 'link_safe_eval_pairs', 'game_info_eval_pair_unlink')
UNION ALL
SELECT 'trigger', tgname FROM pg_trigger
 WHERE NOT tgisinternal AND tgname IN ('trg_eval_pair_link_insert', 'trg_eval_pair_sync', 'trg_eval_pair_delete',
                                       'trg_game_info_eval_pair_unlink');

\echo '--- P3. what 054 leans on: family_id index, trigram indexes, the shared timestamp function, Signal Sense mirror'
SELECT indexname, indexdef FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'game_info'
   AND (indexdef ILIKE '%(family_id)%' OR indexdef ILIKE '%gin_trgm_ops%');
SELECT tgname, tgrelid::regclass AS on_table, tgfoid::regproc AS fn
  FROM pg_trigger
 WHERE NOT tgisinternal AND tgname IN ('trg_game_evaluations_updated', 'trg_link_game_family', 'trg_mirror_custom_field_value');

\echo '--- P4. every trigger on game_info / game_evaluations today'
SELECT tgrelid::regclass AS on_table, tgname, tgfoid::regproc AS fn, tgenabled
  FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('game_info'::regclass, 'game_evaluations'::regclass)
 ORDER BY 1, 2;

\echo '--- P5. functions that WRITE game_evaluations (expect none from Signal Sense)'
SELECT p.proname, pg_get_userbyid(p.proowner) AS owner
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.prosrc ~* '(update|insert\s+into|delete\s+from)\s+(public\.)?game_evaluations\M';

\echo '--- P6. pairs 054 would link now (same rules as link_safe_eval_pairs / eval_pair_safe)'
WITH cand AS (
  SELECT LEAST(ea.id, eb.id) AS f, GREATEST(ea.id, eb.id) AS b, ga.family_id
    FROM game_info ga
    JOIN game_info gb ON gb.family_id = ga.family_id AND ga.os < gb.os
    JOIN game_evaluations ea ON ea.game_id = ga.game_id
    JOIN game_evaluations eb ON eb.game_id = gb.game_id
   WHERE ga.family_id IS NOT NULL
     AND NOT COALESCE(ga.family_unlinked, false) AND NOT COALESCE(gb.family_unlinked, false)
     AND ea.initial_conclusion IS NULL AND eb.initial_conclusion IS NULL
     AND ea.category_group = eb.category_group
), valid AS (
  SELECT c.* FROM cand c
    JOIN game_evaluations f ON f.id = c.f
    JOIN game_evaluations b ON b.id = c.b
   WHERE (SELECT count(*) FROM game_evaluations x WHERE x.game_id = f.game_id) = 1
     AND (SELECT count(*) FROM game_evaluations x WHERE x.game_id = b.game_id) = 1
     AND (SELECT count(*) FROM game_info g WHERE g.family_id = c.family_id) = 2
), safe AS (
  SELECT v.* FROM valid v
    JOIN game_evaluations f ON f.id = v.f
    JOIN game_evaluations b ON b.id = v.b
   WHERE (SELECT bool_and(COALESCE(fv, '') IN ('', '[]') OR COALESCE(bv, '') IN ('', '[]') OR fv = bv)
            FROM (VALUES
              (f.initial_evaluator::text, b.initial_evaluator::text), (f.initial_note, b.initial_note),
              (f.initial_gameplay, b.initial_gameplay), (f.initial_game_over, b.initial_game_over),
              (f.initial_level_complete, b.initial_level_complete), (f.initial_self_note, b.initial_self_note),
              (f.evaluate_date::text, b.evaluate_date::text), (f.final_evaluator::text, b.final_evaluator::text),
              (f.final_conclusion::text, b.final_conclusion::text), (f.final_note, b.final_note),
              (f.final_conclusion_date::text, b.final_conclusion_date::text), (f.batch::text, b.batch::text),
              (f.game_alike::text, b.game_alike::text),
              (f.drive_link, b.drive_link), (f.drive_date::text, b.drive_date::text),
              (f.record_bucket::text, b.record_bucket::text), (f.record_assignee::text, b.record_assignee::text),
              (f.record_assign_date::text, b.record_assign_date::text), (f.record_confirmed_at::text, b.record_confirmed_at::text),
              (f.record_5min_assignee::text, b.record_5min_assignee::text), (f.record_5min_date::text, b.record_5min_date::text),
              (f.record_5min_drive, b.record_5min_drive), (f.record_5min_drive_date::text, b.record_5min_drive_date::text),
              (f.record_5min_confirmed_at::text, b.record_5min_confirmed_at::text), (f.record_5min_batch::text, b.record_5min_batch::text),
              (f.record_20min_assignee::text, b.record_20min_assignee::text), (f.record_20min_date::text, b.record_20min_date::text),
              (f.record_20min_drive, b.record_20min_drive), (f.record_20min_drive_date::text, b.record_20min_drive_date::text),
              (f.record_20min_confirmed_at::text, b.record_20min_confirmed_at::text), (f.record_20min_batch::text, b.record_20min_batch::text),
              (f.youtube_link, b.youtube_link), (f.youtube_uploaded_at::text, b.youtube_uploaded_at::text),
              (f.youtube_5min_link, b.youtube_5min_link), (f.youtube_5min_uploaded_at::text, b.youtube_5min_uploaded_at::text),
              (f.youtube_20min_link, b.youtube_20min_link), (f.youtube_20min_uploaded_at::text, b.youtube_20min_uploaded_at::text)
            ) AS v(fv, bv))
)
SELECT (SELECT count(*) FROM cand) AS candidate_pairs, (SELECT count(*) FROM valid) AS valid_pairs,
       (SELECT count(*) FROM safe) AS safe_pairs_054_links,
       (SELECT count(*) FROM game_evaluations) AS evaluation_rows;

\echo '--- P7. families with BOTH stores already in game_evaluations (phase 2 backlog, for scale)'
SELECT count(*) AS families_with_two_rows,
       count(*) FILTER (WHERE ea.initial_conclusion IS NOT NULL AND eb.initial_conclusion IS NOT NULL) AS both_judged
  FROM game_info ga
  JOIN game_info gb ON gb.family_id = ga.family_id AND ga.os < gb.os
  JOIN game_evaluations ea ON ea.game_id = ga.game_id
  JOIN game_evaluations eb ON eb.game_id = gb.game_id
 WHERE ga.family_id IS NOT NULL AND NOT ga.family_unlinked AND NOT gb.family_unlinked;
```

**Đọc kết quả, dừng lại nếu có dòng nào sai:**

| Khối | Phải thấy | Nếu khác |
|------|-----------|----------|
| P1 | `me` = `owner_game_evaluations` = `owner_evaluation_log`, `can_trigger_game_info = t` | Dừng. 054 phải chạy bằng role sở hữu 2 bảng đó (cần cho `ALTER TABLE`, `DISABLE TRIGGER`, và hàm `SECURITY DEFINER` chạy với quyền của role tạo nó). Không có quyền TRIGGER trên `game_info` thì transaction 3 lỗi. Tìm đúng role rồi chạy lại P1. |
| P2 | 0 dòng | Dừng. Đã có tên trùng (ai đó tạo tay, hoặc 054 đã chạy). Hỏi lại trước khi làm gì. |
| P3 | có `idx_game_info_family_id` (btree, `family_id`), có `idx_game_info_title_trgm` và `idx_game_info_game_id_trgm`; 3 trigger `trg_game_evaluations_updated`, `trg_link_game_family`, `trg_mirror_custom_field_value` | Thiếu index family_id: trigger nối khi push và trigger gỡ nối sẽ quét cả `game_info` (625k dòng) mỗi lần, dừng và báo. Thiếu trigram: search đã chậm từ trước, ghi lại số rồi báo. Thiếu `trg_mirror_custom_field_value` (Signal Sense 042): số tag trong Report/daily sẽ chỉ đếm 1 store của cặp, báo user trước khi đi tiếp. |
| P4 | `game_info`: `trg_link_game_family`, `trg_seed_pending_on_insert`, `trg_suggest_publisher_on_link`, `trg_sync_publisher_tag`, `trg_union_cf_on_link` (đây là danh sách trên DB mẫu, bản Signal Sense 041-044). `game_evaluations`: `trg_game_evaluations_record_slots`, `trg_game_evaluations_updated` | Trigger lạ trên 1 trong 2 bảng: đọc thân hàm của nó (`\sf <tên hàm>`) trước khi đi tiếp. |
| P5 | 0 dòng (054 chưa có trên prod nên chưa có hàm nào của Playtest) | Có hàm của Signal Sense ghi vào `game_evaluations`: dừng. Hàm đó sẽ chạy qua trigger chép của 054 và có thể chép cột dùng chung sang store kia. Đọc thân hàm, báo lại. |
| P6 | `safe_pairs_054_links` là số cặp 054 sẽ nối lúc chạy. Ghi số này lại để so ở mục 3. DB mẫu: 43 ứng viên, 2 an toàn (21/11). | Số an toàn rất lớn (trên vài nghìn) thì transaction 2 lâu hơn ước tính ở mục 2: chọn giờ vắng hẳn. |
| P7 | chỉ để biết quy mô đợt 2 (DB mẫu: 1097 cặp đã có 2 dòng, 842 cặp cả 2 đã chấm) | |

### 1b. EXPLAIN search trên prod (chỉ đọc)

Search của Evaluate dùng index trigram trên `game_info`. Bản build mới tìm thêm theo `game_id` của store kia.
Bản viết ở Task 5 (`OR EXISTS` trên `game_evaluations`) làm Postgres mất BitmapOr và quét cả `game_info`;
commit `0aa3bda` đã viết lại thành `ge.id IN (... UNION ALL ...)`, mọi ILIKE đều trên cột của `game_info`.
Chạy 2 câu dưới đây trên prod với 3 giá trị `q`: 1 từ phổ biến (`%block%`), 1 tên game cụ thể, 1 store id
có trong `game_evaluations`. `EXPLAIN ANALYZE` của SELECT không ghi gì.

```sql
-- psql "$PROD_URL" -X -v q='%block%' -f explain.sql   (PGOPTIONS read only như trên)
\echo '--- E1. search today (prod build): own title / id, BitmapOr expected'
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM (
  SELECT ge.initial_conclusion FROM game_evaluations ge JOIN game_info gi ON ge.game_id = gi.game_id
   WHERE ge.category_group = 'puzzle' AND (gi.title ILIKE :'q' OR gi.game_id ILIKE :'q')
   LIMIT 501) s;
\echo '--- E2. search shape of the new build, before 054 (twin via family_id, no pair columns yet)'
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM (
  SELECT ge.initial_conclusion FROM game_evaluations ge JOIN game_info gi ON ge.game_id = gi.game_id
   WHERE ge.category_group = 'puzzle'
     AND ge.id IN (
       SELECT e.id FROM game_info g JOIN game_evaluations e ON e.game_id = g.game_id
        WHERE g.title ILIKE :'q' OR g.game_id ILIKE :'q'
       UNION ALL
       SELECT tw.id FROM game_info g
         JOIN game_info gt ON gt.family_id = g.family_id AND gt.game_id <> g.game_id
         JOIN game_evaluations tw ON tw.game_id = gt.game_id
        WHERE g.game_id ILIKE :'q')
   LIMIT 501) s;
```

Đạt khi: E2 có `BitmapOr` trên 2 index trigram và **không** có `Seq Scan on game_info`, và `Execution Time`
của E2 không quá ~3 lần E1. Không đạt thì dừng, gửi cả 2 plan cho dev. (Sau khi áp 054 có câu EXPLAIN đúng
y bản build ở mục 3.)

**Mốc so sánh, DB mẫu 21/11** (60k `game_info`, 18,1k `game_evaluations`; 2 index trigram của prod được
tạo tạm trong 1 transaction rồi ROLLBACK):

| Câu count (LIMIT 501) | `q='%Carnival Sort%'` | `q='%block%'` | Plan |
|---|---|---|---|
| Hôm nay (build prod) | 2,3 ms | 13,2 ms | BitmapOr 2 index trigram |
| Bản Task 5 (`OR EXISTS`) | 63,7 ms | 42,5 ms | **Seq Scan on game_info** (60k dòng; prod 625k) |
| Bản sửa `0aa3bda` | 1,5 ms | 44,5 ms | BitmapOr, không quét `game_info`; phần còn lại là quét `game_evaluations` (18k) + hash, tăng theo số dòng eval chứ không theo `game_info` |
| Bản sửa, DB mẫu không có trigram | 92-118 ms (ấm) | | 2 lần Seq Scan `game_info` (prod có trigram nên không gặp) |

Câu list (ORDER BY searchOrder, LIMIT 200): hôm nay 0,6 / 8,7 ms; bản Task 5 61 / 55 ms; bản sửa 1,2 / 60 ms.
Kết quả bản sửa trùng hoàn toàn bản Task 5 trên 9 từ khoá thử (block, puzzle, sort, com., 683, Jaka, sloppy, hurdle, 99990).

## 2. Áp 054 trên prod **[CẦN USER ĐỒNG Ý]**

Chọn giờ vắng (tối giờ VN, không ai đang chấm, không có n8n push/assign chạy trong 10 phút tới).

**Khoá:** transaction 1 (`ADD COLUMN`) giữ khoá độc quyền `game_evaluations` vài ms. Transaction 2 có
`DROP TRIGGER IF EXISTS ... ON game_evaluations` nên giữ khoá độc quyền `game_evaluations` (chặn cả đọc lẫn
ghi) đến hết lượt nối cặp an toàn. DB mẫu: 0,15 s cả file, lượt nối 100-220 ms cho 3 cặp, 55 ms khi không
có gì để nối. Prod (71k dòng eval, xa hơn ~225 ms mỗi round-trip) ước vài giây: app đứng chờ chừng đó,
không lỗi. Transaction 3 tạo trigger trên `game_info` của Signal Sense, có `lock_timeout 5s` riêng.

Chạy bằng role ở P1 (chủ `game_evaluations`/`evaluation_log`), từ checkout có 054:

```bash
unset PGOPTIONS                                   # bỏ read only của mục 1
PGOPTIONS='-c lock_timeout=5s' \
  psql "$PROD_URL" -X -v ON_ERROR_STOP=1 -f migrations/054_eval_pairs.sql 2>&1 | tee 054-prod.log
```

`lock_timeout=5s` cho cả file: nếu có transaction dài đang giữ `game_evaluations`, lệnh bỏ cuộc sau 5 s thay
vì xếp hàng và chặn mọi query đến sau. (Transaction 3 tự đặt `SET LOCAL lock_timeout = '5s'`.)

**Phải thấy** trong log: `NOTICE: 054: linked N safe store pairs` và `safe_pairs_linked = N`, với N bằng
`safe_pairs_054_links` ở P6 (có thể ít hơn nếu có người chấm 1 trong 2 dòng giữa lúc kiểm và lúc chạy).

**Nếu lỗi:**

| Lỗi ở đâu | Trạng thái | Làm gì |
|-----------|-----------|--------|
| `lock timeout` ở transaction 1 hoặc 2 | Transaction đó ROLLBACK; transaction 1 nếu đã COMMIT thì chỉ là cột trống, vô hại với app cũ | Đợi query dài kết thúc (xem `pg_stat_activity`), chạy lại **cả file** |
| `lock timeout` ở transaction 3 (trigger trên `game_info`) | Cột, hàm, trigger trên `game_evaluations` và các cặp đã nối **đã COMMIT**. Chỉ thiếu trigger gỡ nối khi Signal Sense đổi family | Chạy lại **cả file** (idempotent: không nối lại cặp đã nối, không thêm FK lần 2). Trong lúc chờ, family đổi trên 1 cặp đã nối sẽ được tách ở lần ghi kế tiếp vào cặp đó (trigger chép thấy cặp không còn hợp lệ) |
| Lỗi khác | psql dừng ở lệnh lỗi | Không chạy tiếp, không sửa tay. Lưu `054-prod.log`, báo dev. Nếu cần quay lại: mục 7 |

## 3. Kiểm sau 054, trước khi deploy (chỉ đọc)

```sql
-- PGOPTIONS='-c default_transaction_read_only=on'
-- a. cột + trigger đã có
SELECT column_name FROM information_schema.columns
 WHERE table_name IN ('game_evaluations', 'evaluation_log') AND column_name IN ('pair_eval_id', 'pair_back', 'pair_scope');
SELECT tgrelid::regclass, tgname, tgfoid::regproc FROM pg_trigger
 WHERE tgname IN ('trg_eval_pair_link_insert', 'trg_eval_pair_sync', 'trg_eval_pair_delete',
                  'trg_game_info_eval_pair_unlink', 'trg_game_evaluations_updated');
-- trg_game_evaluations_updated phải trỏ game_evaluations_touch_updated

-- b. bất biến: mỗi cặp nối 2 chiều, đúng 1 dòng sau (expect 0 | 0 | 0)
SELECT
  (SELECT count(*) FROM game_evaluations a JOIN game_evaluations b ON b.id = a.pair_eval_id
    WHERE b.pair_eval_id IS DISTINCT FROM a.id) AS one_way_links,
  (SELECT count(*) FROM game_evaluations a JOIN game_evaluations b ON b.id = a.pair_eval_id
    WHERE a.id < b.id AND (a.pair_back::int + b.pair_back::int) <> 1) AS pairs_without_one_back,
  (SELECT count(*) FROM game_evaluations WHERE pair_back AND pair_eval_id IS NULL) AS orphan_back_rows;

-- c. ngay sau 054 (trước mọi push mới): linked_pairs = pair_link_logs = N ở mục 2
SELECT count(*) / 2 AS linked_pairs FROM game_evaluations WHERE pair_eval_id IS NOT NULL;
SELECT count(*) AS pair_link_logs FROM evaluation_log WHERE kind = 'pair_link';
```

**d. EXPLAIN đúng câu search của build mới** (giờ đã có cột cặp), cùng 3 giá trị `q` như 1b. Đạt khi giống 1b:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM (
  SELECT ge.initial_conclusion FROM game_evaluations ge JOIN game_info gi ON ge.game_id = gi.game_id
   WHERE ge.category_group = 'puzzle' AND NOT ge.pair_back
     AND ge.id IN (
       SELECT e.id FROM game_info g JOIN game_evaluations e ON e.game_id = g.game_id
        WHERE g.title ILIKE :'q' OR g.game_id ILIKE :'q'
       UNION ALL
       SELECT pe.pair_eval_id FROM game_info g JOIN game_evaluations pe ON pe.game_id = g.game_id
        WHERE g.game_id ILIKE :'q' AND pe.pair_eval_id IS NOT NULL)
   LIMIT 501) s;
```

**e.** Mở app prod (bản cũ): Evaluate, Short List, Record vẫn load. Cặp vừa nối hiện 2 dòng giống nhau (đúng,
build cũ chưa ẩn dòng sau).

## 4. Merge vào `main` **[CẦN USER ĐỒNG Ý]**

```bash
git fetch origin
git log --oneline origin/main..feat/unified-playtest | wc -l     # 21/11: 19 commit + commit runbook
git merge-base --is-ancestor origin/main feat/unified-playtest && echo fast-forward-ok
```

Nếu `main` đã đi tiếp: rebase/merge, rồi chạy lại `bash scripts/verify-eval-pairs.sh`, `rtk proxy npx jest`,
`rtk proxy npm run typecheck` và build `NEXT_DIST_DIR=.next-check NODE_OPTIONS=--max-old-space-size=6144 rtk proxy npx next build`
(xoá `.next-check` sau đó). Rồi push `main`.

## 5. Pull + Deploy trên Replit **[CẦN USER ĐỒNG Ý]**, và xác nhận prod chạy JS mới

User: tab Git của Replit, **Pull**, rồi **Deploy** (Republish). Build của Replit chạy `npm run build`, trong đó
`scripts/stamp-version.mjs` ghi `buildId = <git short sha>-<timestamp>`.

```bash
BASE=https://signal-playtest-management.replit.app
git rev-parse --short origin/main
curl -s "$BASE/api/version"            # buildId phải bắt đầu bằng đúng sha trên (route này không cần đăng nhập)
```

Xác nhận thêm bằng 1 chuỗi UI mới có trong bundle (`Saved to both stores`). Trang `/evaluations` cần đăng nhập:

- Trình duyệt đã đăng nhập: DevTools, Sources, tìm (Cmd+Opt+F) `Saved to both stores`. Có kết quả là JS mới.
- Hoặc curl với cookie phiên chép từ trình duyệt (không lưu cookie vào file):

```bash
COOKIE='__Secure-next-auth.session-token=<dán từ DevTools>'
for c in $(curl -s -H "Cookie: $COOKIE" "$BASE/evaluations" | grep -oE '/_next/static/chunks/[^"]+\.js' | sort -u); do
  curl -s "$BASE$c" | grep -q "Saved to both stores" && echo "HIT $c"
done
```

(Cách lặp chunk này đã thử trên dev server local: trúng `app/(manager)/evaluations/page.js`. Trong build
production 21/11 chuỗi nằm ở 1 chunk dùng chung `static/chunks/605-*.js`; tên chunk prod sẽ khác.)

## 6. Kiểm sau deploy

UI (tài khoản manager):

1. Evaluate: 1 cặp đã nối (lấy id từ mục 3c) hiện **1 dòng**, cột Stores 2 ô.
2. Mở panel cặp đó: có nút chuyển iOS / Android, dòng chữ `Saved to both stores` khi 2 store sống.
3. Search bằng `game_id` của dòng sau: ra đúng dòng trước. Search 1 từ phổ biến: tốc độ như trước deploy.
4. Short List, Record, Team Ops, Report, Quick stats load bình thường.
5. Push/assign tự động lần kế tiếp (n8n): một cặp mới được push đủ 2 store thì nối ngay, `assignment_history.game_count` đếm cặp là 1, `game_ids` có 2 id.

SQL (chỉ đọc), lặp lại khối 3b (phải vẫn 0 | 0 | 0) và:

```sql
-- cặp mới nối sau deploy, log mới có pair_scope
SELECT kind, pair_scope, count(*) FROM evaluation_log
 WHERE created_at > now() - interval '1 day' GROUP BY 1, 2 ORDER BY 1, 2;
```

Log app / Postgres: tìm `WARNING: 054:`. Trigger nối và trigger gỡ nối nuốt lỗi thành WARNING để không làm
hỏng lệnh push hay lệnh của Signal Sense, nên đây là chỗ duy nhất lỗi của chúng lộ ra.

## 7. Rollback

**Luôn app trước, DB sau.** Build mới đọc `pair_back`/`pair_eval_id`/`pair_scope`; xoá cột khi build mới còn
chạy thì mọi list trả 500.

1. **App [CẦN USER ĐỒNG Ý]:** Replit, Deployments, chọn bản deploy trước đó, Redeploy/Rollback. Hoặc revert
   commit merge trên `main`, push, user Pull + Deploy. Kiểm `/api/version` ra sha cũ.
2. **DB [CẦN USER ĐỒNG Ý]**, chỉ khi app đã về bản cũ: chạy khối `-- ROLLBACK:` ở đầu 054 (lệnh trích giống
   `scripts/verify-eval-pairs.sh`, script này đã chạy khối đó và so schema sau rollback với schema trước 054):

```bash
sed -n '/^-- ROLLBACK:/,/^-- END ROLLBACK/{/^-- ROLLBACK:/d;/^-- END ROLLBACK/d;s/^-- \{0,1\}//;p;}' \
  migrations/054_eval_pairs.sql > rollback-054.sql
cat rollback-054.sql                       # đọc lại trước khi chạy
PGOPTIONS='-c lock_timeout=5s' psql "$PROD_URL" -X -v ON_ERROR_STOP=1 -f rollback-054.sql
```

Khối này trả `trg_game_evaluations_updated` về `update_game_evaluations_timestamp()` **trước** khi xoá cột
(nếu không, `game_evaluations_touch_updated()` sẽ làm hỏng mọi UPDATE), rồi xoá 4 trigger, các hàm, index,
FK và 3 cột.

**Rollback không hoàn tác dữ liệu:**

- Giá trị đã chép sang dòng của store kia (kết luận, note, holder, batch, media) **ở lại**. Dòng sau trước đây
  là bản chép, sau rollback nó thành 1 game riêng đã chấm: list hiện lại 2 dòng giống nhau cho mỗi cặp, số
  đếm (Report, Quick stats, Effort APIs) tăng thêm 1 game cho mỗi cặp đã chấm trong thời gian chạy.
- Dòng `evaluation_log` kind `pair_link` / `pair_unlink` ở lại, mất cột `pair_scope` (đọc như log cũ).
- Mã file (demo/record code) đã cấp cho 1 store của cặp vẫn chỉ nằm ở store đó.

Kiểm sau rollback: P2 ở mục 1 phải ra 0 dòng; app cũ load Evaluate, Short List, Record.

## 8. Ghi chú gửi repo `signal-deploy` (Signal Sense)

Gửi trước bước 2, nguyên văn:

> Playtest (migration 054, repo signal-smartsheet-management) thêm 1 trigger trên bảng `game_info` của Signal Sense:
>
> - `trg_game_info_eval_pair_unlink AFTER UPDATE OF family_id, family_unlinked ON game_info FOR EACH ROW`,
>   chỉ chạy khi `family_id` hoặc `family_unlinked` thật sự đổi. Hàm `game_info_eval_pair_unlink()` là
>   `SECURITY DEFINER` (chạy với quyền role của Playtest, `search_path = public, pg_temp`).
> - Nó tách cặp đánh giá Android + iOS trong `game_evaluations` khi 2 game không còn cùng family (Unlink,
>   đổi bundle). Mọi lỗi trong hàm thành `WARNING '054: ...'`, không bao giờ làm hỏng lệnh UPDATE của Signal Sense.
> - Nó dựa vào `idx_game_info_family_id` và vào `trg_link_game_family` (đặt `family_id`). Đổi tên/bỏ 2 cột
>   `family_id`, `family_unlinked` hoặc index đó thì báo Playtest trước.
> - Không xoá trigger này khi dọn trigger. Nếu cần tắt khẩn cấp: `DROP TRIGGER trg_game_info_eval_pair_unlink ON game_info;`
>   (Playtest chỉ mất việc tự tách cặp; cặp sai sẽ được tách ở lần ghi kế tiếp vào nó).
> - Playtest lưu tag Trends của 1 cặp dưới `game_id` của dòng trước, nên cần `trg_mirror_custom_field_value`
>   (042) tiếp tục chép tag đã duyệt sang game cùng family (store kia).
> - Xoá 1 dòng `game_info` thì `game_evaluations` bị xoá theo (FK `ON DELETE CASCADE`), và trigger
>   `trg_eval_pair_delete` (hàm `eval_pair_on_delete()`) chạy NGAY TRONG transaction DELETE đó của Signal Sense:
>   nó chỉ UPDATE dòng còn lại của cặp thành game 1 store (`pair_eval_id = NULL`, `pair_back = false`).
>   Hàm này không bắt lỗi, nên nếu nó lỗi thì lệnh DELETE của Signal Sense cũng lỗi theo.
> - Đã kiểm trên DB mẫu (041-044): không hàm/trigger nào của Signal Sense ghi vào `game_evaluations`.

## 9. Giới hạn đã biết (theo dõi sau rollout)

- **Preview push** (Assign setup) vẫn đếm game mới theo từng store, cặp mới bị đếm 2. Lệnh assign thật đếm cặp là 1. Sửa sau rollout.
- **Cặp có 1 store `Link_dead`** được giao như game 1 store của store còn sống (luật specialist cũ).
- **Đợt 2 chưa làm:** cặp đã có 2 dòng mà không "an toàn" (P7) vẫn hiện 2 dòng như hôm nay.
- **Push nhiều cặp trong 1 transaction:** trigger nối mở 1 subtransaction cho mỗi dòng có family. Trên 64 dòng
  trong 1 transaction thì tràn cache subxid, tốn chút trên replica, vô hại ở đây.
- **Tách cặp bằng tay:** chỉ dùng `SELECT unlink_eval_pair(<id>);`. `UPDATE ... SET pair_eval_id = NULL` trên
  1 dòng để lại dòng kia nửa nối (có thể vẫn là dòng sau và bị ẩn khỏi list).
- **Unlink (Signal Sense):** dòng sau trước đó là bản chép, sau khi tách được đếm lại như 1 game đã chấm.
- **n8n ghi vào `game_evaluations`** (drive link, YouTube, record) không khoá trước 2 dòng của cặp như app làm.
  Nếu n8n và 1 người cùng ghi vào 2 store của 1 cặp đúng lúc đó, Postgres có thể báo lỗi `deadlock detected`
  cho 1 bên: lệnh đó lỗi rõ ràng (n8n ghi lỗi vào `flow_log`), không mất dữ liệu âm thầm. Chạy lại là xong.
- **Flow n8n ngoài repo** (thẻ Chat daily eval, log trạng thái evaluator sang Sheet) đếm thẳng trên
  `game_evaluations`, không có `pair_back`: chúng thấy cả 2 dòng của 1 cặp, nên 1 game có 2 store bị đếm 2.
  Sửa từng flow sau rollout (bỏ dòng `pair_back`, giữ dòng sau có `Link_dead` / `Stale_release` nếu cần đếm việc).
- **Đợt 2 (importer):** `link_eval_pair` chỉ so kết quả (`initial_conclusion`). Dòng nối vào có cùng kết quả
  nhưng ghi chú riêng vẫn được nối; ghi chú của nó giữ trong dòng nhưng bị che nếu nó thành dòng sau. Push và
  add-to-record tạo dòng trống, `link_safe_eval_pairs()` bỏ qua cặp có cột khác nhau; đường duy nhất INSERT kèm
  kết quả là `/api/admin/import-evaluations` (nhập từ Smartsheet, đã ngưng dùng). Importer đợt 2 phải tự kiểm
  ghi chú trước khi gọi `link_eval_pair`.
- `final_evaluator` / `actor` trống trên các bản ghi tạo khi chạy local `SKIP_AUTH` (chỉ local, không áp dụng prod).

## 10. Đã chạy ở local ngày 21/11 (Task 14)

DB mẫu `postgres://127.0.0.1:54330/sample` (054 đã áp), app ở `:3334`. Chi tiết + bằng chứng psql và ảnh:
`.superpowers/sdd/2026-11-21-unified-game-playtest/task-14-report.md`.

- `scripts/verify-eval-pairs.sh`: OK. Jest: chỉ các suite fail sẵn từ trước. Typecheck: 3 lỗi có sẵn. `next build`: exit 0, không lỗi lint.
- Cặp giả `com.test.unifiedpair` / `9999000001`: push nối 2 dòng (1 log `pair_link`); assign 1 người, `game_count 1`, `game_ids` 2 id;
  chấm `List_Idea` ở Android thì iOS có cùng kết quả, mã demo chỉ 1; `iOS link dead` rồi mở lại đều đúng; History, Short List, Record 1 dòng;
  `family_unlinked = true` tách thành 2 dòng, 2 log `pair_unlink`.
- `POST /api/cron/report-rollup` (`current` và `all`) chạy xong trên DB mẫu.
- Tìm ra và sửa: search mất index trigram (`0aa3bda`, xem 1b).
