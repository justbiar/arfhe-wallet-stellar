-- 0007_create_task_review_view.sql
--
-- Read-only convenience view joining `user_tasks` with `x_users` and `tasks`, for reviewing
-- task submissions (who submitted what, its status, and when). No table schema changes.

CREATE VIEW task_submissions_view AS
SELECT
  ut.id AS submission_id,
  xu.x_username,
  xu.x_user_id,
  t.title AS task_title,
  t.description AS task_description,
  ut.status,
  ut.submitted_at,
  ut.reviewed_at
FROM user_tasks ut
JOIN x_users xu ON ut.user_id = xu.id
JOIN tasks t ON ut.task_id = t.id
ORDER BY ut.submitted_at DESC;
