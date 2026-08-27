# Assign một trang: cột Genre, Sub-genre, History matrix

Ngày: 2026-08-27

## Vấn đề

Tab Assign hiện chia làm 3 tab genre (Puzzle / Arcade / Simulation). Mỗi tab
load riêng `evaluator_roster WHERE category_group = ?`, nên roster của một
người trải ra 3 chỗ không nhìn thấy nhau cùng lúc.

Hệ quả nặng nhất không phải là số lần click, mà là **weight trở nên vô nghĩa
khi một người có nhiều genre**. `assignGames()` chạy độc lập từng genre: lấy
pool game chưa assign của genre đó, cộng weight những người `Available = Yes`
trong genre đó, chia theo tỉ lệ. Không pool nào biết pool kia tồn tại. NhiLV
weight 100 ở Puzzle ăn `100/600` pool puzzle, rồi weight 100 ở Arcade lại ăn
`100/(tổng weight arcade)` pool arcade. Gánh cộng dồn, mà UI 3 tab không có
chỗ nào nói ra điều đó.

Gộp về một trang là để cái cộng dồn đó hiện ra được.

## Từ vựng

Chỗ này đang lệch giữa hai tab, phải chốt trước khi code:

| Khái niệm | DB | Assign gọi | Config đang gọi |
|---|---|---|---|
| puzzle / arcade / simulation | `category_group` | **Genre** | bucket |
| puzzle, word, trivia, music, casual / arcade, adventure, action / simulation, strategy | `game_category`, list từ `/api/config/categories` | **Sub-genre** | genre |

Hai tab gọi ngược nhau hoàn toàn. Spec này lấy cách gọi của Assign làm chuẩn
và **đổi chữ trên UI Config** từ `GENRE → BUCKET` thành `GENRE → SUB-GENRE`,
`Add genre to puzzle…` thành `Add sub-genre to puzzle…`. Chỉ đổi label; cột
`category_group` và mọi payload API không đụng tới.

## Quyết định đã chốt

| Câu hỏi | Chốt | Lý do |
|---|---|---|
| Row model | 1 dòng = 1 người × 1 genre | Khớp đúng PK `(list_type, category_group, name)` hiện có, nên không cần migration. Một dòng là một đơn vị chia game, không có gì ẩn. |
| Weight nghĩa là gì | Giữ nguyên: tỉ lệ trong pool của riêng genre đó | Không đổi thuật toán, không migration. Cộng dồn 2 genre đọc ở matrix History. |
| Available | Thuộc về người | "Hôm nay có đi làm không" là trạng thái của người. Nghỉ mà phải bấm No 2-3 lần thì sẽ sót, và dòng bị sót vẫn được chia game. |
| Platform | Thuộc về từng dòng | Cho phép "arcade chỉ test iOS, puzzle test cả hai". |
| Cột Load | Không làm | Matrix History ngay bên dưới trả lời đúng câu hỏi đó, chi tiết theo ngày thay vì một số trung bình. |
| Panel History | Xuống dưới roster, full width, dạng matrix ngày × người | Thấy được ô trống, thứ mà timeline year/month/day cũ ở cột 40% không cho thấy. |

## Layout roster

```
Assign
[ All ] [ Puzzle ] [ Arcade ] [ Simulation ]        ← filter chip, chỉ lọc view
ROSTER                                                        ↻ Refresh

INITIAL EVALUATOR
┌───────────┬────────────┬───────┬──────────┬───────────┬────────┬────────┐
│ EVALUATOR │ GENRE      │ AVAIL │ PLATFORM │ SUB-GENRE │ WEIGHT │        │
├───────────┼────────────┼───────┼──────────┼───────────┼────────┼────────┤
│ NhiLV     │ Puzzle     │       │  all  ▾  │  All   ▾  │ 100 ▾  │ Remove │
│           │ Arcade     │ Yes ▾ │  ios  ▾  │ action  ▾ │  50 ▾  │ Remove │
│           │ + genre    │       │          │           │        │        │
├───────────┼────────────┼───────┼──────────┼───────────┼────────┼────────┤
│ MyTL      │ Puzzle     │ Yes ▾ │  all  ▾  │  All   ▾  │ 100 ▾  │ Remove │
│           │ + genre    │       │          │           │        │        │
└───────────┴────────────┴───────┴──────────┴───────────┴────────┴────────┘
+ Add evaluator
```

Bảng **Final Evaluator** cấu trúc y hệt, chỉ khác `list_type`. Evaluator vẫn
chỉ thấy dòng của chính mình ở Initial và không thấy Final.

