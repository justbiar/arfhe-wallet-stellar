/**
 * PortfolioHistoryService — what the wallet was actually worth, when.
 *
 * The chart this feeds used to be `Math.random()`: a plausible line walked backwards from
 * today's balance, drawn on a balance screen as if it were history. It is the one kind of
 * fabrication a wallet cannot afford, because the user has no way to tell it from the real
 * thing and every instinct says a chart is a record.
 *
 * A real record has to be accumulated, and that has a consequence worth stating plainly:
 * **a fresh wallet has no history.** There is no backfill — nobody kept the data, and
 * reconstructing it from prices would be inventing it again. The chart therefore starts
 * empty, fills as the wallet is used, and says which it is.
 *
 * What is stored is one number per point: the account's total in USD. No balances, no
 * addresses, no per-token detail — a series of totals is the least that answers "how has
 * this moved", and it is kept in the same encrypted store as everything else.
 */

import type StorageManager from "./StorageManager.js";

/** One observation: what the account was worth at a moment in time. */
export interface PortfolioPoint {
    /** Unix milliseconds. */
    t: number;
    /** Total across every network with a snapshot at that moment, in USD. */
    usd: number;
}

const STORAGE_KEY = "arfhe_portfolio_history";

/**
 * Shortest gap between stored points.
 *
 * Home refetches on every navigation and after every confirmation, so without a floor the
 * series would be dominated by bursts of near-identical points from a single session and
 * a day would be indistinguishable from a minute.
 */
const MIN_POINT_INTERVAL_MS = 15 * 60_000;

/**
 * How long points are kept.
 *
 * Ninety days covers every range the UI offers with room to spare, and bounds a blob that
 * is decrypted on each unlock.
 */
const RETENTION_MS = 90 * 24 * 60 * 60_000;

/** Hard cap, so a pathological write loop cannot grow the blob without limit. */
const MAX_POINTS = 720;

export type HistoryRange = "1D" | "1W" | "1M" | "ALL";

const RANGE_MS: Record<Exclude<HistoryRange, "ALL">, number> = {
    "1D": 24 * 60 * 60_000,
    "1W": 7 * 24 * 60 * 60_000,
    "1M": 30 * 24 * 60 * 60_000,
};

/** The movement between two points in a series. */
export interface PortfolioChange {
    /** Difference in USD. Negative when the total fell. */
    absolute: number;
    /** Difference as a percentage of the earlier value. */
    percent: number;
    /** When the comparison starts. */
    since: number;
    /**
     * False when there is nothing old enough to compare against.
     *
     * A wallet used for the first time has one point, and "0.00% today" would be a claim
     * about a day it did not observe. Callers must render this case as "no data yet"
     * rather than as no change.
     */
    hasBaseline: boolean;
}

export class PortfolioHistoryService {
    private storage?: StorageManager;
    /** Per-account series, keyed by lowercased address. */
    private series = new Map<string, PortfolioPoint[]>();
    private loaded = false;
    private persistTimer: ReturnType<typeof setTimeout> | null = null;

    attachStorage(storage: StorageManager): void {
        this.storage = storage;
    }

    /** Read the stored series. Safe to call repeatedly; only the first read does work. */
    async hydrate(): Promise<void> {
        if (this.loaded || !this.storage?.isUnlocked()) return;
        try {
            const stored = await this.storage.decryptAndRetrieve<Record<string, PortfolioPoint[]>>(STORAGE_KEY);
            if (stored && typeof stored === "object") {
                for (const [address, points] of Object.entries(stored)) {
                    if (Array.isArray(points)) this.series.set(address, points.filter(isPoint));
                }
            }
            this.loaded = true;
        } catch {
            // Unreadable history is not worth blocking the wallet for; it starts fresh.
            this.loaded = true;
        }
    }

