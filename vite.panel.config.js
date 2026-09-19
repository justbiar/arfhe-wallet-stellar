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
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(__dirname, "panel"),
  publicDir: path.resolve(__dirname, "public"),
  plugins: [react()],
  server: { port: 5174 },
  build: {
    outDir: path.resolve(__dirname, "dist-panel"),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@wallet": path.resolve(__dirname, "src"),
    },
  },
});
