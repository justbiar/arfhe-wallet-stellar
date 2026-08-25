/**
 * Tests for the request gate that stands between the wallet's screens and the provider.
 *
 * The wallet opens several screens at once, each resolving its own data. That is a
 * deliberate design choice — no screen waits on another — but it means the same read is
 * issued several times in the same tick, and providers answer a burst like that with 429.
 *
 * What is pinned here is the behaviour under that burst: identical reads share one round
 * trip, recent answers are reused, immutable metadata is not re-fetched, and a host never
 * has more connections open than the limit allows. Also pinned is what must *never* be
 * shared — a receipt poll, a nonce, a gas estimate — because reusing one of those answers
 * would silently break a send rather than merely slow it down.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { RpcClient } from "../RpcClient.js";

const URL_A = "https://rpc.example.test/key";
const URL_B = "https://other.example.test/key";

/** An `eth_call` for `decimals()` — fixed for the life of the contract. */
const DECIMALS_CALL = [{ to: "0xabc", data: "0x313ce567" }, "latest"];
/** An `eth_call` for `confidentialBalanceOf` — changes every block. */
const BALANCE_CALL = [{ to: "0xabc", data: "0x344ff101000000" }, "latest"];

describe("RpcClient", () => {
  let client: RpcClient;

  beforeEach(() => {
    client = new RpcClient();
    vi.useRealTimers();
  });

  describe("aynı anda gelen istekler birleştirilir", () => {
    it("eşzamanlı özdeş istekler tek çağrıya iner", async () => {
      const fetcher = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return "0x1";
      });

      // Exactly the mount storm: several screens asking at once, before any cache exists.
      const results = await Promise.all([
        client.request(URL_A, "eth_call", DECIMALS_CALL, fetcher),
        client.request(URL_A, "eth_call", DECIMALS_CALL, fetcher),
        client.request(URL_A, "eth_call", DECIMALS_CALL, fetcher),
      ]);

      expect(results).toEqual(["0x1", "0x1", "0x1"]);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(client.getStats().coalesced).toBe(2);
    });

    it("farklı parametreler birleştirilmez", async () => {
      const fetcher = vi.fn(async () => "0x1");
      await Promise.all([
        client.request(URL_A, "eth_call", DECIMALS_CALL, fetcher),
        client.request(URL_A, "eth_call", BALANCE_CALL, fetcher),
      ]);
      // Sharing these would attribute one contract's answer to another's question.
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("farklı ağlar birbirinin cevabını almaz", async () => {
      const fetcher = vi.fn(async () => "0x1");
      await client.request(URL_A, "eth_chainId", [], fetcher);
      await client.request(URL_B, "eth_chainId", [], fetcher);
      // Keyed by URL, so switching chains cannot serve the previous chain's answer.
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("hata birleştirilmiş çağıranların hepsine ulaşır", async () => {
      const fetcher = vi.fn(async () => { throw new Error("boom"); });
      const both = Promise.all([
        client.request(URL_A, "eth_call", DECIMALS_CALL, fetcher).catch((e) => e.message),
        client.request(URL_A, "eth_call", DECIMALS_CALL, fetcher).catch((e) => e.message),
      ]);
      expect(await both).toEqual(["boom", "boom"]);
    });

    it("başarısız istek tekrar denenebilir kalır", async () => {
      const fetcher = vi.fn()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce("0x5");

      await expect(client.request(URL_A, "eth_call", DECIMALS_CALL, fetcher)).rejects.toThrow();
      // A failure must not leave a permanent in-flight entry, or the wallet would keep
      // handing every later caller the same rejected promise.
      await expect(client.request(URL_A, "eth_call", DECIMALS_CALL, fetcher)).resolves.toBe("0x5");
    });
  });

  describe("önbellek", () => {
    it("değişmeyen metadata ikinci kez ağa gitmez", async () => {
      const fetcher = vi.fn(async () => "0x12");
      await client.request(URL_A, "eth_call", DECIMALS_CALL, fetcher);
      await client.request(URL_A, "eth_call", DECIMALS_CALL, fetcher);
      // decimals() cannot change; re-reading it per token row is the waste this prevents.
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(client.getStats().hits).toBe(1);
    });

    it("makbuz sorgusu asla önbelleğe alınmaz", async () => {
      const fetcher = vi.fn(async () => null);
      await client.request(URL_A, "eth_getTransactionReceipt", ["0xdead"], fetcher);
      await client.request(URL_A, "eth_getTransactionReceipt", ["0xdead"], fetcher);
      // A receipt goes from null to final exactly once. Serving a cached null would leave
      // a confirmed transaction looking pending forever.
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("nonce ve gaz tahmini önbelleğe alınmaz", async () => {
      const fetcher = vi.fn(async () => "0x1");
      for (const method of ["eth_getTransactionCount", "eth_estimateGas", "eth_gasPrice"]) {
        fetcher.mockClear();
        await client.request(URL_A, method, [], fetcher);
        await client.request(URL_A, method, [], fetcher);
        // A stale nonce produces a replacement transaction; a stale gas price an
        // underpriced one. Both fail a send the user already approved.
        expect(fetcher, method).toHaveBeenCalledTimes(2);
      }
    });

    it("invalidateVolatile bakiyeyi düşürür, metadatayı korur", async () => {
      const balance = vi.fn(async () => "0x1");
      const decimals = vi.fn(async () => "0x12");

      await client.request(URL_A, "eth_call", BALANCE_CALL, balance);
      await client.request(URL_A, "eth_call", DECIMALS_CALL, decimals);

      client.invalidateVolatile();

      await client.request(URL_A, "eth_call", BALANCE_CALL, balance);
      await client.request(URL_A, "eth_call", DECIMALS_CALL, decimals);

      // After a transaction the balance moved but decimals() did not.
      expect(balance).toHaveBeenCalledTimes(2);
      expect(decimals).toHaveBeenCalledTimes(1);
    });

    it("invalidate yalnızca verilen ağı temizler", async () => {
      const a = vi.fn(async () => "0x1");
      const b = vi.fn(async () => "0x2");
      await client.request(URL_A, "eth_call", DECIMALS_CALL, a);
      await client.request(URL_B, "eth_call", DECIMALS_CALL, b);

      client.invalidate(URL_A);

      await client.request(URL_A, "eth_call", DECIMALS_CALL, a);
      await client.request(URL_B, "eth_call", DECIMALS_CALL, b);
      expect(a).toHaveBeenCalledTimes(2);
      expect(b).toHaveBeenCalledTimes(1);
    });
  });

  describe("eşzamanlılık sınırı", () => {
    it("bir host için açık istek sayısı sınırı aşmaz", async () => {
      let active = 0;
      let peak = 0;
      const release: (() => void)[] = [];

      const fetcher = async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => release.push(r));
        active--;
        return "0x1";
      };

      // Distinct params so nothing is coalesced — this measures the limit, not sharing.
      const all = Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          client.request(URL_A, "eth_getBalance", [`0x${i}`, "latest"], fetcher)
        )
      );

      // Let the queue settle, then drain it.
      await new Promise((r) => setTimeout(r, 20));
      expect(peak).toBeLessThanOrEqual(8);

      while (release.length > 0 || active > 0) {
        release.splice(0).forEach((fn) => fn());
        await new Promise((r) => setTimeout(r, 5));
      }
      await all;
      expect(peak).toBeLessThanOrEqual(8);
    });

    it("hata durumunda slot geri verilir", async () => {
      const failing = vi.fn(async () => { throw new Error("nope"); });

      // Enough failures to exhaust the pool several times over. If a slot leaked on the
      // error path, the host would deadlock and this would time out rather than fail.
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          client.request(URL_A, "eth_getBalance", [`0x${i}`, "latest"], failing).catch(() => null)
        )
      );

      await expect(
        client.request(URL_A, "eth_getBalance", ["0xlast", "latest"], async () => "0x9")
      ).resolves.toBe("0x9");
    });

    it("slot() ikinci kez çağrılınca sayacı bozmaz", async () => {
      // callBatch releases in both its catch and its finally; the second call must be inert
      // or the pool would grow past its limit on every batch that falls back.
      const release = await client.slot(URL_A);
      release();
      release();

      let peak = 0;
      let active = 0;
      const fetcher = async () => {
        active++; peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--; return "0x1";
      };
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          client.request(URL_A, "eth_getBalance", [`0x${i}`, "latest"], fetcher)
        )
      );
      expect(peak).toBeLessThanOrEqual(8);
    });
  });

  it("reset her şeyi unutur", async () => {
    const fetcher = vi.fn(async () => "0x1");
    await client.request(URL_A, "eth_call", DECIMALS_CALL, fetcher);
    expect(client.getStats().cacheSize).toBe(1);

    client.reset();
    // Wallet lock must leave no chain reads behind in memory.
    expect(client.getStats().cacheSize).toBe(0);

    await client.request(URL_A, "eth_call", DECIMALS_CALL, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