    /**
     * Record what the account is worth right now.
     *
     * Ignored when a point was stored recently, so the series measures time rather than
     * how often the user navigated. Also ignored for a total of zero while the wallet is
     * still loading — writing that would carve a false crash into the chart.
     *
     * @param totalUsd Total across every network with a snapshot.
     * @param networksCounted How many networks that total covers; zero means nothing is
     *        loaded yet, which is not the same as being worth nothing.
     */
    record(address: string, totalUsd: number, networksCounted: number): void {
        if (!address || !Number.isFinite(totalUsd) || totalUsd < 0) return;
        // Nothing is loaded yet. A zero here describes the wallet's knowledge, not the
        // user's holdings, and the series must not confuse the two.
        if (networksCounted === 0) return;

        const key = address.toLowerCase();
        const points = this.series.get(key) ?? [];
        const now = Date.now();
        const last = points[points.length - 1];

        if (last && now - last.t < MIN_POINT_INTERVAL_MS) {
            // Within the window: keep the series honest about *now* by moving the latest
            // point rather than appending a second one for the same moment.
            last.t = now;
            last.usd = totalUsd;
        } else {
            points.push({ t: now, usd: totalUsd });
        }

        const cutoff = now - RETENTION_MS;
        const trimmed = points.filter((p) => p.t >= cutoff).slice(-MAX_POINTS);

        this.series.set(key, trimmed);
        this.schedulePersist();
    }

    /** Points for an account within a range, oldest first. */
    getSeries(address: string, range: HistoryRange = "1W"): PortfolioPoint[] {
        const points = this.series.get(address.toLowerCase()) ?? [];
        if (range === "ALL") return [...points];

        const cutoff = Date.now() - RANGE_MS[range];
        return points.filter((p) => p.t >= cutoff);
    }

    /**
     * Movement over the last 24 hours.
     *
     * The baseline is the newest point at least a day old — not the oldest point in the
     * window, which after a gap in usage could be a week back and would label a week's
     * drift as today's.
     */
    getDailyChange(address: string): PortfolioChange {
        const points = this.series.get(address.toLowerCase()) ?? [];
        const latest = points[points.length - 1];

        if (!latest) {
            return { absolute: 0, percent: 0, since: Date.now(), hasBaseline: false };
        }

        const dayAgo = latest.t - RANGE_MS["1D"];
        let baseline: PortfolioPoint | undefined;
        for (const point of points) {
            if (point.t <= dayAgo) baseline = point;
            else break;
        }

        if (!baseline) {
            return { absolute: 0, percent: 0, since: latest.t, hasBaseline: false };
        }

        const absolute = latest.usd - baseline.usd;
        // A baseline of zero has no meaningful percentage — going from nothing to
        // something is not "infinity percent", so the amount stands alone.
        const percent = baseline.usd > 0 ? (absolute / baseline.usd) * 100 : 0;

        return { absolute, percent, since: baseline.t, hasBaseline: true };
    }

    /** Wipe one account's history, or everything when no address is given. */
    clear(address?: string): void {
        if (address) this.series.delete(address.toLowerCase());
        else this.series.clear();
        this.schedulePersist();
    }

    /** Drop in-memory series on lock; the encrypted copy on disk survives. */
    clearMemory(): void {
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = null;
        }
        this.series.clear();
        this.loaded = false;
    }

    private schedulePersist(): void {
        if (!this.storage) return;
        if (this.persistTimer) clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            void this.persistNow();
        }, 1000);
    }

    private async persistNow(): Promise<void> {
        if (!this.storage?.isUnlocked()) return;
        try {
            await this.storage.encryptAndStore(STORAGE_KEY, Object.fromEntries(this.series));
        } catch {
            // Storage unavailable or locked mid-write; the in-memory series still serves.
        }
    }
}

function isPoint(value: unknown): value is PortfolioPoint {
    const p = value as PortfolioPoint;
    return !!p && Number.isFinite(p.t) && Number.isFinite(p.usd);
}

export default PortfolioHistoryService;
