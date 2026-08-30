import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";

/**
 * POST /agent/x402/payment-required ve POST /agent/x402/settle — X402_USE_REAL_FACILITATOR="true"
 * iken (gerçek facilitator yolu, x402FacilitatorClient.ts). x402StubEndpoints.test.ts'in aksine,
 * burada bayrak açık ve dış dünyaya giden `fetch` mock'lanıyor (gerçek x402.org/facilitator'a her
 * test koşusunda istek atmıyoruz — rate limit/flakiness riski).
 */

const EXTENSION_ORIGIN = "chrome-extension://cdhfecdlpblpdngkadiigjmodedapoih";

function postX402(path: string, body: unknown, origin: string = EXTENSION_ORIGIN) {
  return SELF.fetch(`https://proxy.example${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

const VALID_SIGNED_PAYLOAD = {
  signature: "0x" + "ab".repeat(65),
  authorization: {
    from: "0x1111111111111111111111111111111111111111",
    to: "0x9332339e54A27f9350C7Be300b4B9dEBc7D1c350",
    value: "10000",
    validAfter: 0,
    validBefore: 9999999999,
    nonce: "0x" + "cd".repeat(32),
  },
};

describe("gerçek facilitator yolu (X402_USE_REAL_FACILITATOR=true)", () => {
  beforeEach(() => {
    env.X402_USE_REAL_FACILITATOR = "true";
  });

  // "false"'a (wrangler.toml'daki gerçek varsayılana) SABİT olarak geri döner — ambient bir
  // değeri (`const originalFlag = env.X402_USE_REAL_FACILITATOR` gibi) capture edip geri
  // yazmak KIRILGAN: bu dosya çalıştığında env zaten kirlenmiş olabilir (ör. yerel bir .dev.vars
  // dosyasında geliştirici manuel Chrome-uçtan-uca testi için X402_USE_REAL_FACILITATOR=true
  // bırakmışsa — gitignored, CI'da yok ama yerel makinede miniflare/vitest-pool-workers bunu da
  // wrangler.toml ile birlikte okuyor), o zaman "restore" aslında "true"ya geri dönüyor ve bu
  // dosyadaki "stub yolu" describe'ına (aşağıda), hatta AYRI bir dosya olan
  // x402StubEndpoints.test.ts'e bile sızıyordu (env aynı worker instance'ında dosya/describe
  // sınırları arasında paylaşılıyor). Testin kendi varsayımı ("stub" davranışı sadece
  // X402_USE_REAL_FACILITATOR !== "true" iken geçerli) burada açıkça, ambient duruma bakılmaksızın
  // garanti ediliyor.
  afterEach(() => {
    env.X402_USE_REAL_FACILITATOR = "false";
    vi.unstubAllGlobals();
  });

  describe("POST /agent/x402/payment-required", () => {
    it("gerçek v1 şekilli requirements döner, _stub alanı YOK", async () => {
      const res = await postX402("/agent/x402/payment-required", { resource: "https://api.example.com/weather" });
      expect(res.status).toBe(402);
      const body = (await res.json()) as { x402Version: number; accepts: Array<Record<string, unknown>> };
      expect(body.x402Version).toBe(1);
      expect(body.accepts[0]?.payTo).toBe(env.X402_PAYTO_ADDRESS);
      expect(body.accepts[0]?.asset).toBe(env.X402_USDC_ASSET_ADDRESS);
      expect(body).not.toHaveProperty("_stub");
    });
  });

  describe("POST /agent/x402/settle", () => {
    it("KIRMIZI→YEŞİL: eski stub sözleşmesiyle ({resource, paymentPayload:{signature:'0xfake'}}) çağrılırsa 502 DEĞİL, açık bir hata ile 4xx/5xx döner — facilitator'a hiç gitmez", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const res = await postX402("/agent/x402/settle", {
        resource: "https://api.example.com/weather",
        paymentPayload: { signature: "0xfake" },
      });

      // Eski stub bu gövdeyle 200 dönerdi (bkz. x402StubEndpoints.test.ts). Gerçek client
      // reddediyor.
      expect(res.status).not.toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/EIP-3009/);
    });

    it("verify+settle ikisi de başarılı → 200, transaction alanı txHash'e çevrilmiş olarak döner", async () => {
      const fetchSpy = vi.fn(async (url: string) => {
        if (String(url).includes("/verify")) {
          return new Response(JSON.stringify({ isValid: true, payer: VALID_SIGNED_PAYLOAD.authorization.from }), { status: 200 });
        }
        return new Response(JSON.stringify({ success: true, network: "base-sepolia", transaction: "0xREALTX999" }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchSpy);

      const res = await postX402("/agent/x402/settle", {
        resource: "https://api.example.com/weather",
        paymentPayload: VALID_SIGNED_PAYLOAD,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; txHash: string; network: string };
      expect(body.success).toBe(true);
      expect(body.txHash).toBe("0xREALTX999");
      expect(body).not.toHaveProperty("transaction");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("verify başarısız → 402, hata mesajı X402ProxyClient.settleX402Payment()'ın throw etmesi için response.ok=false olur", async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: false, invalidReason: "invalid_exact_evm_signature" }), { status: 200 }));
      vi.stubGlobal("fetch", fetchSpy);

      const res = await postX402("/agent/x402/settle", {
        resource: "https://api.example.com/weather",
        paymentPayload: VALID_SIGNED_PAYLOAD,
      });
      expect(res.status).toBe(402);
      expect(res.ok).toBe(false);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_exact_evm_signature");
    });

    it("facilitator'a ağ hatası (fetch reddedilir) → 502", async () => {
      const fetchSpy = vi.fn(async () => {
        throw new Error("network down");
      });
      vi.stubGlobal("fetch", fetchSpy);

      const res = await postX402("/agent/x402/settle", {
        resource: "https://api.example.com/weather",
        paymentPayload: VALID_SIGNED_PAYLOAD,
      });
      expect(res.status).toBe(502);
    });

    // Hata-yolu senaryoları (bkz. src/backend/__tests__/X402ProxyClient.test.ts — extension bu
    // `error` alanını okuyup UserFacingError.ts'in x402 matcher'ları aracılığıyla anlaşılır bir
    // mesaja çeviriyor). Burada endpoint seviyesinde yalnızca doğru durum kodu + ham `error`
    // gövdesinin gerçekten sızmadan (ne kaybolmadan ne dönüştürülmeden) taşındığı kanıtlanıyor.
    it("yetersiz bakiye (settle errorReason:'insufficient_funds') → 402, {error:'insufficient_funds'} aynen döner", async () => {
      const fetchSpy = vi.fn(async (url: string) => {
        if (String(url).includes("/verify")) return new Response(JSON.stringify({ isValid: true }), { status: 200 });
        return new Response(
          JSON.stringify({ success: false, network: "base-sepolia", transaction: "", errorReason: "insufficient_funds" }),
          { status: 200 }
        );
      });
      vi.stubGlobal("fetch", fetchSpy);

      const res = await postX402("/agent/x402/settle", {
        resource: "https://api.example.com/weather",
        paymentPayload: VALID_SIGNED_PAYLOAD,
      });
      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("insufficient_funds");
    });

    it("süresi geçmiş EIP-3009 yetkilendirmesi (settle errorReason:'...valid_before...') → 402, ham neden aynen döner", async () => {
      const fetchSpy = vi.fn(async (url: string) => {
        if (String(url).includes("/verify")) return new Response(JSON.stringify({ isValid: true }), { status: 200 });
        return new Response(
          JSON.stringify({
            success: false,
            network: "base-sepolia",
            transaction: "",
            errorReason: "invalid_exact_evm_payload_authorization_valid_before",
          }),
          { status: 200 }
        );
      });
      vi.stubGlobal("fetch", fetchSpy);

      const res = await postX402("/agent/x402/settle", {
        resource: "https://api.example.com/weather",
        paymentPayload: VALID_SIGNED_PAYLOAD,
      });
      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_exact_evm_payload_authorization_valid_before");
    });

    it("invalid_exact_evm_token_name_mismatch (EIP-712 domain uyuşmazlığı, CONTEXT.md'de belgelenen gerçek bug) → 402, ham kod aynen döner", async () => {
      const fetchSpy = vi.fn(async (url: string) => {
        if (String(url).includes("/verify")) return new Response(JSON.stringify({ isValid: true }), { status: 200 });
        return new Response(
          JSON.stringify({ success: false, network: "base-sepolia", transaction: "", errorReason: "invalid_exact_evm_token_name_mismatch" }),
          { status: 200 }
        );
      });
      vi.stubGlobal("fetch", fetchSpy);

      const res = await postX402("/agent/x402/settle", {
        resource: "https://api.example.com/weather",
        paymentPayload: VALID_SIGNED_PAYLOAD,
      });
      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_exact_evm_token_name_mismatch");
    });

    it("facilitator genel bir 5xx ile bozuk/boş gövde dönerse → 502, JSON parse hatası çökmeye yol açmaz", async () => {
      const fetchSpy = vi.fn(async () => new Response("Internal Server Error", { status: 500 }));
      vi.stubGlobal("fetch", fetchSpy);

      const res = await postX402("/agent/x402/settle", {
        resource: "https://api.example.com/weather",
        paymentPayload: VALID_SIGNED_PAYLOAD,
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
    });
  });
});

describe("stub yolu (X402_USE_REAL_FACILITATOR=false, varsayılan) hâlâ değişmedi", () => {
  // Yukarıdaki "gerçek facilitator yolu" bloğunun sızdırmasına karşı defense-in-depth değil,
  // bu describe'ın kendi doğruluğu için gerekli: "stub" davranışını test ediyoruz, o davranış
  // yalnızca env !== "true" iken geçerli — bunu ambient duruma (wrangler.toml + yerel .dev.vars'ın
  // birleşimi neyse) güvenmek yerine burada açıkça kuruyoruz.
  beforeEach(() => {
    env.X402_USE_REAL_FACILITATOR = "false";
  });

  it("payment-required hâlâ _stub:true döner", async () => {
    const res = await postX402("/agent/x402/payment-required", { resource: "https://api.example.com/weather" });
    const body = (await res.json()) as { _stub: boolean };
    expect(body._stub).toBe(true);
  });

  it("settle hâlâ her paymentPayload'ı kabul edip _stub:true döner", async () => {
    const res = await postX402("/agent/x402/settle", { resource: "https://api.example.com/weather", paymentPayload: { signature: "0xfake" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { _stub: boolean };
    expect(body._stub).toBe(true);
  });
});
