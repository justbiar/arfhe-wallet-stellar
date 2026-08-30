-- 0002_users_source_enum_drop_email.sql
--
-- Two changes to `users`:
--   1. `source` grows from a 2-value enum ('google', 'password') to 4 values that
--      distinguish how the wallet's key material was obtained: 'google', 'created',
--      'mnemonic', 'private_key'. Previously every non-Google flow (new wallet, mnemonic
--      import, private key import) collapsed into 'password', making them indistinguishable.
--   2. The `email` column is dropped — it was only ever populated by the Google/Web3Auth
--      flow and isn't needed for pseudonymous wallet_address-keyed tracking.
--
-- SQLite can't ALTER a CHECK constraint or DROP a column with one in place, so this
-- rebuilds the table: create new -> copy data -> drop old -> rename.
--
-- Existing rows all have source = 'password'; since the specific origin (new wallet vs.
-- mnemonic vs. private key import) isn't recoverable retroactively, they are mapped to
-- 'created' as the default/most-common case.

CREATE TABLE users_new (
  wallet_address TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('google', 'created', 'mnemonic', 'private_key')),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

INSERT INTO users_new (wallet_address, source, first_seen, last_seen)
SELECT
  wallet_address,
  CASE WHEN source = 'password' THEN 'created' ELSE source END,
  first_seen,
  last_seen
FROM users;

DROP TABLE users;

ALTER TABLE users_new RENAME TO users;
