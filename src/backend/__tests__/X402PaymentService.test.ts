/// <reference types="vitest/globals" />
import { Wallet, verifyTypedData } from 'ethers';
import {
  signTransferWithAuthorization,
  recoverAuthorizationSigner,
  generateAuthorizationNonce,
  type Eip3009Authorization,
  type Eip3009TokenIdentity,
} from '../X402PaymentService';

/**
 * X402PaymentService testleri — İZOLE, gerçek bir facilitator'a hiçbir şey göndermez.
 *
 * Amaç "imza üretildi" demek değil, "bu imza gerçekten bu veriyle bu adresin imzaladığını
 * kanıtlıyor" demek: her testte üretilen imza, ethers'ın KENDİ verifyTypedData fonksiyonuyla
 * (bu modülün kendi recoverAuthorizationSigner'ı da sadece bunu sarmalıyor) geri doğrulanıp
 * beklenen adrese geri çözüldüğü kontrol ediliyor — imzanın formatına değil, EIP-712 domain
 * separator + type hash + alan sırasının gerçekten doğru kurulduğuna dair kanıt bu.
 *
 * Sabit (test-only) bir private key kullanılıyor — gerçek bir hesap/anahtar değil, sadece
 * deterministik bir adres üretmek için.
 */

// Test-only anahtar — hardhat/foundry'nin herkese açık, hiçbir gerçek fonu olmayan varsayılan
// test hesaplarından biri. Gerçek bir cüzdanla hiçbir ilgisi yok.
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const testWallet = new Wallet(TEST_PRIVATE_KEY);

const USDC_BASE_SEPOLIA: Eip3009TokenIdentity = {
  address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  name: 'USD Coin',
  version: '2',
  chainId: 84532, // NetworkId.Base_Sepolia
};

const RECIPIENT = '0x00000000000000000000000000000000000000f1';

function makeAuthorization(overrides: Partial<Eip3009Authorization> = {}): Eip3009Authorization {
  return {
    from: testWallet.address,
    to: RECIPIENT,
    value: '10000', // $0.01 in USDC atomic units (6 decimals)
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 60,
    nonce: generateAuthorizationNonce(),
    ...overrides,
  };
}

