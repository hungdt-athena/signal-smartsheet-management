# Runbook: đợt 2 unified game, nối các cặp cũ trên prod

> **TRẠNG THÁI: BẢN NHÁP, CHƯA ÁP DỤNG.** Chưa có gì của đợt 2 chạy trên prod. Mỗi bước có nhãn
> **[CẦN USER ĐỒNG Ý]** chỉ được làm khi user nói "go" rõ ràng cho đúng bước đó. Đồng ý bước trước
> không có nghĩa là đồng ý bước sau.

- Spec: `docs/superpowers/specs/2026-11-23-unified-playtest-phase2-design.md`
- Migration: `migrations/055_eval_pairs_phase2.sql` (5 transaction, chạy lại không hỏng, khối `-- ROLLBACK:` ở đầu
  file). 055 **không tự nối cặp nào**: chỉ thêm cột `credit`, bảng `eval_pair_merge_snapshots`, view
  `eval_stats_rows`, các hàm plan / apply / rollback, và đổi luật dòng chính thành "giữ nguyên".
- Script (đều đọc chuỗi kết nối từ biến môi trường, không ghi URL hay mật khẩu vào file):
  - `scripts/phase2-preview.sql`: bản xem trước, mỗi cặp 1 dòng CSV (chỉ đọc)
  - `scripts/phase2-stats-snapshot.sql`: số liệu theo người x tháng x nhóm (chỉ đọc)
  - `scripts/phase2-expected-diff.sql`: phần chênh được phép, tính từ snapshot của các run (chỉ đọc)
  - `scripts/phase2-stats-diff.py`: cổng so A với B, chỉ đạt khi phần chênh đúng bằng phần được phép
  - `scripts/phase2-rollback.sh`: gỡ 1 run theo từng mẻ, có `--dry-run`
- Code: branch `feat/unified-playtest-phase2` (đi trước `origin/main` = `b0f0b44`, fast-forward được ở lần fetch 23/11)
- App prod: `https://signal-playtest-management.replit.app`

## 0. Thứ tự

| # | Bước | Ai | Prod bị ghi? |
|---|------|----|--------------|
| 1 | Kiểm trước, chỉ đọc (mục 1) | dev | Không |
| 2 | Backup 2 bảng (mục 2) | dev | Không |
| 3 | Áp 055 + `ANALYZE` **[CẦN USER ĐỒNG Ý]** (mục 3) | dev | Có: schema, không đổi dòng nào |
| 4 | Xem trước: plan theo nhóm + CSV cho sheet review (mục 4) | dev, user duyệt | Không |
| 5 | Merge vào `main` + push **[CẦN USER ĐỒNG Ý]** (mục 5) | dev | Không (chỉ git) |
| 6 | User Pull + Deploy trên Replit **[CẦN USER ĐỒNG Ý]**, xác nhận `/api/version` (mục 5) | user + dev | App mới |
| 7 | Snapshot số liệu A trên prod (mục 6) | dev | Không |
| 8 | Áp đợt 2 theo mẻ **[CẦN USER ĐỒNG Ý]** (mục 7) | dev | Có |
| 9 | Snapshot B + cổng so số liệu (mục 8) | dev | Không |
| 10 | Kiểm sau (mục 9) | dev + user | Không |

055 PHẢI có trước bản build mới: build mới đọc view `eval_stats_rows` ở mọi route đếm (Report, Quick stats,
Effort API, cron `report-rollup`...). Không có view thì các route đó trả 500. Ngược lại build cũ chạy được trên
DB đã có 055 (nó bỏ qua cột, bảng và view mới). Đợt 2 (bước 8) phải chạy SAU khi build mới đã lên: build cũ đếm
trên `game_evaluations` + `notPairCopy`, không biết `credit`, nên sau bước 8 build cũ sẽ đếm mất công của store phụ
nhóm D/E/F.

Trước bước 8: báo team (backlog của người đang giữ store chờ nhóm B giảm, khoảng 490 game) và báo Signal Sense
(store phụ nhóm E/F đổi kết luận, ví dụ Bypass thành List_Idea; xem spec mục 8).

Chuỗi kết nối prod lấy từ Replit Secrets, gán vào biến shell ngay trong terminal, không ghi vào file:

```bash
export PROD_URL='...'           # endpoint TRỰC TIẾP (host không có "-pooler"), cho psql / pg_dump
export DATABASE_URL="$PROD_URL"  # các script đọc biến này
export PATH=/usr/local/opt/postgresql@16/bin:$PATH
```

