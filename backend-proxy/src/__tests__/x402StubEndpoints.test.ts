import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

/**
 * POST /agent/x402/payment-required ve POST /agent/x402/settle testleri.
 *
 * Her ikisi de STUB (x402Stub.ts) — gerçek bir resource server veya facilitator'a hiç
 * bağlanmıyor. Bu testler gerçek x402 davranışını değil, stub'ın kararlı ve doğru şekilde
 * "sahte veri" ürettiğini ve CORS/rate-limit/validation davranışının diğer endpoint'lerle
 * tutarlı olduğunu doğruluyor.
 */

const EXTENSION_ORIGIN = "chrome-extension://ajfpejolnhgeflhgjmboikiffpdlhngi";

function postX402(path: string, body: unknown, origin: string = EXTENSION_ORIGIN) {
  return SELF.fetch(`https://proxy.example${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

describe("POST /agent/x402/payment-required", () => {
  it("402 durum kodu ve x402-şekilli ödeme gereksinimleri döner, açıkça STUB olarak işaretlenmiş", async () => {
    const res = await postX402("/agent/x402/payment-required", { resource: "https://api.example.com/weather" });
    expect(res.status).toBe(402);

    const body = (await res.json()) as {
      x402Version: number;
      accepts: Array<{ scheme: string; network: string; resource: string; payTo: string; asset: string }>;
      _stub: boolean;
    };
    expect(body._stub).toBe(true);
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0].scheme).toBe("exact");
    expect(body.accepts[0].network).toBe("base-sepolia");
    expect(body.accepts[0].resource).toBe("https://api.example.com/weather");
  });

  it("_stub alanı ve error metni bunun gerçek bir 402 olmadığını açıkça belirtir", async () => {
    const res = await postX402("/agent/x402/payment-required", { resource: "https://api.example.com/weather" });
    const body = (await res.json()) as { error: string; _stub: true };
    expect(body._stub).toBe(true);
    expect(body.error.toLowerCase()).toContain("stub");
  });

  it('resource alanı eksikse 400 döner', async () => {
    const res = await postX402("/agent/x402/payment-required", {});
    expect(res.status).toBe(400);
  });

  it('resource boş string ise 400 döner', async () => {
    const res = await postX402("/agent/x402/payment-required", { resource: "   " });
    expect(res.status).toBe(400);
  });

  it("izin verilmeyen origin'den 403 döner", async () => {
    const res = await postX402("/agent/x402/payment-required", { resource: "x" }, "https://evil.example");
    expect(res.status).toBe(403);
  });

  it("her çağrıda aynı sabit (stub) veriyi döner — gerçek bir kaynak sorgulamaz", async () => {
    const first = await (await postX402("/agent/x402/payment-required", { resource: "https://api.example.com/a" })).json() as { accepts: Array<{ payTo: string; asset: string }> };
    const second = await (await postX402("/agent/x402/payment-required", { resource: "https://api.example.com/b" })).json() as { accepts: Array<{ payTo: string; asset: string }> };
    expect(first.accepts[0].payTo).toBe(second.accepts[0].payTo);
    expect(first.accepts[0].asset).toBe(second.accepts[0].asset);
  });
});

describe("POST /agent/x402/settle", () => {
  it("200 ve _stub:true ile sahte bir settlement döner", async () => {
    const res = await postX402("/agent/x402/settle", {
      resource: "https://api.example.com/weather",
      paymentPayload: { signature: "0xfake" },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { success: boolean; txHash: string; _stub: boolean; note: string };
    expect(body.success).toBe(true);
    expect(body._stub).toBe(true);
    expect(body.txHash.startsWith("0xSTUB")).toBe(true);
    expect(body.note.toLowerCase()).toContain("stub");
  });

  it('resource alanı eksikse 400 döner', async () => {
    const res = await postX402("/agent/x402/settle", { paymentPayload: {} });
    expect(res.status).toBe(400);
  });

  it('paymentPayload alanı hiç yoksa 400 döner', async () => {
    const res = await postX402("/agent/x402/settle", { resource: "https://api.example.com/weather" });
    expect(res.status).toBe(400);
  });

  it('paymentPayload açıkça null/boş olsa bile (alan mevcut olduğu sürece) kabul eder — stub, imzayı hiç doğrulamıyor', async () => {
    const res = await postX402("/agent/x402/settle", { resource: "https://api.example.com/weather", paymentPayload: null });
    expect(res.status).toBe(200);
  });

  it("izin verilmeyen origin'den 403 döner", async () => {
    const res = await postX402("/agent/x402/settle", { resource: "x", paymentPayload: {} }, "https://evil.example");
    expect(res.status).toBe(403);
  });
});
