# Đề xuất: Signal Management Site
> Phiên bản: Draft 1 — Ngày: 2026-03-19
> Mục đích: Xin ý kiến team về tính năng trước khi làm

---

## Vấn đề hiện tại

Hiện tại team đang quản lý công việc hàng ngày qua nhiều nơi khác nhau:

- **Google Chat** — nhận thông báo khi hệ thống chạy xong (nhưng không lưu lại lịch sử)
- **Google Sheets** — theo dõi trạng thái evaluator, log upload YouTube
- **Smartsheet** — quản lý game list, assign cho evaluator
- **n8n** — phải vào tay để trigger workflow khi cần chạy thủ công
- **Google Forms** — evaluator submit handover khi nghỉ phép

Việc phân tán như vậy khiến khó biết: *hôm nay đã pull bao nhiêu game? ai đang rảnh? flow nào bị lỗi?*

---

## Giải pháp đề xuất

Xây dựng một **trang quản lý tập trung** (Management Site) — một website nội bộ để:
- Xem toàn bộ tình hình hoạt động trong ngày tại một nơi
- Bấm nút để chạy các tác vụ thay vì vào n8n
- Evaluator có thể đăng nhập và tự xử lý việc của mình

**Đăng nhập bằng tài khoản Google** — không cần tạo thêm tài khoản mới.

---

## Đối tượng sử dụng

| Vai trò | Ai | Quyền hạn |
|---------|-----|---------|
| **Manager** | Quản lý team | Xem toàn bộ, điều khiển mọi tác vụ |
| **Evaluator** | Thành viên team | Chỉ xem được trang Handover + Drive Videos |

---

## Các tính năng đề xuất

### 1. Tổng quan (Dashboard)
*Dành cho: Manager*

Trang chủ hiển thị tình hình hoạt động trong ngày:

- **Số game đã import hôm nay** — chia theo category (Puzzle / Arcade / Simulation) và OS (iOS / Android)
- **Trạng thái các tác vụ tự động** — lần chạy gần nhất thành công hay lỗi, lúc mấy giờ
- **Nhật ký hoạt động** — 10 sự kiện gần nhất (import, push Smartsheet, assign, v.v.)

> 💬 *Feedback cần thiết: Ngoài số game theo category, manager còn muốn xem thêm số liệu nào khác không?*

---

### 2. Điều khiển tác vụ (Operations)
*Dành cho: Manager*

Bảng các nút bấm để trigger tác vụ thủ công — thay vì vào n8n:

| Nút | Tác vụ |
|-----|--------|
| ▶ Pull iOS Games | Kéo game mới từ App Store |
| ▶ Pull Android Games | Kéo game mới từ Google Play |
| ▶ Push to Smartsheet | Đẩy game lên Smartsheet |
| ▶ Assign Evaluator | Phân công game cho evaluator |
| ▶ Assign Initial Evaluator | Phân công initial evaluation |
| ▶ Clean Dead Links | Xóa link die trên Smartsheet |

Sau khi bấm: hiện trạng thái đang chạy → hiện kết quả khi xong (số game, lỗi nếu có).

> 💬 *Feedback cần thiết: Còn tác vụ nào khác muốn trigger từ đây không?*

---

### 3. Quản lý Team (Team)
*Dành cho: Manager*

Bảng danh sách evaluator với:

- **Toggle Available / Unavailable** — bật/tắt trạng thái có thể nhận game
- **Games assigned tuần này** — tổng số game đã được phân công
- **Games checked hôm nay** — số game đã xử lý trong ngày (so sánh với hôm qua)

> 💬 *Feedback cần thiết: Ngoài Available toggle, manager còn muốn thao tác gì trực tiếp với evaluator từ đây không? (ví dụ: ghi chú, xem chi tiết lịch sử)*

---

### 4. Upload YouTube (YouTube)
*Dành cho: Manager*

Danh sách video đang chờ upload lên YouTube:

- Xem danh sách video từ Google Drive chưa được upload
- Nút **[Upload All]** để trigger upload toàn bộ
- Trạng thái từng video sau khi upload xong

> 💬 *Feedback cần thiết: Cần xem thêm thông tin gì về video không? (tên game, category, người tạo?)*

---

### 5. Handover (Trang Evaluator)
*Dành cho: Evaluator*

Thay thế Google Form hiện tại — evaluator đăng nhập vào site và submit handover trực tiếp:

- Điền: Tên + Ngày bắt đầu nghỉ + Ngày kết thúc
- Submit → hệ thống tự động redistribute game list của người đó cho các evaluator khác
- Xem lịch sử các lần handover của mình

**Ưu điểm so với Google Form:** Xử lý ngay lập tức (Form hiện tại cần đợi đến 20 phút).

> 💬 *Feedback cần thiết: Evaluator có muốn xem danh sách game nào đang được assign cho mình không?*

---

### 6. Drive Videos (Trang Evaluator) — *Làm sau*
*Dành cho: Evaluator*

- Xem danh sách video trong Google Drive
- Nút **[Request Push]** để yêu cầu upload thủ công cho video bị miss
- Manager nhận request và approve

> 💬 *Feedback cần thiết: Tính năng này có cần thiết không, hay để manager tự xử lý từ Tab YouTube?*

---

## Không thay đổi gì

Để rõ ràng — những thứ sau **giữ nguyên, không sửa**:

- Toàn bộ hệ thống n8n và các automation hiện tại
- Google Sheets đang dùng (evaluator list, handover responses)
- Smartsheet structure
- Quy trình làm việc hiện tại — site chỉ là lớp UI bên trên

---

## Câu hỏi tổng hợp cần feedback

1. Tính năng nào trong 6 tính năng trên là **quan trọng nhất** cần có ngay?
2. Tính năng nào có thể **bỏ hoặc làm sau**?
3. Ngoài Manager và Evaluator, có cần thêm vai trò nào không? (ví dụ: Read-only viewer)
4. Có tính năng nào **đang thiếu** mà bạn muốn thêm vào không?
