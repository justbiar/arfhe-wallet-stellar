/// <reference types="vitest/globals" />
import { toUserFacingError } from '../UserFacingError';

/**
 * UserFacingError.ts testleri — şimdilik yalnızca x402 facilitator (Faz 3, gerçek settle
 * hataları) matcher'larını kapsıyor. Bu matcher'lar, X402ProxyClient.settleX402Payment'ın artık
 * facilitator'ın ham `error` gövdesini (bkz. backend-proxy/src/x402FacilitatorClient.ts'in
 * invalidReason/errorReason'ları — "insufficient_funds", "invalid_exact_evm_signature",
 * "invalid_exact_evm_token_name_mismatch", bir "...valid_before..." süre-doldu mesajı vb.)
 * thrown Error mesajı olarak taşıması sayesinde devreye giriyor — daha önce bu gövde tamamen
 * atılıyor, kullanıcı her facilitator reddinde aynı jenerik "Something went wrong" mesajını
 * görüyordu (bkz. X402ProxyClient.ts'in settle hata yolu ve ConfirmationCard.test.tsx'teki
 * "pay_for_resource hata yolu" testleri).
 */
describe('toUserFacingError — x402 facilitator hataları', () => {
  it('yetersiz bakiye (facilitator\'ın "insufficient_funds" kodu) anlaşılır, tekrar denenemez bir mesaja çevrilir', () => {
    const result = toUserFacingError(new Error('insufficient_funds'));
    expect(result.key).toBe('errors.insufficientFunds');
    expect(result.retryable).toBe(false);
  });

  it('yetersiz bakiye (boşluklu "insufficient funds" varyantı) da aynı anahtara düşer', () => {
    const result = toUserFacingError(new Error('insufficient funds'));
    expect(result.key).toBe('errors.insufficientFunds');
  });

  it('süresi geçmiş EIP-3009 yetkilendirmesi (valid_before) tekrar denenebilir özel bir mesaja çevrilir', () => {
    const result = toUserFacingError(new Error('invalid_exact_evm_payload_authorization_valid_before'));
    expect(result.key).toBe('errors.x402AuthorizationExpired');
    expect(result.retryable).toBe(true);
  });

  it('"authorization expired" düz metniyle gelen bir hata da aynı anahtara düşer', () => {
    const result = toUserFacingError(new Error('Payment authorization expired before settlement'));
    expect(result.key).toBe('errors.x402AuthorizationExpired');
  });

  it('invalid_exact_evm_signature (EIP-712 domain uyuşmazlığı) tekrar denenemez bir mesaja çevrilir, ham kod sızmaz', () => {
    const result = toUserFacingError(new Error('invalid_exact_evm_signature'));
    expect(result.key).toBe('errors.x402PaymentRejected');
    expect(result.retryable).toBe(false);
  });

  it('invalid_exact_evm_token_name_mismatch da aynı "reddedildi" anahtarına düşer', () => {
    const result = toUserFacingError(new Error('invalid_exact_evm_token_name_mismatch'));
    expect(result.key).toBe('errors.x402PaymentRejected');
  });

  it('unexpected_error (facilitator\'ın kendi iç hatası) tekrar denenebilir ayrı bir mesaja çevrilir', () => {
    const result = toUserFacingError(new Error('unexpected_error'));
    expect(result.key).toBe('errors.x402FacilitatorError');
    expect(result.retryable).toBe(true);
  });

  it('facilitator gövdesi okunamadığında düşen jenerik "x402 settle isteği başarısız oldu: 502" mesajı sunucu hatası olarak sınıflandırılır (rakamsal durum kodu classifyError\'ın 5xx kontrolüyle eşleşir)', () => {
    const result = toUserFacingError(new Error('x402 settle isteği başarısız oldu: 502'));
    expect(result.key).toBe('networkError.serverError');
    expect(result.retryable).toBe(true);
  });

  it('ham hata mesajı (raw) her zaman korunur — loglama/destek için, ekranda gösterilmese bile', () => {
    const result = toUserFacingError(new Error('invalid_exact_evm_signature'));
    expect(result.raw).toBe('invalid_exact_evm_signature');
  });
});
