# Config rework — bỏ drag & drop + People visibility

Mockup đã duyệt: `docs/mockups/config-rework.html`

## Vấn đề

1. **Drag & drop nặng và khó dùng.** `components/DnDColumns.tsx` dựng 2 cột
   Used / Archived, kéo card qua lại để bật/tắt và kéo trong cột để đổi thứ tự.
   Nó chiếm nửa màn hình cho cột Archived thường trống, không dùng được trên
   mobile, và không có bàn phím thay thế.

2. **Dropdown evaluator hiện mọi cái tên từng xuất hiện.**
   `app/api/evaluations/route.ts` trả `available_evaluators` bằng
   `SELECT DISTINCT initial_evaluator FROM game_evaluations`, nên danh sách lôi
   cả tài khoản hệ thống `Shortcut` lẫn người đã nghỉ vào mọi filter. Không có
   chỗ nào để loại ai ra.

## Phạm vi

**Trong phạm vi**

- Thay `DnDColumns` bằng danh sách hàng gọn, không kéo thả.
- Mục **People in filters** mới trong Config với 2 cờ mỗi người:
  - `Filter` — có hiện trong dropdown evaluator không.
  - `Report` — có bị tính điểm trong Report không.
- Đổi ngưỡng "không hoạt động" thành **7 ngày** (mockup ban đầu là 90).

- **Deactivate thay cho Remove** ở Users Management: chặn đăng nhập, biến khỏi
  mọi dropdown và khỏi bảng People, nhưng giữ nguyên dòng và lịch sử.
- **Rà soát evaluator không có user**: tự tạo tài khoản ở trạng thái inactive.
- **Label hệ thống** (`Shortcut`) không phải người: không tạo account, không nằm
  trong bảng People, không bao giờ hiện ở dropdown.

**Ngoài phạm vi**

- Roster chia game (`evaluator_roster.today_available`) — Team Ops đã quản, Config
  không đụng vào. Cố tình không có cột `Assign`.
- Tab Config trong Report giữ nguyên; nó và mục People sửa chung một chỗ dữ liệu
  (`report_config.excluded`) nên không thể lệch nhau.

## Hai mức ẩn người

| | Ở đâu | Nghĩa là gì |
|---|---|---|
| Tắt cờ `Filter` | Config › People | Vẫn là user, vẫn đăng nhập được, chỉ không hiện trong dropdown |
| Deactivate | Users Management | Không đăng nhập được, biến khỏi cả bảng People lẫn mọi dropdown |

Muốn bỏ hẳn một người ra khỏi bảng People (ví dụ QuangNM) thì deactivate,
không phải tắt cờ.

`SYSTEM_LABEL_KEYS = ['shortcut']` là mức thứ ba, cứng trong code: không có ai
đứng sau cái tên đó nên chẳng có gì để quản. Nó hẹp hơn `SYSTEM_EVALUATOR_KEYS`
(`shortcut` + `vinhtd`) — VinhTD bị loại khỏi thống kê per-evaluator nhưng vẫn là
user thật có login.

Users Management tách hẳn hai bảng: **Users** (đang hoạt động) và **Inactive**,
chứ không trộn dòng mờ vào cùng một bảng.

## Dữ liệu

### `dashboard_users.active` — migration 041

`BOOLEAN NOT NULL DEFAULT TRUE`, kèm partial index trên `lower(name) WHERE active`.
Nhánh signIn trả `/login?error=inactive`; `session()` và `jwt()` không gán role cho
người inactive nên phiên đang mở cũng mất quyền ngay ở request kế tiếp, không phải
đợi JWT hết hạn.

`DELETE /api/admin/users` đã gỡ. Xóa một user là xóa bằng chứng duy nhất rằng cái
tên đó thuộc về người thật, trong khi mọi game họ đánh giá vẫn giữ tên — roster và
lịch sử lệch nhau vĩnh viễn.

### `people_config` — key mới trong `app_config` (không cần migration)

```jsonc
{ "hiddenInFilters": ["shortcut", "thudt"] }   // key viết thường
```

Mặc định rỗng = mọi người đều hiện. Parse khoan dung như `report-config.ts`:
blob hỏng thì về mặc định, không bao giờ ném lỗi lên filter.

### Cờ `Report` = `report_config.excluded`

