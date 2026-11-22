# Unified game trong Playtest: thiết kế đợt 1

Status: DRAFT (2026-11-21). Đã chọn: List B, Panel A, Short List bản 2, phương án A (DB tự chép).
Mockup: canvas https://claude.ai/artifact/CMk9zTqNQno33i8Mj5Kqwx, trang "List B + Panel A" (artboard 1-5 và 7).
Handover gốc: `~/orca/workspaces/signal-smartsheet-management/HANDOVER-unified-playtest-2026-11-21.md`.

## 1. Vì sao

Một game có bản Android và iOS cùng `bundle_id` là 2 dòng `game_info` và 2 dòng `game_evaluations`. Hôm nay Playtest chấm 2 lần:

- Khoảng 1.000 lượt test mỗi tháng bị lặp ở store thứ 2.
- Khoảng 1.113 cặp đã chấm cả 2 store ra kết quả khác nhau.

Signal Sense đã coi cặp là 1 game từ 2026-11-21: `game_info.family_id` và `family_unlinked`, trigger tự ghép cặp, tag custom field tự chép sang store kia. Playtest cần làm giống vậy cho phần đánh giá.

## 2. Mục tiêu, không làm, phản mục tiêu

**Mục tiêu (đợt 1):**
- Từ lúc ship, một cặp đã nối là 1 game: chung evaluator, conclusion, note, game_alike, final, batch, drive_link demo, record. Lưu ở store nào cũng ghi cả 2 dòng.
- Store thứ 2 vào Playtest sau thì đi theo người đang giữ store 1. Nếu store 1 đã chấm xong thì nhận luôn kết quả.
- Push và assign tính cặp là 1 game. Cặp giao được cho bất kỳ tester nào.
- Các list (Evaluate, Short List, Record) hiện cặp thành 1 dòng. Panel có nút chuyển store. History ghi rõ thay đổi thuộc store nào.
- Mọi số đếm (list, Quick stats, Report, Team Ops, Effort Tracker API, badge Record) tính cặp là 1.

**Không làm trong đợt 1 (để đợt 2):**
- Không sửa data cũ: 5.077 cặp đã chấm cả 2 store, 365 cặp chấm 1 store và store kia đang chờ, 56 cặp đang giao cho 2 người, các cặp lệch kết quả trong sheet review, 52 game thuộc cặp có hơn 1 dòng, các cặp đã có 2 mã record/demo khác nhau.
- Những cặp cũ đó vẫn hiện 2 dòng như hôm nay cho tới đợt 2.
- Không tự đẩy store thứ 2 vào Playtest nếu nó không qua điều kiện push của chính nó.
- Không tự phát hiện link sống lại. "Mở lại" là người dùng tắt công tắc link dead.
- Không đụng phần Signal Sense hiển thị Playtest (quyết định 10 thuộc repo signal-deploy).

**Phản mục tiêu (làm xong mà dính 1 trong các điều này là hỏng):**
- 2 dòng của một cặp đã nối bị lệch nhau mà không ai thấy.
- Một store `Link_dead` / `Stale_release` bị ghi đè bằng kết quả của store kia, hoặc ngược lại.
- Giờ làm hay số game của tester bị đếm gấp đôi.
- Signal Sense bị lỗi khi import hay ghép cặp vì trigger của Playtest.
- Lỡ ghi vào DB prod khi test.

## 3. Ràng buộc

- Làm và test ở local: app trỏ vào DB mẫu `postgres://127.0.0.1:54330/sample` (qua proxy SSL local ở cổng 54331 vì `lib/db.ts` ép `ssl:'require'`). Prod chỉ đọc. Không push, merge, deploy hay chạy migration prod khi user chưa đồng ý.
- Giữ 2 dòng `game_evaluations` mỗi cặp (Signal Sense đọc theo `game_id`).
- `game_info` là bảng chung với Signal Sense. Các trigger Signal Sense trên đó đã chạy trên prod (041-044 bên signal-deploy).
- Migration Playtest viết tay, đánh số riêng: đợt này là `migrations/054_eval_pairs.sql`, có khối `-- ROLLBACK:`, chạy lại nhiều lần không hỏng (`IF NOT EXISTS`, `CREATE OR REPLACE`).
- Jest mock DB, nên logic trong DB phải test bằng script SQL chạy trên DB mẫu (giống `scripts/verify-evaluation-log.sh`).
- UI copy tiếng Anh, ngắn, không dùng em dash.
- `next build` phải qua (lint lỗi là Replit không publish được).

