-- 041: deactivating a user replaces deleting one.
--
-- Removing a row from dashboard_users threw away the only record that a name
-- belonged to a real person, while every game they evaluated kept that name. So
-- Users Management no longer deletes: it deactivates. An inactive user cannot
-- sign in, is dropped from every evaluator dropdown, and disappears from
-- Config > People — but the row, and the history attached to it, stays.
ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

-- Partial index: every "who can sign in / who shows in a filter" query reads the
-- active rows, and the inactive tail only ever grows.
CREATE INDEX IF NOT EXISTS idx_dashboard_users_active ON dashboard_users(lower(name)) WHERE active;
