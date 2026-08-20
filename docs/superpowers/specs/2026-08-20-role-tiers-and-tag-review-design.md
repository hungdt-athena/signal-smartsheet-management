# Ba tier quyền, và review tag ngay trong Evaluate panel

2026-08-20

## Vấn đề

Hai chuyện tách rời nhưng chạm cùng một chỗ:

1. **Phân quyền đã trôi khỏi ý định ban đầu.** Migration 032 khai tử role
   `moderator` bằng cách `UPDATE dashboard_users SET role='admin'`, nên hôm nay
   chỉ còn hai bậc: admin và evaluator. Người làm triage (duyệt tag, chốt Final
   Conclusion, điều phối Team Ops) buộc phải là admin đầy đủ — kể cả khi họ
   không nên đụng tới Users Management.
2. **Admin tag xong vẫn phải tự duyệt chính mình.** `PUT /api/playtest-tags`
   luôn ghi `status='pending'`. VinhTD tag trong modal test game rồi phải mở
   Evaluations > Tagging confirm lại tag của chính mình — một vòng vô nghĩa.
   Và khi đang mở modal của một game, admin không có cách nào duyệt tag của
   evaluator ngay tại đó.

## Ma trận quyền

`Role = 'admin' | 'moderator' | 'evaluator'`.

**Moderator = admin**, trừ ba khoản dưới. Đây là lựa chọn có chủ ý: chia nhỏ
quyền theo từng màn hình đã từng được cân nhắc và bị bỏ vì mọi màn hình review
đều là việc của cùng một người.

| Khoản | admin | moderator | evaluator |
|---|---|---|---|
| Tag trong modal | sync thẳng vào Signal Sense | vào queue pending | vào queue pending |
| Điền Final Conclusion / Final Note | có | **không** | không |
| Users Management: đổi role / xoá user | có | **không** | không |
| Users Management: invite, sửa tên/title | có | có | không |
| Duyệt tag (confirm/reject/sửa/gỡ) | có | có | không |
| Config, Team Ops, Report toàn team, mọi category | có | có | scoped |
| Cron, backfill, import, push-split, sync-roster | có | không | không |

Moderator **được tự confirm tag của chính mình**. Khác biệt với admin vì thế chỉ
còn một cú click — đó là quyết định của chủ sản phẩm, ghi ở đây để người đọc sau
đừng tưởng là thiếu sót.

Invite bị chặn leo thang: moderator chỉ mời được người ở role `evaluator` hoặc
`moderator`. Không thì "không được đổi role" vẫn lách được bằng cách mời một
tài khoản admin mới.

Final Conclusion và Final Note đều là admin-only: cả hai là phát ngôn cuối cùng
về một game, Report đọc cái trước và cái sau giải thích nó.

## Thay đổi tầng auth

`lib/auth-guard.ts`:

- `type Role` thêm `'moderator'`.
- `requireManager()` → `requireRole(['admin', 'moderator'])`.
- Thêm `requireAdmin()` = `requireRole(['admin'])`, tên gọi đúng ý nghĩa cho các
  route admin thuần, thay cho `requireRole(['admin'])` rải rác.

Migration `038_moderator_role.sql`: nới CHECK constraint (đang là
`role IN ('admin','evaluator')` từ migration 002) thành ba giá trị. Không
backfill — không ai tự nhiên thành moderator; admin gán tay.

`middleware.ts`: `isManager = role === 'admin' || role === 'moderator'`. Ba
nhánh đang viết `role !== 'admin'` (category arcade/simulation, tab
short_list/record_video) đổi sang `!isManager`. Riêng `/admin` và `/config` vẫn
cho manager tier vào — phân quyền bên trong `/admin` là chuyện của route, không
phải của middleware.

`app/(manager)/layout.tsx`: mọi `roles: ['admin']` và `roles: ['admin','evaluator']`
trong nav thêm `'moderator'`.

