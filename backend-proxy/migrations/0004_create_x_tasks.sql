-- 0004_create_x_tasks.sql
--
-- X (Twitter) login tracking + task/quest completion for the "X ile giriş yap ve görevleri
-- tamamla" flow (see /api/x-login, /api/tasks, /api/user-tasks in src/index.ts).
--
-- x_users.x_user_id is X's own immutable numeric user id — the identity key. x_username is
-- kept unique too so two different X accounts can never collide on a display name, but it is
-- not the identity key because usernames can change; x_user_id is what every other table
-- references.

CREATE TABLE IF NOT EXISTS x_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  x_username TEXT NOT NULL UNIQUE,
  x_user_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

-- UNIQUE(user_id, task_id) is what makes submission a one-shot action: a second POST
-- /api/user-tasks for the same (user, task) pair hits the constraint instead of creating a
-- duplicate 'pending' row, and the Worker turns that into a 409.
CREATE TABLE IF NOT EXISTS user_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES x_users(id),
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_at TEXT NOT NULL,
  reviewed_at TEXT,
  UNIQUE (user_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_user_tasks_user_id ON user_tasks (user_id);
