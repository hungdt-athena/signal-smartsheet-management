# Audit tải dữ liệu — signal-smartsheet-management

Đo trực tiếp trên Neon prod ngày 2026-09-05 (EXPLAIN ANALYZE + pg_stat_*), không phải ước lượng.

## 0. Bối cảnh hạ tầng (quyết định mọi thứ bên dưới)

| Thông số | Giá trị đo được |
|---|---|
| DB size | 7101 MB (dùng chung với Signal Sense) |
| `shared_buffers` | 128 MB |
| Heap cache hit ratio toàn DB | **49.2%** |
| `game_info` | 4856 MB, hit ratio **19.7%**, 976M block đọc từ storage |
| `game_evaluations` | 69.437 dòng / 35 MB, hit ratio 96.6%, **60.647 seq scan** |
| Connection string | endpoint **direct**, không phải `-pooler` |
| Deploy target | Cloud Run (scale-to-zero, multi-instance) |

Kết luận nền: compute Neon quá nhỏ so với working set. `game_evaluations` (35MB) thì nằm
trong cache, nhưng mọi lần JOIN sang `game_info` (4.8GB) là đọc từ storage. Chênh lệch
cold/warm đo được: cùng một query, **425ms cold vs 40ms warm**.

## 1. Các site nạp dữ liệu

| Trang | Endpoint | Số query/lần load | Ghi chú |
|---|---|---|---|
| `/evaluations` (Evaluate + Short List) | `/api/evaluations` | **8** | nặng nhất, gọi lại mỗi lần đổi filter |
| Report / `team-ops?tab=performance` | `/api/report` | **17** query trên `game_evaluations` | có cache in-memory 3 phút |
| `/youtube` (Record) | `/api/sheets/ytb-uploaded` ×2 + `/api/evaluations` | Google Sheets full-read `A:H`, no cache | |
| `/team-ops` | assign-setup, operations/runs, rescue, assignment-history | mỗi panel 1 fetch | nhẹ |
| Tagging | `/api/playtest-tags/*` | queue có window function sort toàn bộ pending | nhẹ (550 dòng) |

## 2. Vấn đề, xếp theo mức độ

### P0 — Auth tốn 2 round-trip DB cho MỖI request API

`requireAuth()` gọi `getServerSession` → callback `session()` chạy
`SELECT id,name,role FROM dashboard_users WHERE email=…`. Sau đó route **gọi lại**
`getServerSession` lần nữa → thêm 1 query. **24 route** đang làm vậy
(`app/api/evaluations/route.ts`, `app/api/report/route.ts`, toàn bộ `playtest-tags/*`, …).

Đây là 2 round-trip tuần tự tới us-east-2 **trước khi** query thật bắt đầu.

### P0 — Không có index nào trên `evaluate_date`, và filter đang non-sargable

`game_evaluations` có 15 index nhưng **không có cái nào cho `evaluate_date`**, trong khi:

- Short List sort + filter theo `COALESCE(ge.evaluate_date, ge.updated_at)`
- Report filter theo `(ge.evaluate_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= …`

Cả hai đều là biểu thức → planner không có statistics. Đo được:

```
Seq Scan on game_evaluations  (cost… rows=282) (actual rows=15384)
```
→ **ước lượng lệch 55 lần**. Sai số này lan sang các query có JOIN, chọn nested-loop sai.

Viết lại dạng sargable (đã verify ra **cùng 15384 dòng**, bit-identical):

```sql
-- thay vì: (evaluate_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= '2026-08-01'::date
evaluate_date >= ('2026-08-01'::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
```
Chỉ đổi cách viết, **chưa cần index**, estimate đã về `rows=15506` vs actual 15384.

### P1 — `/api/evaluations` chạy lại toàn bộ facet mỗi lần đổi filter

`wantMeta = (page === 1)`, mà UI luôn gửi page 1 → mỗi lần bấm filter chạy đủ 8 query,
trong đó 5 query **không phụ thuộc filter vừa đổi**:

| Query | Cold | Warm |
|---|---|---|
| `available_months` (DISTINCT EXTRACT trên COALESCE) | **425ms** | 40ms |
| `available_evaluators` (mode() GROUP BY lower()) | — | 67ms |
| `available_batches` (DISTINCT batch) | — | ~30ms |
| `conclusion_options` + `current_batch` + `default_batch` | — | 3 query nhỏ |
| list chính (LATERAL trends + JOIN game_info/developer) | **886ms** | ~200ms |

Payload list: **584 KB** cho 500 dòng.

### P1 — Report tab: 17 seq scan, cache sai chỗ, và bảng rollup bị bỏ không

- `app/api/report/route.ts` chạy 17 query trên `game_evaluations`, query facet
  (week/month/quarter/batch options) một mình đã **590ms warm** vì UNION 4 lần scan cùng bảng.
- Cache là `Map` in-memory, TTL 3 phút → trên Cloud Run **mất sạch mỗi cold start** và
  **không chia sẻ giữa các instance**.
