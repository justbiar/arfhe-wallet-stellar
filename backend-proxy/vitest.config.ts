import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// Migration file contents are read here (Node.js config context) and threaded into the
// worker under test as a TEST_MIGRATIONS binding — applyMigrations.ts then applies them to
// the local (Miniflare-emulated) USERS_DB before any test runs. See
// src/__tests__/setup/applyMigrations.ts.
const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

export default defineConfig({
  test: {
    setupFiles: ["./src/__tests__/setup/applyMigrations.ts"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
});
