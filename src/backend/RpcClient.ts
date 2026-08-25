/**
 * RpcClient — the shared gate every JSON-RPC read passes through.
 *
 * The wallet's screens are independent by design: Home, Privacy, the shield panel and the
 * send panel each resolve what they need without asking the others. That independence is
 * what made the request volume explode. Opening the wallet mounts several of them at once,
 * and each fires its own `eth_call` for the same token metadata, against the same node, in
 * the same tick. The provider sees a burst; the user sees "too many requests".
 *
 * Three mechanisms, in the order a request meets them:
 *
 *  1. **Cache** — an answer that was just fetched is reused. Scoped by TTL, because not all
 *     reads age alike: `decimals()` cannot change, a balance changes every block.
 *
 *  2. **Coalescing** — identical requests already in flight share one promise rather than
 *     opening a second connection. This is the one that matters most on mount, where the
 *     duplicates are simultaneous and a cache written on completion is still empty.
 *
 *  3. **Concurrency limit** — per host, so a batch of a hundred reads becomes a steady
 *     stream instead of a hundred parallel sockets. Providers rate-limit on burst rate far
 *     more aggressively than on total volume.
 *
 * Writes never come through here. `eth_sendRawTransaction` must not be cached, coalesced or
 * queued behind reads, and nothing in this file should ever be taught to handle it.
 */

/** Reads whose answer is fixed for the lifetime of a contract. */
const IMMUTABLE_METHODS = new Set(["eth_chainId", "net_version"]);

/**
 * `eth_call` selectors whose result cannot change after deployment.
 *
 * Metadata is re-read constantly — every token row, every asset picker, every shield
 * option resolves the same `symbol()`/`decimals()` on the same address. Caching by
 * selector rather than by method is what lets those share an answer while a balance read
 * against the same contract stays live.
 */
const IMMUTABLE_SELECTORS = new Set([
  "0x313ce567", // decimals()
  "0x95d89b41", // symbol()
  "0x06fdde03", // name()
  "0x2c4e722e", // rate()
  "0x6f307dc3", // underlying()
  "0xa415f269", // balanceOfIsIndicator()
  "0x3fc8cef3", // weth()
]);

/** How long each class of read stays usable. */
const TTL = {
  /** Fixed at deployment — an hour is arbitrary; it could be forever. */
  immutable: 60 * 60_000,
  /** Chain head and balances. Long enough to absorb a mount storm, short enough to be live. */
  volatile: 4_000,
  /** Block number: several callers ask within the same tick, and it moves in ~12s. */
  blockNumber: 6_000,
} as const;

/** Reads that are never worth caching — the answer is the point of asking again. */
const NEVER_CACHE = new Set([
  "eth_sendRawTransaction",
  "eth_sendTransaction",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getTransactionCount",
]);

/**
 * Simultaneous requests per host.
 *
 * Chosen against provider burst limits rather than throughput: Alchemy and friends admit a
 * high request *count* but throttle hard on concurrent connections from one key. Eight
 * keeps a full token-list scan moving without tripping that.
 */
const MAX_CONCURRENT_PER_HOST = 8;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/** A queued request waiting for a concurrency slot. */
interface Waiter {
  resolve: () => void;
}

export class RpcClient {
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<unknown>>();

  /** Active request count per host, and who is waiting for a slot. */
  private active = new Map<string, number>();
  private queue = new Map<string, Waiter[]>();

  /** Counters for the diagnostics screen — plain numbers, no request contents. */
  private stats = { hits: 0, coalesced: 0, sent: 0, rateLimited: 0 };

  /**
   * How long a request for `method` may be reused.
   *
   * Returns 0 for anything that must go to the network.
   */
  private ttlFor(method: string, params: unknown[]): number {
    if (NEVER_CACHE.has(method)) return 0;
    if (IMMUTABLE_METHODS.has(method)) return TTL.immutable;
    if (method === "eth_blockNumber") return TTL.blockNumber;

    if (method === "eth_call") {
      const data = (params?.[0] as { data?: string } | undefined)?.data;
      const selector = typeof data === "string" ? data.slice(0, 10).toLowerCase() : "";
      if (IMMUTABLE_SELECTORS.has(selector)) return TTL.immutable;
      return TTL.volatile;
    }

    if (method === "eth_getBalance" || method === "eth_getCode" || method === "eth_getStorageAt") {
      return TTL.volatile;
    }

    // Receipts flip from null to final exactly once, so a stale null is the one answer
    // that must never be served — a caller polling for confirmation would never see it.
    return 0;
  }

  private keyFor(url: string, method: string, params: unknown[]): string {
    return `${url}|${method}|${JSON.stringify(params)}`;
  }