Dùng endpoint trực tiếp, không dùng `-pooler`: migration, `pg_dump`, `SET` theo phiên và lock theo transaction
cần 1 kết nối thật.

## 1. Kiểm trước trên prod (chỉ đọc)

```bash
export PGOPTIONS='-c default_transaction_read_only=on'
psql "$PROD_URL" -X -v ON_ERROR_STOP=1 -f preflight-055.sql   # preflight-055.sql = các khối Q1..Q4 dưới đây
```

```sql
\echo '--- Q1. who am I, who owns the tables 055 alters (055 must run as their owner)'
SELECT current_user AS me,
       (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'game_evaluations') AS owner_game_evaluations,
       (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'evaluation_log')   AS owner_evaluation_log;

\echo '--- Q2. names 055 adds must not exist yet (expect 0 rows)'
SELECT 'column' AS kind, 'game_evaluations.credit' AS name
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'game_evaluations' AND column_name = 'credit'
UNION ALL
SELECT 'relation', c.relname FROM pg_class c
 WHERE c.relnamespace = 'public'::regnamespace
   AND c.relname IN ('eval_pair_merge_snapshots', 'eval_stats_rows', 'idx_eval_pair_merge_snapshots_run_family',
                     'idx_eval_pair_merge_snapshots_eval', 'idx_game_evaluations_credited')
UNION ALL
SELECT 'function', p.proname FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('eval_pair_phase2_classify', 'eval_pair_phase2_plan', 'eval_pair_phase2_apply', 'eval_pair_phase2_rollback');

\echo '--- Q3. 054 is there and is 054 (expect: 3 columns, touch function without keep_updated_at)'
SELECT column_name FROM information_schema.columns
 WHERE table_name IN ('game_evaluations', 'evaluation_log') AND column_name IN ('pair_eval_id', 'pair_back', 'pair_scope');
SELECT tgname, tgfoid::regproc AS fn,
       position('eval_pairs.keep_updated_at' IN p.prosrc) > 0 AS has_055_check
  FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
 WHERE t.tgrelid = 'game_evaluations'::regclass AND NOT t.tgisinternal ORDER BY 1;

\echo '--- Q4. 054 invariants (expect 0 | 0 | 0) and today''s pairs'
SELECT
  (SELECT count(*) FROM game_evaluations a JOIN game_evaluations b ON b.id = a.pair_eval_id
    WHERE b.pair_eval_id IS DISTINCT FROM a.id) AS one_way_links,
  (SELECT count(*) FROM game_evaluations a JOIN game_evaluations b ON b.id = a.pair_eval_id
    WHERE a.id < b.id AND (a.pair_back::int + b.pair_back::int) <> 1) AS pairs_without_one_back,
  (SELECT count(*) FROM game_evaluations WHERE pair_back AND pair_eval_id IS NULL) AS orphan_back_rows,
  (SELECT count(*) / 2 FROM game_evaluations WHERE pair_eval_id IS NOT NULL) AS linked_pairs,
  (SELECT count(*) FROM game_evaluations) AS evaluation_rows;
```

| Khối | Phải thấy | Nếu khác |
|------|-----------|----------|
| Q1 | `me` = `owner_game_evaluations` = `owner_evaluation_log` | Dừng, tìm đúng role (055 cần `ALTER TABLE`, `CREATE INDEX`, thay hàm trigger). |
| Q2 | 0 dòng | Dừng. 055 đã chạy (một phần?) hoặc có tên trùng. Hỏi lại trước khi làm gì. |
| Q3 | đủ 3 cột; `trg_game_evaluations_updated` trỏ `game_evaluations_touch_updated`, `has_055_check = f`; có `trg_eval_pair_sync`, `trg_eval_pair_link_insert`, `trg_eval_pair_delete`, `trg_game_evaluations_record_slots` | Thiếu 054: dừng, đợt 2 cần 054. |
| Q4 | `0 \| 0 \| 0`; ghi lại `linked_pairs`, `evaluation_rows` | Khác 0: dừng, sửa cặp hỏng trước (054 runbook mục 9). |

## 2. Backup (chỉ đọc trên prod)

