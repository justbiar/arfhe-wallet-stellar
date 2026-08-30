/**
 * Tests for the site permission store.
 *
 * This record is the only thing standing between a visited web page and the user's
 * address, so the cases that matter are the ones where a grant could be inferred rather
 * than given: a lookalike origin, a parent domain, a different account, a non-web scheme.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import SitePermissionService, { normalizeOrigin } from "../SitePermissionService.js";

const UNISWAP = "https://app.uniswap.org";
const EVIL = "https://evil.com";
const ALICE = "0xAbCdEf0000000000000000000000000000000001";
const BOB = "0x1234560000000000000000000000000000000002";

/** In-memory stand-in for chrome.storage.local. */
function makeStore() {
  const memory = new Map<string, unknown>();
  return {
    async get(key: string) {
      return memory.has(key) ? { [key]: memory.get(key) } : {};
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) memory.set(k, v);
    },
    _memory: memory,
  };
}

describe("SitePermissionService", () => {
  let store: ReturnType<typeof makeStore>;
  let perms: SitePermissionService;

  beforeEach(() => {
    store = makeStore();
    perms = new SitePermissionService(store);
  });

  it("izin verilmemiş site hiçbir hesap göremez", async () => {
    expect(await perms.getAccounts(UNISWAP)).toEqual([]);
    expect(await perms.isConnected(UNISWAP)).toBe(false);
    expect(await perms.canUseAccount(UNISWAP, ALICE)).toBe(false);
  });

  it("izin verilen siteye yalnızca verilen hesapları açar", async () => {
    await perms.grant(UNISWAP, [ALICE]);

    expect(await perms.getAccounts(UNISWAP)).toEqual([ALICE.toLowerCase()]);
    expect(await perms.canUseAccount(UNISWAP, ALICE)).toBe(true);
    // The wallet holds Bob too, but this site was never shown Bob.
    expect(await perms.canUseAccount(UNISWAP, BOB)).toBe(false);
  });

  it("izin başka origin'e sızmaz", async () => {
    await perms.grant(UNISWAP, [ALICE]);
    expect(await perms.getAccounts(EVIL)).toEqual([]);
    // A parent domain must not inherit a subdomain's grant.
    expect(await perms.getAccounts("https://uniswap.org")).toEqual([]);
    // Nor may a different scheme or port reuse it.
    expect(await perms.getAccounts("http://app.uniswap.org")).toEqual([]);
    expect(await perms.getAccounts("https://app.uniswap.org:8443")).toEqual([]);
  });

  it("adres karşılaştırması büyük/küçük harfe duyarsızdır", async () => {
    await perms.grant(UNISWAP, [ALICE.toUpperCase().replace("0X", "0x")]);
    expect(await perms.canUseAccount(UNISWAP, ALICE.toLowerCase())).toBe(true);
  });

  it("yeniden izin verince eski küme birleştirilmez, değiştirilir", async () => {
    await perms.grant(UNISWAP, [ALICE, BOB]);
    // The user came back and deselected Bob; the screen showed only Alice.
    await perms.grant(UNISWAP, [ALICE]);

    expect(await perms.getAccounts(UNISWAP)).toEqual([ALICE.toLowerCase()]);
    expect(await perms.canUseAccount(UNISWAP, BOB)).toBe(false);
  });

  it("boş hesap listesi bağlantıyı kaldırır", async () => {
    await perms.grant(UNISWAP, [ALICE]);
    await perms.grant(UNISWAP, []);
    expect(await perms.isConnected(UNISWAP)).toBe(false);
    expect(await perms.getAll()).toHaveLength(0);
  });

  it("revoke yalnızca hedef siteyi kaldırır", async () => {
    await perms.grant(UNISWAP, [ALICE]);
    await perms.grant(EVIL, [BOB]);

    await perms.revoke(UNISWAP);

    expect(await perms.isConnected(UNISWAP)).toBe(false);
    expect(await perms.isConnected(EVIL)).toBe(true);
  });

  it("cüzdandan silinen hesap her siteden düşer", async () => {
    await perms.grant(UNISWAP, [ALICE, BOB]);
    await perms.grant(EVIL, [BOB]);

    await perms.revokeAccountEverywhere(BOB);

    expect(await perms.getAccounts(UNISWAP)).toEqual([ALICE.toLowerCase()]);
    // Nothing left to expose, so the grant itself goes.
    expect(await perms.isConnected(EVIL)).toBe(false);
  });

  it("web olmayan şemalara izin verilmez", async () => {
    await expect(perms.grant("file:///Users/me/dapp.html", [ALICE])).rejects.toThrow();
    await expect(perms.grant("chrome-extension://abc", [ALICE])).rejects.toThrow();
    await expect(perms.grant("not a url", [ALICE])).rejects.toThrow();
  });

  it("bozuk kayıt erişim kararı vermez", async () => {
    // A corrupt entry must read as "no grant", never as an open one.
    store._memory.set("arfhe_site_permissions", [
      { origin: UNISWAP },                       // no accounts array
      { accounts: [ALICE] },                     // no origin
      { origin: EVIL, accounts: [123] },         // non-string account
      "garbage",
    ]);

    expect(await perms.getAccounts(UNISWAP)).toEqual([]);
    expect(await perms.getAccounts(EVIL)).toEqual([]);
  });

  it("depo tamamen okunamazsa kapalı kalır", async () => {
    const broken = new SitePermissionService({
      get: async () => { throw new Error("storage unavailable"); },
      set: async () => { },
    });
    expect(await broken.getAccounts(UNISWAP)).toEqual([]);
    expect(await broken.canUseAccount(UNISWAP, ALICE)).toBe(false);
  });

  it("değişiklikleri abonelere bildirir", async () => {
    const listener = vi.fn();
    perms.subscribe(listener);

    await perms.grant(UNISWAP, [ALICE]);
    expect(listener).toHaveBeenCalledTimes(1);

    await perms.revoke(UNISWAP);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("per-account revocation", () => {
  /**
   * A grant belongs to an origin *and* an account. The screens that show connections show
   * one account's, so the revoke behind them has to match — otherwise a user looking at
   * one account disconnects sites from another they never saw.
   */
  let store: ReturnType<typeof makeStore>;
  let perms: SitePermissionService;

  const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  beforeEach(async () => {
    store = makeStore();
    perms = new SitePermissionService(store);
    await perms.grant("https://shared.example", [ALICE, BOB]);
    await perms.grant("https://alice-only.example", [ALICE]);
  });

  it("bir hesabı kaldırmak diğerinin erişimini korur", async () => {
    await perms.revokeAccount("https://shared.example", ALICE);

    expect(await perms.canUseAccount("https://shared.example", ALICE)).toBe(false);
    // Bob never asked to be disconnected and was not on the screen that did it.
    expect(await perms.canUseAccount("https://shared.example", BOB)).toBe(true);
  });

  it("son hesap da kaldırılınca site tamamen düşer", async () => {
    // An origin with an empty account list is a grant to nobody; leaving it would keep the
    // site listed as connected while it can see nothing.
    await perms.revokeAccount("https://alice-only.example", ALICE);

    const all = await perms.getAll();
    expect(all.some((p) => p.origin === "https://alice-only.example")).toBe(false);
  });

  it("hepsini kaldır yalnızca o hesabı etkiler", async () => {
    await perms.revokeAccountEverywhere(ALICE);

    expect(await perms.canUseAccount("https://shared.example", ALICE)).toBe(false);
    expect(await perms.canUseAccount("https://alice-only.example", ALICE)).toBe(false);
    // Bob keeps the site he shares, which is the whole point of scoping the button.
    expect(await perms.canUseAccount("https://shared.example", BOB)).toBe(true);
  });

  it("bilinmeyen hesap veya origin hiçbir şeyi silmez", async () => {
    await perms.revokeAccount("https://shared.example", "0xdead");
    await perms.revokeAccount("https://not-a-site.example", ALICE);

    expect(await perms.canUseAccount("https://shared.example", ALICE)).toBe(true);
    expect(await perms.canUseAccount("https://shared.example", BOB)).toBe(true);
  });
});

describe("normalizeOrigin", () => {
  it("tam URL'den origin çıkarır", () => {
    expect(normalizeOrigin("https://app.uniswap.org/swap?a=1")).toBe("https://app.uniswap.org");
  });

  it("web olmayanı reddeder", () => {
    expect(normalizeOrigin("file:///tmp/x.html")).toBe("");
    expect(normalizeOrigin("chrome://extensions")).toBe("");
    expect(normalizeOrigin("data:text/html,x")).toBe("");
    expect(normalizeOrigin("")).toBe("");
    expect(normalizeOrigin(undefined)).toBe("");
  });
});

// ─── Contract with the service worker ───────────────────────────────


describe("service worker agreement", () => {
  // The worker is plain JS copied verbatim into the build, so it cannot import this
  // module. It reads the same storage area to answer `eth_accounts` and to gate every
  // other method. If the key drifts, the worker silently sees no grants — every site
  // would be told it is not connected, and `eth_accounts` would return nothing.
  const workerSource = readFileSync(resolve(process.cwd(), "service-worker.js"), "utf8");

  it("depo anahtarı iki tarafta da aynı", () => {
    expect(workerSource).toContain('"arfhe_site_permissions"');
  });

  it("worker izinleri chrome.storage.local'dan okur", () => {
    // Not session storage: a grant must survive a browser restart, and the gate has to
    // work before the wallet is unlocked.
    expect(workerSource).toMatch(/chrome\.storage\.local\.get\(STORAGE_KEY_SITE_PERMISSIONS\)/);
  });

  it("worker kaydı origin ve accounts alanlarıyla okur", () => {
    expect(workerSource).toMatch(/p\.origin === origin/);
    expect(workerSource).toMatch(/Array\.isArray\(p\.accounts\)/);
  });
});