  private hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  /** Take a concurrency slot for `host`, waiting in line if the limit is reached. */
  private async acquire(host: string): Promise<void> {
    const running = this.active.get(host) ?? 0;
    if (running < MAX_CONCURRENT_PER_HOST) {
      this.active.set(host, running + 1);
      return;
    }
    await new Promise<void>((resolve) => {
      const waiters = this.queue.get(host) ?? [];
      waiters.push({ resolve });
      this.queue.set(host, waiters);
    });
  }

  /** Release a slot, handing it straight to the next waiter if there is one. */
  private release(host: string): void {
    const waiters = this.queue.get(host);
    if (waiters && waiters.length > 0) {
      // The slot is passed on rather than decremented and re-taken, so the count cannot
      // dip and let an extra request in between the two operations.
      waiters.shift()!.resolve();
      return;
    }
    this.active.set(host, Math.max(0, (this.active.get(host) ?? 1) - 1));
  }

  /**
   * Run `fetcher` under the cache, coalescing and concurrency rules.
   *
   * `fetcher` performs the actual transport and is supplied by the caller, so this class
   * stays free of retry policy, headers and error classification — all of which already
   * live in Network.
   */
  async request<T>(
    url: string,
    method: string,
    params: unknown[],
    fetcher: () => Promise<T>
  ): Promise<T> {
    const ttl = this.ttlFor(method, params);
    const key = this.keyFor(url, method, params);
    const now = Date.now();

    if (ttl > 0) {
      const hit = this.cache.get(key);
      if (hit && hit.expiresAt > now) {
        this.stats.hits++;
        return hit.value as T;
      }
    }

    // Coalescing applies even to uncacheable reads: two screens asking for the same
    // receipt in the same tick still only need one round trip.
    const pending = this.inFlight.get(key);
    if (pending) {
      this.stats.coalesced++;
      return pending as Promise<T>;
    }

    const host = this.hostOf(url);
    const run = (async () => {
      await this.acquire(host);
      try {
        this.stats.sent++;
        const value = await fetcher();
        if (ttl > 0) this.cache.set(key, { value, expiresAt: Date.now() + ttl });
        return value;
      } finally {
        this.release(host);
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, run);
    return run;
  }

  /**
   * Take a concurrency slot for a request this class is not otherwise managing.
   *
   * Batched calls carry many methods in one HTTP request, so they cannot be keyed or
   * cached here — but they still occupy a connection, and letting them bypass the limit
   * would defeat it exactly when the volume is highest.
   *
   * @returns The matching release function. Always call it in a `finally`.
   */
  async slot(url: string): Promise<() => void> {
    const host = this.hostOf(url);
    await this.acquire(host);
    this.stats.sent++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(host);
    };
  }

  /** Record that a provider rate-limited us, for the diagnostics screen. */
  noteRateLimited(): void {
    this.stats.rateLimited++;
  }

  /**
   * Drop cached answers, optionally only those for one URL.
   *
   * Called after a transaction confirms: the balances the cache holds describe the state
   * before it, and serving them would show the user a send that appears not to have
   * happened. In-flight requests are deliberately left alone — they were issued against
   * the same pre-transaction state and their callers already handle staleness.
   */
  invalidate(url?: string): void {
    if (!url) {
      this.cache.clear();
      return;
    }
    const prefix = `${url}|`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  /**
   * Forget cached *volatile* answers while keeping immutable ones.
   *
   * After a transaction, balances are wrong but `decimals()` is not. Re-fetching token
   * metadata that cannot have changed is precisely the waste this class exists to remove.
   */
  invalidateVolatile(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      // Immutable entries are the only ones with a horizon this far out, which makes the
      // remaining lifetime a reliable way to tell the two classes apart without storing
      // a second field on every entry.
      if (entry.expiresAt - now <= TTL.blockNumber) this.cache.delete(key);
      else if (entry.expiresAt - now < TTL.immutable / 2) this.cache.delete(key);
    }
  }

  /** Counters for the diagnostics screen. */
  getStats(): { hits: number; coalesced: number; sent: number; rateLimited: number; cacheSize: number } {
    return { ...this.stats, cacheSize: this.cache.size };
  }

  /** Wipe everything — used on wallet lock, so no chain reads survive in memory. */
  reset(): void {
    this.cache.clear();
    this.inFlight.clear();
    this.stats = { hits: 0, coalesced: 0, sent: 0, rateLimited: 0 };
  }
}

/**
 * One client for the whole wallet.
 *
 * Coalescing only works if every caller shares the same map, and the callers are spread
 * across independently constructed Network instances — one per chain, several alive at
 * once. A per-Network client would coalesce nothing.
 */
export const rpcClient = new RpcClient();