- `report_rollup` (migration 030) + cron `/api/cron/report-rollup` **đang ghi nhưng
  không có nơi nào đọc** — grep toàn repo chỉ ra file cron. Đây là pre-aggregation chết.

### P2 — Google Sheets đọc sống mỗi lần mở tab Record

`readYtbUploaded()` đọc `A:H` không giới hạn, `Cache-Control: no-store`, và
`app/(manager)/youtube/page.tsx` gọi **2 lần lúc mount** (dòng 496 và 1568).
Sheets API latency 300–1500ms + có quota. Trong khi DB đã có bảng `ytb_uploads`.

### P2 — Connection không qua pooler

`ep-polished-flower-a5omvpjj.us-east-2.aws.neon.tech` (direct). Cloud Run scale nhiều
instance × `postgres.js max=10` → dễ chạm giới hạn, và mỗi cold start phải bắt tay TLS mới.

## 3. Hướng xử lý, theo thứ tự làm

### Tier 0 — sửa tại chỗ, không đổi kiến trúc, không thêm dịch vụ

Bốn việc độc lập nhau, làm cái nào trước cũng được.

---

#### 0.1 — Gộp session lookup (bỏ 1 trong 2 query auth mỗi request)

**Đang xảy ra gì.** `lib/auth.ts:88` có callback `session()`, và mỗi lần callback này chạy
nó bắn 1 query:

```ts
async session({ session }) {
  const rows = await sql`SELECT id, name, role, active FROM dashboard_users WHERE email = ${email}`
```

Callback đó chạy mỗi lần ai gọi `getServerSession()`. Mà route đang gọi **hai lần**:

```ts
// app/api/evaluations/route.ts
17:  const guard = await requireAuth()                       // → getServerSession → query #1
27:  const session = skipAuth ? null : await getServerSession(authOptions)  // → query #2
```

`requireAuth()` (`lib/auth-guard.ts`) chỉ cần biết "có session hay không", nhưng nó lấy
session bằng đúng cách đắt tiền đó. Rồi route lại cần `session.user.name`/`role` nên gọi lại.
Kết quả: 2 round-trip tuần tự sang Neon us-east-2 **trước khi** query dữ liệu thật bắt đầu.
Pattern này lặp ở **24 route**.

**Cách sửa (an toàn, khuyến nghị): memo hoá trong phạm vi 1 request.**

```ts
// lib/auth-guard.ts (hoặc lib/session.ts)
import { cache } from 'react'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

/** Một request = tối đa một lần đọc session. React cache() có scope theo request,
 *  nên hai route handler của hai người dùng khác nhau không bao giờ đụng nhau. */
export const getSession = cache(() => getServerSession(authOptions))
```

Rồi trong `requireAuth`/`requireRole` và trong mọi route, thay `getServerSession(authOptions)`
bằng `getSession()`. Lần gọi thứ hai trở đi trong cùng request lấy từ memo, không query.

**Được gì.** Bỏ đúng 1 round-trip DB trên mọi request của 24 route.

**Rủi ro.** Gần như không. `cache()` của React scope theo request, không phải global —
không có chuyện session người này rò sang người khác.

**Phương án mạnh hơn (cân nhắc kỹ): đẩy `role`/`name` vào JWT** và bỏ hẳn query trong
`session()`. Cắt được cả 2 query thay vì 1. **Nhưng** `SESSION_MAX_AGE` đang là 30 ngày,
nghĩa là admin đổi role hoặc set `active = false` cho ai đó thì **thay đổi không có hiệu lực
tới 30 ngày** — người bị deactivate vẫn vào được. Nếu muốn đi đường này thì phải hạ
`jwt.maxAge` xuống (ví dụ 15 phút) để token buộc phải refresh, và lúc đó lại quay về query DB
mỗi 15 phút. Với `active` vừa thêm ở migration 041, tôi khuyên **làm 0.1 dạng memo trước**,
JWT để sau.

---

#### 0.2 — Viết lại filter ngày sang dạng sargable

**"Sargable" nghĩa là gì.** Là điều kiện WHERE mà Postgres có thể so sánh trực tiếp lên giá trị
cột. Khi bạn bọc cột trong hàm — `f(cột) >= X` — Postgres mất hai thứ: (a) không dùng được
index thường trên cột đó, và (b) **không còn statistics** để đoán số dòng, nên nó bịa ra
một con số mặc định.

**Đang xảy ra gì.** `app/api/report/route.ts` filter thế này:

```sql
AND (ge.evaluate_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= '2026-08-01'::date
AND (ge.evaluate_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date <  '2026-09-01'::date
```

Đo thật:
```
Seq Scan on game_evaluations  (cost=0.00..3765.36 rows=282) (actual rows=15384)
```
Postgres đoán **282 dòng**, thực tế **15.384 dòng** — lệch **55 lần**.

