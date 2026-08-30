PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(1,'0001_create_users_activity.sql','2026-08-26 18:04:20');
CREATE TABLE users (
  wallet_address TEXT PRIMARY KEY,
  email TEXT,
  source TEXT NOT NULL CHECK (source IN ('google', 'password')),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('send', 'shield', 'unshield')),
  timestamp TEXT NOT NULL
);
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',1);
CREATE INDEX idx_activity_wallet_address ON activity (wallet_address);