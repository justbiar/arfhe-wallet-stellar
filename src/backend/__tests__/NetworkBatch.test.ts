/**
 * Tests for Network's JSON-RPC batching layer.
 *
 * This code sits underneath every confidential balance read: the wallet resolves the
 * whole wrapper registry, then asks for one `confidentialBalanceOf` per wrapper in a
 * single request and matches the answers back up by position. If that alignment slips,
 * a balance is silently attributed to the wrong token — the user sees someone else's
 * number against their own asset, and the error is invisible because every value still
 * looks plausible. Hence the emphasis here on ordering rather than happy-path shape.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Network } from "../Network.js";
import { NetworkId } from "../NetworkTypes.js";

/** A Network wired to a dummy HTTP RPC, with no Alchemy client. */
function makeNetwork(): Network {
  const net = new Network(NetworkId.Ethereum_Sepolia, "Sepolia", undefined, "CUSTOM_URL");
  net.rpc_url = "https://rpc.example.test";
  net.alchemy = undefined;
  return net;
}

/** Stub global.fetch with a handler over the parsed request body. */
function stubFetch(handler: (body: unknown) => unknown) {
  const spy = vi.fn(async (_url: string, init: { body: string }) => ({
    ok: true,
    status: 200,
    json: async () => handler(JSON.parse(init.body)),
  }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("Network.callBatch", () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("boş istek listesi için ağa hiç gitmez", async () => {
    const spy = stubFetch(() => []);
    const result = await makeNetwork().callBatch([]);
    expect(result).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("tüm çağrıları tek bir HTTP isteğinde toplar", async () => {
    const spy = stubFetch((body) =>
      (body as { id: number }[]).map((r) => ({ id: r.id, jsonrpc: "2.0", result: `0x${r.id}` }))
    );

    const requests = Array.from({ length: 12 }, (_, i) => ({
      method: "eth_call",
      params: [{ to: `0x${i}` }, "latest"],
    }));
    const result = await makeNetwork().callBatch(requests);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result).toEqual(requests.map((_, i) => `0x${i}`));
  });

  it("sunucu sırayı karıştırsa bile sonuçları id ile hizalar", async () => {
    // JSON-RPC does not promise response order, and a mismatched balance is invisible.
    stubFetch((body) => {
      const entries = (body as { id: number }[]).map((r) => ({
        id: r.id, jsonrpc: "2.0", result: `result-${r.id}`,
      }));
      return entries.reverse();
    });

    const requests = Array.from({ length: 5 }, (_, i) => ({ method: "eth_call", params: [i] }));
    const result = await makeNetwork().callBatch(requests);

    expect(result).toEqual(["result-0", "result-1", "result-2", "result-3", "result-4"]);
  });

  it("chunk sınırını aşan istekleri böler ve sırayı korur", async () => {
    const spy = stubFetch((body) =>
      (body as { id: number; params: number[] }[]).map((r) => ({
        id: r.id, jsonrpc: "2.0", result: `v${r.params[0]}`,
      }))
    );

    const requests = Array.from({ length: 7 }, (_, i) => ({ method: "eth_call", params: [i] }));
    const result = await makeNetwork().callBatch(requests, 3);

    expect(spy).toHaveBeenCalledTimes(3); // 3 + 3 + 1
    expect(result).toEqual(["v0", "v1", "v2", "v3", "v4", "v5", "v6"]);
  });

  it("tek tek hataları null yapar, komşularını bozmaz", async () => {
    stubFetch((body) =>
      (body as { id: number }[]).map((r) =>
        r.id === 1
          ? { id: r.id, jsonrpc: "2.0", error: { code: -32000, message: "execution reverted" } }
          : { id: r.id, jsonrpc: "2.0", result: `ok-${r.id}` }
      )
    );

    const requests = Array.from({ length: 3 }, (_, i) => ({ method: "eth_call", params: [i] }));
    const result = await makeNetwork().callBatch(requests);

    expect(result).toEqual(["ok-0", null, "ok-2"]);
  });

  it("yanıtta eksik kalan girdiler null döner", async () => {
    // A truncated response must not shift the remaining answers up by one.
    stubFetch((body) =>
      (body as { id: number }[]).filter((r) => r.id !== 0).map((r) => ({
        id: r.id, jsonrpc: "2.0", result: `ok-${r.id}`,
      }))
    );

    const result = await makeNetwork().callBatch(
      Array.from({ length: 3 }, (_, i) => ({ method: "eth_call", params: [i] }))
    );

    expect(result).toEqual([null, "ok-1", "ok-2"]);
  });

  it("toplu isteği desteklemeyen sağlayıcıda tek tek çağrıya düşer", async () => {
    // Some RPCs answer a batch with a single object instead of an array.
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const parsed = JSON.parse(init.body);
      call++;
      if (Array.isArray(parsed)) {
        return { ok: true, status: 200, json: async () => ({ error: { message: "batch unsupported" } }) };
      }
      return { ok: true, status: 200, json: async () => ({ id: 1, jsonrpc: "2.0", result: `single-${parsed.params[0]}` }) };
    }));

    const result = await makeNetwork().callBatch(
      Array.from({ length: 3 }, (_, i) => ({ method: "eth_call", params: [i] }))
    );

    expect(result).toEqual(["single-0", "single-1", "single-2"]);
    expect(call).toBeGreaterThan(1); // the batch attempt plus the individual retries
  });

  it("RPC adresi yoksa hata verir", async () => {
    const net = makeNetwork();
    net.rpc_url = "";
    await expect(net.callBatch([{ method: "eth_call", params: [] }])).rejects.toThrow("RPC URL not set");
  });
});