Các route đang dùng `requireRole(['admin'])` cho việc *nghiệp vụ review* đổi sang
`requireManager()`: `evaluations/record-bucket`, `assign-records`,
`add-to-record`, `confirm-records`, `reconcile-recorders`, `operations/history`,
`operations/realtime`. Giữ nguyên admin-only: `cron/*`, `admin/backfill-sheets`,
`admin/import-evaluations`, `admin/import-screenshots`, `admin/push-split`,
`admin/sync-evaluators`, `admin/sync-roster`.

`app/api/admin/users/route.ts`: `VALID_ROLES` thêm `'moderator'`; GET và PUT
(tên/title) mở cho manager tier; PUT có `role` và DELETE gọi `requireAdmin()`;
POST cho manager tier nhưng moderator bị chặn nếu `role === 'admin'`.

`app/api/evaluations/route.ts`: PUT hiện có một cờ `isManager` gác cả
`final_note`, `final_conclusion` và `batch`. Tách thành `isManager` (nay gồm
moderator, gác `batch`) và `isAdmin` (gác `final_note` + `final_conclusion`).

Client: `EvalDetailPanel` đang dùng `canEditFinalNote` cho hai việc khác nhau —
sửa Final Note, *và* mở khoá Game Alike cùng Trends tags trên game mình không
sở hữu (`canEditGameAlike = canEditEval || canEditFinalNote`, và
`TrendTagsField disabled={!canEditGameAlike}`). Đổi thẳng cờ đó thành admin-only
sẽ lấy mất quyền tag của moderator, nên tách đôi:

- `canEditManagerFields = !readOnly && isManager` — thay chân `canEditFinalNote`
  trong `canEditGameAlike`, giữ Game Alike và Trends tags mở cho moderator.
- `canEditFinalNote = !readOnly && isAdmin`, và
  `canEditFinalConc = canEditFinalNote && !finalLocked` giữ nguyên công thức —
  nay tự động là admin-only vì vế đầu đã đổi.
- `canEdit` (cờ quyết định form có gì để lưu) đọc `canEditManagerFields` thay vì
  `canEditFinalNote`, không thì moderator sửa Game Alike xong không bấm Save được.
- Placeholder "Final note (managers only)" đổi thành "admin only" cho khớp.

`TaggingTab.isAdmin` đổi thành `isManager`. UI chỉ quyết định cái gì đáng vẽ,
quyền vẫn do route giữ — nguyên tắc đã ghi sẵn trong `TaggingTab.tsx:107`.

## Admin tag thì đi thẳng

`PUT /api/playtest-tags` khi người lưu là admin: các tag trong payload được sync
vào `custom_field_values` ngay trong cùng transaction, row `playtest_tags` ghi
`status='synced'`, `confirmed_by` = chính admin đó, `confirmed_at = now()`. Có
audit trail đầy đủ, chỉ là không qua hàng đợi. Với moderator và evaluator, PUT
giữ nguyên hành vi cũ.

Conflict (Signal Sense đã có value đó với sub-value khác): **admin thắng**,
sub-value của admin ghi đè, `sync_result='overwritten'`, và ghi `cfv_change_log`
y như confirm route đang làm. Đây là ngoại lệ duy nhất so với đường confirm thủ
công, nơi overwrite phải được tick.

Auto-sync chỉ chạm tag do **chính admin đó** đề xuất (`tagged_by = email`).
Modal hiển thị cả tập pending của game, nên nếu không giới hạn, một admin bấm
Save form là duyệt luôn mọi đề xuất evaluator đang chờ — phê duyệt thứ họ chưa
hề xem. Tag của người khác vẫn nằm chờ và được duyệt có chủ đích, ở queue hoặc ở
khu review trong panel.

Ngoại lệ giữ nguyên: value không còn là định nghĩa Trends active thì bị
`rejected`/`inactive`, không auto hồi sinh definition Signal Sense đã retire.

Ba vai trên một dòng lịch sử, tách bạch: `tagged_by` đề xuất, `edited_by`
(migration 039) sửa, `confirmed_by` chốt. Mượn `confirmed_by` để ghi người sửa
thì tên đó biến mất ngay khi ai đó bấm Confirm. Cả hai đường sửa — PATCH ở khu
review và upsert ở hộp thoại Manage Trends Tags — cùng ghi `edited_by` và cùng
snapshot `original_*` một lần, để một hành động không để lại hai dấu vết khác
nhau. Mọi nhánh đều canh trên "sub-value thật sự đổi", vì PUT bắn mỗi lần lưu
form kể cả khi không ai mở hộp thoại tag.

