/**
 * DataCacheService — the wallet's balance cache.
 *
 * Balances are read constantly: every page mount, every network switch, the send and
 * shield asset pickers. Fetching them each time is what made the wallet blank its token
 * list and show a spinner on every navigation, and start from nothing on every open.
 *
 * The model here is stale-while-revalidate. A cached snapshot is served immediately,
 * however old, and callers refresh in the background and overwrite it. Nothing waits on
 * the network to render, and nothing that has already been shown is taken away.
 *
 * Persistence: the snapshot is written to **encrypted** storage, not plain localStorage.
 * It contains what an address holds, and on FHE networks the decrypted confidential
 * balances — exactly the data this wallet exists to keep private. It is loaded on unlock
 * and dropped from memory on lock.
 *
 * - Balances: 60s before a refresh is due (data is still served while refreshing)
 * - Prices: 120s
 * - After a send / approval: invalidate()
 */

import type { TokenBalance } from "./NetworkTypes.js";
import type StorageManager from "./StorageManager.js";

/** Minimal token info for cache storage (subset of DisplayToken) */
interface CachedTokenInfo {
    name: string;
    symbol: string;
    logoSrc: string;
    contractAddress: string;
    decimals: number;
    isShielded?: boolean;
    [key: string]: unknown;
}

/** Extended balance with optional metadata fields added at runtime */
type BalanceRecord = TokenBalance & {
    isShielded?: boolean;
    symbol?: string;
    name?: string;
    [key: string]: unknown;
};

interface CachedPortfolio {
    balances: Record<string, BalanceRecord>;
    tokens: CachedTokenInfo[];
    prices: Record<string, number>;
    totalUsd: number;
    balanceTimestamp: number;
    priceTimestamp: number;
}

const BALANCE_TTL_MS = 60_000;   // 60 seconds
const PRICE_TTL_MS = 120_000;    // 120 seconds

/** Encrypted-storage key holding every account/network snapshot. */
const PERSIST_KEY = "portfolio_cache";

/**
 * Cap on persisted snapshots.
 *
 * One per account per network, and both grow. Without a bound the blob would keep
 * expanding across every network a user ever visits, and it is decrypted on each unlock.
 */
const MAX_PERSISTED_ENTRIES = 24;

export class DataCacheService {
    private cache = new Map<string, CachedPortfolio>();
    private storage?: StorageManager;
    /** Coalesces bursts of `set` calls into one write. */
    private persistTimer: ReturnType<typeof setTimeout> | null = null;

    private makeKey(address: string, networkId: string | number): string {
        return `${address.toLowerCase()}:${networkId}`;
    }

    // ─── Persistence ────────────────────────────────────────────────

    /** Give the cache somewhere to persist to. Safe to call before unlock. */
    attachStorage(storage: StorageManager): void {
        this.storage = storage;
    }

    /**
     * Load the persisted snapshots into memory.
     *
     * Called right after unlock, so the first render of Home already has balances instead
     * of starting from an empty list and a spinner. A failure here is not an error worth
     * surfacing — it just means the wallet fetches as it did before.
     */
    async hydrate(): Promise<void> {
        if (!this.storage?.isUnlocked()) return;

        try {
            const stored = await this.storage.decryptAndRetrieve<Record<string, CachedPortfolio>>(PERSIST_KEY);
            if (!stored || typeof stored !== "object") return;

            for (const [key, value] of Object.entries(stored)) {
                // Do not overwrite anything fetched since unlock; live data is newer.
                if (this.cache.has(key)) continue;
                if (value && typeof value === "object" && value.balances) {
                    this.cache.set(key, value);
                }
            }
        } catch {
            // Corrupt or unreadable snapshot — fetching still works.
        }
    }