## 4. Các phương án đã cân nhắc

| | Cách làm | Được | Mất |
|---|---|---|---|
| **A (đã chọn)** | Thêm cột nối 2 dòng + trigger trong DB chép cột dùng chung sang dòng kia | Mọi đường ghi (khoảng 11 route, 2 flow n8n, script, route mới sau này) tự đồng bộ | Logic nằm trong DB, phải test bằng SQL trên DB mẫu |
| B | Code app đổi 1 id thành 2 id rồi ghi cả 2, sửa từng route | Logic trong TypeScript, test bằng jest | Sót 1 đường ghi là cặp lệch mà không ai biết; flow n8n phải sửa SQL riêng |
| C | Bảng riêng lưu kết quả chung | Một nguồn duy nhất | Trái quyết định giữ 2 dòng; Signal Sense và mọi chỗ đọc theo `game_id` phải sửa. Loại |

User chọn A (2026-11-21). Phần không phải chép dữ liệu (push, assign, list, panel, log) vẫn ở code app.

## 5. Những gì đã chốt với user

Quyết định trong handover (không mở lại): khoá cặp là `family_id`; luôn chép kết quả store 1 sang store 2 trừ `Link_dead` / `Stale_release`; store `Link_dead` mở lại khi link sống lại; record 5/20 phút dùng chung; cặp là 1 dòng 2 icon; cặp giao cho bất kỳ ai và tính là 1; giữ 2 dòng + cột nối, lưu 1 lần ghi cả 2, history ghi ai chấm store nào; cặp `family_unlinked` là 2 game riêng.

Chốt thêm trong buổi brainstorm:
- Cặp đã nối dùng chung mọi thứ: evaluator, conclusion, note, game_alike, final, batch, drive_link demo, record. Riêng từng store: `game_id`, link store, genre, và 2 ngoại lệ `Link_dead` / `Stale_release`.
- Làm 2 đợt. Đợt 1: phần nền + giao diện ship cùng lúc. Đợt 2: data cũ.
- `evaluation_log` ghi 1 lần cho cả cặp.
- Game chỉ có 1 store vẫn theo luật tester chuyên iOS / Android như cũ.
- Store bị gỡ (`is_active=false`) hiện giống Signal Sense: icon mờ, gạch đỏ.
- Cặp bị Unlink thì tách thành 2 game, giữ dữ liệu, ngừng đồng bộ.
- Số đếm tính cặp là 1 từ lúc ship. Số liệu cũ giữ nguyên.
- Mỗi cặp dùng chung 1 mã record và 1 mã demo.
- Giao diện: List B (cột Stores chỉ có icon), Panel A (nút chuyển store), Record có 2 dấu store trên icon game, Short List cột Game bản 2.

## 6. Thiết kế

### 6.1 Dữ liệu (migration 054)

**Cột mới trên `game_evaluations`:**
- `pair_eval_id integer NULL REFERENCES game_evaluations(id) ON DELETE SET NULL`: id dòng của store kia. Hai chiều: A trỏ B thì B trỏ A. Unique index partial (`WHERE pair_eval_id IS NOT NULL`).
- `pair_back boolean NOT NULL DEFAULT false`: dòng này là "dòng sau" của cặp, các list và số đếm bỏ qua nó. Mỗi cặp đã nối có đúng 1 dòng `pair_back = true`.

**Dòng trước / dòng sau:** dòng trước là dòng không mang kết quả riêng store. Nếu cả 2 cùng mang hoặc cùng không mang, dòng có `id` nhỏ hơn là dòng trước. "Kết quả riêng store" = `initial_conclusion IN ('Link_dead','Stale_release')`. Trigger tính lại `pair_back` mỗi khi conclusion của 1 trong 2 dòng đổi, và khi 1 dòng bị xoá (`AFTER DELETE`: dòng còn lại về `pair_back = false`).

**Hai cách bỏ dòng sau, dùng đúng chỗ:**
- **List** (Evaluate, Short List, Record, missing-demo, export): bỏ mọi dòng sau, `NOT ge.pair_back`. Mỗi cặp 1 dòng.
- **Số đếm công việc** (Report, Quick stats, Team Ops, Effort APIs, giờ làm): chỉ bỏ dòng sau **đang là bản chép**, tức `NOT (ge.pair_back AND ge.initial_conclusion IS DISTINCT FROM 'Link_dead' AND ge.initial_conclusion IS DISTINCT FROM 'Stale_release')`. Dòng `Link_dead` / `Stale_release` là việc thật của người đánh dấu nên vẫn được đếm. Viết 1 lần thành helper SQL trong `lib/` (ví dụ `notPairCopy(alias)`), mọi query đếm gọi lại.

