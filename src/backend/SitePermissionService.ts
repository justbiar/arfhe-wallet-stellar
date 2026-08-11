/**
 * SitePermissionService — which websites may see which accounts.
 *
 * The injected provider (`window.ethereum`) is reachable by every page the user visits, so
 * "is this site allowed to know my address" has to be an explicit, persisted answer rather
 * than a side effect of having once connected. This is the record behind that answer.
 *
 * Design notes:
 *
 *  - **Origin is the unit.** `https://app.uniswap.org` is a different grant from
 *    `https://uniswap.org`, and there is no wildcard. A grant is never inferred from a
 *    parent domain, because subdomain takeover is a real way to inherit one.
 *
 *  - **Stored in `chrome.storage.local`**, because both the service worker (which enforces
 *    the gate) and the extension pages (which show and revoke grants) must read it.
 *    `localStorage` is unavailable to a service worker, so it cannot live there.
 *
 *  - **Not secret.** A grant contains an origin and public addresses. It is deliberately
 *    outside the encrypted store so the gate still works while the wallet is locked — the
 *    answer to "may this site see anything" must not require a password.
 *
 *  - **Accounts are stored lowercased** and compared that way; EIP-55 checksumming is a
 *    display concern and must never decide an access check.
 */

/** One site's grant. */
export interface SitePermission {
    /** Exact origin, e.g. `https://app.uniswap.org`. */
    origin: string;
    /** Lowercased addresses this site may see, in the order the user chose them. */
    accounts: string[];
    grantedAt: number;
    lastUsedAt: number;
}

const STORAGE_KEY = "arfhe_site_permissions";

/** Minimal shape of the storage area, so this works in a worker, a page, and a test. */
interface PermissionStore {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
}

/** `chrome.storage.local` when present, otherwise an in-memory stand-in. */
function defaultStore(): PermissionStore {
    const globalChrome = (globalThis as { chrome?: { storage?: { local?: PermissionStore } } }).chrome;
    const local = globalChrome?.storage?.local;
    if (local) return local;

    // Test and non-extension contexts. Deliberately not localStorage: a fallback that
    // silently persists to a different place than the service worker reads would make the
    // gate look enforced while it is not.
    const memory = new Map<string, unknown>();
    return {
        async get(key: string) {
            return memory.has(key) ? { [key]: memory.get(key) } : {};
        },
        async set(items: Record<string, unknown>) {
            for (const [k, v] of Object.entries(items)) memory.set(k, v);
        },
    };
}

export default class SitePermissionService {
    private store: PermissionStore;
    private listeners = new Set<(permissions: SitePermission[]) => void>();

    constructor(store: PermissionStore = defaultStore()) {
        this.store = store;
    }

    // ─── Reads ──────────────────────────────────────────────────────

    async getAll(): Promise<SitePermission[]> {
        try {
            const result = await this.store.get(STORAGE_KEY);
            const raw = result?.[STORAGE_KEY];
            if (!Array.isArray(raw)) return [];

            // Drop anything malformed rather than letting a corrupt entry decide an
            // access check. A grant that cannot be read is not a grant.
            return raw.filter(
                (p): p is SitePermission =>
                    !!p &&
                    typeof p.origin === "string" &&
                    Array.isArray(p.accounts) &&
                    p.accounts.every((a: unknown) => typeof a === "string")
            );
        } catch {
            return [];
        }
    }

    async get(origin: string): Promise<SitePermission | undefined> {
        const normalized = normalizeOrigin(origin);
        if (!normalized) return undefined;
        return (await this.getAll()).find((p) => p.origin === normalized);
    }

    /**
     * Accounts this origin may see. Empty when it has no grant.
     *
     * This is the answer `eth_accounts` returns, and the check `eth_requestAccounts`
     * short-circuits on, so "no grant" and "grant with no accounts" must look the same.
     */
    async getAccounts(origin: string): Promise<string[]> {
        return (await this.get(origin))?.accounts ?? [];
    }

    async isConnected(origin: string): Promise<boolean> {
        return (await this.getAccounts(origin)).length > 0;
    }

