-- Migration 040: dọn các dòng "tự từ chối chính mình" trong History.
--
-- Trước bản này, bỏ một chip khỏi danh sách tag luôn tạo ra một dòng `rejected`,
-- kể cả khi người bỏ chính là người vừa đề xuất nó. History vì thế đầy những
-- dòng Proposed và Reviewed cùng một tên — không kể lại quyết định nào, chỉ nói
-- rằng ai đó đổi ý trước khi có admin nào nhìn tới tag.
--
-- Route PUT giờ xoá thẳng những dòng đó thay vì log. Migration này dọn phần đã
-- tích trong prod theo đúng một điều kiện: rejected, người đề xuất = người
-- "duyệt", và chưa ai khác sửa (edited_by NULL) — tức chưa ai ngoài chủ tag can
-- dự vào. Mọi dòng rejected còn lại là quyết định về việc của người khác và giữ
-- nguyên.
--
-- Không đụng tới custom_field_values: dòng rejected chưa bao giờ được sync sang
-- Signal Sense, nên xoá nó không lấy đi tag nào của ai.

BEGIN;

DELETE FROM playtest_tags
WHERE status = 'rejected'
  AND confirmed_by IS NOT NULL
  AND confirmed_by = tagged_by
  AND edited_by IS NULL;

COMMIT;