```bash
unset PGOPTIONS
STAMP=$(date +%Y%m%d-%H%M)
pg_dump "$PROD_URL" -Fc -t game_evaluations -t evaluation_log -f "backup-before-055-$STAMP.dump"
pg_restore -l "backup-before-055-$STAMP.dump" | grep -E 'TABLE DATA .*(game_evaluations|evaluation_log)'   # phải có 2 dòng
```

Lưu file ở máy dev, ngoài repo. Lấy lại backup ngay trước bước 8 nếu giữa bước 3 và bước 8 cách nhau hơn 1 ngày,
và thêm `-t eval_pair_merge_snapshots` khi bảng đó đã có.

## 3. Áp 055 trên prod **[CẦN USER ĐỒNG Ý]**

Giờ vắng (không ai đang chấm, không có n8n push/assign trong 10 phút tới).

**Khoá:** transaction 1 `ADD COLUMN` (khoá độc quyền vài ms) + `CREATE INDEX ... WHERE credit IS NOT NULL` (1 lượt
quét `game_evaluations`, chặn ghi trong lúc đó, ~70k dòng: dưới 1 s). Các transaction sau chỉ thay hàm và tạo view.
Trên DB mẫu cả file dưới 1 s.

```bash
unset PGOPTIONS
PGOPTIONS='-c lock_timeout=5s' \
  psql "$PROD_URL" -X -v ON_ERROR_STOP=1 -f migrations/055_eval_pairs_phase2.sql 2>&1 | tee 055-prod.log
psql "$PROD_URL" -X -v ON_ERROR_STOP=1 -c 'ANALYZE game_evaluations;'
```

`ANALYZE` là bắt buộc: thiếu thống kê của cột `credit` mới, planner chọn quét tuần tự cho nhánh "có credit" của
view, mọi route đếm chậm hẳn.

**Nếu lỗi:** `lock timeout` thì đợi query dài xong (`pg_stat_activity`), chạy lại **cả file** (idempotent:
`IF NOT EXISTS`, hàm và view được thay). Lỗi khác: dừng, lưu `055-prod.log`, báo dev, không sửa tay.

**Kiểm sau 055 (chỉ đọc):** Q2 giờ phải ra đủ 1 cột, 5 relation, 4 hàm; Q3 `has_055_check = t`; Q4 vẫn
`0 | 0 | 0` và `linked_pairs` không đổi (055 không nối gì). Và:

```sql
SELECT (SELECT count(*) FROM eval_stats_rows) AS view_rows,
       (SELECT count(*) FROM game_evaluations) AS table_rows,           -- phải bằng view_rows
       (SELECT count(*) FROM game_evaluations WHERE credit IS NOT NULL) AS credited,   -- 0
       (SELECT count(*) FROM eval_pair_merge_snapshots) AS snapshots;                  -- 0
EXPLAIN SELECT count(*) FROM eval_stats_rows ge WHERE ge.evaluate_date >= now() - interval '7 days' AND ge.eval_row;
-- nhánh "credit IS NOT NULL" phải dùng idx_game_evaluations_credited, không có "Seq Scan" ở nhánh đó
```

App cũ (chưa deploy) vẫn chạy bình thường: mở Evaluate, Report.

## 4. Xem trước cho user duyệt (chỉ đọc)

```bash
export PGOPTIONS='-c default_transaction_read_only=on'
# R1. số cặp theo nhóm
psql "$PROD_URL" -X -c "SELECT grp, count(*) AS pairs, count(*) FILTER (WHERE cardinality(flags) > 0) AS flagged
                          FROM eval_pair_phase2_plan() GROUP BY 1 ORDER BY 1"
# R2. cờ, theo nhóm
psql "$PROD_URL" -X -c "SELECT grp, f AS flag, count(*) FROM eval_pair_phase2_plan(), unnest(flags) f GROUP BY 1, 2 ORDER BY 1, 2"
# R3. CSV mỗi cặp 1 dòng
psql "$PROD_URL" -X -q -v ON_ERROR_STOP=1 -f scripts/phase2-preview.sql > phase2-preview-prod.csv
cut -d, -f1 phase2-preview-prod.csv | sort | uniq -c     # phải khớp R1
```

So R1 với spec mục 4 (23/11: A 91, B 490, C 60, D 3.935, E 547, F 534, G 52). Lệch nhiều (hơn vài chục mỗi
nhóm, ngoài số game mới chấm từ 23/11) thì dừng và hỏi dev. Nhóm G chỉ để xem: không bao giờ được nối.

