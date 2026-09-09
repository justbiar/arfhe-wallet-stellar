-- 0006_fix_omer_title.sql
--
-- 0005_seed_tasks.sql's id=4 row ("Follow Ömer Aydoğan on X") landed in D1 as mangled
-- "Follow Ã–mer AydoÄŸan on X" — classic UTF-8-bytes-read-as-Latin-1-then-re-encoded-to-UTF-8
-- double-encoding, not a bad source file (migrations/0005_seed_tasks.sql's bytes for Ö/ğ were
-- verified correct: C3 96 / C4 9F, valid UTF-8). Whatever ingested the file down the line
-- (wrangler's D1 execute path, or the terminal/shell it ran through) read those UTF-8 bytes as
-- Latin-1/CP-1252 and wrote the resulting 4 garbled characters back out as UTF-8 — which is
-- exactly the "Ã–" / "ÄŸ" pattern seen in the row.

UPDATE tasks
SET title = 'Follow Ömer Aydoğan on X'
WHERE id = 4;