**Nhóm theo người.** Sort `name ASC`, trong mỗi người genre theo thứ tự cố
định puzzle → arcade → simulation (`array_position` trên `BUCKETS`). Cột
`sort_order` không còn dùng cho thứ tự hiển thị.

**Cột Evaluator và Available gộp cell (rowspan) theo người.** Ô Available vật
lý chỉ có một, nên UI không thể tạo ra trạng thái lệch giữa các genre.

**Genre là identity của dòng, không sửa inline.** Đổi genre của một dòng nghĩa
là dời `category_group`, đụng PK và có thể đâm vào dòng đã tồn tại. Thay vào
đó: dòng `+ genre` cuối mỗi nhóm người, dropdown chỉ liệt kê genre người đó
chưa có; `Remove` xoá đúng một dòng; remove dòng cuối cùng của một người là
người đó rời roster.

**`+ Add evaluator`** giữ autocomplete `dashboard_users` và cờ `provision` như
hiện tại, thêm multi-select genre để tạo nhiều dòng một lượt.

**Filter chip thay tabs.** 9 người × 3 genre là 27 dòng, phải có đường lùi về
"chỉ xem Puzzle". Chip chỉ lọc view: không đổi dữ liệu, không đổi URL, không
quyết định cái gì được load — khác hẳn tab cũ.

**Sub-genre picker** đọc `catData[row.category_group]` thay vì `catData[bucket]`,
nên dòng Arcade chỉ thấy sub-genre của Arcade.

## Matrix History

```
[All][Puzzle][Arcade][Sim]                          ◀ 14 ngày ▶

            18  19  20  21  22  25  26  27   TỔNG
┌─────────┬─────────────────────────────────┬──────┐
│ NhiLV   │  4   4   ·   4   6   4   4   4  │  30  │
│ MyTL    │  4   4   ·   4   6   4   4   4  │  30  │
│ MiTT    │  2   2   ·   2   3   2▲  2   2  │  15  │
│ HuyDD   │  4   ·   ·   4   6   4   4   4  │  26  │
│ KietCD  │  ·   ·   ·   ·   ·   ·   ·   ·  │   0  │
├─────────┼─────────────────────────────────┼──────┤
│ Tổng    │ 14  10   0  14  21  14  14  14  │ 101  │
└─────────┴─────────────────────────────────┴──────┘
· = không nhận gì    ▲ = ngày đó có reassign/handover
```

Ba chỗ dễ làm matrix nói dối, và cách xử lý:

**Ô hiện số assign, không cộng reassign vào.** `AssignHistory` hiện tại đã có
`ActionTotals` với comment rõ: game bị reassign đã được đếm một lần ở lần
assign gốc, cộng lại là đếm hai. Nên số trong ô chỉ là `action='assign'`; có
reassign hoặc handover thì gắn ▲ và popover mới xoè ra đủ ba loại. Cột TỔNG và
dòng Tổng cũng chỉ cộng assign, kèm hậu tố nhỏ `+2R` khi ngày đó có reassign.

**Cột là ngày liên tục theo lịch, không phải chỉ ngày có data.** Giá trị của
matrix nằm ở mấy dấu `·`. 20/8 cả team trống là thông tin; nếu chỉ vẽ ngày có
run thì ngày đó biến mất.

**Dòng là hợp của roster hiện tại và người xuất hiện trong cửa sổ.** Người còn
trong roster mà 14 ngày không nhận gì phải ra một dòng toàn `·` (KietCD ở mock
trên). Người đã rời roster nhưng còn history cũ vẫn hiện, tên làm nhạt đi.

Còn lại: `◀ 14 ngày ▶` lùi theo cửa sổ, thay infinite scroll cũ. Đậm nhạt ô
chia 4 bậc theo quantile **trong cửa sổ đang xem**, không dùng thang tuyệt đối,
vì pool mỗi ngày lệch nhau. Header cột cuối tuần làm nhạt. Filter chip genre
dùng chung với roster. Bấm một ô mở popover: giờ chạy, action, genre, số game,
`from_evaluator`, `created_by`.

## DB

**Không có migration.** Row model người × genre đã đúng PK
`(list_type, category_group, name)`. "Available theo người" là ngữ nghĩa của
tầng ghi, không phải tầng lưu — cột `today_available` vẫn nằm trên từng dòng,
chỉ là mọi dòng cùng tên luôn được ghi cùng lúc.

Đây là lý do chọn row model này ở trên: nó mua được toàn bộ tính năng mà không
đụng schema prod.

## API

`GET /api/assign-setup`
- Bỏ tham số `group`. Trả cả 3 genre một lượt, mỗi row thêm `category_group`.
- `ORDER BY name ASC, array_position(ARRAY['puzzle','arcade','simulation'], category_group)`.
- Scope evaluator giữ nguyên: lọc về tên họ, `final = []`.

