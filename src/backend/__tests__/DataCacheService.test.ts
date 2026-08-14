/**
 * Tests for the balance cache.
 *
 * The contract this guards is a UX one that kept regressing: whatever was fetched last is
 * served immediately, however old, and a refresh replaces it without ever handing back
 * nothing. A cache that returns null once a timer lapses is what put a spinner on every
 * navigation and an empty token list on every reopen.
 *
 * The persistence side matters for a different reason: the snapshot holds what an address
 * owns — including decrypted confidential balances on FHE networks — so it must go to
 * encrypted storage and must leave memory when the wallet locks.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import DataCacheService from "../DataCacheService.js";
import type StorageManager from "../StorageManager.js";

const ALICE = "0xAbCdEf0000000000000000000000000000000001";
const SEPOLIA = 11155111;
const BASE = 84532;

function snapshot(totalUsd = 100) {
  return {
    balances: {
      ETH: { contractAddress: "ETH", tokenBalance: "1.5", isNative: true },
      "0xtoken": { contractAddress: "0xtoken", tokenBalance: "42", isNative: false },
    } as never,
    tokens: [{ name: "Ether", symbol: "ETH", logoSrc: "", contractAddress: "ETH", decimals: 18 }],
    prices: { ETH: 2000 },
    totalUsd,
  };
}

/** Storage stand-in that records what was written and can pretend to be locked. */
function makeStorage(unlocked = true) {
  const vault = new Map<string, unknown>();
  return {
    isUnlocked: () => unlocked,
    encryptAndStore: vi.fn(async (key: string, value: unknown) => { vault.set(key, value); return true; }),
    decryptAndRetrieve: vi.fn(async (key: string) => vault.get(key) ?? null),
    _vault: vault,
    _setUnlocked: (v: boolean) => { unlocked = v; },
  };
}