**Cột mới trên `evaluation_log`:** `pair_scope text NULL` (`'pair'` | `'store'`). NULL là log cũ, coi như `'store'`.

**Cặp hợp lệ** khi cả 2 điều sau đúng (hàm `eval_pair_valid(a, b)`):
- 2 dòng `game_info` cùng `family_id` khác NULL, khác `os`, không dòng nào `family_unlinked`.
- Mỗi `game_id` có đúng 1 dòng `game_evaluations`.

**Cột dùng chung** chia 2 nhóm (mỗi nhóm là 1 danh sách duy nhất trong SQL, chỗ chép và chỗ kiểm tra dùng chung):
- **Nhóm đánh giá** (tôn trọng ngoại lệ `Link_dead` / `Stale_release`): `initial_evaluator, assigned_date, first_assigned_date, initial_conclusion, initial_note, initial_gameplay, initial_game_over, initial_level_complete, initial_self_note, evaluate_date, final_evaluator, final_conclusion, final_note, final_conclusion_date, batch, game_alike, updated_by`, và `category_group`.
- **Nhóm media** (luôn đồng bộ khi cặp đang nối, kể cả 1 bên `Link_dead`, vì video là của cả cặp theo quyết định 4): `drive_link, drive_date, record_bucket, record_assignee, record_assign_date, record_confirmed_at, record_5min_assignee, record_5min_date, record_5min_drive, record_5min_drive_date, record_5min_confirmed_at, record_5min_batch, record_20min_assignee, record_20min_date, record_20min_drive, record_20min_drive_date, record_20min_confirmed_at, record_20min_batch, youtube_link, youtube_uploaded_at, youtube_5min_link, youtube_5min_uploaded_at, youtube_20min_link, youtube_20min_uploaded_at`.
  Lý do: n8n (theo mã, theo tên), YouTube reconcile và record-by-code chọn dòng theo `game_id` / mã, có thể rơi vào dòng của store đã chết. Nhóm media luôn đồng bộ thì link không bị kẹt ở dòng chết.

**Riêng từng store:** `id, game_id, genre_1, genre_2, imported_at, updated_at`.

### 6.2 Trigger trong DB

**a) Chép khi sửa (`AFTER UPDATE` trên `game_evaluations`)**
- Chỉ chạy ở lệnh gốc (`pg_trigger_depth() = 1`), để lệnh chép sang dòng kia không chép ngược lại.
- Dòng R vừa sửa có `pair_eval_id = T` và cặp hợp lệ:
  - Nhóm media: luôn chép sang T những cột media vừa đổi.
  - Nhóm đánh giá, cả R (giá trị mới) và T đều không mang kết quả riêng store: chép sang T **chỉ những cột vừa đổi** (`NEW.x IS DISTINCT FROM OLD.x`). Chép cột đổi thôi để 2 người sửa 2 cột khác nhau cùng lúc không đè nhau.
  - Nhóm đánh giá, R vừa chuyển từ kết quả riêng store sang không (tắt công tắc link dead, "mở lại"): chép **toàn bộ** nhóm đánh giá từ T vào R, trừ khi T cũng mang kết quả riêng store. Nếu T chưa chấm, R nhận người giữ và các ngày giao của T. Nhóm media vốn đã đồng bộ nên không cần chép lại.
  - Nhóm đánh giá, R vừa thành kết quả riêng store, hoặc T đang mang kết quả riêng store: không chép.
- Mọi trường hợp: tính lại `pair_back` cho 2 dòng.
- Cặp không còn hợp lệ (bị Unlink, đổi family): gỡ nối cả 2 dòng (`pair_eval_id = NULL`, `pair_back = false`), không chép.

