-- Migration 039: ai đã sửa một đề xuất, tách khỏi ai đã duyệt nó.
--
-- Migration 037 lưu được tag gốc (original_*), nhưng không lưu ai sửa. Cột duy
-- nhất mang tên người là confirmed_by, và nó bị ghi lại ở lúc confirm — mượn nó
-- để ghi người sửa thì đúng cái thông tin đó biến mất ngay khi tag được duyệt,
-- kể cả khi người duyệt là người khác.
--
-- Nên một dòng lịch sử giờ đọc được đủ ba vai: tagged_by đề xuất, edited_by sửa,
-- confirmed_by chốt. Cả ba đều có thể là ba người khác nhau, và thường là vậy.
--
-- Áp cho cả hai đường sửa: khu review trong Evaluate panel (PATCH) và hộp thoại
-- Manage Trends Tags (PUT). Hai đường cùng ghi một kiểu, nếu không thì cùng một
-- hành động lại để lại hai dấu vết khác nhau.
--
-- Không backfill: các lần sửa trước migration này không ai biết là của ai, và
-- đoán thì tệ hơn là để trống.

ALTER TABLE playtest_tags
  ADD COLUMN IF NOT EXISTS edited_by text,
  ADD COLUMN IF NOT EXISTS edited_at timestamptz;
