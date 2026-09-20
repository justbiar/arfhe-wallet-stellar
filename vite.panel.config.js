/**
 * Vite config for the panel — the TRY <-> USDC demo app, separate from the extension.
 *
 * A second config rather than a second package.json: the panel needs React, MUI and the
 * router, all of which the extension already depends on, and a nested project would mean a
 * second node_modules and two versions of each to keep in step. Sharing the root's
 * dependencies also lets the panel import the extension's own theme (src/components/ArfTheme)
 * instead of holding a copy of the brand tokens that drifts the first time one side changes.
 *
 *   npm run dev:panel     — dev server on 5174 (the extension's uses 5173)
 *   npm run build:panel   — static build into dist-panel/
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Ships `panel/runtime-config.js` beside the bundle, unprocessed.
 *
 * It is deliberately not in `public/`: that directory is shared with the extension build,
 * and the extension has no business carrying the demo's backend addresses. It is also
 * deliberately not bundled — the point is a file that can be edited after a build, when a
 * tunnel rotates, without touching anything else.
 */
function runtimeConfig() {
  const source = path.resolve(__dirname, "panel/runtime-config.js");
  let outDir = "";
  return {
    name: "runtime-config",
    configResolved(config) {
      // The output directory as Vite resolved it, rather than a second guess at the same
      // path — and it is read here because closeBundle has no config to ask.
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use("/runtime-config.js", (_req, res) => {
        res.setHeader("content-type", "text/javascript");
        fs.createReadStream(source).pipe(res);
      });
    },
    closeBundle() {
      if (!outDir) return;
      // mkdir first: a clean checkout has no dist-panel, and copyFileSync reports the
      // missing destination directory as ENOENT on the source, which sent the first CI
      // failure looking for a file that was there all along.
      fs.mkdirSync(outDir, { recursive: true });
      fs.copyFileSync(source, path.join(outDir, "runtime-config.js"));
    },
  };
}

export default defineConfig({
  /**
   * GitHub Pages serves the site from a sub-path, a local server from the root.
   *
   * `PANEL_BASE` carries that difference into the build rather than into two configs, so
   * the published link and `npm run serve:panel` come out of the same file.
   */
  base: process.env.PANEL_BASE ?? "/",
  root: path.resolve(__dirname, "panel"),
  publicDir: path.resolve(__dirname, "public"),
  plugins: [react(), runtimeConfig()],
  server: {
    port: 5174,
    // Some imports resolve to the repo root's node_modules, which is outside this config's
    // `root` (panel/). Without this the dev server refuses to serve them.
    fs: { allow: [path.resolve(__dirname)] },
  },
  assetsInclude: ["**/*.wasm"],
  build: {
    outDir: path.resolve(__dirname, "dist-panel"),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@wallet": path.resolve(__dirname, "src"),
    },
    /**
     * One React, one ReactDOM.
     *
     * The Vite root is panel/ but the dependencies live in the repo root's node_modules, and
     * the @wallet alias reaches back into src/ — two resolution paths into the same packages.
     * Without dedupe that loaded React twice and every hook threw "Invalid hook call", which
     * reads like a mistake in the component and is not one.
     */
    dedupe: ["react", "react-dom", "@mui/material", "@emotion/react", "@emotion/styled"],
  },
});
