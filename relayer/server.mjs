/**
 * The relayer, as an HTTP service.
 *
 *   POST /relay   {pool, proof, extData}  ->  {hash}
 *   GET  /health                          ->  {ok, publicKey, pools}
 *
 * Deliberately built on node:http with no framework: the whole service is one endpoint
 * that takes two opaque strings, and every dependency here is one more thing that sees
 * payloads it has no reason to see.
 *
 * ── On logging ──
 *
 * Nothing about a payload is logged. Not the arguments, not the recipient, not the amount.
 * The relayer already learns a caller's IP and the timing of their transfer, which is the
 * unavoidable cost of the service; writing the rest to disk would turn a service that
 * cannot see much into one that remembers everything it could.
 */

import { createServer } from "node:http";
import { createRelayer } from "./relay.mjs";
import { RelayRefused } from "./policy.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const SECRET = process.env.RELAYER_SECRET;
const POOLS = (process.env.RELAYER_POOLS ?? "").split(",").map((p) => p.trim()).filter(Boolean);

/** Requests per window, per address. Crude on purpose — see the note in README. */
const RATE_LIMIT = Number(process.env.RELAYER_RATE_LIMIT ?? 10);
const RATE_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 64 * 1024;

if (!SECRET || POOLS.length === 0) {
  console.error("RELAYER_SECRET and RELAYER_POOLS are required");
  process.exit(1);
}

const relayer = createRelayer({ secret: SECRET, allowedPools: POOLS });

/** hits per source, oldest first, trimmed on read. */
const hits = new Map();
function rateLimited(key) {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > RATE_LIMIT;
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RelayRefused("body too large", "bad_request");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RelayRefused("body is not JSON", "bad_request");
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true, publicKey: relayer.publicKey, pools: relayer.allowedPools });
  }
  // A bare "not found" is what this answered before, and it reads as a broken service to
  // anyone who opened the port in a browser — which can only ever send a GET. Saying what
  // the routes are costs nothing and leaks nothing that /health does not already publish.
  if (req.url === "/relay" && req.method !== "POST") {
    return send(res, 405, {
      error: "/relay takes POST with {pool, proof, extData}",
      code: "method_not_allowed",
    });
  }
  if (req.method !== "POST" || req.url !== "/relay") {
    return send(res, 404, {
      error: "not found",
      endpoints: ["GET /health", "POST /relay {pool, proof, extData}"],
    });
  }

  const source = req.socket.remoteAddress ?? "unknown";
  if (rateLimited(source)) {
    return send(res, 429, { error: "too many requests", code: "rate_limited" });
  }

  try {
    const body = await readBody(req);
    const result = await relayer.relay(body);
    // The hash is the caller's to watch. Confirmation happens here too, but only so a
    // failure is reported as one rather than as a hash that never lands.
    const status = await relayer.confirm(result.hash);
    return send(res, 200, { ...result, status });
  } catch (e) {
    if (e instanceof RelayRefused) {
      const status = e.code === "rate_limited" ? 429 : e.code === "bad_request" ? 400 : 422;
      return send(res, status, { error: e.message, code: e.code });
    }
    // Nothing from the payload goes into this line.
    console.error("relay failed:", e?.message ?? "unknown error");
    return send(res, 500, { error: "relay failed" });
  }
});

server.listen(PORT, () => {
  console.log(`relayer on :${PORT} as ${relayer.publicKey}`);
  console.log(`pools: ${relayer.allowedPools.join(", ")}`);
});
