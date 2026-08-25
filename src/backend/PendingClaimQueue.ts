/**
 * PendingClaimQueue — makes unshielding survive the popup closing.
 *
 * Unshielding is two transactions: `unshield` burns the confidential balance and opens a
 * claim, then `claimUnshielded` publishes a decryption proof and releases the tokens.
 * Between them the wallet must decrypt off-chain, which takes a network round-trip. An
 * extension popup can be dismissed at any moment during that window, and the JS context
 * dies with it — leaving burned balance behind an unsettled claim.
 *
 * This queue records the intent the moment the burn confirms, so the second half is never
 * lost. Settlement is retried automatically whenever the wallet is open and unlocked.
 *
 * Deliberate limits:
 *  - Settlement needs a signature, and the signing key only exists in memory while the
 *    wallet is unlocked. Nothing here can (or should) complete a claim on a locked wallet;
 *    handing the key to a background worker to achieve that would defeat the lock.
 *  - The queue is an intent log, not a source of truth. The chain is authoritative — a
 *    claim already settled elsewhere simply drops out on the next reconcile.
 *
 * Entries are non-sensitive (a public ciphertext handle plus addresses) and are stored
 * unencrypted so they can be read before the wallet is unlocked.
 */

import type StorageManager from "./StorageManager.js";

const STORAGE_KEY = "arfhe_pending_claims";

/** Give up after this many consecutive failures so a permanently bad claim stops retrying. */
const MAX_ATTEMPTS = 5;

export interface PendingClaimIntent {
  /**
   * The claim's on-chain id — what `claimUnshielded` is called with.
   *
   * Separate from {@link ctHash} since confidential-contracts 0.4: the id keys the claim,
   * the handle carries the amount. Settlement needs both.
   */
  claimId: string;
  /** Burned ciphertext handle — decrypted off-chain to produce the settlement proof. */
  ctHash: string;
  /** Confidential wrapper the claim belongs to. */
  tokenAddress: string;
  /** Account that opened the claim — settlement only runs for this account. */
  accountAddress: string;
  /** Network the claim lives on. */
  networkId: number;
  /** Symbol for user-facing messages (e.g. "aeETH"). */
  symbol: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

export default class PendingClaimQueue {
  private storage: StorageManager;
  private listeners = new Set<(intents: PendingClaimIntent[]) => void>();
  /** Guards against two concurrent drains racing on the same claim. */
  private draining = false;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  // ─── Persistence ────────────────────────────────────────────────

  getAll(): PendingClaimIntent[] {
    return this.storage.getLocal<PendingClaimIntent[]>(STORAGE_KEY) ?? [];
  }

  /** Claims still owed to a specific account on a specific network. */
  getFor(accountAddress: string, networkId: number): PendingClaimIntent[] {
    const account = accountAddress.toLowerCase();
    return this.getAll().filter(
      (c) => c.accountAddress.toLowerCase() === account && c.networkId === networkId
    );
  }

  private write(intents: PendingClaimIntent[]): void {
    this.storage.setLocal(STORAGE_KEY, intents);
    for (const listener of this.listeners) listener(intents);
  }

  /** Record a freshly opened claim. Idempotent on `ctHash`. */
  add(intent: Omit<PendingClaimIntent, "createdAt" | "attempts">): void {
    const all = this.getAll();
    if (all.some((c) => c.ctHash.toLowerCase() === intent.ctHash.toLowerCase())) return;

    all.push({ ...intent, createdAt: Date.now(), attempts: 0 });
    this.write(all);
  }

  remove(ctHash: string): void {
    const target = ctHash.toLowerCase();
    this.write(this.getAll().filter((c) => c.ctHash.toLowerCase() !== target));
  }