**b) Nối khi thêm dòng (`AFTER INSERT` trên `game_evaluations`)**
- Dòng mới N chưa nối, game của N có twin (cùng `family_id`, khác `os`, không unlinked), twin có đúng 1 dòng T, T chưa nối với ai: nối N và T.
- Chạy được cả khi push thêm 2 store trong cùng 1 lệnh (dòng thứ 2 thấy dòng thứ nhất, hoặc dòng thứ nhất đã được nối bởi dòng thứ hai thì bỏ qua).
- Chép từ T sang N, **chỉ vào cột N đang NULL** (để `add-to-record` không bị đè giá trị nó vừa ghi):
  - T mang kết quả riêng store: không chép gì. N là dòng trước và được giao bình thường.
  - T đã chấm (conclusion khác): chép toàn bộ cột dùng chung. N là dòng sau.
  - T chưa chấm: chép người giữ, các ngày giao, `batch`, `category_group`. N là dòng sau.
- `category_group` của N đổi theo T để cặp nằm cùng 1 genre trong list (N mới nên không đụng unique `(game_id, category_group)`).
- Vì `category_group` có thể đổi ngay sau INSERT, route nào INSERT rồi UPDATE lại theo `(game_id, category_group)` (hiện có `add-to-record`) phải chuyển sang UPDATE theo `id` lấy từ `RETURNING`.
- Ghi 1 dòng `evaluation_log` kind `pair_link`, actor `System`, `game_id` = game của N, `pair_scope = 'store'`. History hiện "linked iOS to the pair".

**c) Gỡ nối khi family đổi (`AFTER UPDATE OF family_id, family_unlinked` trên `game_info`)**
- Nếu game không còn hợp lệ trong cặp Playtest đang nối: gỡ nối 2 dòng, giữ nguyên dữ liệu.
- Không tự nối ở đây (family hình thành khi cả 2 dòng đã có kết quả là việc của đợt 2).
- Trigger này chạy trong transaction của Signal Sense, nên **không được làm hỏng lệnh của Signal Sense**: thân hàm bọc `BEGIN ... EXCEPTION WHEN OTHERS THEN RAISE WARNING ... END`, chỉ làm 1 lệnh UPDATE theo index. Phải báo bên Signal Sense biết trigger này tồn tại (ghi vào runbook).

**d) Nối các cặp an toàn có sẵn lúc chạy migration**
- Chỉ nối cặp có 2 dòng, cả 2 chưa chấm, cùng `category_group`, `batch` trùng nhau hoặc 1 bên NULL, và người giữ trùng nhau hoặc chỉ 1 bên có người giữ. Bên thiếu nhận giá trị của bên kia; `first_assigned_date` lấy ngày sớm hơn, `assigned_date` lấy của dòng trước. Mọi cột media của cặp phải trùng hoặc 1 bên NULL. Không thoả 1 điều kiện nào thì để đợt 2.
- Mọi cặp khác để đợt 2. Migration in ra số cặp đã nối.

Hàm nối 2 dòng (`link_eval_pair(a, b)`) dùng chung cho (b), (d) và đợt 2.

### 6.3 Code app

**Push** (`cron/push-evaluations`, `admin/push-split`): không đổi điều kiện. Trigger (b) lo phần nối. Bản dry-run giữ nguyên.

**Assign** (`cron/assign-evaluators`, reassign, handover, rescue):
- Ứng viên chỉ lấy dòng trước của cặp (`NOT pair_back`). Dòng sau đi theo nhờ trigger chép `initial_evaluator`, `assigned_date`, `first_assigned_date`.
- Cặp mang `os = 'pair'`: ai cũng nhận được, kể cả tester chuyên iOS / Android. Game 1 store giữ luật cũ.
- `assignGames`: tester chuyên store được lấy từ pool của store mình rồi từ pool cặp; tester `all` lấy phần còn lại. Vẫn giữ tinh thần chia theo trọng số và không để người cuối bị đói (có test cho ca này). Thuật toán cụ thể để người build chọn, có test.
- `assignment_history.game_count` đếm cặp là 1. `game_ids` ghi cả 2 `game_id` để History của từng store đều thấy.
- Preview số game sắp vào (`assign-setup/preview`, `lib/push-preview.ts`) đếm cặp là 1 và tách thêm nhóm "pair".

**PATCH `/api/evaluations`**: vẫn ghi 1 dòng, trigger chép sang dòng kia. Thêm:
- Ghi `evaluation_log.pair_scope`: `'pair'` nếu dòng đang nối và cả 2 không mang kết quả riêng store lúc lưu, ngược lại `'store'`.
- Kiểm quyền "non-manager chỉ sửa dòng của mình" vẫn theo dòng đang ghi (2 dòng cùng người giữ nên không đổi gì).

