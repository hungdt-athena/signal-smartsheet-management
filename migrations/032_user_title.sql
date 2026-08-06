-- 032: user title classification (Admin / Fulltime / Freelancer / Recorder).
-- Nullable — set manually per user in Users Management. Valid values are
-- enforced in the API, not a CHECK, so new titles can ship without a migration.
ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS title TEXT;

-- The moderator role is retired (manager tier = admin only). No moderator rows
-- exist in prod; this is a safety net for any stray one.
UPDATE dashboard_users SET role = 'admin' WHERE role = 'moderator';