Không tạo store thứ hai. Tick `Report` = bỏ tên khỏi
`report_config.excluded`, bỏ tick = thêm vào. Cùng một mảng mà tab Config của
Report đang sửa, nên `updated_at` của `app_config` vẫn invalidate cache report
đúng như cũ.

### Danh sách người

`evaluator_roster` (list_type = 'initial') UNION distinct evaluator trong
`game_evaluations` — để người đã rời roster nhưng còn game cũ vẫn chỉnh được.
Kèm theo mỗi người:

| Trường | Nguồn |
|---|---|
| `title` | `dashboard_users.title` (Admin / Fulltime / Freelancer / Recorder), `System` cho tài khoản trong `SYSTEM_EVALUATOR_KEYS` |
| `lastEval` | `MAX(evaluation_date)` trong `game_evaluations` |
| `recent` | số eval trong **7 ngày** gần nhất |

`recent = 0` → gợi ý "N người không có evaluation nào trong 7 ngày" kèm nút
ẩn hàng loạt khỏi filter. Chỉ là gợi ý, không tự động làm gì.

## Chỗ đọc cờ `hiddenInFilters`

| File | Đổi gì |
|---|---|
| `app/api/evaluations/route.ts` | `available_evaluators` lọc bỏ tên bị ẩn |
| `app/api/weekly-feedback/batches/route.ts` | `evaluators` lọc bỏ tên bị ẩn |

`loadHiddenEvaluatorKeys()` = `people_config.hiddenInFilters` ∪ `lower(name)` của
mọi user `active = false`.

Ẩn hẳn, không gom xuống nhóm "không còn hoạt động" — dropdown ngắn là mục đích
chính. Tắt cờ **không** xoá dữ liệu: game cũ vẫn giữ nguyên tên evaluator, và
nếu người dùng đang chọn sẵn một tên bị ẩn thì filter đó vẫn chạy.

## UI

### `components/OptionRows.tsx` (thay `DnDColumns`)

Giữ nguyên chữ ký props (`items / loading / onToggle / onDelete / onReorder? /
onRename?`) nên `config/page.tsx` gần như không phải sửa. Mỗi hàng:

```
[▲▼]  Tên (click để sửa)      1.204 game     [công tắc]  [✕]
```

- `▲▼` chỉ hiện khi có `onReorder` (genre không cần thứ tự).
- Tắt = gạch ngang, xám, vẫn ở nguyên vị trí — không nhảy sang cột khác.
- ✕ = xoá, đẩy xuống dòng thu gọn "Đã lưu kho (n)" mở ra là chip + Khôi phục.
- Cột lượt dùng lấy từ `COUNT(*) GROUP BY initial_conclusion / final_conclusion`
  trong `game_evaluations`, để biết tắt cái nào thì đụng bao nhiêu game.
  Genre không có cột này (đếm genre phải quét jsonb, không đáng).

### Mục People

Bảng chật, một hàng một người: tên + chip title + ngày eval gần nhất, số eval 7
ngày, rồi 2 checkbox. Cạnh bảng là preview dropdown "All evaluators" cập nhật
ngay khi tick — không phải mở tab khác để kiểm tra. Trên màn hẹp preview xuống
dưới bảng và cột `Report` + `Eval 7d` ẩn đi.

## API

```
GET   /api/config/people              → { people: [...], staleDays, noAccount }
PATCH /api/config/people              → { key | keys, inFilters?, inReport? }   (manager)
PUT   /api/admin/users                → { id, active }                          (admin)
GET   /api/admin/users/audit-evaluators → { orphans: [...] }   xem trước, không ghi gì
POST  /api/admin/users/audit-evaluators → { created, skipped } tạo tài khoản inactive
```

Bảng People bỏ hẳn user inactive; người có eval nhưng chưa có tài khoản thì vẫn
hiện kèm chip `no account`, vì ẩn luôn thì không còn chỗ nào để nhận ra.

Rà soát khớp theo `lower(name)`, không theo email — email của user cũ không bắt
buộc theo dạng `name@athena.studio`. Tài khoản tạo mới dùng địa chỉ tổng hợp
`<name>@athena.studio` giống `sync-evaluators`, và vì inactive nên nó không bao giờ
là một lối đăng nhập thật.

`PATCH` ghi `people_config.hiddenInFilters` và/hoặc `report_config.excluded`
tuỳ cờ nào được gửi, rồi trả về danh sách đã cập nhật.
