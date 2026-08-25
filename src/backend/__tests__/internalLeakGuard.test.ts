/// <reference types="vitest/globals" />
import { findLeakedInternalReference } from '../internalLeakGuard';

describe('internalLeakGuard', () => {
  describe('bilinen tool isimlerini yakalar', () => {
    it.each([
      'propose_send',
      'get_balance',
      'get_shielded_balance',
      'get_shielded_portfolio',
      'get_pending_claims',
      'propose_shield',
      'propose_unshield',
    ])('%s ismini metin içinde tespit eder', (toolName) => {
      const leak = findLeakedInternalReference(`${toolName} aracını çalıştırdım.`);
      expect(leak).toBe(toolName);
    });

    it('gerçek bug raporundaki örneği yakalar', () => {
      const leak = findLeakedInternalReference(
        'propose_send aracını çağırıyorum. Ancak önce hedef adresi belirtmeniz gerekiyor.'
      );
      expect(leak).toBeTruthy();
    });
  });

  describe('mekanik ifadeleri yakalar', () => {
    it.each([
      'get_balance aracını çağırıyorum, bir saniye.',
      'get_balance fonksiyonunu çalıştırıyorum.',
      "propose_send tool'unu çağırıyorum.",
      'Calling the get_balance tool now.',
    ])('"%s" içindeki mekanik ifadeyi tespit eder', (text) => {
      expect(findLeakedInternalReference(text)).toBeTruthy();
    });
  });

  describe('doğal insan dilinde false positive vermez', () => {
    it.each([
      'Bakiyeni kontrol ediyorum, bir saniye.',
      'ETH göndermek için önce hedef adresi öğrenmem gerekiyor, nereye göndermek istiyorsun?',
      'Bekleyen bir talebiniz görünmüyor.',
      'Shield işlemini hazırladım, onayınızı bekliyorum.',
      'Merhaba! Nasıl yardımcı olabilirim?',
    ])('"%s" temiz kabul edilir', (text) => {
      expect(findLeakedInternalReference(text)).toBeNull();
    });
  });
});
