import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildRealPaymentRequirements,
  buildRealPaymentRequiredBody,
  buildFacilitatorPaymentPayload,
  isExtensionSignedPayload,
  verifyWithFacilitator,
  settleWithFacilitator,
  settleX402PaymentReal,
} from "../x402FacilitatorClient";

/**
 * x402FacilitatorClient.ts testleri.
 *
 * Gerçek facilitator'a (https://x402.org/facilitator) HER TEST KOŞUSUNDA canlı istek ATMIYORUZ
 * (rate limit / flakiness riski) — bunun yerine bu entegrasyonu kurarken gözlemlenen GERÇEK
 * response şekilleri (aşağıdaki FIXTURE'lar) fetch mock'u olarak kullanılıyor:
 *   - Verify hata örneği (`invalid_exact_evm_signature` DEĞİL, `unexpected_error`) canlı olarak
 *     eksik/boş bir authorization gönderilerek gözlendi.
 *   - Settle hata örneği (`invalid_exact_evm_signature`) canlı olarak geçersiz bir imzayla
 *     gözlendi — gerçek payTo (0x9332339e54A27f9350C7Be300b4B9dEBc7D1c350) ve gerçek Base
 *     Sepolia USDC adresiyle (0x036CbD53842c5426634e7929541eC2318f3dCF7e).
 *   - Verify/settle başarı örnekleri sentetik (gerçek bir geçerli imzayla uçtan uca hiç
 *     denenmedi — bkz. CONTEXT.md, "Chrome'da elle uçtan uca test" hâlâ bekliyor).
 */

const ENV = {
  X402_PAYTO_ADDRESS: "0x9332339e54A27f9350C7Be300b4B9dEBc7D1c350",
  X402_USDC_ASSET_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

const VALID_SIGNED_PAYLOAD = {
  signature: "0x" + "ab".repeat(65),
  authorization: {
    from: "0x1111111111111111111111111111111111111111",
    to: ENV.X402_PAYTO_ADDRESS,
    value: "10000",
    validAfter: 0,
    validBefore: 9999999999,
    nonce: "0x" + "cd".repeat(32),
  },
};

describe("buildRealPaymentRequirements / buildRealPaymentRequiredBody", () => {
  it("v1 şekilli, env'den payTo/asset okuyan requirements üretir", () => {
    const req = buildRealPaymentRequirements("https://api.example.com/weather", ENV);
    expect(req.scheme).toBe("exact");
    expect(req.network).toBe("base-sepolia");
    expect(req.payTo).toBe(ENV.X402_PAYTO_ADDRESS);
    expect(req.asset).toBe(ENV.X402_USDC_ASSET_ADDRESS);
    expect(req.resource).toBe("https://api.example.com/weather");
    expect(req.outputSchema).toEqual({});
    expect(req.maxAmountRequired).toBe("10000");
  });

  it("aynı resource için deterministik — iki çağrı birebir aynı requirements üretir", () => {
    const a = buildRealPaymentRequirements("https://api.example.com/x", ENV);
    const b = buildRealPaymentRequirements("https://api.example.com/x", ENV);
    expect(a).toEqual(b);
  });

  it("X402_PAYTO_ADDRESS eksikse açık bir hata fırlatır (sessizce geçersiz adres üretmez)", () => {
    expect(() => buildRealPaymentRequirements("https://api.example.com/x", {})).toThrow(/X402_PAYTO_ADDRESS/);
  });

  it("X402_USDC_ASSET_ADDRESS eksikse açık bir hata fırlatır", () => {
    expect(() =>
      buildRealPaymentRequirements("https://api.example.com/x", { X402_PAYTO_ADDRESS: ENV.X402_PAYTO_ADDRESS })
    ).toThrow(/X402_USDC_ASSET_ADDRESS/);
  });

  it("buildRealPaymentRequiredBody x402Version:1 ve tek accepts girdisi döner", () => {
    const body = buildRealPaymentRequiredBody("https://api.example.com/weather", ENV);
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toHaveLength(1);
  });
});

describe("isExtensionSignedPayload / buildFacilitatorPaymentPayload — eski stub sözleşmesiyle KIRMIZI→YEŞİL", () => {
  // Eski x402Stub.ts hiçbir doğrulama yapmıyordu (StubSettleRequestBody.paymentPayload: unknown,
  // içeriği hiç kontrol edilmeden kabul ediliyordu). Gerçek client bunu KABUL ETMEMELİ — aşağıdaki
  // testler bu davranış değişikliğini kanıtlıyor. Bu testler ilk yazıldığında (buildFacilitatorPaymentPayload
  // içinde isExtensionSignedPayload kontrolü henüz YOKKEN) `{ signature: "0xfake" }` gibi eski stub'ın
  // kabul ettiği eksik bir payload'la çağrıldığında sessizce facilitator'a gönderiliyordu (kırmızı: hiç
  // throw etmiyordu, TypeError riskiyle authorization.from okunmaya çalışılıyordu). Kontrol eklendikten
  // sonra (mevcut kod) net bir hata ile reddediyor — bu dosyadaki assertion'lar şu anki (yeşil) davranışı
  // doğruluyor.

  it('eski stub\'ın kabul ettiği eksik payload ("paymentPayload: { signature: \'0xfake\' } gibi, authorization YOK") reddedilir', () => {
    expect(isExtensionSignedPayload({ signature: "0xfake" })).toBe(false);
    expect(() => buildFacilitatorPaymentPayload("base-sepolia", { signature: "0xfake" })).toThrow(
      /EIP-3009 imza şeklinde değil/
    );
  });

  it("eski stub'ın kabul ettiği null paymentPayload reddedilir", () => {
    expect(isExtensionSignedPayload(null)).toBe(false);
    expect(() => buildFacilitatorPaymentPayload("base-sepolia", null)).toThrow();
  });

  it("geçerli EIP-3009 payload kabul edilir ve validAfter/validBefore string'e çevrilir", () => {
    expect(isExtensionSignedPayload(VALID_SIGNED_PAYLOAD)).toBe(true);
    const wrapped = buildFacilitatorPaymentPayload("base-sepolia", VALID_SIGNED_PAYLOAD);
    expect(wrapped.x402Version).toBe(1);
    expect(wrapped.scheme).toBe("exact");
    expect(wrapped.network).toBe("base-sepolia");
    const auth = wrapped.payload.authorization as Record<string, unknown>;
    expect(auth.validAfter).toBe("0");
    expect(typeof auth.validAfter).toBe("string");
    expect(auth.validBefore).toBe("9999999999");
    expect(typeof auth.validBefore).toBe("string");
    expect(auth.value).toBe("10000");
  });
});

describe("verifyWithFacilitator / settleWithFacilitator — gerçek facilitator'dan gözlenen response şekilleriyle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("verify başarısız (canlı gözlenen unexpected_error örneği) invalidReason/invalidMessage'ı aynen döner", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            isValid: false,
            invalidReason: "unexpected_error",
            invalidMessage: "Cannot read properties of undefined (reading 'from')",
          }),
          { status: 500 }
        )
      )
    );
    const req = buildRealPaymentRequirements("https://api.example.com/weather", ENV);
    const result = await verifyWithFacilitator(VALID_SIGNED_PAYLOAD, req, ENV);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("unexpected_error");
    vi.unstubAllGlobals();
  });

  it("verify başarılı → isValid:true, payer alanı taşınır", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ isValid: true, payer: VALID_SIGNED_PAYLOAD.authorization.from }), { status: 200 }))
    );
    const req = buildRealPaymentRequirements("https://api.example.com/weather", ENV);
    const result = await verifyWithFacilitator(VALID_SIGNED_PAYLOAD, req, ENV);
    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(VALID_SIGNED_PAYLOAD.authorization.from);
    vi.unstubAllGlobals();
  });

  it("settle başarısız (canlı gözlenen invalid_exact_evm_signature örneği) errorReason'ı aynen döner", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            success: false,
            network: "base-sepolia",
            transaction: "",
            errorReason: "invalid_exact_evm_signature",
            payer: ENV.X402_PAYTO_ADDRESS,
          }),
          { status: 200 }
        )
      )
    );
    const req = buildRealPaymentRequirements("https://api.example.com/weather", ENV);
    const result = await settleWithFacilitator(VALID_SIGNED_PAYLOAD, req, ENV);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("invalid_exact_evm_signature");
    vi.unstubAllGlobals();
  });

  it("settle başarılı → transaction alanı (txHash değil) taşınır", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, network: "base-sepolia", transaction: "0xSETTLED123" }), { status: 200 })
      )
    );
    const req = buildRealPaymentRequirements("https://api.example.com/weather", ENV);
    const result = await settleWithFacilitator(VALID_SIGNED_PAYLOAD, req, ENV);
    expect(result.success).toBe(true);
    expect(result.transaction).toBe("0xSETTLED123");
    vi.unstubAllGlobals();
  });
});

