/**
 * rateLimiter.ts — Per-IP request cap for the /agent/chat endpoint.
 *
 * Workers have no persistent memory between invocations (and can run as many concurrent
 * isolates), so an in-memory counter would reset constantly and undercount — it looks like
 * a rate limiter locally but does nothing in production. KV is the standard fix: it's
 * shared across the whole edge network and namespace TTLs clean up old buckets for free.
 *
 * This is a fixed-window counter, not a sliding one, and KV reads/writes are only
 * eventually consistent — under concurrent bursts a client can slip a few requests past the
 * limit before the count catches up. That's an acceptable trade for a lightweight abuse
 * guard; it is not a substitute for OpenRouter's own per-key limits.
 */

const WINDOW_SECONDS = 60;

export interface RateLimitResult {
  allowed: boolean;
  /** Requests still permitted in the current window, once this call is counted. */
  remaining: number;
  /** Set only when `allowed` is false — seconds until the current window rolls over. */
  retryAfterSeconds?: number;
}

/**
 * Check and record one request from `clientIp` against `maxRequestsPerWindow` per 60s.
 *
 * @param kv KV namespace bound in wrangler.toml (`RATE_LIMIT_KV`).
 * @param clientIp Caller's IP, e.g. from the `CF-Connecting-IP` header.
 * @param maxRequestsPerWindow Max requests allowed per 60-second window.
 */
export async function checkRateLimit(
  kv: KVNamespace,
  clientIp: string,
  maxRequestsPerWindow: number
): Promise<RateLimitResult> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowBucket = Math.floor(nowSeconds / WINDOW_SECONDS);
  const key = `ratelimit:${clientIp}:${windowBucket}`;

  const currentRaw = await kv.get(key);
  const current = currentRaw ? Number.parseInt(currentRaw, 10) : 0;
  const secondsIntoWindow = nowSeconds % WINDOW_SECONDS;
  const retryAfterSeconds = WINDOW_SECONDS - secondsIntoWindow;

  if (current >= maxRequestsPerWindow) {
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  // TTL outlives the window itself so a request right at the boundary still expires cleanly
  // instead of leaking a stale bucket into KV.
  await kv.put(key, String(current + 1), { expirationTtl: WINDOW_SECONDS * 2 });

  return { allowed: true, remaining: maxRequestsPerWindow - (current + 1) };
}
