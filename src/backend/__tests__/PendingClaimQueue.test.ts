/**
 * Tests for PendingClaimQueue, with the emphasis on batched settlement.
 *
 * This queue is the only thing standing between a dismissed popup and permanently
 * stranded funds: `unshield` burns the confidential balance immediately, and the tokens
 * are not released until a second transaction publishes a decryption proof. An entry
 * dropped from here is burned balance nobody will ever claim.
 *
 * `drainGrouped` settles a whole token's claims in one `claimUnshieldedBatch` call, so the
 * failure semantics matter: the on-chain batch is atomic, and a group that reverts must
 * leave every claim in it queued — not just the one that happened to be inspected.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import PendingClaimQueue, { PendingClaimIntent } from "../PendingClaimQueue.js";
import type StorageManager from "../StorageManager.js";

/** Minimal in-memory StorageManager stand-in. */
function makeStorage(unlocked = true) {
  const store = new Map<string, unknown>();
  return {
    getLocal: <T>(key: string): T | undefined => store.get(key) as T | undefined,
    setLocal: (key: string, value: unknown) => { store.set(key, value); },
    isUnlocked: () => unlocked,
  } as unknown as StorageManager;
}

const ACCOUNT = "0xAbCdEf0000000000000000000000000000000001";
const NETWORK = 11155111;
const TOKEN_A = "0x1111111111111111111111111111111111111111";
const TOKEN_B = "0x2222222222222222222222222222222222222222";

function seed(queue: PendingClaimQueue, entries: { ctHash: string; tokenAddress: string }[]) {
  for (const e of entries) {
    queue.add({
      ctHash: e.ctHash,
      tokenAddress: e.tokenAddress,
      accountAddress: ACCOUNT,
      networkId: NETWORK,
      symbol: "aeTEST",
    });
  }
}

