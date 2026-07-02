-- 026: add 'Playtest & Bypass' to the initial-conclusion option list.
-- Appended after the existing options (sort_order 16). Idempotent — re-running
-- is a no-op thanks to the (field, value) unique constraint.
INSERT INTO config_options (field, value, sort_order) VALUES
  ('conclusion', 'Playtest & Bypass', 16)
ON CONFLICT (field, value) DO NOTHING;
