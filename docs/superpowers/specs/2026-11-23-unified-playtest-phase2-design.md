# Unified game trong Playtest: đợt 2, nối các cặp cũ

Status: DRAFT (2026-11-23). Đợt 1: `docs/superpowers/specs/2026-11-21-unified-game-playtest-design.md` (đã lên prod 22/11, migration 054, main `26e0544`).

## 1. Vì sao

Đợt 1 chỉ nối cặp mới và 6 cặp cũ an toàn. Trên prod còn khoảng 5.700 cặp Android + iOS cùng `family_id` mà cả 2 store đều có dòng `game_evaluations` nhưng chưa nối: list vẫn hiện 2 dòng, assign vẫn giao 2 lần, record có thể làm 2 lần. Đợt 2 nối hết các cặp đó theo luật user đã chốt, mà không làm mất công của ai đã test store thứ 2.

## 2. Mục tiêu, không làm, phản mục tiêu

**Mục tiêu**
- Mọi cặp sạch (mỗi store đúng 1 dòng eval, family có đúng 2 game, không `family_unlinked`) được nối bằng `pair_eval_id`, đúng luật ở mục 5.
- Sau khi nối, 2 dòng của cặp mang cùng nội dung dùng chung (trừ ngoại lệ `Link_dead` / `Stale_release` của đợt 1).
- Số liệu cũ giữ nguyên (phương án A user chọn 23/11): lượt chấm có thật của store thứ 2 trước ngày nối vẫn được đếm cho đúng người, đúng kết luận, đúng ngày.
- Mọi giá trị bị thay vẫn xem lại được (History + bảng snapshot) và quay lại được.

**Không làm**
- 52 game có hơn 1 dòng eval (bị push trùng vào 2 nhóm, lỗi push tháng 10). Để nguyên, ghi riêng một việc dọn sau.
- Không đổi luật đồng bộ của đợt 1 cho cặp mới.
- Không sửa flow n8n đọc thẳng DB (card Chat hằng ngày, sheet status log). Ghi vào mục rủi ro.

**Phản mục tiêu**
- Số lượt chấm, số List_Idea, signal rate của một người ở tháng cũ thay đổi sau khi chạy.
- Một store `Link_dead` / `Stale_release` bị ghi đè kết quả.
- Note, demo link, video của store phụ mất hẳn (không còn ở đâu để xem lại).
- Lỡ ghi prod khi chưa có lệnh của user; chạy prod mà chưa có bản xem trước để user duyệt.

## 3. Ràng buộc

Như đợt 1: làm và test trên DB mẫu local; prod chỉ đọc cho tới khi user đồng ý từng bước; migration viết tay đánh số `055`, có khối `-- ROLLBACK:`, chạy lại không hỏng; logic DB test bằng script SQL trên cluster tạm (như `scripts/verify-eval-pairs.sh`); `next build` phải qua; UI copy tiếng Anh, không em dash.

## 4. Số liệu prod (chỉ đọc, 23/11)

| Nhóm | Cặp |
|---|---|
| A. Cả 2 chưa chấm | 91 (cả 91 do 2 người khác nhau giữ, 15 khác nhóm) |
| B. 1 store đã chấm, store kia chờ | 490 (Bypass 387, List_Idea 55, P&B 48) |
| C. Có store `Link_dead` / `Stale_release` | 60 |
| D. Cả 2 chấm, cùng kết quả | 3.935 (Bypass 3.558, List_Idea 328, P&B 49) |
| E. List_Idea vs Bypass / P&B | 547 (430 có final, 57 đang ở Record) |
| F. Bypass vs Playtest & Bypass | 534 |
| G. Store có hơn 1 dòng eval | 52 (không làm) |

233 cặp có 2 store ở 2 nhóm khác nhau. Media lệch (cả 2 có, khác nhau): demo link 273 + 3 + 5 + 168 + 10, link record/YouTube 9; 10 cặp có 2 mã demo, 4 cặp có 2 mã record. Sheet review (tab Playtest, 615 dòng) chưa ai điền cột Review, và chỉ chứa nhóm E + nhóm C, nên không chặn việc này.