**Vì sao con số lệch này nguy hiểm hơn là chậm.** Một mình nó chỉ tốn thêm ~40ms. Nhưng
planner dùng con số đó để chọn kiểu JOIN. Đoán 282 dòng → nó chọn nested-loop
(lặp 282 lần, rẻ). Thực tế 15.384 dòng → nó lặp 15.384 lần vào `game_info` (bảng 4.8GB,
cache hit 19.7%). Đó là lúc query từ 40ms thành vài giây. Sai số lan sang mọi query có JOIN
trong file report.

**Cách sửa.** Chuyển phép đổi timezone từ **cột** sang **hằng số**:

```sql
-- thay vì bọc cột:
--   (evaluate_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= '2026-08-01'::date
-- bọc mốc thời gian:
    evaluate_date >= ('2026-08-01'::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
AND evaluate_date <  ('2026-09-01'::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
```

Postgres tính vế phải một lần thành `'2026-07-31 17:00:00+00'` rồi so thẳng với cột.

**Đã verify là tương đương tuyệt đối:**
```
old_way | new_way
  15384 |   15384
```
Và estimate sau khi sửa: `rows=15506` vs actual `15384` — chính xác, **chưa cần thêm index nào**.

**Chỗ cần sửa:** biến `winF` và `recAtDate` trong `app/api/report/route.ts` (~dòng 112-163),
và mọi chỗ trong file dùng pattern `AT TIME ZONE ${VN})::date >=`.

**Rủi ro.** Không. Chỉ đổi cách viết, kết quả bit-identical (đã chạy đối chiếu trên prod).

---

#### 0.3 — Thêm 2 index

`game_evaluations` đang có **15 index**, nhưng **không cái nào dùng được cho `evaluate_date`** —
mà đó lại là cột Short List sort theo và Report filter theo.

```sql
-- (1) Cho Short List: nó filter category_group rồi sort theo COALESCE(evaluate_date, updated_at).
--     Index phải khớp đúng biểu thức COALESCE thì mới dùng được.
CREATE INDEX CONCURRENTLY idx_ge_cat_evalcoalesce
  ON game_evaluations (category_group, (COALESCE(evaluate_date, updated_at)) DESC);

-- (2) Cho Report, sau khi đã làm 0.2. Không làm 0.2 thì index này vô dụng.
CREATE INDEX CONCURRENTLY idx_ge_evaluate_date
  ON game_evaluations (evaluate_date) WHERE evaluate_date IS NOT NULL;

ANALYZE game_evaluations;
```

**Lưu ý thứ tự:** 0.2 phải làm trước hoặc cùng lúc với index (2). Index btree thường trên
`evaluate_date` **không** cứu được điều kiện `(evaluate_date AT TIME ZONE …)::date` — đó
chính là lý do 15 index hiện tại không giúp gì.

**Vì sao `CONCURRENTLY`:** để không khoá bảng khi tạo. Bù lại nó không chạy được trong
transaction, nên chạy tay từng câu chứ đừng bỏ vào file migration cùng `BEGIN`.

**Rủi ro.** Thấp. Tốn thêm ~2-3 MB đĩa mỗi index và làm INSERT/UPDATE chậm đi không đáng kể
(bảng chỉ 69k dòng). Nếu không giúp thì `DROP INDEX` lại.

---

#### 0.4 — Đổi sang endpoint pooled của Neon

**Đang xảy ra gì.** `DATABASE_URL` đang trỏ endpoint **direct**:
```
ep-polished-flower-a5omvpjj.us-east-2.aws.neon.tech
```

App deploy lên **Cloud Run** (xem `.replit`: `deploymentTarget = "cloudrun"`), tức là
chạy nhiều instance và scale-to-zero. Mỗi instance mở tới 10 connection
(`postgres.js` mặc định `max: 10`). Ba instance là 30 connection thật tới Postgres, mỗi cái
tốn RAM trên compute Neon vốn đã nhỏ. Và mỗi cold start phải bắt tay TLS mới từ đầu.

**Cách sửa.** Thêm `-pooler` vào hostname:
```
ep-polished-flower-a5omvpjj-pooler.us-east-2.aws.neon.tech
```
Neon route qua PgBouncer, nhiều connection từ app dồn vào ít connection thật.

**Rủi ro.** PgBouncer chạy transaction-pooling nên **không hỗ trợ prepared statement**.
`postgres.js` mặc định có dùng prepared statement, nên phải tắt:
```ts
// lib/db.ts
export const sql = postgres(connectionString, {
  ssl: 'require',
  prepare: false,   // ← bắt buộc khi qua pooler
  ...
})
```
Nếu quên dòng này sẽ gặp lỗi kiểu `prepared statement "s1" already exists`. Đây là bẫy
duy nhất của bước này — sửa xong thì test kỹ một vòng trước khi deploy.

---

### Tier 1 — sửa cấu trúc endpoint (1-2 ngày)

Tier 0 làm cho từng query nhanh hơn. Tier 1 làm cho **số lượng query ít đi**.

---

#### 1.1 — Tách facet ra khỏi `/api/evaluations`

