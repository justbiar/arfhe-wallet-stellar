/**
 * What happens to the wallet when its primary RPC stops answering.
 *
 * This matters more than it looks. The extension ships with one Alchemy key per chain,
 * compiled into a bundle every user downloads — so it is one quota for the entire
 * userbase, and extractable by anyone who installs it. Whether that key being exhausted
 * takes the wallet down or merely makes it slower is decided entirely by the code these
 * tests cover.
 *
 * The endpoints in `PUBLIC_FALLBACKS` were checked against the live networks before being
 * added; these tests pin the *logic* around them and make no network calls.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Network } from "../Network";
import { NetworkId } from "../NetworkTypes";
import { rpcClient } from "../RpcClient";

/** A network with a primary that behaves however the test says. */
function makeNetwork(primary = "https://primary.example/key"): Network {
  const net = new Network(NetworkId.Ethereum_Sepolia, "Sepolia");
  net.rpc_url = primary;
  return net;
}

/** Stub `fetch` with a per-host verdict, recording the order hosts were tried in. */
function stubFetch(verdict: (url: string) => "ok" | "429" | "offline") {
  const tried: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    tried.push(url);
    const outcome = verdict(url);
    if (outcome === "offline") throw new TypeError("Failed to fetch");
    if (outcome === "429") {
      return {
        ok: false,
        status: 429,
        json: async () => ({ error: { message: "Too Many Requests" } }),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 1, jsonrpc: "2.0", result: `answered-by:${new URL(url).host}` }),
    } as unknown as Response;
  }));
  return tried;
}

describe("RPC failover", () => {
  beforeEach(() => {
    rpcClient.reset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("üç yerleşik ağın hepsinde yedek uç tanımlı", () => {
    // A shipped chain with no fallback is a chain that dies with the key.
    for (const id of [NetworkId.Ethereum_Sepolia, NetworkId.Base_Sepolia, NetworkId.Arbitrum_Sepolia]) {
      const net = new Network(id, "n");
      expect(net.fallbackRpcUrls.length, `network ${id}`).toBeGreaterThan(0);
      for (const url of net.fallbackRpcUrls) expect(url).toMatch(/^https:\/\//);
    }
  });

  it("birincil uç 429 verince yedeğe geçer ve cevabı döndürür", async () => {
    const net = makeNetwork();
    const tried = stubFetch((url) => (url.includes("primary.example") ? "429" : "ok"));

    const result = await net.call("eth_blockNumber", []);

    expect(result).toMatch(/^answered-by:/);
    expect(result).not.toContain("primary.example");
    expect(tried.some((u) => u.includes("primary.example"))).toBe(true);
  });

  it("birincil tamamen çökse de zincirdeki bir sonrakini dener", async () => {
    const net = makeNetwork();
    // Everything fails except the last endpoint in the shipped chain.
    const last = net.fallbackRpcUrls[net.fallbackRpcUrls.length - 1];
    stubFetch((url) => (url === last ? "ok" : "offline"));

    await expect(net.call("eth_blockNumber", [])).resolves.toContain(new URL(last).host);
  });

  it("hiçbir uç cevap vermezse hata fırlatır — sessizce sıfır dönmez", async () => {
    // A wallet that turns "every endpoint is down" into a zero balance is worse than one
    // that says it does not know.
    const net = makeNetwork();
    stubFetch(() => "offline");

    await expect(net.call("eth_blockNumber", [])).rejects.toBeTruthy();
  });

  it("indeksleyiciye özgü çağrıda yedeğe geçmez", async () => {
    // A public node answers alchemy_* with "method not found", which is a different
    // failure the caller cannot tell from a real answer. Its own non-indexed path is the
    // correct recovery, and it only gets there if this one fails cleanly.
    const net = makeNetwork();
    const tried = stubFetch((url) => (url.includes("primary.example") ? "429" : "ok"));

    await expect(net.call("alchemy_getAssetTransfers", [{}])).rejects.toBeTruthy();
    expect(tried.every((u) => u.includes("primary.example"))).toBe(true);
  });

  it("düşen birincili bir süre atlar, sonra tekrar dener", async () => {
    const net = makeNetwork();
    let primaryHealthy = false;
    const tried = stubFetch((url) =>
      url.includes("primary.example") ? (primaryHealthy ? "ok" : "429") : "ok"
    );

    await net.call("eth_blockNumber", []);           // fails over, starts the cooldown
    const afterFirst = tried.length;

    rpcClient.reset();                                // otherwise the answer is cached
    await net.call("eth_getBalance", ["0x1", "latest"]);

    // During the cooldown the primary is not asked at all — paying its retry budget on
    // every request is slower than having no primary.
    expect(tried.slice(afterFirst).some((u) => u.includes("primary.example"))).toBe(false);

    primaryHealthy = true;
    vi.advanceTimersByTime(61_000);
    rpcClient.reset();
    const back = tried.length;
    await net.call("eth_getBalance", ["0x2", "latest"]);

    // And it is tried again afterwards: the primary is the only endpoint that can answer
    // history, so a bad minute must not cost the user the rest of their session.
    expect(tried.slice(back).some((u) => u.includes("primary.example"))).toBe(true);
  });
});