`PATCH /api/assign-setup`
- `field='today_available'`: `UPDATE ... WHERE list_type = ? AND name = ?` —
  mọi genre của người đó, một câu, không loop. Đây là chỗ **duy nhất** ngữ
  nghĩa "theo người" hiện diện, và nó nằm ở server nên UI không thể làm lệch.
  Body cần thêm `list_type` và `name`; `id` vẫn nhận để định vị dòng gốc.
- `game_platform`, `game_category`, `weight`: `WHERE id = ?` như cũ.

`POST /api/assign-setup`
- Nhận `category_groups: Bucket[]` thay cho `category_group` đơn.
- Insert N dòng trong một câu `VALUES (...), (...)`, giữ `ON CONFLICT DO NOTHING`.
- Kế thừa `today_available` từ dòng đã có của người đó nếu có, mặc định `true`.

`GET /api/admin/assignment-history`
- Bỏ lọc bucket. Nhận `from` / `to` (cửa sổ ngày, mặc định 14 ngày gần nhất),
  trả phẳng kèm `category_group`. Việc pivot thành matrix làm ở client.

`POST /api/cron/assign-evaluators` **không đổi**. Vẫn nhận `category` đơn và
n8n vẫn gọi 3 lần. Thuật toán chia không đổi một dòng nào.

## Component

- `components/AssignSetup.tsx` — bỏ prop `bucket`, thêm `genreFilter`. Thêm
  rowspan grouping, `+ genre`, multi-select genre trong `AddEvalRow`.
- `components/AssignHistory.tsx` — viết lại. Bỏ `groupRows` (year → month →
  day) và các type `YearGroup` / `MonthGroup` / `DayGroup`, thay bằng pivot
  `(name, date) → ActionTotals`. Hàm pivot để thuần, export được để test.
- `app/(manager)/team-ops/page.tsx` — gỡ segmented switcher và grid 60/40, xếp
  dọc roster → history. `Bucket` vẫn dùng cho filter chip.
- `components/config/…` — đổi label GENRE → SUB-GENRE.

## Test

- `__tests__/api/assign-setup.test.ts` (đã có): sửa GET cho 3 genre; thêm case
  PATCH available lan sang mọi dòng cùng tên và **không** lan sang người khác
  cùng genre; thêm case POST multi-genre tạo đủ N dòng và idempotent khi một
  genre đã tồn tại.
- Mới, cho hàm pivot thuần — ba case là đúng ba chỗ dễ sai ở trên:
  ngày trống vẫn ra cột; reassign không bị cộng vào số assign; người trong
  roster mà 0 history vẫn ra dòng.
- `__tests__/lib/assign-evaluators.test.ts` không đụng tới, vì thuật toán chia
  không đổi.

## Phase 0: bản giả lập

Trước khi sửa component thật, dựng `/team-ops/assign-preview` — một page
độc lập, admin-only, không có trong sidebar, dữ liệu hardcode trong file
fixture, **không gọi API, không ghi DB**. Mục đích duy nhất là xem layout
roster và matrix bằng mắt để chốt trước khi đụng vào đường đi thật.

Fixture phải chứa đủ mấy ca biên đã nêu: người 2 genre, người 3 genre, người
1 genre, người `Available = No`, người platform-specific, người trong roster
mà 0 history, ngày cả team trống, ngày có reassign.

Page này **xoá đi** khi Phase 1 xong, cùng file fixture. Nó không phải feature
flag, không phải bản song song để bảo trì.

## Ngoài phạm vi

- Không đổi thuật toán chia game.
- Không thêm capacity / quota / trần số game mỗi ngày.
- Không thêm ngưỡng cảnh báo quá tải.
- Không đổi lịch cron hay cách n8n gọi.
- Không đụng `sort_order` (để nguyên, chỉ thôi dùng cho hiển thị).

## Rủi ro

**Ghi Available theo tên trong khi PK có `category_group`.** Nếu một ngày nào
đó hai người trùng tên trong cùng `list_type`, một cú PATCH sẽ chạm cả hai.
Hiện `name` là khoá nghiệp vụ khắp `evaluator_roster`, `game_evaluations`,
`assignment_history` nên rủi ro này đã tồn tại từ trước và không do spec này
tạo ra; ghi lại ở đây để không ai nghĩ nó đã được xử lý.

**Matrix 14 cột trên mobile.** Bảng cuộn ngang trong container riêng, cột tên
sticky. Không làm layout thay thế cho mobile.
