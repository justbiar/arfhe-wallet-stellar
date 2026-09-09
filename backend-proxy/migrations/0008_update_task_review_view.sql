-- 0008_update_task_review_view.sql
--
-- Drops x_user_id from task_submissions_view (see 0007_create_task_review_view.sql). SQLite
-- has no ALTER VIEW, so the view is dropped and recreated.

DROP VIEW IF EXISTS task_submissions_view;

CREATE VIEW task_submissions_view AS
SELECT
  ut.id AS submission_id,
  xu.x_username,
  t.title AS task_title,
  t.description AS task_description,
  ut.status,
  ut.submitted_at,
  ut.reviewed_at
FROM user_tasks ut
JOIN x_users xu ON ut.user_id = xu.id
JOIN tasks t ON ut.task_id = t.id
ORDER BY ut.submitted_at DESC;