**Facet là gì.** Là dữ liệu để đổ vào các dropdown filter: danh sách tháng có data,
danh sách evaluator, danh sách batch, danh sách conclusion. Nó khác với **rows** (dữ liệu bảng).

**Đang xảy ra gì.** `app/api/evaluations/route.ts:55`:
```ts
const wantMeta = page === 1
```
Ý định ban đầu đúng: "chỉ trả meta ở trang đầu, các trang sau khỏi tính lại". Nhưng
`app/(manager)/evaluations/page.tsx` **không có phân trang** — nó gửi `limit=500` và
không bao giờ gửi `page`. Nên `page` luôn = 1, `wantMeta` luôn = true.

Hệ quả: mỗi lần user bấm đổi một filter bất kỳ, `fetchData()` chạy lại **8 query**:

| # | Query | Phụ thuộc filter? | Đo được |
|---|---|---|---|
| 1 | list chính (LATERAL trends + JOIN game_info + developer) | có | 886ms cold / ~200ms warm |
| 2 | stats (count + count filtered) | có | nhanh |
| 3 | `available_months` — `DISTINCT EXTRACT(...)` trên COALESCE | **không** | **425ms cold** / 40ms warm |
| 4 | `available_evaluators` — `mode() … GROUP BY lower()` toàn bảng | **không** | 67ms |
| 5 | `available_batches` — `DISTINCT batch` | **không** | ~30ms |
| 6 | `conclusion_options` (`getConfigValues`) | **không** | nhỏ |
| 7 | `current_batch` (`app_config`) | **không** | nhỏ |
| 8 | `default_batch` (fallback batch có game) | một phần | nhỏ |

Query #3, #4, #5 đọc **toàn bộ** bảng và cố tình bỏ qua filter ngày (comment trong code nói rõ:
"deliberately ignores month and pagination so the filter dropdown shows everyone").
Tức là chúng **cho ra kết quả y hệt nhau** dù user bấm filter gì. Vậy mà chạy lại mỗi lần bấm.

**Cách sửa.**

```
GET /api/evaluations/facets?category=puzzle
   → { available_months, available_evaluators, available_batches,
       conclusion_options, current_batch }
   → client gọi 1 lần lúc mount + khi đổi category. Hết.

GET /api/evaluations?...filters
   → { data, total, stats }
   → gọi mỗi lần đổi filter. Chỉ còn 2 query.
```

Phía client (`app/(manager)/evaluations/page.tsx`): tách `fetchData` hiện tại thành
`fetchFacets()` (useEffect chỉ phụ thuộc `filterCategory`) và `fetchRows()`
(useEffect phụ thuộc dependency array đầy đủ như hiện nay).

**Được gì.** Đường bấm filter từ 8 query → 2 query. Bỏ hẳn cục 425ms ra khỏi thao tác
thường xuyên nhất của người dùng.

**Cần cẩn thận.** Logic `month=auto` + `default_batch` hiện đang đan xen giữa meta và rows
(có cả cờ `suppressFetchRef` để chặn refetch thừa). Khi tách phải giữ nguyên hành vi:
facets trả về `applied_month` để client chốt tháng, rồi mới gọi rows. Đây là phần tốn công
nhất của Tier 1 — không khó nhưng dễ làm vỡ hành vi mặc định của Short List nếu ẩu.

---

#### 1.2 — Cho `/api/report` đọc `report_rollup`

**Đây là đòn mạnh nhất, và phần lớn công đã làm sẵn rồi.**

**Đang xảy ra gì.** `app/api/report/route.ts` chạy **17 query** trên `game_evaluations`
mỗi lần load. Riêng query đổ dropdown filter (week/month/quarter/batch options) đã
**590ms warm** vì nó `UNION ALL` 4 lần quét cùng một bảng:

```sql
SELECT 'week',    date_trunc('week', …)  FROM game_evaluations … GROUP BY 1,2
UNION ALL SELECT 'month',   …            FROM game_evaluations … GROUP BY 1,2
UNION ALL SELECT 'quarter', …            FROM game_evaluations … GROUP BY 1,2
UNION ALL SELECT 'batch',   batch        FROM game_evaluations … GROUP BY 1,2
```

**Phần đã có sẵn mà không ai dùng.** Migration 030 tạo bảng `report_rollup`
(1 dòng / tuần / category / domain / evaluator, đã có sẵn `period_month`, `period_quarter`,
`games`, `active_days`, `turnaround_sum/count`, `priority_count`, `conclusions` JSONB).
Cron `POST /api/cron/report-rollup` **đang chạy và đang ghi** vào đó.

Nhưng grep toàn repo tìm `report_rollup` chỉ ra đúng file cron. **Không có nơi nào đọc.**
Chính comment trong file cron cũng thừa nhận: *"remain as an OPTIONAL pre-aggregation for scale"*.
Hiện bảng có 89 dòng.

**Cách sửa.** Định tuyến theo view:

