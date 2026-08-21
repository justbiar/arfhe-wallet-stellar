/// <reference types="vitest/globals" />
import { configureX402ProxyClient, fetchX402PaymentRequirement, settleX402Payment } from '../X402ProxyClient';

/**
 * X402ProxyClient.settleX402Payment testleri — özellikle hata yolu.
 *
 * backend-proxy/src/index.ts'in handleX402Settle'ı (X402_USE_REAL_FACILITATOR="true" iken),
 * facilitator'ın settle reddini `{ error: <ham facilitator nedeni> }` gövdesiyle 402, facilitator'a
 * hiç ulaşılamadığını ise aynı şekilde `{ error }` gövdesiyle 502 döner (bkz. o dosyanın kendi
 * JSDoc'u ve backend-proxy/src/__tests__/x402FacilitatorEndpoint.test.ts). Bu testler, extension
 * tarafının o `error` alanını GERÇEKTEN okuyup thrown Error mesajı olarak taşıdığını kanıtlıyor —
 * önceden `!response.ok` dalı gövdeyi hiç okumadan yalnızca durum koduyla ("x402 settle isteği
 * başarısız oldu: 402") throw ediyordu, bu da facilitator'ın "insufficient_funds",
 * "invalid_exact_evm_signature" gibi ayırt edici nedenini tamamen siliyordu — UserFacingError.ts'in
 * hiçbir matcher'ı eşleşemiyordu ve kullanıcı her zaman aynı jenerik "Something went wrong"
 * mesajını görüyordu (bkz. UserFacingError.test.ts'teki x402 matcher testleri, ve
 * ConfirmationCard.test.tsx'teki "pay_for_resource hata yolu" ucu-uca testleri).
 */
describe('X402ProxyClient.settleX402Payment — hata yolu', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    configureX402ProxyClient({ proxyBaseUrl: '' });
  });

  function mockFetchOnce(status: number, body: unknown) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as typeof fetch;
  }

  const SIGNED = {
    signature: '0xsig',
    authorization: { from: '0xabc', to: '0xdef', value: '10000', validAfter: 0, validBefore: 9999999999, nonce: '0xnonce' },
  };

  it('facilitator yetersiz bakiye ile reddederse (402, {error:"insufficient_funds"}), ham neden throw edilen mesajda görünür', async () => {
    configureX402ProxyClient({ proxyBaseUrl: 'https://proxy.example' });
    mockFetchOnce(402, { error: 'insufficient_funds' });

    await expect(settleX402Payment('https://api.example.com/weather', SIGNED)).rejects.toThrow('insufficient_funds');
  });

  it('süresi geçmiş yetkilendirme (402, {error:"...valid_before..."}) ham neden throw edilen mesajda görünür', async () => {
    configureX402ProxyClient({ proxyBaseUrl: 'https://proxy.example' });
    mockFetchOnce(402, { error: 'invalid_exact_evm_payload_authorization_valid_before' });

    await expect(settleX402Payment('https://api.example.com/weather', SIGNED)).rejects.toThrow(
      'invalid_exact_evm_payload_authorization_valid_before'
    );
  });

  it('invalid_exact_evm_signature / invalid_exact_evm_token_name_mismatch (402) ham kod olarak korunur', async () => {
    configureX402ProxyClient({ proxyBaseUrl: 'https://proxy.example' });
    mockFetchOnce(402, { error: 'invalid_exact_evm_token_name_mismatch' });

    await expect(settleX402Payment('https://api.example.com/weather', SIGNED)).rejects.toThrow(
      'invalid_exact_evm_token_name_mismatch'
    );
  });

  it('facilitator\'a hiç ulaşılamazsa (502, {error:"x402 facilitator hatası."}) o mesaj da aynen taşınır', async () => {
    configureX402ProxyClient({ proxyBaseUrl: 'https://proxy.example' });
    mockFetchOnce(502, { error: 'x402 facilitator hatası.' });

    await expect(settleX402Payment('https://api.example.com/weather', SIGNED)).rejects.toThrow('x402 facilitator hatası.');
  });

  it('yanıt gövdesi JSON değilse (route seviyesinde bir 404/HTML sayfası gibi), durum koduna geri döner, çökmez', async () => {
    configureX402ProxyClient({ proxyBaseUrl: 'https://proxy.example' });
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => {
        throw new Error('not json');
      },
    }) as unknown as typeof fetch;

    await expect(settleX402Payment('https://api.example.com/weather', SIGNED)).rejects.toThrow(/404/);
  });

  it('yanıt gövdesi JSON ama {error} alanı boş/eksikse, durum koduna geri döner', async () => {
    configureX402ProxyClient({ proxyBaseUrl: 'https://proxy.example' });
    mockFetchOnce(500, {});

    await expect(settleX402Payment('https://api.example.com/weather', SIGNED)).rejects.toThrow(/500/);
  });

  it('başarılı settle hâlâ {success:true, txHash} döner (regresyon: hata-yolu değişikliği başarı yolunu bozmadı)', async () => {
    configureX402ProxyClient({ proxyBaseUrl: 'https://proxy.example' });
    mockFetchOnce(200, { success: true, txHash: '0xREALTX' });

    const result = await settleX402Payment('https://api.example.com/weather', SIGNED);
    expect(result).toEqual({ success: true, txHash: '0xREALTX' });
  });

  it('proxy hiç yapılandırılmamışsa fetch hiç çağrılmadan açık bir hata fırlatır', async () => {
    configureX402ProxyClient({ proxyBaseUrl: '' });
    await expect(settleX402Payment('https://api.example.com/weather', SIGNED)).rejects.toThrow(/yapılandırılmadı/);
  });
});

describe('X402ProxyClient.fetchX402PaymentRequirement — regresyon (bu görevde dokunulmadı)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    configureX402ProxyClient({ proxyBaseUrl: '' });
  });

  it('402 dışında bir durum kodu dönerse açık bir hata fırlatır', async () => {
    configureX402ProxyClient({ proxyBaseUrl: 'https://proxy.example' });
    global.fetch = vi.fn().mockResolvedValue({ status: 500, json: async () => ({}) }) as unknown as typeof fetch;

    await expect(fetchX402PaymentRequirement('https://api.example.com/weather')).rejects.toThrow(/beklenmeyen bir durum kodu/);
  });
});