**Mã record / demo dùng chung** (`lib/file-codes.ts`): `ensureCode` xem twin trước. Twin đã có mã thì trả mã đó, không cấp mã mới (unique index không cho 2 dòng `game_info` cùng mã). Chỗ đọc mã (Record tab, record queue, panel) đọc `COALESCE(mã của mình, mã của twin)`. Cặp cũ có 2 mã khác nhau: đọc mã của mình như hôm nay (đợt 2 xử lý).

**Các chỗ đọc phải bỏ dòng sau** (theo 2 cách ở 6.1):
- Cách list: `/api/evaluations` (cả total và facets), `missing-demo`, `record-view-games`, record queue và badge, shortlist export, `weekly-feedback/batches`.
- Cách đếm công việc: Quick stats, Report (`report/route.ts`, `report/daily`, `cron/report-rollup`), Team Ops (`operations/pending-holders`, rescue, reassign preview), `external/effort-sessions`, `external/effort-game-time`, `lib/evaluation-hours.ts`.
- Người build rà lại toàn repo (`FROM game_evaluations`) để không sót chỗ nào, ghi danh sách vào plan.
- Search `q` theo `game_id` phải tìm được cả id của store sau và trả về dòng trước.

**List trả thêm thông tin store** cho mỗi dòng: `stores: [{os, game_id, app_link, is_active, dead}]`, `dead = initial_conclusion = 'Link_dead'` của dòng store đó. Chỉ dòng **đang nối** (`pair_eval_id` khác NULL) mới có 2 store. Dòng chưa nối (cặp cũ chờ đợt 2, hoặc store kia chưa vào Playtest) chỉ có store của chính nó, giống hôm nay. Như vậy UI cặp (2 icon, nút chuyển store, "Saved to both stores") chỉ hiện khi lưu thật sự ghi cả 2 dòng.

**Panel** `GET /api/evaluations/[gameId]`: mở bằng `game_id` của store nào cũng ra cặp, chọn sẵn store đó. Trả thêm `pair: { front_id, back_id, stores: [...] }` và thông tin game info của từng store (link, QR, publisher, ngày phát hành, ảnh StoreKit).

**History** `GET /api/evaluations/[gameId]/history`: đọc `evaluation_log` và `assignment_history` của cả 2 `game_id`. Mỗi dòng sự kiện có `stores`: `pair_scope = 'pair'` hoặc dòng assign có cả 2 id → 2 icon; còn lại → icon của store ghi log.

### 6.4 Giao diện (theo canvas)

Icon store dùng chung một bộ (Apple / Play, cùng màu, cùng cỡ) ở cột Stores, nút chuyển store, History, Record, gợi ý "Saved to both stores".

**Evaluate (artboard 1):**
- Cột **Stores** ngay sau cột Game. Mỗi store là ô icon 28x28 bằng nhau. Tooltip: `iOS · 6822015244`, thêm ` · Link dead` / ` · Removed`.
- Store `Link_dead`: ô nền đỏ nhạt, chấm đỏ ở góc. Store `is_active=false`: icon mờ, vạch đỏ chéo.
- Bảng có cột Stores thì icon game bỏ dấu store ở góc.
- Dòng đếm: `N games`, cặp đếm là 1.

**Panel (artboard 2, 3):**
- Card Game Info có 2 nút chuyển store: icon + `Android` / `iOS`, id chỉ ở tooltip. Game 1 store không có nút này.
- Đổi theo store đang chọn: link, QR, publisher, ngày phát hành, StoreKit (`StoreKit · Android (24)`), mô tả.
- Không đổi theo store: Assigned, Initial / Final Evaluated, toàn bộ form bên phải.
- Công tắc `<Store> link dead` cạnh tên game, riêng từng store, **màu đỏ khi bật** (các switch khác giữ màu cũ).
- Cột phải có gợi ý `Saved to both stores`. Thanh Save ghi `saves Android and iOS together` khi có thay đổi chưa lưu.
- Store đang chọn bị link dead: dòng báo đỏ "The iOS link is dead, so iOS keeps Link dead. The evaluation on the right is Android only. When the iOS link works again, iOS reopens and takes the pair's result." Gợi ý cột phải đổi thành `Android only while the iOS link is dead`.
- Lưu: bật/tắt link dead là PATCH dòng của store đó (`initial_conclusion`). Form là PATCH dòng của store đang sống. Bật link dead thì gửi trước, form gửi sau.
- Cả 2 store cùng link dead: form ghi vào dòng trước, không chép (cả 2 riêng store).