```
view = month | quarter | all-time  → đọc report_rollup   (89 dòng, index sẵn có)
view = week (tuần hiện tại) | custom → query sống như hiện nay
```

Rollup cố tình lưu `turnaround_sum` + `turnaround_count` riêng (không lưu sẵn trung bình)
chính là để cộng nhiều tuần lại vẫn ra đúng trung bình — schema đã thiết kế cho việc này rồi.

Với dropdown options (query 590ms ở trên), lấy thẳng từ
`SELECT DISTINCT period_month, period_quarter, period_week FROM report_rollup` — quét
89 dòng thay vì 4 lần quét 69.437 dòng.

**Được gì.** 17 query trên bảng 69k dòng → 1-2 query trên bảng 89 dòng cho phần lớn lượt xem.
Ước tính Report từ ~1.5s về ~200ms.

**Cần cẩn thận.** Phải đối chiếu số liệu rollup vs query sống trước khi cắt sang, vì report
đã qua nhiều vòng đổi định nghĩa (v5.19 đổi mẫu số từ `assigned` sang `evaluated`, v5.21
gộp định nghĩa "Recorded"). Nếu cron được viết trước các thay đổi đó thì rollup có thể
đang tính theo luật cũ. **Kiểm tra bước này trước tiên** — nếu lệch thì phải sửa cron
trước khi sửa report.

---

#### 1.3 — Thôi đọc Google Sheets mỗi lần mở tab Record

**Đang xảy ra gì.** `lib/google-sheets.ts:31` `readYtbUploaded()` đọc nguyên dải `A:H`
không giới hạn, và `app/api/sheets/ytb-uploaded/route.ts` trả về với `Cache-Control: no-store`.

Tệ hơn: `app/(manager)/youtube/page.tsx` gọi endpoint đó **2 lần lúc mount** — dòng 496
và dòng 1568 (hai component khác nhau cùng cần dữ liệu, mỗi cái tự fetch).

Google Sheets API latency 300-1500ms và có quota theo phút. Nghĩa là mở tab Record là
đứng chờ 2 lượt gọi Sheets tuần tự, và nếu nhiều người mở cùng lúc thì đụng rate limit.

**Cách sửa, theo thứ tự ưu tiên:**

1. **Bỏ 1 trong 2 lần gọi.** Nâng state lên component cha hoặc dùng React context, để
   2 chỗ dùng chung 1 kết quả. Cái này rẻ nhất, làm ngay được — cắt ngay 50%.
2. **Đọc từ DB thay vì Sheets.** Bảng `ytb_uploads` đã tồn tại (có sẵn
   `idx_ytb_uploads_file_id`, `idx_ytb_uploads_status`). Nếu nó đã được đồng bộ đầy đủ
   thì đọc DB thay Sheets là xong, latency về mức milli giây.
3. Nếu (2) chưa khả thi vì Sheets vẫn là nguồn sự thật cho cột nào đó: cache 60s
   trong process, hoặc mirror vào `ytb_uploads` bằng cron rồi đọc DB.

**Cần cẩn thận.** Ghi (PATCH/POST/DELETE) vẫn phải đi thẳng Sheets, và sau khi ghi phải
xoá cache ngay — nếu không user bấm sửa xong reload lại thấy giá trị cũ, rất khó chịu.

### Tier 2 — Redis (có đáng, nhưng là bước 2 chứ không phải bước 1)

Redis hợp lý vì app chạy **Cloud Run multi-instance + scale-to-zero**, nên cache
in-memory hiện tại gần như vô dụng. Đưa vào Redis đúng 4 thứ:

| Key | TTL | Lý do |
|---|---|---|
| bundle `/api/report` (key hiện có sẵn) | 3–5 phút | thay `Map` in-memory, sống qua cold start |
| facet lists (evaluators/batches/months/options) | 5–10 phút, invalidate khi ghi | đổi rất chậm, query lại rất đắt |
| mirror sheet `ytb_uploaded` | 60s | cắt latency Sheets API |
| `email → {role,name}` | 60s | chặn query auth nếu không chuyển sang JWT |

**Không** cache row data của Short List: nó đổi mỗi lần evaluator save, và cardinality
theo filter quá lớn → hit rate thấp, rủi ro stale cao.

Chọn **Upstash Redis (REST/HTTP)** thay vì Memorystore: Cloud Run gọi Memorystore cần
VPC connector (thêm tiền + thêm cấu hình), Upstash chỉ cần 2 env var.

### Tier 3 — hạ tầng

8. **Nâng compute Neon / tắt autosuspend.** Chênh lệch 425ms→40ms là autosuspend + buffer
   cache lạnh. Với `shared_buffers` 128MB và `game_info` 4.8GB ở hit ratio 19.7%, đây là
   trần thật sự của mọi tối ưu query.
9. Cân nhắc deploy Cloud Run cùng region với Neon (us-east-2) — hiện mỗi round-trip DB
   đang cộng thêm latency xuyên vùng, mà pattern code là rất nhiều query nhỏ.

