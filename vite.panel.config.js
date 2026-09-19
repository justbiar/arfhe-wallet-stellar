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
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the SPP SDK keeps its compiled circuits (83MB of r1cs, witness graphs and Groth16
 * proving keys). Resolved from the installed package rather than copied into `public/`:
 * that directory is shared with the extension build, and nothing this large belongs in a
 * Chrome Web Store package.
 */
// Resolved through an exported subpath, because the package's `exports` map deliberately
// does not expose package.json — asking for it throws rather than returning a path.
const sppCircuitsDir = path.dirname(
  fileURLToPath(import.meta.resolve("stellar-private-payments/circuits/NOTICE.txt"))
);

/** Serves the circuits at a stable path the page can pass as `circuitsBaseUrl`. */
function serveSppCircuits() {
  return {
    name: "serve-spp-circuits",
    configureServer(server) {
      server.middlewares.use("/spp-circuits", (req, res, next) => {
        const name = path.basename(decodeURIComponent((req.url ?? "").split("?")[0]));
        const file = path.join(sppCircuitsDir, name);
        if (!name || !fs.existsSync(file)) return next();
        res.setHeader("content-type", "application/octet-stream");
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  root: path.resolve(__dirname, "panel"),
  publicDir: path.resolve(__dirname, "public"),
  plugins: [react(), serveSppCircuits()],
  server: {
    port: 5174,
    /**
     * Cross-origin isolation, for the privacy-pool page.
     *
     * The SPP SDK proves in a Web Worker that wants SharedArrayBuffer, and the browser
     * only hands that out to an isolated document. `credentialless` rather than
     * `require-corp` so the Stellar RPC and Horizon fetches still go through without
     * those servers having to send us CORS headers they have no reason to send.
     */
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
    // The SDK's wasm and workers live in the repo root's node_modules, which is outside
    // this config's `root` (panel/). Without this the dev server refuses to serve them.
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
  /**
   * The SPP SDK must reach the browser as native ESM.
   *
   * It finds its own workers and wasm with `new URL('../dist/...', import.meta.url)`.
   * Pre-bundling rewrites the module into a flattened chunk, `import.meta.url` then
   * points at that chunk, the sibling files are not beside it, and proving hangs with no
   * error — the same failure bb.js has, for the same reason.
   */
  optimizeDeps: {
    exclude: ["stellar-private-payments"],
  },
});
