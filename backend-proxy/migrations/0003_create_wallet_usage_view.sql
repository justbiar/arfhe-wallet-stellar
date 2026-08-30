-- 0003_create_wallet_usage_view.sql
--
-- Read-only convenience view joining `users` with its `activity` row count, for the admin
-- dashboard / ad-hoc queries. No table schema changes.

CREATE VIEW wallet_usage AS
SELECT
  u.wallet_address,
  u.source,
  u.first_seen AS created_at,
  u.last_seen AS last_activity,
  COUNT(a.id) AS transaction_count
FROM users u
LEFT JOIN activity a ON a.wallet_address = u.wallet_address
GROUP BY u.wallet_address
ORDER BY transaction_count DESC;