## 3b. KẾT QUẢ TIER 0 (đã triển khai 2026-09-06)

Đo bằng cùng một script, cùng máy, cùng cách (EXPLAIN ANALYZE, median của 5 lần, đã warm-up).
Script + baseline gốc: `scratchpad/bench/` (run.sh, BASELINE.md).

| query | trước | sau | đổi |
|---|---|---|---|
| A report_window (filter tháng) | 42.6 ms | **9.9 ms** | **4.3x nhanh hơn** |
| D eval_list (Short List 500 dòng) | 75.6 ms | **7.8 ms** | **9.7x nhanh hơn** |
| C eval_months | 60.9 ms | 53.4 ms | 1.14x |
| E eval_evaluators | 65.4 ms | 61.9 ms | 1.06x |
| B report_facets | 188.2 ms | 174.8 ms | 1.08x |
| F auth_session (server-side) | 0.073 ms | 0.036 ms | — |

Plan sau khi sửa, xác nhận index mới thực sự được dùng:
- D: `Index Scan using idx_ge_cat_evalcoalesce` — đọc **510 dòng** thay vì quét 69.437 dòng
  rồi top-N sort. Sort giờ pre-sorted từ index.
- A: `Bitmap Index Scan on idx_ge_evaluate_date`, estimate **12.581 vs actual 15.384**
  (trước: 282 vs 15.384). Từ lệch 55x xuống lệch 18%.

**B, C, E gần như không đổi — đúng như dự đoán.** Chúng là các query facet quét toàn bảng
không phụ thuộc filter; index không cứu được, phải cắt bằng Tier 1 (1.1 và 1.2).

### Số query auth mỗi request

Đo trên dev server thật, với JWT hợp lệ, 5 request, mỗi request gọi 3 chỗ cần session:

| | dashboard_users scans / 5 request |
|---|---|
| trước (getServerSession x3) | **14** |
| sau (getSession memo) | **5** |

### Cạm bẫy đã gặp khi làm — đọc trước khi đụng lại chỗ này

**React `cache()` KHÔNG dedupe trong Route Handler của Next 14.** Bản sửa đầu tiên dùng
`cache()` từ 'react'. Probe thực tế cho `invocationsThisRequest: 3` — nó chạy đủ 3 lần.
`cache()` chỉ memo hoá trong một React render; Route Handler không phải render. Nếu không
đo thì đã ship một bản "tối ưu" không tối ưu gì cả.

Cơ chế thay thế đã kiểm chứng: WeakMap khoá trên object mà `headers()` trả về. Next cấp cho
mỗi request một object riêng và ổn định trong request đó (đã verify cả hai tính chất).
Xem `lib/session.ts`.

## 3c. EVALUATIONS — đo end-to-end (2026-09-06)

Đây là bề mặt user dùng nhiều nhất nên đo riêng, ở mức **HTTP end-to-end** chứ không phải
từng query. Cùng dev server, cùng máy, median, đã warm-up. Script: `bench/api-bench.sh`.

**Lưu ý đọc số:** đây là dev mode + máy local ở VN (RTT tới Neon us-east-2 ~270 ms).
Số tuyệt đối KHÔNG phải số prod. Cái đáng đọc là **tỉ lệ** và **hình dạng**: dòng
"đổi batch" trả về 826 byte mà mất 4690 ms chứng minh chi phí nằm ở số round-trip
chứ không phải khối lượng dữ liệu.

| Thao tác | Gốc | Sau song song hoá | Sau tách facet | Tổng |
|---|---|---|---|---|
| Evaluate: mở lần đầu (month=auto) | 7530 ms | 3560 ms | — | |
| Evaluate: đổi filter conclusion | 6724 ms | 3466 ms | **3077 ms** | **2.2x** |
| Short List: mở lần đầu | 6801 ms | 3584 ms | **2306 ms** | **2.9x** |
| Short List: đổi final_conclusion | 5159 ms | 2899 ms | **1675 ms** | **3.1x** |
| Short List: đổi batch | 4690 ms | 2467 ms | **1116 ms** | **4.2x** |

`/api/evaluations/facets` tốn 1920 ms nhưng **không còn nằm trên đường đổi batch/sort** —
nó chỉ chạy khi category / evaluator / conclusion / khoảng ngày đổi.

### Đã sửa những gì

**1. Chuỗi 5 `await` nối đuôi nhau.** Sau `Promise.all` chính, route còn chạy tuần tự:
`getConfigValues` → `loadHiddenEvaluatorKeys` → `batchRows` → `app_config` → `presentRows`.
Không cái nào phụ thuộc cái nào; handler chỉ ngồi chờ 4 lần latency vô ích. Gộp vào một
`Promise.all`. `presentRows` trước đây có điều kiện, giờ chạy vô điều kiện — tốn 1 query
trên connection đang rảnh, đổi lấy việc bỏ hẳn 1 round-trip tuần tự, mà điều kiện cũ gần
như luôn đúng. Kết quả vẫn dùng đúng theo điều kiện cũ nên hành vi không đổi.