Nhập `phase2-preview-prod.csv` vào **1 tab mới** của sheet review (File, Import, Insert new sheet). Ý nghĩa các
cột ở đầu `scripts/phase2-preview.sql` (`front_*` là store list sẽ hiện, `*_after` là cặp sau khi nối,
`back_note_now` là note của store phụ sẽ bị che sau nối, vẫn xem được trong History). Thêm 1 tab tóm tắt từ R1/R2.
User duyệt xong mới sang bước 8 (bước 5, 6 làm song song được).

DB mẫu 23/11: plan 0,4 s, CSV 5,5 s cho 1.080 cặp.

## 5. Merge `main`, Pull + Deploy **[CẦN USER ĐỒNG Ý]**

```bash
git fetch origin
git log --oneline origin/main..feat/unified-playtest-phase2
git merge-base --is-ancestor origin/main feat/unified-playtest-phase2 && echo fast-forward-ok
```

Nếu `main` đã đi tiếp: merge, rồi chạy lại `bash scripts/verify-eval-pairs.sh`, `rtk proxy npx jest`,
`rtk proxy npm run typecheck`, build `NEXT_DIST_DIR=.next-check NODE_OPTIONS=--max-old-space-size=6144 rtk proxy npx next build`
(xoá `.next-check` sau đó). Push `main`.

User: tab Git của Replit, **Pull**, rồi **Deploy**. Xác nhận:

```bash
BASE=https://signal-playtest-management.replit.app
git rev-parse --short origin/main
curl -s "$BASE/api/version"      # buildId phải bắt đầu bằng đúng sha trên
```

Rồi mở Report (Team Operations, Performance) và Quick stats: load bình thường, số liệu như trước deploy (view
không đổi số khi chưa có run nào).

## 6. Snapshot số liệu A (chỉ đọc), ngay trước bước 8

Chọn giờ vắng; tạm tắt flow n8n push/assign trong lúc chạy 6 -> 8 (mọi ghi vào `game_evaluations` trong cửa sổ
này sẽ hiện ra ở cổng so sánh).

```bash
export PGOPTIONS='-c default_transaction_read_only=on'
T0=$(psql "$PROD_URL" -XAt -c "SELECT now()")      # ghi lại, dùng ở mục 8
psql "$PROD_URL" -X -q -v ON_ERROR_STOP=1 -f scripts/phase2-stats-snapshot.sql > stats-prod-A.csv
wc -l stats-prod-A.csv
```

## 7. Áp đợt 2 theo mẻ **[CẦN USER ĐỒNG Ý]**

Mỗi mẻ: 1 lệnh, 1 transaction, 1 `run_id` riêng, tối đa 500 cặp (mặc định). Đặt tên `prod-p2-001`, `prod-p2-002`...
Chạy từng mẻ, đọc kết quả, rồi mẻ tiếp, đến khi 1 mẻ trả **0 dòng** (hết cặp).

```bash
unset PGOPTIONS
RID=prod-p2-001
time PGOPTIONS='-c lock_timeout=5s' psql "$PROD_URL" -X -v ON_ERROR_STOP=1 \
  -c "SELECT grp, linked, flagged FROM eval_pair_phase2_apply('$RID')" 2>&1 | tee -a phase2-apply-prod.log
```

- Kết quả: 1 dòng mỗi nhóm (`linked` = số cặp đã nối, `flagged` = trong đó có cờ). Cộng dồn các mẻ phải bằng R1
  (A..F; có thể ít hơn vài cặp nếu có người chấm giữa lúc xem trước và lúc áp: `apply` phân nhóm lại ngay trong
  transaction).
- Một mẻ lỗi (lock timeout, `deadlock detected`, mất kết nối) thì **cả mẻ ROLLBACK**, không có gì được ghi: chạy
  lại đúng lệnh đó (cùng `run_id` cũng được). `deadlock detected` hiếm khi xảy ra khi 1 transaction của Signal Sense
  vừa sửa `game_info` vừa thêm dòng eval đúng lúc đó: chỉ cần chạy lại.
- Mỗi mẻ khoá tới 500 family đến lúc commit (DB mẫu: 4-7 s mỗi mẻ 500 cặp). Người đang lưu đúng 1 game trong mẻ
  sẽ chờ vài giây, không lỗi.
- `apply` từ chối chạy nếu hàm `game_evaluations_touch_updated()` không có kiểm tra của 055 (ai đó chạy lại 054
  sau 055): chạy lại 055 rồi tiếp.
