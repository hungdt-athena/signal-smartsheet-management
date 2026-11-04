# File codes for demo and record videos — design

Status: DRAFT chờ user đọc và duyệt (2026-11-05). Builder check đã xong, mọi câu hỏi mở đã được trả lời.

## Why

Hôm nay n8n khớp video với game bằng **tên file = tên game** (demo) hoặc `Tên_Người_Nmins` do recorder gõ tay (record). Hậu quả đã đo:

- Tên trùng khác game: 2.636/87.711 tên; 108 link demo đang gắn video cho game khác `bundle_id`.
- Recorder gõ sai tên: 27/389 game kẹt Recording (bỏ phụ đề, typo, sai số phút). Phải vá bằng fuzzy match (`lib/ytb-match.ts`) và vẫn có ca khớp nhầm (Bee Flow!).
- Người quay phải gõ tên game dài, tên người, số phút.

Ý tưởng: mỗi video có một **mã 6 ký tự**. Người quay chỉ đặt tên file bằng mã. n8n tra mã ra game, đổi tên file thành tên đúng rồi chạy tiếp như cũ.

## Goals

- Người quay chỉ cần copy mã từ app, đặt tên file `<MÃ>.mp4`.
- Khớp video ↔ game theo mã, không theo tên. Hết tên trùng, hết gõ sai.
- n8n đổi tên file thành tên chuẩn, nên mọi thứ phía sau (sheet, YouTube, `ytb_uploads`, Record tab) không phải đổi.
- File sai mã, mã không tồn tại, hoặc chưa đến lúc: giữ nguyên file và báo, không im lặng.

## Non-goals

- Không dọn 108 link demo cũ bị sai (chưa ai yêu cầu).
- Không đụng luồng Smartsheet (đã retire).
- Chưa bỏ khớp theo tên / fuzzy match ngay: giữ làm dự phòng cho file cũ và file người quay vẫn đặt tên tay. Bỏ sau, là việc riêng.
- Không thêm mã vào link Drive, tên YouTube hay UI Report.

## Anti-goals

- Một mã chạy sai game (mã trùng, tra nhầm bảng) là tệ hơn việc không có mã.
- Người quay phải làm thêm bước (gõ thêm gì ngoài mã) thì thất bại.

## Quyết định của user

1. **Hai mã riêng**: mã demo cho evaluator, mã record cho recorder. Demo và record dùng **hai folder Drive riêng**, hai workflow n8n riêng.
2. **Mã demo sinh khi Initial conclusion của game được đặt = `List_Idea`.**
3. **Mã record sinh khi manager Confirm assign record.**
4. Người quay đặt tên file trong Drive theo mã; n8n khớp được thì tự đổi tên file theo tên game và (record) upload YouTube.

## Quyết định của tôi (chưa được user duyệt, đánh dấu để xem)

