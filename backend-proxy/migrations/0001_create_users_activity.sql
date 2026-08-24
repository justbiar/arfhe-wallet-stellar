-- 0001_create_users_activity.sql
--
-- Pseudonymous user/activity tracking for arfio-users (D1). Deliberately no amount/value
-- column in either table — action_type only records that a send/shield/unshield happened,
-- never how much, to avoid contradicting the FHE-shielded-balance architecture (see
-- FHE_COMPLETE_GUIDE.md) with a plaintext amount log sitting next to it.

CREATE TABLE IF NOT EXISTS users (
  wallet_address TEXT PRIMARY KEY,
  email TEXT,
  source TEXT NOT NULL CHECK (source IN ('google', 'password')),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('send', 'shield', 'unshield')),
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_wallet_address ON activity (wallet_address);
