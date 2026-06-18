-- 011 down: revert the password_hash column added in 011_user_password.up.sql.

ALTER TABLE users DROP COLUMN IF EXISTS password_hash;