- Prod ước khoảng 5.650 cặp: 12 mẻ.

DB mẫu 23/11 (1.066 cặp): `local-p2-001` 500 cặp 6,2 s; `-002` 500 cặp 3,8 s; `-003` 66 cặp 1,7 s; `-004` 0 dòng.

## 8. Snapshot B + cổng so số liệu (chỉ đọc)

```bash
export PGOPTIONS='-c default_transaction_read_only=on'
psql "$PROD_URL" -X -q -v ON_ERROR_STOP=1 -f scripts/phase2-stats-snapshot.sql > stats-prod-B.csv
psql "$PROD_URL" -X -q -v ON_ERROR_STOP=1 -v run_like='prod-p2-%' -f scripts/phase2-expected-diff.sql > expected-prod.csv
python3 -I scripts/phase2-stats-diff.py stats-prod-A.csv stats-prod-B.csv expected-prod.csv | tee gate-prod.txt
```

**Đạt** khi dòng cuối là `MATCHES EXPECTED`. Phần chênh được phép chỉ có 3 loại (user chốt 23/11, controller R11),
mỗi loại tính từ snapshot của chính các run:

| Loại (`reason`) | Số liệu | Vì sao | DB mẫu 23/11 |
|---|---|---|---|
| `assigned_ab` | `assigned` (first_assigned_date), `assigned_cur` (assigned_date) | Nhóm A/B không đóng băng việc giao ("bỏ luôn"): store rời người đang giữ thì người đó mất 1 game được giao. 2 store cùng người giữ vẫn mất 1 (2 dòng là 1 game). | 36 dòng, tổng -498 (-249 mỗi số) = 249 family A/B (48 + 201); 235 store đổi người giữ, 14 cặp B cùng người |
| `platform_b` | `os` (Quick stats, iOS / Android theo người) | Nhóm B: dòng chính là store ra trước; khi store đã chấm thành dòng phụ, lượt chấm tính sang os của store kia. Cùng người, tháng, nhóm, kết luận; tổng không đổi. | 16 dòng, tổng 0, 19 cặp |
| `demo_link` | `drive_link` (Quick stats "Drive links" theo người) | Demo của cặp phải nằm ở dòng chính: demo của store phụ được chuyển lên dòng chính (D/E/F `_moved`, A/B điền chỗ trống), hoặc link chung được chép sang dòng phụ `Link_dead` / `Stale_release` (nhóm C, như đợt 1). | 9 dòng, tổng +1, 5 cặp đổi số (225 family có ghi `drive_link`) |

Mọi số khác (evaluations, ngày làm, từng kết luận, final theo người chấm và theo người final, noted, record
5'/20' theo Report và theo Effort, giờ panel) phải trùng 100%.

**Không đạt:** script in `UNEXPECTED` / `MISSING`. Trước khi kết luận là lỗi, xem có ai ghi vào DB sau `T0` không:

```bash
# PGOPTIONS read only như trên; T0 ở mục 6 (psql -c không thay biến, nên đưa SQL qua stdin)
psql "$PROD_URL" -X -v t0="$T0" <<'SQL'
SELECT id, game_id, initial_evaluator, initial_conclusion, evaluate_date, first_assigned_date, updated_at, imported_at
  FROM game_evaluations WHERE updated_at >= :'t0' OR imported_at >= :'t0' ORDER BY updated_at;
SELECT actor, kind, source, game_id, created_at FROM evaluation_log
 WHERE created_at >= :'t0' AND COALESCE(context, '') NOT LIKE 'prod-p2-%' ORDER BY created_at;
SQL
```

(`apply` không đổi `updated_at`, nên mọi dòng ở đây là người hoặc n8n.) Mỗi dòng `UNEXPECTED` phải giải thích được
bằng 1 dòng ở đây (cùng người, tháng, nhóm). Còn dòng không giải thích được: dừng, gửi `gate-prod.txt` cho dev,
cân nhắc rollback (mục 10). `expected-prod.csv` phải lấy TRƯỚC mọi rollback (nó đọc snapshot, rollback xoá snapshot).

DB mẫu 23/11: `MATCHES EXPECTED` (A 1.323 khoá, B 1.327 khoá, 61 khoá đổi, đúng 3 loại trên). Thử sửa 1 số
`evaluations` trong B thì cổng báo `UNEXPECTED` và `DOES NOT MATCH EXPECTED`.

