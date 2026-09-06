-- 0005_seed_tasks.sql
--
-- Seeds the initial 5 active tasks for the X-login task flow (see migrations/0004_create_x_tasks.sql,
-- GET /api/tasks in src/index.ts). created_at uses strftime to match the ISO 8601 format
-- (`new Date().toISOString()`) the Worker itself writes everywhere else in this DB.

INSERT INTO tasks (title, description, active, created_at) VALUES
  ('Follow Arfhe Wallet on X', 'Follow @arfhewallet on X (Twitter): https://x.com/arfhewallet', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Follow ArfDAO on X', 'Follow @arfdao on X (Twitter): https://x.com/arfdao', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Follow Biar Arf on X', 'Follow @justbiar on X (Twitter): https://x.com/justbiar', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Follow Ömer Aydoğan on X', 'Follow @relax4400 on X (Twitter): https://x.com/relax4400', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Like and comment on our post', 'Like and leave a comment on this post: https://x.com/arfhewallet/status/2094138498110419429', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