describe('X402PaymentService', () => {
  // ─── Nonce üretimi ────────────────────────────────────────────
  describe('generateAuthorizationNonce', () => {
    it('32 byte (66 karakter, 0x dahil) hex string üretir', () => {
      const nonce = generateAuthorizationNonce();
      expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('her çağrıda farklı bir nonce üretir', () => {
      const nonces = new Set(Array.from({ length: 20 }, () => generateAuthorizationNonce()));
      expect(nonces.size).toBe(20);
    });
  });

  // ─── İmzalama + gerçek doğrulama ────────────────────────────────
  describe('signTransferWithAuthorization', () => {
    it('üretilen imza, ethers.verifyTypedData ile geri doğrulandığında imzalayanın adresine çözülür', async () => {
      const authorization = makeAuthorization();
      const signed = await signTransferWithAuthorization(testWallet, USDC_BASE_SEPOLIA, authorization);

      // Bu modülün kendi sarmalayıcısı yerine DOĞRUDAN ethers'ın kendi fonksiyonunu kullanarak
      // bağımsız bir doğrulama — "imza üretildi" değil "bu imza gerçekten bu adrese ait" kanıtı.
      const recovered = verifyTypedData(
        { name: USDC_BASE_SEPOLIA.name, version: USDC_BASE_SEPOLIA.version, chainId: USDC_BASE_SEPOLIA.chainId, verifyingContract: USDC_BASE_SEPOLIA.address },
        {
          TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        },
        authorization,
        signed.signature
      );

      expect(recovered.toLowerCase()).toBe(testWallet.address.toLowerCase());
    });

    it("modülün kendi recoverAuthorizationSigner'ı da aynı sonucu verir (ethers.verifyTypedData'yı doğru sarmaladığının kanıtı)", async () => {
      const authorization = makeAuthorization();
      const signed = await signTransferWithAuthorization(testWallet, USDC_BASE_SEPOLIA, authorization);

      expect(recoverAuthorizationSigner(USDC_BASE_SEPOLIA, signed).toLowerCase()).toBe(testWallet.address.toLowerCase());
    });

    it('imza 65 byte (130 hex karakter + 0x) uzunluğundadır', async () => {
      const signed = await signTransferWithAuthorization(testWallet, USDC_BASE_SEPOLIA, makeAuthorization());
      expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
    });

    it('aynı authorization + aynı imzalayan → her zaman aynı imza (deterministik, ECDSA nonce RFC6979)', async () => {
      const authorization = makeAuthorization({ nonce: generateAuthorizationNonce() });
      const first = await signTransferWithAuthorization(testWallet, USDC_BASE_SEPOLIA, authorization);
      const second = await signTransferWithAuthorization(testWallet, USDC_BASE_SEPOLIA, authorization);
      expect(first.signature).toBe(second.signature);
    });

    it('farklı bir imzalayan farklı bir imza üretir', async () => {
      const otherWallet = new Wallet('0x0000000000000000000000000000000000000000000000000000000000000002');
      const authorization = makeAuthorization();
      const bySigner1 = await signTransferWithAuthorization(testWallet, USDC_BASE_SEPOLIA, authorization);
      const bySigner2 = await signTransferWithAuthorization(otherWallet, USDC_BASE_SEPOLIA, authorization);

      expect(bySigner1.signature).not.toBe(bySigner2.signature);
      expect(recoverAuthorizationSigner(USDC_BASE_SEPOLIA, bySigner2).toLowerCase()).toBe(otherWallet.address.toLowerCase());
    });
  });

  // ─── EIP-712 domain/struct'ın gerçekten veriye bağlı olduğunun kanıtı ────────────
  // Bu blok "imza her zaman doğrulanır" gibi anlamsız bir teste düşmemek için: aşağıdaki her
  // testte tek bir alan değiştiriliyor ve imzanın ARTIK O DEĞİŞTİRİLMİŞ VERİYLE doğrulanmadığı
  // gösteriliyor — yani domain separator + type hash + alan sırası gerçekten hash'e giriyor,
  // dekoratif değil.
  describe('imza, imzalanan tam veriye (domain + struct) bağlıdır — kurcalama tespiti', () => {
    it('value değiştirilirse imza artık doğrulanmaz (recoverAuthorizationSigner farklı/yanlış bir adres döner)', async () => {
      const authorization = makeAuthorization({ value: '10000' });
      const signed = await signTransferWithAuthorization(testWallet, USDC_BASE_SEPOLIA, authorization);

      const tampered = { ...signed, authorization: { ...signed.authorization, value: '999999999' } };
      expect(recoverAuthorizationSigner(USDC_BASE_SEPOLIA, tampered).toLowerCase()).not.toBe(testWallet.address.toLowerCase());
    });

    it("to (alıcı) değiştirilirse imza artık doğrulanmaz", async () => {
      const signed = await signTransferWithAuthorization(testWallet, USDC_BASE_SEPOLIA, makeAuthorization());
      const tampered = { ...signed, authorization: { ...signed.authorization, to: '0x00000000000000000000000000000000000000f2' } };
      expect(recoverAuthorizationSigner(USDC_BASE_SEPOLIA, tampered).toLowerCase()).not.toBe(testWallet.address.toLowerCase());
    });

    it('nonce değiştirilirse imza artık doğrulanmaz', async () => {
      const signed = await signTransferWithAuthorization(testWallet, USDC_BASE_SEPOLIA, makeAuthorization());
      const tampered = { ...signed, authorization: { ...signed.authorization, nonce: generateAuthorizationNonce() } };
      expect(recoverAuthorizationSigner(USDC_BASE_SEPOLIA, tampered).toLowerCase()).not.toBe(testWallet.address.toLowerCase());
    });

    it('validBefore değiştirilirse imza artık doğrulanmaz', async () => {
      const signed = await signTransferWithAuthorization(testWallet, USDC_BASE_SEPOLIA, makeAuthorization());
      const tampered = { ...signed, authorization: { ...signed.authorization, validBefore: signed.authorization.validBefore + 3600 } };
      expect(recoverAuthorizationSigner(USDC_BASE_SEPOLIA, tampered).toLowerCase()).not.toBe(testWallet.address.toLowerCase());
    });

    it('farklı bir token kontrat adresi (domain.verifyingContract) altında doğrulanmaya çalışılırsa imza geçersiz kalır — cross-contract replay olmaz', async () => {
      const signed = await signTransferWithAuthorization(testWallet, USDC_BASE_SEPOLIA, makeAuthorization());
      const differentToken: Eip3009TokenIdentity = { ...USDC_BASE_SEPOLIA, address: '0x00000000000000000000000000000000000000aa' };
      expect(recoverAuthorizationSigner(differentToken, signed).toLowerCase()).not.toBe(testWallet.address.toLowerCase());
    });

    it('farklı bir chainId (domain.chainId) altında doğrulanmaya çalışılırsa imza geçersiz kalır — cross-chain replay olmaz', async () => {
      const signed = await signTransferWithAuthorization(testWallet, USDC_BASE_SEPOLIA, makeAuthorization());
      const differentChain: Eip3009TokenIdentity = { ...USDC_BASE_SEPOLIA, chainId: 1 }; // Ethereum mainnet
      expect(recoverAuthorizationSigner(differentChain, signed).toLowerCase()).not.toBe(testWallet.address.toLowerCase());
    });

    it('farklı bir domain name/version altında doğrulanmaya çalışılırsa imza geçersiz kalır', async () => {
      const signed = await signTransferWithAuthorization(testWallet, USDC_BASE_SEPOLIA, makeAuthorization());
      const differentDomain: Eip3009TokenIdentity = { ...USDC_BASE_SEPOLIA, name: 'Not USD Coin' };
      expect(recoverAuthorizationSigner(differentDomain, signed).toLowerCase()).not.toBe(testWallet.address.toLowerCase());
    });
  });
});