**2. Tách `/api/evaluations/facets`.** Trước đây "meta" gộp hai thứ có nhịp thay đổi khác
hẳn nhau:
- *list meta* (`total`/`stats`/`applied_month`) — đổi theo mọi filter, phải đi cùng rows.
- *facet meta* (nội dung dropdown) — chỉ đổi theo category/evaluator/conclusion/ngày, và
  `available_batches`/`default_batch` **cố tình bỏ qua** filter batch.

Nên bấm đổi batch — thao tác phổ biến nhất của Short List — không thể làm dropdown đổi,
vậy mà vẫn chạy lại toàn bộ scan toàn bảng cho chúng. Giờ rows nhận `meta=0`, facets có
endpoint riêng với useEffect deps hẹp hơn.

**3. `available_months` chuyển hẳn sang facets.** Nó là nội dung của picker. Rows chỉ cần
nó khi phải giải `month=auto`. Bỏ thêm 1 round-trip + 1 lần quét bảng khỏi mỗi lần đổi filter.

**4. `lib/evaluations-filters.ts`** — hai route dựng filter từ cùng một nguồn. Nếu facets
scope "batch nào tồn tại" khác với list nó mô tả, dropdown sẽ mời batch mà list không hiển
thị được. Một builder duy nhất là thứ chặn drift đó.

### Kiểm chứng tương đương (không phải "chắc là đúng")

- **12/12 tổ hợp filter** (3 category, month=auto, year+month, conclusions, final_conclusions
  gồm cả `(none)`, evaluator, batch, status=pending, record_view): mọi field mà `meta=0` bỏ
  đi đều được `/facets` trả lại **giá trị y hệt**; phần list giữ nguyên từng byte.
- **Mô phỏng đúng chuỗi effect của client**, luồng cũ vs luồng mới: batch mặc định
  (`W1 Sep, 2026`), số dòng cuối (193), `data`, `total`, `stats`, cả 3 dropdown, và
  `applied_month` của `month=auto` — **khớp hết**.
- typecheck sạch, production build compile OK, 13 test hỏng sẵn không tăng thêm.

### Còn lại trong luồng Evaluation (chưa làm)

Mở panel đánh giá 1 game bắn **5 request song song**, trong đó có
`/api/sheets/ytb-uploaded` — **đọc nguyên Google Sheet**. Tức Tier 1.3 không chỉ ảnh hưởng
tab Record mà nằm ngay trên đường nóng của Evaluation. Đây nên là việc tiếp theo.

Payload rows vẫn ~580 KB cho 500 dòng ở Short List (tab Evaluate đã phân trang sẵn bằng
infinite scroll nên không bị). Cắt được nữa thì phải phân trang Short List — là thay đổi
UX, cần hỏi trước.

## 3d. TIER 1.3 — bỏ Google Sheets khỏi đường nóng Evaluation (2026-09-06)

### Phát hiện làm đổi thiết kế

Kế hoạch ban đầu ghi ở 1.3 là "đọc từ bảng `ytb_uploads` thay Sheets". **Sai.** Đo thật:

```
ytb_uploads:  433 dòng | uploaded_at cũ nhất 2026-01-05 | mới nhất 2026-06-08
game_evaluations: 200 game có youtube_uploaded_at SAU 2026-06-08, mới nhất 2026-08-27
```

Bảng đó chỉ có một người ghi: `POST /api/admin/backfill-sheets`, chạy tay, không cron nào
đụng tới. Đọc thẳng nó không phải "hơi cũ" mà là **sai**: mọi video quay trong 3 tháng
gần nhất sẽ báo là chưa có. Nên trước khi đọc được, phải cho nó một người ghi thật.

Ràng buộc thứ hai: panel cần **hai** match (5min + 20min, phân biệt bằng `duration`),
trong khi `game_evaluations` chỉ có một cột `youtube_link`. Nên đọc từ game row cũng
không thay thế được.

### Đã làm

**A — cache sheet trong process** (`lib/ytb-cache.ts`). TTL 60s + single-flight (mở tab
Record bắn nhiều fetch cùng lúc; không có single-flight thì cache lạnh biến thành nhiều
lần gọi Sheets song song). Mọi write trong `app/api/sheets/ytb-uploaded` gọi
`invalidateYtbCache()` trước khi trả lời, nên người sửa vẫn thấy ngay thay đổi của mình.
`reconcile-recorders` cũng đi qua cache này.

**B — mirror sheet → `ytb_uploads`** (`lib/ytb-mirror.ts`, migration 043 APPLIED prod).
Replace-all mỗi lần sync, không upsert: sheet không có khoá ổn định (`file_id` rỗng ở
dòng thêm tay) và xoá dòng theo vị trí, nên diff sẽ để lại rác. Vài trăm dòng thì thay
cả bảng rẻ hơn là làm sai.