    /** Queue a write. Fire-and-forget: persistence must never block a render. */
    private schedulePersist(): void {
        if (!this.storage) return;
        if (this.persistTimer) clearTimeout(this.persistTimer);

        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            void this.persistNow();
        }, 400);
    }

    private async persistNow(): Promise<void> {
        if (!this.storage?.isUnlocked()) return;

        try {
            // Keep the most recently refreshed entries when over the cap.
            const entries = [...this.cache.entries()]
                .sort((a, b) => b[1].balanceTimestamp - a[1].balanceTimestamp)
                .slice(0, MAX_PERSISTED_ENTRIES);

            await this.storage.encryptAndStore(PERSIST_KEY, Object.fromEntries(entries));
        } catch {
            // Out of quota or locked mid-write; the in-memory cache still serves.
        }
    }

    /**
     * Get cached portfolio data if fresh.
     * Returns null if cache is stale or missing.
     */
    get(address: string, networkId: string | number): CachedPortfolio | null {
        const key = this.makeKey(address, networkId);
        const cached = this.cache.get(key);
        if (!cached) return null;

        const now = Date.now();
        const balanceFresh = (now - cached.balanceTimestamp) < BALANCE_TTL_MS;
        if (!balanceFresh) return null;

        return cached;
    }

    /**
     * Return cached data regardless of age, with a freshness flag.
     *
     * `get` returning null once the TTL lapses is right for a page that refetches, but
     * wrong for one that only reads: Portfolio has no loader of its own, so a stale cache
     * left it waiting on a page the user is not looking at — a blank skeleton for as long
     * as the timeout allowed, then an empty portfolio for an account that has funds.
     *
     * Showing numbers that are a minute old, marked as such, beats showing nothing.
     */
    getAllowStale(address: string, networkId: string | number): { data: CachedPortfolio; isStale: boolean } | null {
        const key = this.makeKey(address, networkId);
        const cached = this.cache.get(key);
        if (!cached) return null;

        return {
            data: cached,
            isStale: (Date.now() - cached.balanceTimestamp) >= BALANCE_TTL_MS,
        };
    }

    /**
     * Cached balances in the shape `Network.getTokenBalances` returns, or null.
     *
     * The send and shield asset pickers used to hit the network on every open, which is
     * why they sat on a spinner each time even though Home had just fetched exactly the
     * same list. This lets them reuse it and go to the network only when nothing is
     * cached — the pickers are read-only views of what the wallet already knows.
     */
    getTokenBalances(address: string, networkId: string | number): TokenBalance[] | null {
        const cached = this.cache.get(this.makeKey(address, networkId));
        if (!cached) return null;

        const rows = Object.values(cached.balances);
        return rows.length > 0 ? rows : null;
    }

    /**
     * Every network this account has a cached snapshot for.
     *
     * The cache is keyed by account *and* network, so it already holds a picture of each
     * chain the wallet has visited. Home only ever renders one of them; this is what lets
     * a cross-network view exist without issuing a single new request.
     *
     * A network absent from this list is not empty — it is unknown, and callers must say
     * so rather than counting it as zero. Silently treating "never loaded" as "nothing
     * here" would understate the user's holdings, which is the same mistake that once
     * made undecryptable shielded balances disappear.
     */
    getCachedNetworks(address: string): { networkId: number; data: CachedPortfolio; ageMs: number }[] {
        const prefix = `${address.toLowerCase()}:`;
        const now = Date.now();
        const out: { networkId: number; data: CachedPortfolio; ageMs: number }[] = [];

        for (const [key, data] of this.cache) {
            if (!key.startsWith(prefix)) continue;
            const networkId = Number(key.slice(prefix.length));
            if (!Number.isFinite(networkId)) continue;
            out.push({ networkId, data, ageMs: now - data.balanceTimestamp });
        }

        return out.sort((a, b) => b.data.totalUsd - a.data.totalUsd);
    }

    /**
     * Check if prices are still fresh (separate longer TTL).
     */
    arePricesFresh(address: string, networkId: string | number): boolean {
        const key = this.makeKey(address, networkId);
        const cached = this.cache.get(key);
        if (!cached) return false;
        return (Date.now() - cached.priceTimestamp) < PRICE_TTL_MS;
    }

    /**
     * Store portfolio data in cache.
     */
    set(
        address: string,
        networkId: string | number,
        data: {
            balances: Record<string, BalanceRecord>;
            tokens: CachedTokenInfo[];
            prices: Record<string, number>;
            totalUsd: number;
        }
    ): void {
        const key = this.makeKey(address, networkId);
        const now = Date.now();
        this.cache.set(key, {
            ...data,
            balanceTimestamp: now,
            priceTimestamp: now,
        });
        this.schedulePersist();
    }

    /**
     * Whether a refresh is due for this account/network.
     *
     * Separate from reading: callers render whatever is cached and use this to decide
     * whether to also go to the network. Returning true for a missing entry is what makes
     * a cold start fetch.
     */
    needsRefresh(address: string, networkId: string | number): boolean {
        const cached = this.cache.get(this.makeKey(address, networkId));
        if (!cached) return true;
        return (Date.now() - cached.balanceTimestamp) >= BALANCE_TTL_MS;
    }

    /**
     * Invalidate cache. 
     * Called after sending transactions, WC approvals, etc.
     */
    invalidate(address?: string, networkId?: string | number): void {
        if (address && networkId !== undefined) {
            const key = this.makeKey(address, networkId);
            this.cache.delete(key);
        } else {
            // Clear all
            this.cache.clear();
        }
        this.schedulePersist();
    }

    /**
     * Drop everything from memory without touching the persisted copy.
     *
     * Called on lock: balances must not sit in the heap of a locked wallet, but the
     * encrypted snapshot is exactly as safe on disk as the accounts beside it, and
     * discarding it would put the spinner back on the next unlock.
     */
    clearMemory(): void {
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = null;
        }
        this.cache.clear();
    }

    /**
     * Check how old the cache is (for debug/display).
     */
    getAge(address: string, networkId: string | number): number | null {
        const key = this.makeKey(address, networkId);
        const cached = this.cache.get(key);
        if (!cached) return null;
        return Date.now() - cached.balanceTimestamp;
    }
}

export default DataCacheService;