describe("PendingClaimQueue.drainGrouped", () => {
  let queue: PendingClaimQueue;

  beforeEach(() => { queue = new PendingClaimQueue(makeStorage()); });

  it("aynı tokenın taleplerini tek grupta toplar", async () => {
    seed(queue, [
      { ctHash: "0xa1", tokenAddress: TOKEN_A },
      { ctHash: "0xa2", tokenAddress: TOKEN_A },
      { ctHash: "0xa3", tokenAddress: TOKEN_A },
    ]);

    const calls: { token: string; count: number }[] = [];
    const settled = await queue.drainGrouped(ACCOUNT, NETWORK, async (token, intents) => {
      calls.push({ token, count: intents.length });
    });

    // One batch transaction instead of three separate ones.
    expect(calls).toEqual([{ token: TOKEN_A, count: 3 }]);
    expect(settled).toBe(3);
    expect(queue.getFor(ACCOUNT, NETWORK)).toHaveLength(0);
  });

  it("farklı tokenları ayrı gruplara böler", async () => {
    seed(queue, [
      { ctHash: "0xa1", tokenAddress: TOKEN_A },
      { ctHash: "0xb1", tokenAddress: TOKEN_B },
      { ctHash: "0xa2", tokenAddress: TOKEN_A },
    ]);

    const groups: Record<string, number> = {};
    await queue.drainGrouped(ACCOUNT, NETWORK, async (token, intents) => {
      groups[token.toLowerCase()] = intents.length;
    });

    // Each wrapper is its own contract, so they cannot share a transaction.
    expect(groups).toEqual({ [TOKEN_A.toLowerCase()]: 2, [TOKEN_B.toLowerCase()]: 1 });
  });

  it("adres büyük/küçük harf farkına rağmen tek grup yapar", async () => {
    seed(queue, [
      { ctHash: "0xa1", tokenAddress: TOKEN_A.toLowerCase() },
      { ctHash: "0xa2", tokenAddress: TOKEN_A.toUpperCase().replace("0X", "0x") },
    ]);

    const calls: number[] = [];
    await queue.drainGrouped(ACCOUNT, NETWORK, async (_t, intents) => { calls.push(intents.length); });

    expect(calls).toEqual([2]);
  });

  it("başarısız grubun TÜM talepleri kuyrukta kalır", async () => {
    // The batch is atomic on-chain: if it reverts, none of them settled.
    seed(queue, [
      { ctHash: "0xa1", tokenAddress: TOKEN_A },
      { ctHash: "0xa2", tokenAddress: TOKEN_A },
    ]);

    const settled = await queue.drainGrouped(ACCOUNT, NETWORK, async () => {
      throw new Error("reverted");
    });

    expect(settled).toBe(0);
    const remaining = queue.getFor(ACCOUNT, NETWORK);
    expect(remaining).toHaveLength(2);
    expect(remaining.every((c: PendingClaimIntent) => c.attempts === 1)).toBe(true);
  });

  it("bir grup başarısız olsa da diğer token ilerler", async () => {
    seed(queue, [
      { ctHash: "0xa1", tokenAddress: TOKEN_A },
      { ctHash: "0xb1", tokenAddress: TOKEN_B },
    ]);

    const settled = await queue.drainGrouped(ACCOUNT, NETWORK, async (token) => {
      if (token.toLowerCase() === TOKEN_A.toLowerCase()) throw new Error("reverted");
    });

    expect(settled).toBe(1);
    const remaining = queue.getFor(ACCOUNT, NETWORK);
    expect(remaining.map((c) => c.ctHash)).toEqual(["0xa1"]);
  });

  it("sürekli başarısız olan talep sonunda düşer, sonsuz denenmez", async () => {
    seed(queue, [{ ctHash: "0xa1", tokenAddress: TOKEN_A }]);

    for (let attempt = 0; attempt < 5; attempt++) {
      await queue.drainGrouped(ACCOUNT, NETWORK, async () => { throw new Error("always"); });
    }

    expect(queue.getFor(ACCOUNT, NETWORK)).toHaveLength(0);
  });

  it("kilitli cüzdanda hiçbir şey denemez", async () => {
    const locked = new PendingClaimQueue(makeStorage(false));
    seed(locked, [{ ctHash: "0xa1", tokenAddress: TOKEN_A }]);

    const settle = vi.fn();
    const settled = await locked.drainGrouped(ACCOUNT, NETWORK, settle);

    // Settlement needs a signature, and the key only exists while unlocked.
    expect(settled).toBe(0);
    expect(settle).not.toHaveBeenCalled();
    expect(locked.getFor(ACCOUNT, NETWORK)).toHaveLength(1);
  });

  it("başka hesabın veya ağın talebine dokunmaz", async () => {
    queue.add({
      ctHash: "0xa1", tokenAddress: TOKEN_A, accountAddress: ACCOUNT,
      networkId: NETWORK, symbol: "aeTEST",
    });
    queue.add({
      ctHash: "0xz1", tokenAddress: TOKEN_A, accountAddress: "0xdead000000000000000000000000000000000000",
      networkId: NETWORK, symbol: "aeTEST",
    });
    queue.add({
      ctHash: "0xz2", tokenAddress: TOKEN_A, accountAddress: ACCOUNT,
      networkId: 84532, symbol: "aeTEST",
    });

    const seen: string[] = [];
    await queue.drainGrouped(ACCOUNT, NETWORK, async (_t, intents) => {
      seen.push(...intents.map((i) => i.ctHash));
    });

    expect(seen).toEqual(["0xa1"]);
    expect(queue.getAll()).toHaveLength(2); // the other two are untouched
  });

  it("eski drain() API'si hâlâ tek tek işler", async () => {
    seed(queue, [
      { ctHash: "0xa1", tokenAddress: TOKEN_A },
      { ctHash: "0xa2", tokenAddress: TOKEN_A },
    ]);

    const seen: string[] = [];
    const settled = await queue.drain(ACCOUNT, NETWORK, async (intent) => { seen.push(intent.ctHash); });

    expect(seen).toEqual(["0xa1", "0xa2"]);
    expect(settled).toBe(2);
  });
});