Bỏ một chip khỏi danh sách là **reject**, không phải xoá: row bị xoá mang theo cả
câu chuyện, evaluator chỉ thấy tag biến mất mà không biết ai bỏ và lúc nào.

Gỡ một chip đã synced trong modal **không** xoá khỏi Signal Sense. Xoá vẫn phải
qua `POST /remove`, route duy nhất được phép xoá dữ liệu của app khác và chỉ xoá
được row do `playtest_sync` tạo.

### Tách `lib/playtest-tags-sync.ts`

Logic sync hiện nằm trong thân `confirm/route.ts`: classify → resolve → insert
hoặc update có guard → đọc lại khi write trượt → ghi log. Chép nó sang PUT sẽ đẻ
ra bản sao thứ hai của luật, và bản sao sẽ trôi.

Tách ra một hàm `syncTags(tx, { gameId, pending, actor, overwriteIds, notes })`
trả về `{ results, skipped, log }`. `confirm/route.ts` và PUT cùng gọi. Chữ ký
này giữ được cả hai chế độ: confirm truyền tập id được tick, PUT của admin
truyền toàn bộ id vừa ghi kèm `overwriteIds = tất cả`.

Hàm nhận `tx` chứ không tự mở transaction: PUT cần DELETE + INSERT pending rồi
sync trong cùng một transaction, không thì một lỗi giữa chừng để lại tag đã ghi
vào Signal Sense mà row nguồn thì không.

## Review tag trong Evaluate panel

`TrendTagsField` hôm nay có ba khối: "Waiting for review", "Already in Signal
Sense", và nút mở dialog. Với manager, khối thứ nhất đổi thành khu review.

Mỗi tag pending là một dòng: tên người đề xuất, combobox trend + sub-value (gọi
`PATCH /api/playtest-tags/[id]`), badge conflict kèm sub-value hiện tại của
Signal Sense và ô tick overwrite, ô note, nút **Confirm** và **Reject**.

Confirm/Reject gọi thẳng `POST /confirm` và `POST /reject` với `ids` đúng một
tag, ngay lúc bấm — không gộp vào save của form. Hai lý do: tab Tagging đã hành
xử như vậy, và một tag không nên phải chờ người dùng bấm Save mới được duyệt.
Sau mỗi hành động, panel gọi lại `loadTrendTags(gameId)` để pending và "Already
in Signal Sense" khớp với thực tế.

Admin tự tag thì không thấy khu này: tag của họ đã synced, rơi xuống khối
"Already in Signal Sense".

Tag của chính người đang xem vẫn hiện nút Confirm — moderator được tự duyệt, và
evaluator thì không thấy nút nào vì `isManager` sai.

## Kiểm thử

Mở rộng bộ test sẵn có trong `__tests__/api/playtest-tags*.test.ts`:

- PUT bởi admin → row `synced`, `custom_field_values` có tag, conflict bị ghi đè.
- PUT bởi moderator và bởi evaluator → row vẫn `pending`, Signal Sense không đổi.
- Moderator gọi confirm/reject/PATCH → 200; evaluator → 403.
- Moderator confirm tag do chính mình đề xuất → 200.
- `requireManager()` nhận moderator; `requireAdmin()` từ chối moderator.
- Evaluations PUT: moderator gửi `final_conclusion` hoặc `final_note` → cả hai
  không đổi; moderator gửi `game_alike` → đổi.
- Users PUT có `role` bởi moderator → 403; POST invite role `admin` bởi
  moderator → 403; POST invite role `evaluator` → 200.

## Ngoài phạm vi

- Đổi chữ "moderator" trong comment và label của Report/Final Conclusion. Nay
  role đã tồn tại lại nên những chỗ đó đọc đúng nghĩa, không phải sửa.
- Đổi `title` (Admin/Fulltime/Freelancer/Recorder). Đó là phân loại công việc,
  độc lập với role, và không đổi.
