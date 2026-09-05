-- 011_immutable_users: add protected column to prevent editing/deleting default users
ALTER TABLE users ADD COLUMN IF NOT EXISTS protected BOOLEAN NOT NULL DEFAULT false;
