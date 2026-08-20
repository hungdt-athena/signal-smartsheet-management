-- Migration 038: moderator trở lại thành một tier riêng.
--
-- Migration 032 đã xoá role này bằng cách UPDATE mọi moderator thành admin, nên
-- người làm triage buộc phải là admin đầy đủ. Moderator nay bằng admin ở mọi
-- màn hình, trừ ba khoản: tag của họ vẫn qua queue, Final Conclusion + Final
-- Note là của admin, và họ không đổi được role hay xoá user.
--
-- Không backfill: không ai tự nhiên thành moderator, admin gán tay ở Users
-- Management. Các row đã bị 032 nâng lên admin ở lại admin — không có cách nào
-- biết row nào từng là moderator, và đoán thì nguy hiểm hơn là để nguyên.

ALTER TABLE dashboard_users DROP CONSTRAINT IF EXISTS dashboard_users_role_check;
ALTER TABLE dashboard_users ADD CONSTRAINT dashboard_users_role_check
  CHECK (role IN ('admin', 'moderator', 'evaluator'));
