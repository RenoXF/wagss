-- 008_rbac: add role column to users.
-- Default 'user'; the auto-seeded first user (root) becomes admin.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
-- Backfill: first user (lowest id) is admin if still default 'user'
UPDATE users SET role = 'admin' WHERE id = (SELECT min(id) FROM users) AND role = 'user';
-- Also ensure any user named 'root' is admin (idempotent)
UPDATE users SET role = 'admin' WHERE username = 'root' AND role = 'user';
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