## 5. Luật nối (user đã chốt 23/11)

Từ dưới đây: **dòng chính** là dòng list hiện (front, `pair_back = false`), **dòng phụ** là dòng còn lại.

**Chọn dòng chính (user chốt 23/11: store ra trước):** mặc định là store phát hành trước (`COALESCE(initial_release, temp_release)` sớm hơn; prod: 99% cặp có ngày, 204 cặp cùng ngày). Cùng ngày hoặc thiếu ngày: store vào Playtest trước (`first_assigned_date`, rồi id nhỏ hơn). Ngoại lệ, vì nội dung của cặp phải lấy từ store này: nhóm C là store còn sống; nhóm E là store List_Idea; nhóm F là store P&B; nhóm D là store đi xa hơn trong quy trình khi chỉ 1 bên có final / record / demo (prod: ít nhất 42 cặp List_Idea có final ở store ra sau).

**A. Cả 2 chưa chấm:** giữ cho người đang có ít game chờ chấm hơn (đếm backlog lúc chạy, theo luật đếm của Rescue). Người đã deactivate (`dashboard_users.active = false`) không được chọn; cả 2 đều deactivate thì giữ người của dòng có `assigned_date` sớm hơn và ghi vào báo cáo. Cả 2 dòng nhận người giữ, ngày giao, batch, nhóm của dòng thuộc người được chọn; dòng chính vẫn là store ra trước.

**B. 1 store đã chấm:** chép toàn bộ nhóm đánh giá của dòng đã chấm sang dòng chờ (kể cả người giữ); dòng chính vẫn là store ra trước. Store chờ rời backlog của người đang giữ nó. Không ai mất công (store chờ chưa ai chấm).

**C. Có store chết:** nối, mỗi store giữ kết quả riêng (`eval_store_specific`). Store còn lại nếu chưa chấm thì giữ nguyên người đang giữ để người đó chấm; không chép nhóm đánh giá. Nhóm media vẫn đồng bộ như đợt 1 (cả 2 có mà khác thì theo luật media ở D).

**D, E, F. Cả 2 đã chấm**
- Kết quả của cặp: D giữ nguyên; E lấy `List_Idea` (quyết định 9 của handover); F lấy `Playtest & Bypass`.
- Dòng chính: theo luật chọn ở đầu mục 5. Thứ tự "đi xa hơn": có final, rồi có record (assignee 5' hoặc 20'), rồi có demo link; cả 2 ngang nhau thì store ra trước.
- Dòng phụ nhận từ dòng chính toàn bộ `eval_pair_eval_cols()` (kết luận, note, gameplay brief, game alike, batch, nhóm...), **trừ** khi đã giữ công ở cột riêng (mục 6.1).
- Final: của dòng chính. Vì dòng chính được chọn theo "có final" trước, nó chỉ thiếu final khi cả 2 đều không có; 84 cặp cả 2 có final khác nhau thì giữ final của dòng chính, final của dòng phụ nằm trong snapshot + History. (Bản nháp đầu ghi "lấy final muộn hơn"; đổi để final của người chấm dòng chính không bị thay, giữ đúng số liệu cũ.)
- Media: cột nào dòng chính trống mà dòng phụ có thì đưa lên dòng chính; cả 2 có mà khác thì giữ của dòng chính. Sau đó dòng phụ nhận media của dòng chính như đợt 1.
- Mã file (`game_info.demo_code` / `record_code`): không sửa. Mỗi store giữ mã của mình; app đã đọc `COALESCE(của mình, của twin)` từ đợt 1. 14 cặp có 2 mã ghi vào báo cáo.

**Mọi nhóm:** `category_group` của dòng phụ theo dòng chính (dòng phụ là dòng duy nhất của game đó, nên không đụng unique `(game_id, category_group)`). Không đổi `updated_at` của dòng nào.

## 6. Thiết kế

### 6.1 Giữ công của dòng phụ (phương án A)

