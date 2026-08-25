import { applyD1Migrations, env } from "cloudflare:test";

// Applies migrations/0001_create_users_activity.sql to the local (Miniflare-emulated)
// USERS_DB before any test runs. env.TEST_MIGRATIONS is populated in vitest.config.ts via
// readD1Migrations() — that call must happen in Node.js at config time, so the actual
// migration contents are threaded in as a binding rather than read from disk here.
await applyD1Migrations(env.USERS_DB, env.TEST_MIGRATIONS);