## 9. Kiểm sau

SQL (chỉ đọc):

```sql
-- a. bất biến 054 (expect 0 | 0 | 0)
SELECT
  (SELECT count(*) FROM game_evaluations a JOIN game_evaluations b ON b.id = a.pair_eval_id
    WHERE b.pair_eval_id IS DISTINCT FROM a.id) AS one_way_links,
  (SELECT count(*) FROM game_evaluations a JOIN game_evaluations b ON b.id = a.pair_eval_id
    WHERE a.id < b.id AND (a.pair_back::int + b.pair_back::int) <> 1) AS pairs_without_one_back,
  (SELECT count(*) FROM game_evaluations WHERE pair_back AND pair_eval_id IS NULL) AS orphan_back_rows;

-- b. view: số dòng = bảng; credited = số cặp D+E+F đã nối; eval_row / media_row
SELECT count(*) AS view_rows, count(*) FILTER (WHERE eval_row) AS eval_rows,
       count(*) FILTER (WHERE media_row) AS media_rows, count(*) FILTER (WHERE credit IS NOT NULL) AS credited
  FROM eval_stats_rows;
SELECT count(*) AS table_rows FROM game_evaluations;

-- c. mỗi run: 2 snapshot mỗi cặp, 1 log mỗi cặp
SELECT ms.run_id, count(*) AS snapshots, count(DISTINCT ms.family_id) AS pairs,
       (SELECT count(*) FROM evaluation_log l WHERE l.context = ms.run_id) AS log_rows
  FROM eval_pair_merge_snapshots ms GROUP BY 1 ORDER BY 1;

-- d. vài cặp mẫu cho UI: 1 D, 1 E (store phụ có note), 1 C
SELECT ms.pair_group, f.game_id AS front_game, k.game_id AS back_game, k.credit ->> 'initial_evaluator' AS back_was_by,
       k.credit ->> 'initial_conclusion' AS back_was, left(k.credit ->> 'initial_note', 60) AS back_old_note
  FROM eval_pair_merge_snapshots ms
  JOIN game_evaluations k ON k.id = ms.game_evaluation_id AND k.pair_back
  JOIN game_evaluations f ON f.id = k.pair_eval_id
 WHERE ms.pair_group IN ('C', 'D', 'E') ORDER BY ms.pair_group, ms.id DESC LIMIT 15;
```

DB mẫu 23/11 sau 3 run: a `0 | 0 | 0`; b 18.101 dòng view = bảng, eval_row 17.849, media_row 17.840, credited 808
(= 589 D + 134 E + 85 F); c 1.000 / 1.000 / 132 snapshot, log 500 / 500 / 66.

UI (tài khoản manager), với game ở d:

1. Evaluate: search tên 1 cặp D, hiện **1 dòng**, cột Stores 2 ô.
2. Mở panel 1 cặp E: kết luận `List Idea`, `Saved to both stores`; History có dòng `System merged <store> into the pair`,
   `EVALUATOR <cũ> -> <mới>`, `Bypass -> List Idea`, `was Bypass by <người cũ>`, mở `Old note` thấy note cũ.
3. 1 cặp C: 1 dòng, ô store chết có chấm đỏ; panel ghi `<store> only while the <store> link is dead`.
4. Report (Team Operations, Performance), Quick stats, Short List, Record load bình thường.

Ảnh DB mẫu 23/11 (ngoài repo): xem `.superpowers/sdd/2026-11-23-unified-playtest-phase2/task-7-report.md`.

Log Postgres / app: tìm `WARNING: 054:` như đợt 1.

## 10. Rollback

### 10a. Gỡ các run đợt 2 **[CẦN USER ĐỒNG Ý]** (app giữ nguyên)

Build mới đọc được DB cả khi có lẫn khi không có run, nên gỡ run không cần đổi app. Lấy `expected-prod.csv` (mục 8)
trước nếu chưa lấy. Mỗi run, thử trước rồi chạy thật, từ run mới nhất về cũ:

```bash
unset PGOPTIONS
psql "$PROD_URL" -XAt -c "SELECT DISTINCT run_id FROM eval_pair_merge_snapshots ORDER BY 1 DESC"
bash scripts/phase2-rollback.sh --dry-run prod-p2-012     # mẻ đầu rồi ROLLBACK, không đổi gì
bash scripts/phase2-rollback.sh prod-p2-012 | tee -a phase2-rollback-prod.log
```