Thêm vào `game_evaluations` 1 cột `credit jsonb`, chỉ đợt 2 ghi, chỉ trên dòng phụ có kết quả thật của chính nó trước khi nối (nhóm D, E, F; không ghi cho A, B, C). `credit` là bản đóng băng, ngay trước khi nối, của **mọi cột mà các số liệu theo người đọc**: tối thiểu `initial_evaluator`, `initial_conclusion`, `evaluate_date`, `final_conclusion`, `final_evaluator`, `final_conclusion_date`, `category_group`, `batch`, `first_assigned_date`, `assigned_date`, có note hay không (`noted`). Người build rà mọi route đếm để chốt danh sách; test trước/sau ở dưới là thước đo.

Luật đếm (helper dùng chung trong `lib/eval-pairs.ts`, không route nào tự viết lại):
- Dòng có `credit` **luôn** được đếm, và đếm bằng giá trị trong `credit` thay cho cột thật, dù sau này cặp bị Unlink, store đó bị đánh Link_dead, hay dòng đó thành dòng chính. Nhờ vậy công cũ không bao giờ bị đếm 2 lần hay mất.
- Mọi dòng khác: như đợt 1 (`notPairCopy`).

Các route áp luật này: mọi route hôm nay dùng `notPairCopy` để đếm theo người / ngày / kết luận / nhóm (Report + cron `report-rollup`, report daily, Quick stats, Effort sessions, Effort game-time, Performance, và các chỗ khác người build tìm thấy). Route theo hàng đợi việc (assign, rescue, pending holders, preview) không đổi: dòng phụ đã chấm không còn là việc.

**Dòng chính giữ nguyên vị trí** (quyết định của mình, 23/11): 054 hôm nay chọn lại dòng chính theo id nhỏ hơn mỗi lần lưu (`eval_pair_refresh_back`). 055 đổi thành: khi không store nào mang kết quả riêng, giữ dòng chính hiện tại; chỉ đổi khi luật `Link_dead` / `Stale_release` buộc phải đổi. Lúc nối, dòng chính là dòng đợt 2 chọn; cặp mới của đợt 1 vẫn lấy id nhỏ hơn lúc nối. Với cặp đợt 1 chỉ khác ở một ca: store chết được mở lại thì dòng chính không quay về id nhỏ hơn.

Thước đo chính của phương án A: trên DB mẫu, chụp mọi con số theo người theo tháng (và theo nhóm) của các route trên trước khi chạy, chạy đợt 2, so lại: phải trùng 100%. Cron `report-rollup` chạy lại tuần cũ phải ra đúng số cũ.

Ngoại lệ user chốt 23/11 ("bỏ luôn"): nhóm A và B không đóng băng việc giao. Store phụ bị lấy khỏi người đang giữ thì số "được giao" và "để quá hạn" của người đó ở các tháng cũ giảm theo (khoảng 550 game). Test trước/sau so mọi số khác, và kiểm riêng rằng phần chênh của số "được giao" đúng bằng các store phụ nhóm A, B.

### 6.2 Snapshot để xem lại và quay lại

Bảng mới `eval_pair_merge_snapshots (id, run_id, game_evaluation_id, pair_group, row_before jsonb, created_at)`: trước khi sửa, đợt 2 chép nguyên dòng (`to_jsonb(ge.*)`) của **cả 2 dòng** mỗi cặp nó đụng tới. `run_id` để chạy theo từng đợt nhỏ và rollback theo đợt.

Mỗi cặp nối ghi 1 dòng `evaluation_log` kind `pair_merge`, actor `System`, `pair_scope 'store'`, trên dòng phụ: `conclusion_before/after`, `owner`/`owner_after`, `final_before/after`, `batch_before/after`. History hiện câu kiểu "merged iOS into the pair · was Bypass by HaNP", có thể mở xem note cũ đọc từ snapshot (API History đọc snapshot theo `game_evaluation_id`). Nhóm A/C/B dùng `pair_link` sẵn có của đợt 1 khi không có gì bị thay; có thay (B: người giữ store chờ) thì cũng là `pair_merge`.

### 6.3 Chạy