describe("DataCacheService", () => {
  let cache: DataCacheService;

  beforeEach(() => {
    vi.useRealTimers();
    cache = new DataCacheService();
  });

  it("yazılan anlık görüntüyü hemen geri verir", () => {
    cache.set(ALICE, SEPOLIA, snapshot());
    expect(cache.getAllowStale(ALICE, SEPOLIA)?.data.totalUsd).toBe(100);
  });

  it("süresi geçse bile veriyi verir, bayat olarak işaretler", () => {
    vi.useFakeTimers();
    cache.set(ALICE, SEPOLIA, snapshot());

    // The whole point: an expired entry is still rendered, never withheld.
    vi.advanceTimersByTime(120_000);

    const entry = cache.getAllowStale(ALICE, SEPOLIA);
    expect(entry?.data.totalUsd).toBe(100);
    expect(entry?.isStale).toBe(true);
    expect(cache.needsRefresh(ALICE, SEPOLIA)).toBe(true);
    vi.useRealTimers();
  });

  it("taze veride yenileme istemez", () => {
    cache.set(ALICE, SEPOLIA, snapshot());
    expect(cache.needsRefresh(ALICE, SEPOLIA)).toBe(false);
    expect(cache.getAllowStale(ALICE, SEPOLIA)?.isStale).toBe(false);
  });

  it("hiç veri yoksa yenileme ister", () => {
    expect(cache.needsRefresh(ALICE, SEPOLIA)).toBe(true);
    expect(cache.getAllowStale(ALICE, SEPOLIA)).toBeNull();
  });

  it("ağlar birbirinin verisini görmez", () => {
    cache.set(ALICE, SEPOLIA, snapshot(100));
    cache.set(ALICE, BASE, snapshot(500));

    expect(cache.getAllowStale(ALICE, SEPOLIA)?.data.totalUsd).toBe(100);
    expect(cache.getAllowStale(ALICE, BASE)?.data.totalUsd).toBe(500);
  });

  it("panellere hazır bakiye listesi verir", () => {
    cache.set(ALICE, SEPOLIA, snapshot());
    const rows = cache.getTokenBalances(ALICE, SEPOLIA);
    expect(rows).toHaveLength(2);
    expect(cache.getTokenBalances(ALICE, BASE)).toBeNull();
  });

  it("yenileme eskisini değiştirir", () => {
    cache.set(ALICE, SEPOLIA, snapshot(100));
    cache.set(ALICE, SEPOLIA, snapshot(250));
    expect(cache.getAllowStale(ALICE, SEPOLIA)?.data.totalUsd).toBe(250);
  });

  // ─── Persistence ────────────────────────────────────────────────

  it("anlık görüntüyü şifreli depoya yazar", async () => {
    const storage = makeStorage();
    cache.attachStorage(storage as unknown as StorageManager);

    cache.set(ALICE, SEPOLIA, snapshot());
    // The write is debounced so a burst of updates costs one encrypt.
    await new Promise((r) => setTimeout(r, 600));

    expect(storage.encryptAndStore).toHaveBeenCalledWith("portfolio_cache", expect.any(Object));
  });

  it("kilit açılınca diskteki veriyi geri yükler", async () => {
    const storage = makeStorage();

    const first = new DataCacheService();
    first.attachStorage(storage as unknown as StorageManager);
    first.set(ALICE, SEPOLIA, snapshot(777));
    await new Promise((r) => setTimeout(r, 600));

    // A fresh instance stands in for reopening the popup.
    const reopened = new DataCacheService();
    reopened.attachStorage(storage as unknown as StorageManager);
    expect(reopened.getAllowStale(ALICE, SEPOLIA)).toBeNull();

    await reopened.hydrate();
    expect(reopened.getAllowStale(ALICE, SEPOLIA)?.data.totalUsd).toBe(777);
  });

  it("kilitliyken hiçbir şey yazmaz", async () => {
    const storage = makeStorage(false);
    cache.attachStorage(storage as unknown as StorageManager);

    cache.set(ALICE, SEPOLIA, snapshot());
    await new Promise((r) => setTimeout(r, 600));

    expect(storage.encryptAndStore).not.toHaveBeenCalled();
  });

  it("clearMemory bellekten siler ama diski korur", async () => {
    const storage = makeStorage();
    cache.attachStorage(storage as unknown as StorageManager);
    cache.set(ALICE, SEPOLIA, snapshot(321));
    await new Promise((r) => setTimeout(r, 600));

    cache.clearMemory();
    expect(cache.getAllowStale(ALICE, SEPOLIA)).toBeNull();

    // Locking must not cost the user the spinner-free unlock.
    await cache.hydrate();
    expect(cache.getAllowStale(ALICE, SEPOLIA)?.data.totalUsd).toBe(321);
  });

  it("hydrate canlı veriyi eski diskle ezmez", async () => {
    const storage = makeStorage();
    cache.attachStorage(storage as unknown as StorageManager);
    cache.set(ALICE, SEPOLIA, snapshot(100));
    await new Promise((r) => setTimeout(r, 600));

    cache.set(ALICE, SEPOLIA, snapshot(999));
    await cache.hydrate();

    expect(cache.getAllowStale(ALICE, SEPOLIA)?.data.totalUsd).toBe(999);
  });

  it("bozuk disk verisi çökertmez", async () => {
    const storage = makeStorage();
    storage._vault.set("portfolio_cache", "not an object");
    cache.attachStorage(storage as unknown as StorageManager);

    await expect(cache.hydrate()).resolves.toBeUndefined();
    expect(cache.getAllowStale(ALICE, SEPOLIA)).toBeNull();
  });

  it("invalidate yalnızca hedef ağı düşürür", () => {
    cache.set(ALICE, SEPOLIA, snapshot(100));
    cache.set(ALICE, BASE, snapshot(500));

    cache.invalidate(ALICE, SEPOLIA);

    expect(cache.getAllowStale(ALICE, SEPOLIA)).toBeNull();
    expect(cache.getAllowStale(ALICE, BASE)?.data.totalUsd).toBe(500);
  });
});