- **Lưu ở `game_info`**, 2 cột `demo_code`, `record_code`, mỗi cột unique index riêng (partial, `WHERE ... IS NOT NULL`). Lý do: 495 game đang có 2 dòng `game_evaluations` (cross-genre duplicate); gắn mã vào `game_id` thì không nhân đôi. iOS và Android là 2 `game_id` nên có 2 mã.
- Mã **không bao giờ đổi** sau khi sinh: reset về draft, đổi recorder, đổi bucket 5↔20, bỏ khỏi Record rồi add lại đều giữ mã cũ. Lý do: người quay có thể đã copy mã.
- Định dạng: 6 ký tự, bảng chữ `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (bỏ `0 O 1 I L`), gồm ít nhất 2 chữ số (2-9) và ít nhất 2 chữ cái (để tên game thật chỉ toàn chữ như "Racket" không bao giờ giống mã), sinh bằng CSPRNG, retry khi đụng unique. Khớp không phân biệt hoa thường.
- Regex nhận file ở n8n: tên file (bỏ đuôi, bỏ ` (1)` kiểu trình duyệt) khớp `^[A-Za-z2-9]{6}$` sau chuẩn hoá và có ít nhất 2 chữ số, 2 chữ cái. Chỉ khớp **đúng 6 ký tự cả tên** để file tên game thật (vd "Puzzle") không bị tưởng là mã.
- Mã demo cũng sinh cho game List_Idea **đã có sẵn** khi chạy lần đầu? Không backfill hàng loạt; chỉ sinh lười (lần đầu game List_Idea hiện ở nơi cần mã, hoặc khi lưu List_Idea). Game List_Idea đã có `drive_link` thì không cần mã.

## Hành vi

### Mã demo
- **Sinh:** trong PATCH `app/api/evaluations/[gameId]/route.ts` khi `initial_conclusion` chuyển thành `List_Idea` và `game_info.demo_code` còn NULL (cùng transaction). Ngoài ra endpoint lười `ensure-demo-code` cho game List_Idea cũ đang thiếu link.
- **Hiện:** chip mã + nút Copy ở chỗ nhập demo link trong `EvalDetailPanel`, và trong popup `MissingDemoPrompt`. Chỉ hiện với game List_Idea chưa có `drive_link`.
- **n8n (`drive-video-link-sync`, folder `[Signal] Video`):** thêm nhánh: file có tên là mã → `UPDATE game_info/game_evaluations drive_link` cho game có `demo_code` đó, đổi tên file thành `<title>` (làm sạch ký tự cấm; trùng tên trong folder thì thêm hậu tố `_<game_id>`). Nhánh khớp theo tên hiện có giữ nguyên cho file không phải mã.
- **Ghi vào đâu:** `drive_link` nằm ở `game_evaluations`, nên n8n cập nhật **mọi** dòng `game_evaluations` có `game_id` của game đó (cross-genre có 2 dòng thì cả 2). Mã chỉ để tra `game_id`. (Tôi quyết.)
- **Không bao giờ ghi đè link có sẵn (user chọn A, 2026-11-05):** giữ đúng guard hiện tại `WHERE COALESCE(drive_link,'')=''`. Game đã có `drive_link`, hoặc không còn List_Idea: mã vẫn tra ra game, nhưng n8n không ghi; file giữ nguyên tên mã trong folder, ghi `flow_log` (status=`link_exists`) và báo Chat.
- **Quay lại video cho cùng mã:** manager/evaluator xoá `drive_link` cũ trước, lần poll sau file được xử lý.

### Mã record
- **Sinh:** trong `app/api/evaluations/confirm-records/route.ts`, cho từng game vừa Confirm mà `game_info.record_code` còn NULL.
- **Hiện:** cột Code + Copy trong Record tab, chỉ sau khi Confirm (dòng draft chưa có mã). Có trong mọi bucket (5'/20').
- **n8n (workflow Append Sheet / Upload YouTube, folder record riêng):** file có tên là mã → tra `record_code` → lấy recorder + bucket (5/20) **từ DB** (recorder đã được gán, đã Confirm) → đổi tên file thành `Title_Recorder_Nmins` đúng định dạng cũ → append sheet kèm `game_id` → upload YouTube như hiện tại.
- Recorder không còn gõ tên mình hay số phút; DB quyết định. Nếu recorder thật khác người được gán, vẫn ghi theo DB (đồng bộ recorder theo YouTube `reconcile-recorders` hiện có tự xử lý phần "người upload thật").

- **Mã giữ nguyên khi add lại hoặc đổi người:** n8n luôn đọc recorder và bucket từ DB **lúc xử lý file**, không phải lúc sinh mã. Đây là chủ ý của user ("DB quyết định"). Tên file sau khi đổi có thể mang tên người được gán ở thời điểm đó.
- **Upload trùng cho cùng mã (quay lại):** *(tôi quyết)* nếu game đã có upload YouTube còn hiệu lực (`youtube_link` không NULL) cho bucket đó thì **không tự upload**, giữ file và báo Chat để manager gỡ link cũ rồi file được xử lý ở lần poll sau. Chưa có upload (hoặc link đã bị gỡ) thì upload bình thường.
- **Workflow record hiện có** (Append Sheet / Upload Youtube) **không nằm trong repo**, nó nằm ở n8n cloud. Builder phải mở workflow đó trên n8n để sửa, hoặc export về `workflows/` trước. Folder Drive record và folder demo là hai folder riêng; ID folder đọc từ node Config của từng workflow.

### Trường hợp lỗi (cả hai folder)
- Tên file là mã hợp lệ nhưng không tồn tại: không đổi tên, không upload; ghi `flow_log` (name, status=`code_not_found`, note=tên file) và báo Google Chat.
- Mã record tồn tại nhưng game chưa Confirm (`record_confirmed_at` NULL) hoặc đã bị bỏ khỏi Record: giữ file, ghi `flow_log`, thử lại ở lần poll sau.
- Mã đặt nhầm folder (mã demo vào folder record hoặc ngược lại): n8n tra thêm cột còn lại; nếu thấy thì ghi `wrong_folder` thay vì `code_not_found`. *(tôi quyết)*
- Endpoint sinh mã demo lười là `POST`, cần session, không cache, chỉ chạy khi người dùng bấm hoặc mở ô demo link; không sinh bằng GET lúc render. *(tôi quyết)*
- File đã đổi tên xong thì không còn khớp regex nên không bị xử lý lại (idempotent).
- Đổi tên Drive thất bại sau khi đã ghi DB: lần poll sau thấy file vẫn tên mã, chạy lại (các bước ghi đều idempotent).

## Dữ liệu

- Migration mới (số tiếp theo trong `migrations/`, kiểm lại lúc làm): `ALTER TABLE game_info ADD COLUMN demo_code text, ADD COLUMN record_code text;` + hai unique index partial.
- Không bảng mới. Không backfill.
- n8n đọc/ghi qua credential Postgres hiện có (`KBZC0RGIJsc8d7GK`).
- `workflows/` bị `.gitignore`: file workflow phải `git add -f`.

## Để cho builder

- Chọn thư viện/hàm sinh mã, chỗ đặt helper (`lib/`), tên endpoint lười.
- Cách chuẩn hoá tên file trong n8n Code node, chi tiết làm sạch tên khi đổi tên.
- Kiểu UI cụ thể của chip mã (theo style hiện có của panel / Record tab).
- Thứ tự deploy: migration → app → import workflow n8n (tắt workflow cũ cùng tên).

## Rủi ro đã biết

- Worktree không có `.env.local`; 16 test fail sẵn trên origin/main, không liên quan. Verify build bằng `NEXT_DIST_DIR=.next-check`.
- `route.ts` có byte NUL (sentinel `__no_evaluator__`): dùng `git diff --text`.
- Mã record phụ thuộc Confirm; dòng draft không có mã nên recorder chưa quay được. Đây là chủ ý (khớp luồng log "gán recorder log một dòng lúc confirm").

## Change 2026-11-05 (user)

- Giả định hai folder Drive riêng được thay bằng **một folder chung** `[Signal] Video`. Mã phân biệt demo và record; mỗi workflow bỏ qua im lặng mã của loại kia (không notice, không ghi, không đổi tên). `wrong_folder` không còn.
- Mã mới: 6 ký tự, ít nhất 2 chữ số và 2 chữ cái, nên tên game thật không bao giờ giống mã.
- Mã không có trong bảng nào: chỉ workflow record báo `code_not_found` (flow_log + Chat, text trung tính), workflow demo cho rơi xuống nhánh khớp tên và im lặng, nên đúng một workflow báo lỗi gõ sai. Mã có ở cả hai cột: workflow demo báo `ambiguous_code`, workflow record im lặng.
- Các mục "folder riêng" và `wrong_folder` ở trên không còn đúng.