- Migration `055_eval_pairs_phase2.sql`: 3 cột credit, bảng snapshot, hàm phân nhóm (`eval_pair_phase2_plan()` trả mỗi cặp: nhóm, dòng chính, dòng phụ, người giữ, kết quả, final, cờ báo cáo) và hàm áp (`eval_pair_phase2_apply(run_id, max_pairs)`) dùng lại `link_eval_pair` / `eval_pair_fill` của 054. Migration **không** tự áp.
- Bản xem trước: chạy `plan` (chỉ đọc) trên prod, xuất ra Google Sheet hoặc file để user duyệt: mỗi cặp 1 dòng (game, 2 store, nhóm, dòng chính, kết quả sau nối, người giữ sau nối, final, cảnh báo). Có trang tóm tắt theo nhóm.
- Áp theo đợt nhỏ (ví dụ 500 cặp / transaction, khoá cặp bằng `pg_advisory_xact_lock(54, hashtext(family_id))` như đợt 1), giờ vắng, mỗi đợt in số cặp đã nối theo nhóm. Mỗi bước prod cần user nói "go".
- Cặp thay đổi giữa lúc xem trước và lúc áp (có người vừa chấm): `apply` tính lại nhóm ngay trong transaction; nhóm đổi thì vẫn áp theo luật của nhóm mới và ghi cờ vào báo cáo sau chạy.
- Rollback theo `run_id`: gỡ nối các cặp của run, xoá `credit`, xoá log `pair_merge` của run, và trả lại **chỉ những cột run đã ghi**, và chỉ khi giá trị hiện tại vẫn đúng là giá trị run đã ghi. Cột nào đã bị sửa sau run (ai đó chấm lại, video n8n về) thì giữ giá trị mới và liệt kê trong báo cáo rollback. Vì vậy run phải ghi lại, cho từng dòng, những cột nó đổi và giá trị nó ghi (trong snapshot). Viết trong khối ROLLBACK và có script riêng.

### 6.4 Code app

- `lib/eval-pairs.ts`: helper credit (6.1) + test.
- Các route đếm ở 6.1 dùng helper. Test jest cho từng route: dòng phụ có credit được đếm với người/kết luận/ngày credit; dòng phụ không credit không đếm (như đợt 1).
- History (`lib/evaluation-history.ts` + route): verb cho `pair_merge`, đọc note cũ từ snapshot.
- Không đổi UI list/panel: cặp đã nối hiện như đợt 1.

### 6.5 Test

- SQL trên cluster tạm (mở rộng `scripts/verify-eval-pairs.sh`): mỗi nhóm A..F một ca, ca G bị bỏ qua, ca người giữ deactivate, ca 2 final khác ngày, ca media lệch, ca chạy lại (idempotent: lần 2 không làm gì), ca rollback trả đúng từng cột, ca có người chấm giữa plan và apply.
- Trên DB mẫu (bản sao prod): snapshot số liệu theo người theo tháng của các route 6.1 trước khi chạy, chạy đợt 2, so lại: phải trùng 100%. Đếm số cặp theo nhóm khớp bản xem trước.
- Jest cho helper, các route đếm, History.

## 7. Để người build tự quyết

- Cách viết helper credit (fragment UNION hay biểu thức CASE), miễn mọi route đếm dùng chung một chỗ và không chậm rõ rệt.
- Kích thước đợt áp, định dạng file xem trước (Sheet của user hay CSV), miễn user đọc được mỗi cặp 1 dòng.
- Cách đếm backlog ở nhóm A, miễn khớp con số Rescue đang hiện.

## 8. Rủi ro đã biết

- Flow n8n đọc thẳng `game_evaluations` (card Chat, sheet status log) sẽ thấy dòng phụ mang kết quả của dòng chính: có thể đếm 1 lượt chấm thành 2 ở các ngày sau khi chạy. Ghi lại, xử lý riêng.
- Signal Sense đọc theo `game_id`: store phụ ở nhóm E/F sẽ đổi kết luận (ví dụ Bypass thành List_Idea). Đó là ý muốn (quyết định 9), nhưng báo bên Signal Sense trước khi chạy.
- Người đang giữ store chờ ở nhóm B thấy backlog giảm đột ngột (khoảng 456 game rời backlog của người khác). Báo team trước.