    /**
     * Whether this origin may act as `address`.
     *
     * Checked before signing, not only before connecting: a site that was granted account A
     * must not be able to ask for a signature from account B just because the user later
     * switched to it in the wallet.
     */
    async canUseAccount(origin: string, address: string): Promise<boolean> {
        if (!address) return false;
        return (await this.getAccounts(origin)).includes(address.toLowerCase());
    }

    // ─── Writes ─────────────────────────────────────────────────────

    /**
     * Record the user's decision to connect `origin` to `accounts`.
     *
     * Replaces any previous grant for that origin rather than merging: the approval screen
     * shows the full set the user is agreeing to, so the stored result has to be exactly
     * that set — silently keeping an account they just deselected would be the opposite of
     * what they were shown.
     */
    async grant(origin: string, accounts: string[]): Promise<void> {
        const normalized = normalizeOrigin(origin);
        if (!normalized) throw new Error(`Refusing to grant permission to an invalid origin: ${origin}`);

        const cleaned = [...new Set(
            accounts
                .filter((a) => typeof a === "string" && a.startsWith("0x"))
                .map((a) => a.toLowerCase())
        )];
        if (cleaned.length === 0) {
            // "Connected to nothing" is not a state worth persisting; it reads as connected
            // in every listing while exposing nothing.
            await this.revoke(normalized);
            return;
        }

        const all = await this.getAll();
        const existing = all.find((p) => p.origin === normalized);
        const now = Date.now();

        const next: SitePermission[] = existing
            ? all.map((p) => (p.origin === normalized ? { ...p, accounts: cleaned, lastUsedAt: now } : p))
            : [...all, { origin: normalized, accounts: cleaned, grantedAt: now, lastUsedAt: now }];

        await this.write(next);
    }

    async revoke(origin: string): Promise<void> {
        const normalized = normalizeOrigin(origin);
        if (!normalized) return;
        await this.write((await this.getAll()).filter((p) => p.origin !== normalized));
    }

    async revokeAll(): Promise<void> {
        await this.write([]);
    }

    /**
     * Drop `address` from every site that could use it.
     *
     * Called when an account is removed from the wallet. Leaving it behind would mean a
     * grant naming an address the wallet no longer holds, which reappears as a live
     * permission if that account is ever re-imported.
     */
    async revokeAccountEverywhere(address: string): Promise<void> {
        const target = address.toLowerCase();
        const next = (await this.getAll())
            .map((p) => ({ ...p, accounts: p.accounts.filter((a) => a !== target) }))
            .filter((p) => p.accounts.length > 0);
        await this.write(next);
    }

    /** Note that a site used its grant, so the settings list can show real activity. */
    async touch(origin: string): Promise<void> {
        const normalized = normalizeOrigin(origin);
        if (!normalized) return;

        const all = await this.getAll();
        if (!all.some((p) => p.origin === normalized)) return;

        await this.write(
            all.map((p) => (p.origin === normalized ? { ...p, lastUsedAt: Date.now() } : p))
        );
    }

    // ─── Change notification ────────────────────────────────────────

    subscribe(listener: (permissions: SitePermission[]) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private async write(permissions: SitePermission[]): Promise<void> {
        await this.store.set({ [STORAGE_KEY]: permissions });
        for (const listener of this.listeners) {
            try {
                listener(permissions);
            } catch {
                // A UI listener throwing must not abort the write that already happened.
            }
        }
    }
}

/**
 * Reduce a URL or origin to the exact origin used as the permission key.
 *
 * Returns `""` for anything that is not a normal web origin — `file:`, `chrome:`,
 * `data:` and friends. Those never get a grant: they are not sites a user can meaningfully
 * recognise on an approval screen, so there is no informed consent to record.
 */
export function normalizeOrigin(input: string | undefined | null): string {
    if (!input) return "";
    try {
        const url = new URL(input);
        if (url.protocol !== "https:" && url.protocol !== "http:") return "";
        return url.origin;
    } catch {
        return "";
    }
}