  /** Subscribe to queue changes; returns an unsubscribe function. */
  subscribe(listener: (intents: PendingClaimIntent[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private recordFailure(ctHash: string, error: string): void {
    const all = this.getAll();
    const entry = all.find((c) => c.ctHash.toLowerCase() === ctHash.toLowerCase());
    if (!entry) return;

    entry.attempts += 1;
    entry.lastError = error;

    // A claim that keeps failing is usually already settled or permanently invalid.
    // Dropping it stops an endless retry loop on every unlock.
    this.write(entry.attempts >= MAX_ATTEMPTS ? all.filter((c) => c !== entry) : all);
  }

  // ─── Settlement ─────────────────────────────────────────────────

  /**
   * Settle every claim owed to `account` on the active network.
   *
   * Safe to call often — on unlock, on network change, after an unshield. Does nothing
   * when the wallet is locked, and never throws: a failed claim stays queued for the
   * next attempt rather than surfacing as an error in an unrelated flow.
   *
   * @param settle Performs the on-chain claim. Injected so this class stays free of
   *               Network/FHE imports and remains trivially testable.
   * @returns Number of claims settled.
   */
  async drain(
    accountAddress: string,
    networkId: number,
    settle: (intent: PendingClaimIntent) => Promise<void>
  ): Promise<number> {
    return this.drainGrouped(accountAddress, networkId, async (_token, intents) => {
      for (const intent of intents) await settle(intent);
    });
  }

  /**
   * Settle claims a whole token at a time.
   *
   * The wrapper contracts expose `claimUnshieldedBatch`, so every claim against one token
   * settles in a single transaction. That matters after an interruption: a user who closed
   * the popup mid-unshield several times can accumulate a handful of claims, and settling
   * them one by one means one gas payment and one confirmation wait each.
   *
   * A group that fails is recorded against every claim in it — the batch is atomic
   * on-chain, so none of them settled.
   *
   * @param settle Performs the on-chain claim for one token's claims. Injected so this
   *               class stays free of Network/FHE imports and remains trivially testable.
   * @returns Number of claims settled.
   */
  async drainGrouped(
    accountAddress: string,
    networkId: number,
    settle: (tokenAddress: string, intents: PendingClaimIntent[]) => Promise<void>
  ): Promise<number> {
    if (this.draining) return 0;
    if (!this.storage.isUnlocked()) return 0;

    const owed = this.getFor(accountAddress, networkId);
    if (owed.length === 0) return 0;

    const byToken = new Map<string, PendingClaimIntent[]>();
    for (const intent of owed) {
      const key = intent.tokenAddress.toLowerCase();
      const group = byToken.get(key);
      if (group) group.push(intent);
      else byToken.set(key, [intent]);
    }

    this.draining = true;
    let settled = 0;

    try {
      for (const [, intents] of byToken) {
        try {
          await settle(intents[0].tokenAddress, intents);
          for (const intent of intents) this.remove(intent.ctHash);
          settled += intents.length;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          for (const intent of intents) this.recordFailure(intent.ctHash, message);
        }
      }
    } finally {
      this.draining = false;
    }

    return settled;
  }

  /**
   * Drop queued claims the chain no longer lists as pending.
   *
   * Covers claims settled from another device or session, so the queue does not retry
   * work that is already done.
   */
  reconcile(accountAddress: string, networkId: number, onChainClaimIds: string[]): void {
    const live = new Set(onChainClaimIds.map((h) => h.toLowerCase()));
    const account = accountAddress.toLowerCase();

    const kept = this.getAll().filter((c) => {
      const isOurs = c.accountAddress.toLowerCase() === account && c.networkId === networkId;
      // Matched on the claim id, which is what the chain lists. Two claims can share a
      // handle, so matching on that would drop a still-owed claim as already settled.
      return isOurs ? live.has(c.claimId.toLowerCase()) : true;
    });

    if (kept.length !== this.getAll().length) this.write(kept);
  }

  /** Wipe the queue — used when the wallet itself is removed. */
  clear(): void {
    this.storage.removeLocal(STORAGE_KEY);
    for (const listener of this.listeners) listener([]);
  }
}
