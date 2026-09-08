/**
 * How the wallet asks for a fragment, and what it does when it cannot have one.
 *
 * The behaviour that matters most is what happens when things go wrong. This runs behind a
 * small mark in the corner of ordinary screens — Settings, Privacy, the encryption overlay —
 * so a rejected promise here would surface as a crash on a page that has nothing to do with
 * the hunt. Every failure has to come back as a readable result instead.
 *
 * The other thing under test is that nothing about a fragment is decided locally. The wallet
 * asks; the server answers. If this file could ever produce words on its own, the whole
 * reason for the server would be gone.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Wallet } from "ethers";

/**
 * A fixed key rather than `Wallet.createRandom()`.
 *
 * ethers' random generator does not work under jsdom here: jsdom supplies its own
 * `Uint8Array`, and a Node Buffer is an instance of Node's, so ethers' `instanceof` check
 * fails across the two realms. (The same mismatch is why `Mnemonic.isValidMnemonic` cannot
 * be trusted in this suite — see normalizeMnemonic.test.ts.) Signing with a supplied key
 * takes no random bytes and works fine, and a deterministic key makes these tests
 * reproducible besides.
 *
 * This is Hardhat's well-known account #1. It holds nothing and is public by design.
 */
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const HUNT_API = "https://hunt.test";
vi.stubEnv("VITE_HUNT_API_URL", HUNT_API);

async function loadService() {
  vi.resetModules();
  return import("../HuntService");
}

/** An account shaped the way AccountManager hands them out. */
function fakeAccount(wallet: Wallet) {
  return {
    ethers_wallet: wallet,
    GetAddress: () => wallet.address,
  } as never;
}

describe("HuntService.claimFragment", () => {
  let wallet: Wallet;

  beforeEach(() => {
    wallet = new Wallet(TEST_KEY);
    vi.stubEnv("VITE_HUNT_API_URL", HUNT_API);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns the words the server sends, and signs a nonce to get them", async () => {
    const seen: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      seen.push({ url, body });
      if (url.endsWith("/hunt/nonce")) {
        return { status: 200, json: async () => ({ nonce: "abc123" }) };
      }
      return { status: 200, json: async () => ({ words: "5. clog 6. armor" }) };
    }));

    const { claimFragment } = await loadService();
    const result = await claimFragment("f3", fakeAccount(wallet));

    expect(result).toEqual({ status: "revealed", words: "5. clog 6. armor" });
    // The claim must carry a signature over the server's nonce — not a bare address, which
    // anyone could send for anyone.
    const claim = seen.find((s) => s.url.endsWith("/hunt/fragment"))!;
    expect(claim.body.nonce).toBe("abc123");
    expect(claim.body.address).toBe(wallet.address);
    expect(claim.body.signature).toMatch(/^0x[0-9a-f]{130}$/i);
  });

  it("passes the server's reason through when the gate is not met", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.endsWith("/hunt/nonce")
        ? { status: 200, json: async () => ({ nonce: "n" }) }
        : { status: 403, json: async () => ({ error: "not earned yet", reason: "shield something first" }) },
    ));

    const { claimFragment } = await loadService();
    // The reason is the puzzle. Replacing it with a generic "no" would remove the only
    // thing that tells a finder what to try next.
    expect(await claimFragment("f3", fakeAccount(wallet)))
      .toEqual({ status: "locked", reason: "shield something first" });
  });

  it("does not crash when the network is gone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const { claimFragment } = await loadService();
    const result = await claimFragment("f1", fakeAccount(wallet));
    expect(result.status).toBe("unavailable");
  });

  it("does not crash when the server returns something unexpected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 500, json: async () => { throw new Error("no json"); } })));
    const { claimFragment } = await loadService();
    expect((await claimFragment("f1", fakeAccount(wallet))).status).toBe("unavailable");
  });

  it("asks for nothing when there is no unlocked account", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { claimFragment } = await loadService();

    expect((await claimFragment("f1", undefined)).status).toBe("locked");
    // No account means no signature is possible, so the request is never worth making.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stays silent when no hunt server is configured", async () => {
    vi.stubEnv("VITE_HUNT_API_URL", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { claimFragment } = await loadService();

    // An empty URL is how the hunt is switched off. It must not become a request to the
    // extension's own origin, which is what a relative fetch would do.
    expect((await claimFragment("f1", fakeAccount(wallet))).status).toBe("unavailable");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports rate limiting as its own thing, not as a failed gate", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.endsWith("/hunt/nonce")
        ? { status: 200, json: async () => ({ nonce: "n" }) }
        : { status: 429, json: async () => ({ error: "too many requests" }) },
    ));
    const { claimFragment } = await loadService();
    const result = await claimFragment("f1", fakeAccount(wallet));
    // "You have not earned this" would be a lie, and would send someone off to do work
    // they have already done.
    expect(result.status).toBe("unavailable");
  });
});
