/**
 * Tests for the one distinction the confidential side must never lose: an empty balance
 * and an unreadable one.
 *
 * A confidential balance is a handle on-chain plus a decryption round-trip off it. The
 * handle is authoritative — if it is non-zero, a ciphertext exists and the user owns
 * something. The decryption is not: the coprocessor lags for seconds after a shield, a
 * permit expires, the threshold network hiccups.
 *
 * Collapsing a failed decrypt into "0.0" made those two states identical, and every screen
 * that hides zero-balance rows then hid real assets. From the user's side the tokens had
 * simply vanished from their wallet — the worst possible failure mode for a wallet whose
 * entire premise is that balances are private but still yours.
 *
 * These tests pin the invariant: a non-zero handle never produces a row that reads as
 * empty, whatever happens after it.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Network } from "../Network.js";
import { NetworkId } from "../NetworkTypes.js";
import type Account from "../Account.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const WRAPPER = "0x2222222222222222222222222222222222222222";

/** A 32-byte non-zero ciphertext handle: proof a balance exists on-chain. */
const NONZERO_HANDLE = "0x" + "0".repeat(63) + "7";
const ZERO_HANDLE = "0x" + "0".repeat(64);

function makeNetwork(): Network {
  const net = new Network(NetworkId.Ethereum_Sepolia, "Sepolia", undefined, "CUSTOM_URL");
  net.rpc_url = "https://rpc.example.test";
  net.alchemy = undefined;
  return net;
}

/** Minimal account stand-in — only the address is read on this path. */
const account = { GetAddress: () => OWNER } as unknown as Account;

/**
 * Reach the private reader directly.
 *
 * The public `getShieldedBalance` deliberately flattens the flag away, so testing through
 * it could not distinguish the two states — which is the entire subject here.
 */
function readBalance(net: Network, wrapper = WRAPPER) {
  return (
    net as unknown as {
      readShieldedBalance: (
        c: string,
        u: string,
        a?: Account
      ) => Promise<{ balance: string; decryptFailed: boolean }>;
    }
  ).readShieldedBalance(wrapper, OWNER, account);
}

describe("okunamayan gizli bakiye boş bakiyeden ayrılır", () => {
  // Sepolia is one of the three chains CoFHE runs on, so the network built above is
  // FHE-capable on its own — no stubbing needed to reach the code under test.
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sıfır handle gerçekten boş bakiyedir", async () => {
    const net = makeNetwork();
    vi.spyOn(net, "call").mockResolvedValue(ZERO_HANDLE);

    // The only case that actually proves emptiness: no ciphertext was ever created.
    expect(await readBalance(net)).toEqual({ balance: "0.0", decryptFailed: false });
  });

  it("çözme hatası bakiyeyi sıfır olarak bildirmez", async () => {
    const net = makeNetwork();
    vi.spyOn(net, "call").mockResolvedValue(NONZERO_HANDLE);
    // Stand in for a coprocessor that has not ingested the ciphertext yet.
    vi.spyOn(net as unknown as { ensureFhe: () => Promise<unknown> }, "ensureFhe").mockRejectedValue(
      new Error("ciphertext not found")
    );

    const result = await readBalance(net);
    expect(result.decryptFailed).toBe(true);
    // "0.0" is a placeholder so downstream arithmetic stays safe — never a claim.
    expect(result.balance).toBe("0.0");
  });

  it("RPC erişilemezse bakiye bilinmiyor sayılır", async () => {
    const net = makeNetwork();
    vi.spyOn(net, "call").mockRejectedValue(new Error("network unreachable"));

    // Nothing was learned about this wrapper, so nothing may be asserted about it.
    expect((await readBalance(net)).decryptFailed).toBe(true);
  });

  it("kilitli cüzdan bakiyeyi boş göstermez", async () => {
    const net = makeNetwork();
    const call = vi.spyOn(net, "call");

    const locked = await (
      net as unknown as {
        readShieldedBalance: (c: string, u: string, a?: Account) => Promise<{ decryptFailed: boolean }>;
      }
    ).readShieldedBalance(WRAPPER, OWNER, undefined);

    // Without a key there is no permit and no decryption. Reporting "0.0" here would have
    // told a locked wallet's owner their shielded assets were gone.
    expect(locked.decryptFailed).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it("başarılı çözme bayrağı kaldırmaz", async () => {
    const net = makeNetwork();
    vi.spyOn(net, "call").mockResolvedValue(NONZERO_HANDLE);
    vi.spyOn(net as unknown as { ensureFhe: () => Promise<unknown> }, "ensureFhe").mockResolvedValue({
      decryptForView: async () => 1_500_000n,
    });
    vi.spyOn(
      net as unknown as { getShieldedTokenMeta: () => Promise<unknown> },
      "getShieldedTokenMeta"
    ).mockResolvedValue({ confidentialDecimals: 6, rate: 1n });

    expect(await readBalance(net)).toEqual({ balance: "1.5", decryptFailed: false });
  });

  it("getShieldedBalance eski string sözleşmesini korur", async () => {
    const net = makeNetwork();
    vi.spyOn(net, "call").mockResolvedValue(NONZERO_HANDLE);
    vi.spyOn(net as unknown as { ensureFhe: () => Promise<unknown> }, "ensureFhe").mockRejectedValue(
      new Error("boom")
    );

    // Existing callers only ever wanted a number to print; they must keep compiling and
    // must not start throwing because the reader underneath grew a second field.
    await expect(net.getShieldedBalance(WRAPPER, OWNER, account)).resolves.toBe("0.0");
  });
});

/**
 * The UI-side half of the same invariant.
 *
 * Home, the Privacy page, the Send panel and the unshield dropdown each filter out
 * zero-balance rows to keep the list readable. Every one of them has to make an exception
 * for an unreadable balance, or the token disappears from that screen. This is the shared
 * predicate they all express.
 */
describe("görünürlük kuralı", () => {
  const visible = (h: { balance: string; decryptFailed: boolean }) =>
    parseFloat(h.balance) > 0 || h.decryptFailed;

  it("bakiyesi olan token görünür", () => {
    expect(visible({ balance: "12.5", decryptFailed: false })).toBe(true);
  });

  it("gerçekten boş token gizlenir", () => {
    expect(visible({ balance: "0.0", decryptFailed: false })).toBe(false);
  });

  it("çözülemeyen token gizlenmez", () => {
    // The regression: this row read as "0.0" and was filtered away with the empties.
    expect(visible({ balance: "0.0", decryptFailed: true })).toBe(true);
  });
});