describe("settleX402PaymentReal — verify+settle orkestrasyon", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("verify isValid:false ise settle HİÇ çağrılmadan başarısız döner", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      expect(String(url)).toContain("/verify");
      return new Response(JSON.stringify({ isValid: false, invalidReason: "invalid_exact_evm_signature" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await settleX402PaymentReal("https://api.example.com/weather", VALID_SIGNED_PAYLOAD, ENV);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe("invalid_exact_evm_signature");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("verify isValid:true, settle success:true ise transaction txHash olarak döner", async () => {
    let call = 0;
    const fetchSpy = vi.fn(async (url: string) => {
      call += 1;
      if (String(url).includes("/verify")) {
        return new Response(JSON.stringify({ isValid: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, network: "base-sepolia", transaction: "0xREALTX" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await settleX402PaymentReal("https://api.example.com/weather", VALID_SIGNED_PAYLOAD, ENV);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.txHash).toBe("0xREALTX");
      expect(result.network).toBe("base-sepolia");
    }
    expect(call).toBe(2);
    vi.unstubAllGlobals();
  });

  it("verify geçer ama settle success:false dönerse (canlı örnek) hata mesajı taşınır", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (String(url).includes("/verify")) return new Response(JSON.stringify({ isValid: true }), { status: 200 });
      return new Response(
        JSON.stringify({ success: false, network: "base-sepolia", transaction: "", errorReason: "invalid_exact_evm_signature" }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await settleX402PaymentReal("https://api.example.com/weather", VALID_SIGNED_PAYLOAD, ENV);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe("invalid_exact_evm_signature");
    vi.unstubAllGlobals();
  });

  it("eski stub'ın kabul ettiği geçersiz paymentPayload ile çağrılırsa facilitator'a hiç gitmeden reddedilir", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(settleX402PaymentReal("https://api.example.com/weather", { signature: "0xfake" }, ENV)).rejects.toThrow(
      /EIP-3009 imza şeklinde değil/
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