- `POST /api/cron/ytb-mirror` — cắm vào n8n 10-15 phút/lần (auth `x-webhook-secret`
  hoặc admin session, cùng idiom với report-rollup).
- `GET /api/ytb-uploads` — đọc mirror, **tự chữa**: nếu `max(synced_at)` quá 15 phút thì
  tự pull sheet rồi mới trả. Nghĩa là cron chỉ để giữ ấm, không phải phụ thuộc — bảng
  không thể mục lại lần nữa như vừa rồi.
- `EvalDetailPanel` chuyển sang `/api/ytb-uploads`. Tab Record **giữ nguyên** đường sheet:
  nó sửa dòng và cần `row_index` để ghi ngược. Ranh giới: sửa → sheet, chỉ đọc → mirror.

### Kết quả đo (dev, cùng máy, cùng cách)

| | trước | sau |
|---|---|---|
| Mở panel đánh giá (mỗi lần) | full Sheets read | **0.60 s** (memo hit) |
| `/api/sheets/ytb-uploaded` lần 2+ | full Sheets read | **0.78 s** (cache hit) |
| Mirror sau sync | 433 dòng, cũ 3 tháng | **734 dòng, synced_at = now** |

Payload panel: **87 KB** (5 field) thay vì cả 9 cột của sheet.

### Một kết quả ngược đời, đáng ghi lại

Mirror **một mình thì CHẬM HƠN** cache sheet: đo được 2.0 s vs 0.78 s. Lý do đơn giản —
cache hit trong process tốn 0, còn đọc DB vẫn tốn 1 round-trip tới us-east-2 (~300 ms).
Suýt nữa đã kết luận "chuyển sang DB là nhanh hơn" mà không đo.

Hai thứ đó **bù nhau chứ không thay nhau**, nên dùng cả hai: memo 60s đặt trước lượt đọc
mirror. Warm thì 0 round-trip; lạnh (cold start, instance Cloud Run mới, Sheets quota) thì
sàn là **1 lượt đọc DB** chứ không phải một lượt gọi Sheets vài giây. Sau khi ghép:
2.0 s → **0.60 s**.

Cũng đã gộp `SELECT max(synced_at)` vào cùng query bằng `max(synced_at) OVER ()` — hỏi
riêng một cái timestamp tốn nguyên 1 round-trip (đo 320 ms), đắt ngang lấy toàn bộ dòng.

### Kiểm chứng

Probe tạm dùng **chính `buildYtMap` thật**, dựng map từ sheet và từ mirror rồi so:

```
sheetRows 734 | mirrorRows 733 | sheetKeys 776 | mirrorKeys 776 | diffCount 0
```

Lệch 1 dòng là dòng không có `game_title` — `buildYtMap` vốn đã bỏ qua nó, và 0 diff
xác nhận điều đó. typecheck sạch, production build có cả 2 route mới, jest giữ nguyên
13 fail có sẵn.

**Một bug đã bắt được khi làm:** query mirror đầu tiên không có `ORDER BY`. `buildYtMap`
phá hoà giữa các dòng cùng thời gian (hoặc thời gian không parse được) bằng cách giữ dòng
gặp trước — tức **thứ tự dòng của sheet là thứ có nghĩa**, không phải trang trí. Postgres
trả thứ tự tuỳ ý sẽ làm cùng một request cho ra video khác nhau giữa các lần.
Đã thêm `ORDER BY row_index NULLS LAST, id`.

### Còn lại

- Cron `/api/cron/ytb-mirror` **chưa cắm vào n8n**. Không cắm thì vẫn đúng, chỉ là cứ 15
  phút có một người phải chờ lượt pull sheet.
- `app/(manager)/youtube/page.tsx` vẫn gọi sheet **2 lần lúc mount** (dòng ~496 và ~1568).
  Cache làm lần thứ hai gần như miễn phí, nhưng gộp lại vẫn sạch hơn.

## 4. Không phải vấn đề (đã kiểm tra, loại trừ)

- **Kích thước note**: trung bình 16 byte/note, tổng 1069 kB toàn bảng. Không phải nguồn nặng.
- **`playtest_tags`**: 550 dòng, index đầy đủ. Window function trong `fetchQueue` không đáng lo ở quy mô này.
- **Middleware**: đọc role từ JWT edge token, không chạm DB. Đúng rồi.
- **`Promise.all`**: report và evaluations đã parallel hoá query sẵn — vấn đề không nằm ở tuần tự hoá.

## 5. Kỳ vọng

| Bước | Tác động ước tính |
|---|---|
| Tier 0 (1–4) | Short List cold 1.3s → ~0.4s; mọi request bớt 2 RTT |
| Tier 1 (5–7) | đổi filter Short List ~700ms → ~150ms; Report ~1.5s → ~200ms |
| Tier 2 (Redis) | Report/facet lặp lại về ~20ms, ổn định qua cold start |
| Tier 3 | bỏ hẳn cliff 425ms cold trên toàn bộ endpoint |
