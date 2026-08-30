PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(1,'0001_create_users_activity.sql','2026-08-24 17:11:40');
CREATE TABLE users (
  wallet_address TEXT PRIMARY KEY,
  email TEXT,
  source TEXT NOT NULL CHECK (source IN ('google', 'password')),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
INSERT INTO "users" ("wallet_address","email","source","first_seen","last_seen") VALUES('0x96d701F8A3C08BD0bB7Ef545db3AbebAA1439d4D','fastmers44@gmail.com','google','2026-08-25T14:45:37.196Z','2026-08-25T14:45:37.196Z');
INSERT INTO "users" ("wallet_address","email","source","first_seen","last_seen") VALUES('0xE07C6b63cF84ea4fC7034F56B676b1AFeea96aC3','fastmers44@gmail.com','google','2026-08-26T12:28:54.047Z','2026-08-29T18:18:31.589Z');
INSERT INTO "users" ("wallet_address","email","source","first_seen","last_seen") VALUES('0x74756646A46Df5F1d5337DEE1e4E70C2C400DEaf',NULL,'password','2026-08-28T20:48:01.179Z','2026-08-28T20:48:01.179Z');
INSERT INTO "users" ("wallet_address","email","source","first_seen","last_seen") VALUES('0x78c3B9137B36e438435aDddEa34ef0D483de4c63',NULL,'password','2026-08-28T20:49:57.246Z','2026-08-28T20:49:57.246Z');
CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('send', 'shield', 'unshield')),
  timestamp TEXT NOT NULL
);
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(1,'0x9332339e54A27f9350C7Be300b4B9dEBc7D1c350','send','2026-08-24T17:20:48.808Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(2,'0x8B2265b98f6594bF60930f702a53584ea8026977','send','2026-08-26T15:14:40.280Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(3,'0x8B2265b98f6594bF60930f702a53584ea8026977','shield','2026-08-26T15:16:04.101Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(4,'0x8B2265b98f6594bF60930f702a53584ea8026977','send','2026-08-26T18:12:38.354Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(5,'0xE76e2aC03C3eEC2215d82F468cE30bBD36Afa0F9','send','2026-08-27T11:06:40.103Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(6,'0xE76e2aC03C3eEC2215d82F468cE30bBD36Afa0F9','shield','2026-08-27T11:08:16.133Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(7,'0xE76e2aC03C3eEC2215d82F468cE30bBD36Afa0F9','send','2026-08-27T13:11:29.458Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(8,'0xE76e2aC03C3eEC2215d82F468cE30bBD36Afa0F9','unshield','2026-08-27T13:13:17.604Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(9,'0x8B2265b98f6594bF60930f702a53584ea8026977','send','2026-08-27T19:44:39.773Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(10,'0x8B2265b98f6594bF60930f702a53584ea8026977','send','2026-08-27T19:46:52.796Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(11,'0x8B2265b98f6594bF60930f702a53584ea8026977','send','2026-08-27T19:47:15.412Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(12,'0xE76e2aC03C3eEC2215d82F468cE30bBD36Afa0F9','send','2026-08-27T19:48:01.887Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(13,'0x8B2265b98f6594bF60930f702a53584ea8026977','send','2026-08-28T17:43:04.175Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(14,'0xE07C6b63cF84ea4fC7034F56B676b1AFeea96aC3','send','2026-08-28T19:19:25.303Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(15,'0xE76e2aC03C3eEC2215d82F468cE30bBD36Afa0F9','send','2026-08-28T20:19:16.512Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(16,'0xE76e2aC03C3eEC2215d82F468cE30bBD36Afa0F9','send','2026-08-28T20:19:53.091Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(17,'0xE76e2aC03C3eEC2215d82F468cE30bBD36Afa0F9','send','2026-08-28T20:21:01.553Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(18,'0x045680cD394dECE4477830FA73dbCD7D94A7FD49','send','2026-08-28T20:21:28.905Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(19,'0xE76e2aC03C3eEC2215d82F468cE30bBD36Afa0F9','send','2026-08-28T20:24:13.123Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(20,'0x011394599d3dd2d52c72Ebc285CE5df60c9b130A','send','2026-08-28T20:26:15.228Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(21,'0x8B2265b98f6594bF60930f702a53584ea8026977','send','2026-08-28T20:26:17.620Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(22,'0x045680cD394dECE4477830FA73dbCD7D94A7FD49','send','2026-08-28T20:33:39.881Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(23,'0xE07C6b63cF84ea4fC7034F56B676b1AFeea96aC3','send','2026-08-29T23:02:14.359Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(24,'0xE07C6b63cF84ea4fC7034F56B676b1AFeea96aC3','shield','2026-08-29T23:27:02.937Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(25,'0xE07C6b63cF84ea4fC7034F56B676b1AFeea96aC3','send','2026-08-29T23:28:26.322Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(26,'0x045680cD394dECE4477830FA73dbCD7D94A7FD49','shield','2026-08-29T23:29:26.659Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(27,'0x045680cD394dECE4477830FA73dbCD7D94A7FD49','shield','2026-08-29T23:30:03.350Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(28,'0x045680cD394dECE4477830FA73dbCD7D94A7FD49','unshield','2026-08-29T23:31:05.707Z');
INSERT INTO "activity" ("id","wallet_address","action_type","timestamp") VALUES(29,'0x045680cD394dECE4477830FA73dbCD7D94A7FD49','shield','2026-08-29T23:33:03.690Z');
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',1);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('activity',29);
CREATE INDEX idx_activity_wallet_address ON activity (wallet_address);
