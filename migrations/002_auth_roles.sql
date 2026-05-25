-- Rename manager → admin
UPDATE dashboard_users SET role = 'admin' WHERE role = 'manager';
ALTER TABLE dashboard_users DROP CONSTRAINT IF EXISTS dashboard_users_role_check;
ALTER TABLE dashboard_users ADD CONSTRAINT dashboard_users_role_check CHECK (role IN ('admin', 'evaluator'));

-- Seed hungdt as admin (if not exists)
INSERT INTO dashboard_users (email, name, role)
VALUES ('hungdt@athena.studio', 'HungDT', 'admin')
ON CONFLICT (email) DO UPDATE SET role = 'admin';