Script gỡ theo mẻ 500 family, mỗi mẻ 1 commit, gọi đến khi hết; lỗi giữa chừng thì các mẻ trước giữ nguyên,
chạy lại là đi tiếp. Mỗi cột run đã ghi trở về giá trị trước run, **trừ** cột đã bị sửa sau run (có người chấm lại,
video n8n về): giữ giá trị mới và in ra ở `kept_columns`. `linked_to` khác NULL: dòng đã được nối với dòng khác
sau run, cặp đó có thể lệch cột dùng chung tới lần lưu kế tiếp. Không đổi `updated_at`, không ghi log
`pair_unlink`, xoá log `pair_merge` / `pair_link` và snapshot của run.

Kiểm sau: `SELECT count(*) FROM eval_pair_merge_snapshots` = 0 (khi gỡ hết), `credit IS NOT NULL` = 0, bất biến
9a vẫn `0 | 0 | 0`, snapshot số liệu mới so với `stats-prod-A.csv` bằng `phase2-stats-diff.py` (không file thứ 3):
`IDENTICAL`, trừ những gì người dùng làm sau `T0`.

DB mẫu 23/11: dry-run 1.000 dòng / 0 kept; gỡ 3 run 2,3 s / 1,4 s / 0,8 s, 0 kept, 0 linked; số liệu sau gỡ
`IDENTICAL` với A; md5 toàn bảng `game_evaluations` (kể cả `updated_at`) và `evaluation_log` trùng hệt trước run.

### 10b. Gỡ hẳn 055 **[CẦN USER ĐỒNG Ý]**: app trước, DB sau

1. Gỡ mọi run (10a). Khối ROLLBACK xoá cột `credit` và bảng snapshot: run nào còn thì mất luôn đường quay lại.
2. **App:** về bản build trước 055 (Replit Deployments, Redeploy bản cũ; hoặc revert trên `main`, push, Pull +
   Deploy). Kiểm `/api/version`. Build mới mà mất view thì mọi route đếm trả 500.
3. **DB**, chỉ khi app đã về bản cũ:

```bash
sed -n '/^-- ROLLBACK:/,/^-- END ROLLBACK/{/^-- ROLLBACK:/d;/^-- END ROLLBACK/d;s/^-- \{0,1\}//;p;}' \
  migrations/055_eval_pairs_phase2.sql > rollback-055.sql
cat rollback-055.sql                         # đọc lại trước khi chạy
PGOPTIONS='-c lock_timeout=5s' psql "$PROD_URL" -X -v ON_ERROR_STOP=1 -f rollback-055.sql
```

Khối này trả nguyên văn `eval_pair_refresh_back` và `game_evaluations_touch_updated` của 054, rồi xoá view, hàm,
bảng snapshot, index và cột `credit`. Kiểm: Q2 ra 0 dòng, Q3 `has_055_check = f`.

### 10c. Thứ tự với 054

- Chạy lại 054 sau 055 sẽ đặt lại luật dòng chính của 054 (id nhỏ hơn) và hàm `touch_updated` không có kiểm tra
  của 055: **phải chạy lại 055 ngay sau đó**. Trong lúc đó `apply` và `rollback` của đợt 2 tự từ chối chạy
  (kiểm tra M5), nên không thể lỡ đổi `updated_at` hàng loạt.
- Gỡ 054 cần gỡ 055 trước (view đọc `pair_back`): 10a, 10b, rồi mới tới mục 7 của runbook 054.

## 11. Giới hạn đã biết

- Flow n8n đọc thẳng `game_evaluations` (thẻ Chat daily eval, sheet status log) thấy store phụ mang kết quả của
  dòng chính: có thể đếm 1 lượt chấm thành 2. Sửa riêng (spec mục 8).
- `eval_stats_rows` liệt kê từng cột của `game_evaluations`: migration sau thêm / đổi / bỏ cột phải sửa view cùng
  lúc (đầu file 055). `scripts/sql-verify/phase2-schema.sql` báo lỗi nếu quên.
- Cặp nối ở đợt 2 rồi bị Unlink (Signal Sense): dòng có `credit` vẫn được đếm bằng `credit`, không đếm 2 lần.
  Nối lại cặp đó là việc của người (plan xếp nó vào G, cờ `credited`).
- 52 game nhiều dòng eval (nhóm G, `multi_row`) không được nối; việc dọn riêng.
