-- 0009_add_hunt_completion.sql
--
-- Hunt completion + reward review tracking. Instead of per-task rows in `user_tasks`, we now
-- only need to know whether a user has submitted "I did it" for the whole hunt, and whether an
-- admin has approved/rejected that submission. Adds status/submitted_at/reviewed_at directly
-- to x_users.
--
-- `user_tasks` and `task_submissions_view` are left untouched (old per-task data stays as a
-- historical reference; not read by the new /api/complete-hunt, /api/hunt-status,
-- /api/admin/hunt/* and /api/reveal-reward routes).

ALTER TABLE x_users ADD COLUMN status TEXT DEFAULT NULL;
ALTER TABLE x_users ADD COLUMN submitted_at TEXT;
ALTER TABLE x_users ADD COLUMN reviewed_at TEXT;
