/**
 * Serves the built panel, with the headers the build expects.
 *
 * `dist-panel/_headers` is a Cloudflare Pages file; nothing reads it locally, so a plain
 * static server drops cross-origin isolation and the privacy page's prover loses
 * SharedArrayBuffer — it fails in the worker, far from the missing header. This sends the
 * same two headers the dev server does.
 *
 *   node scripts/serve-panel.mjs [port]
 *
 * For sharing a build over a tunnel. `npm run dev:panel` remains the way to develop.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";

const ROOT = new URL("../dist-panel/", import.meta.url).pathname;
const PORT = Number(process.argv[2] ?? 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".gz": "application/gzip",
  // The extension build, offered for download from the wallet page.
  ".zip": "application/zip",
  ".bin": "application/octet-stream",
  ".r1cs": "application/octet-stream",
};

const server = createServer(async (req, res) => {
  const headers = {
    // Same pair the dev server sends. `credentialless` so Horizon and the anchor answer
    // without having to send CORP headers of their own.
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "credentialless",
  };

  // A visitor who cancels a download — or a tunnel that drops mid-transfer — destroys the
  // socket, and the write below rejects. Unhandled, that error is an event on the request
  // and the response objects, and Node turns an unhandled 'error' event into a crash. This
  // server had exactly one job left running behind a public URL; it took the site down.
  req.on("error", () => {});
  res.on("error", () => {});

  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    // normalize() before join() so a path cannot climb out of dist-panel.
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(ROOT, rel);

    const found = await stat(file).catch(() => null);
    if (!found || found.isDirectory()) file = join(ROOT, "index.html");

    const body = await readFile(file);
    res.writeHead(200, { ...headers, "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    // Nothing can be said to a response that is already on the wire. Trying anyway is what
    // threw ERR_HTTP_HEADERS_SENT out of the catch block, where nothing caught it.
    if (res.headersSent) return void res.destroy();

    // A hash router serves every route from one document; a miss is a path, not a 404.
    try {
      res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
      res.end(await readFile(join(ROOT, "index.html")));
    } catch {
      if (res.headersSent) return void res.destroy();
      res.writeHead(500, headers);
      res.end("dist-panel not built — run npm run build:panel");
    }
  }
});

// Malformed requests reach the server, not a request handler, and are fatal by default.
server.on("clientError", (_err, socket) => socket.destroy());

server.listen(PORT, () => console.log(`panel → http://localhost:${PORT}`));