**History (artboard 4):** sự kiện của cả cặp có 2 icon, sự kiện 1 store có 1 icon. Dòng assign ghi chú `Counts as 1 game`. Có dòng `linked iOS to the pair`.

**Record (artboard 5):** không có cột Stores. Cặp hiện 2 dấu store trên icon game (Apple bên trái, Play ở góc). Một dòng, một recorder, một mã.

**Short List (artboard 7, bản 2):**
- Cột Game 3 dòng: tên game; chip nhỏ batch + evaluator; `Publisher · dd/mm/yy` (publisher dài thì cắt `…`, ngày luôn hiện đủ).
- Nút copy tên hiện khi rê chuột, nằm đè góc phải, không chiếm chỗ.
- Cột Stores dạng icon thay cột Link: bấm icon mở trang store đó.

### 6.5 Test

- **SQL trên DB mẫu** (`scripts/verify-eval-pairs.sh` + `scripts/sql-verify/eval-pairs-*.sql`, chạy trong transaction rồi ROLLBACK, không để lại dữ liệu):
  - nối khi insert (store 1 đã chấm / đang chờ / Link_dead / cả 2 cùng lệnh / twin có 2 dòng / unlinked);
  - chép khi update chỉ cột đổi; không chép khi 1 bên riêng store; mở lại; `pair_back` đúng sau mỗi bước;
  - gỡ nối khi `family_unlinked` bật; trigger `game_info` không làm hỏng lệnh UPDATE của Signal Sense khi có lỗi;
  - trigger `record_slots` vẫn ra đúng `record_*_batch` ở cả 2 dòng sau khi chép;
  - migration chạy 2 lần không lỗi; khối ROLLBACK chạy được.
- **Jest** cho code app: `assignGames` với pool cặp, các query có `NOT pair_back`, `pair_scope`, `ensureCode` với twin, API list/panel/history trả `stores`, component cột Stores / nút chuyển store / công tắc đỏ.
- **Chạy thật ở local** (cổng 3334, DB mẫu): push 1 cặp mới, assign, chấm ở Android, xem iOS tự có kết quả, đánh iOS link dead rồi mở lại, xem History, Record, Short List.
- `npm run typecheck`, jest, `next build` (dist riêng `NEXT_DIST_DIR`) đều qua.

### 6.6 Đưa lên prod (sau khi user đồng ý từng bước)

1. Kiểm trước trên prod, chỉ đọc: số cặp an toàn sẽ nối ở (d), không có cột trùng tên, trigger Signal Sense hiện có.
2. Runbook: thứ tự migration rồi Pull + Deploy trên Replit, rollback, kiểm sau khi chạy.
3. Ghi chú cho repo signal-deploy: trigger mới trên `game_info`.

**Gỡ nối (Unlink):** 2 dòng giữ nguyên dữ liệu như user đã chốt và thành 2 game riêng. Dòng sau trước đó là bản chép nên từ lúc gỡ nối sẽ được đếm lại như 1 game đã chấm. Đây là lựa chọn của mình: Unlink là thao tác admin hiếm, chấp nhận lệch nhỏ này thay vì thêm cột đánh dấu.

## 7. Để người build tự quyết

- Thuật toán cụ thể của `assignGames` khi có pool cặp (miễn có test cho chia theo trọng số và ca người cuối đói).
- Tên hàm SQL, cách tách file `scripts/sql-verify`.
- Cách lấy thông tin store của twin trong list (LATERAL hay JOIN), miễn không chậm hơn rõ rệt (DB ở us-east-2, mỗi round-trip ~225ms, nên không thêm round-trip).
- Bộ lọc conclusion trên list khớp theo dòng trước (cặp có 1 store Link_dead không hiện khi lọc `Link_dead`). Đây là lựa chọn của mình, đổi được nếu user muốn.

## 8. Đợt 2 (chỉ ghi lại, thiết kế sau)

- 365 cặp chấm 1 store: nối và chép kết quả.
- Cặp chấm cả 2 store: `List_Idea` vs `Bypass` / `Playtest & Bypass` → `List_Idea`; các tổ hợp lệch khác theo sheet review (hỏi user sheet đã review xong chưa).
- 56 cặp giao cho 2 người, cặp khác `category_group`, game có hơn 1 dòng, cặp có 2 mã record/demo.
