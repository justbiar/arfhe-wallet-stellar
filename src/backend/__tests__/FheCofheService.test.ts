/// <reference types="vitest/globals" />

/**
 * FheCofheService testleri
 *
 * @cofhe/sdk tamamen mock'lanır — testler ağa çıkmaz. Amaç SDK'yı değil, servisin
 * kendi mantığını doğrulamak: zincir kapısı, bağlantı tekilleştirme, permit geçerlilik
 * kontrolü, hata sınıflandırma ve kilitte temizlik.
 */

const mockClient = {
  connect: vi.fn(async () => { }),
  disconnect: vi.fn(),
  encryptInputs: vi.fn(),
  decryptForView: vi.fn(),
  decryptForTx: vi.fn(),
  verifyDecryptResult: vi.fn(async () => true),
  permits: {
    getOrCreateSelfPermit: vi.fn(async () => ({ hash: '0xpermit', expiration: 9_999_999_999 })),
    getActivePermit: vi.fn(() => undefined as unknown),
    removeActivePermit: vi.fn(),
  },
};

const mockTerminateWorker = vi.fn();
const mockAdapter = vi.fn(async () => ({ publicClient: {}, walletClient: {} }));
let mockIsValid = vi.fn(() => ({ valid: true, error: null as string | null }));

vi.mock('@cofhe/sdk/web', () => ({
  createCofheConfig: vi.fn((c: unknown) => c),
  createCofheClient: vi.fn(() => mockClient),
  terminateWorker: () => mockTerminateWorker(),
}));

vi.mock('@cofhe/sdk/adapters', () => ({
  Ethers6Adapter: (...args: unknown[]) => mockAdapter(...(args as [])),
}));

vi.mock('@cofhe/sdk/chains', () => ({
  chains: { sepolia: { id: 11155111 }, arbSepolia: { id: 421614 }, baseSepolia: { id: 84532 } },
}));

vi.mock('@cofhe/sdk/permits', () => ({
  ValidationUtils: { isValid: (...args: unknown[]) => mockIsValid(...(args as [])) },
}));

vi.mock('@cofhe/sdk', () => ({
  Encryptable: { uint64: (v: bigint) => ({ kind: 'uint64', v }) },
  FheTypes: { Uint64: 5 },
  CofheErrorCode: { PermitNotFound: 'PERMIT_NOT_FOUND' },
  isCofheError: (e: unknown) => !!e && typeof e === 'object' && 'code' in (e as object),
  assertCorrectEncryptedItemInput: vi.fn(),
}));

import FheCofheService, { COFHE_CHAIN_IDS, CiphertextNotFoundError } from '../FheCofheService';

/** Minimal ethers stand-ins; only the members the service touches. */
const makeProvider = (chainId: number) =>
  ({ getNetwork: async () => ({ chainId: BigInt(chainId) }) }) as never;
const makeSigner = (address: string) =>
  ({ getAddress: async () => address }) as never;

const ALICE = '0xAAaAaAaaAaAaAaaAaAAAAAAAAaaAAaAAaAAAaAAA';
const BOB = '0xBbBBBbbBBBbbBBbBbbBbbbbBBbBbbbbBbBbbbBBb';
const SEPOLIA = 11155111;

describe('FheCofheService', () => {
  let service: FheCofheService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsValid = vi.fn(() => ({ valid: true, error: null }));
    mockClient.permits.getActivePermit = vi.fn(() => undefined as unknown);
    service = FheCofheService.getInstance();
    service.reset();
  });

  // ─── Zincir kapısı ────────────────────────────────────────────
  describe('desteklenen zincirler', () => {
    it('yalnızca CoFHE ağlarını tanır', () => {
      expect([...COFHE_CHAIN_IDS].sort()).toEqual([84532, 421614, 11155111].sort());
    });

    it('desteklenmeyen zincirde bağlanmayı reddeder', async () => {
      // Mainnet'te koprosesör yok; bağlanmak sessizce çalışmayan bir kurulum üretirdi.
      await expect(service.init(makeProvider(1), makeSigner(ALICE))).rejects.toThrow(/not available on chain 1/);
      expect(service.isReady()).toBe(false);
    });

    it('Sepolia agina baglanir', async () => {
      await service.init(makeProvider(SEPOLIA), makeSigner(ALICE), 2);
      expect(service.isReady()).toBe(true);
      expect(mockClient.connect).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Bağlantı kimliği ─────────────────────────────────────────
  describe('bağlantı tekilleştirme', () => {
    it('aynı hesap+zincir için yeniden bağlanmaz', async () => {
      await service.init(makeProvider(SEPOLIA), makeSigner(ALICE), 2);
      await service.init(makeProvider(SEPOLIA), makeSigner(ALICE), 2);
      expect(mockClient.connect).toHaveBeenCalledTimes(1);
    });

    it('eşzamanlı farklı hesap çağrısı ilk hesabın bağlantısını döndürmez', async () => {
      // Regresyon: uçuştaki init'in sözünü paylaşmak, ikinci çağıranın kendi hesabıyla
      // bağlandığını sanmasına yol açıyordu; ürettiği şifreli girdiler zincirde reddedilirdi.
      const a = service.init(makeProvider(SEPOLIA), makeSigner(ALICE), 2);
      const b = service.init(makeProvider(SEPOLIA), makeSigner(BOB), 2);
      await Promise.all([a, b]);

      expect(service.isReadyForAccount(BOB, 2)).toBe(true);
      expect(service.isReadyForAccount(ALICE, 2)).toBe(false);
      expect(mockClient.connect).toHaveBeenCalledTimes(2);
    });

    it('ağ değişiminde yeniden bağlanır', async () => {
      await service.init(makeProvider(SEPOLIA), makeSigner(ALICE), 2);
      expect(service.isReadyForAccount(ALICE, 3)).toBe(false);
    });

    it('hesap adresini büyük/küçük harften bağımsız eşleştirir', async () => {
      await service.init(makeProvider(SEPOLIA), makeSigner(ALICE), 2);
      expect(service.isReadyForAccount(ALICE.toLowerCase(), 2)).toBe(true);
    });
  });

  // ─── Permit ───────────────────────────────────────────────────
  describe('permit yönetimi', () => {
    beforeEach(async () => {
      await service.init(makeProvider(SEPOLIA), makeSigner(ALICE), 2);
    });

    it('permit yoksa oluşturur', async () => {
      await service.ensurePermit();
      expect(mockClient.permits.getOrCreateSelfPermit).toHaveBeenCalledTimes(1);
    });

    it('geçerli permit varsa yeniden imzalatmaz', async () => {
      mockClient.permits.getActivePermit = vi.fn(() => ({ hash: '0x1', expiration: 9_999_999_999 }));
      await service.ensurePermit();
      expect(mockClient.permits.getOrCreateSelfPermit).not.toHaveBeenCalled();
    });

    it('süresi dolmuş permiti yeniler', async () => {
      // Regresyon: eskiden bir boolean cache'lendiği için süre dolduğunda fark edilmiyor,
      // her çözme işlemi hata veriyordu.
      mockClient.permits.getActivePermit = vi.fn(() => ({ hash: '0x1', expiration: 1 }));
      mockIsValid = vi.fn(() => ({ valid: false, error: 'expired' }));

      await service.ensurePermit();
      expect(mockClient.permits.getOrCreateSelfPermit).toHaveBeenCalledTimes(1);
    });

    it('bozuk şemalı permiti silip yeniden oluşturur', async () => {
      mockClient.permits.getActivePermit = vi.fn(() => ({ hash: '0x1', expiration: 9_999_999_999 }));
      mockIsValid = vi.fn(() => ({ valid: false, error: 'invalid-schema' }));

      await service.ensurePermit();
      expect(mockClient.permits.removeActivePermit).toHaveBeenCalled();
      expect(mockClient.permits.getOrCreateSelfPermit).toHaveBeenCalledTimes(1);
    });

    it('hasPermit süre bilgisini canlı okur', () => {
      mockClient.permits.getActivePermit = vi.fn(() => ({ hash: '0x1', expiration: 9_999_999_999 }));
      expect(service.hasPermit()).toBe(true);

      mockIsValid = vi.fn(() => ({ valid: false, error: 'expired' }));
      expect(service.hasPermit()).toBe(false);
    });

    it('getPermitExpiry saniye cinsinden döner', () => {
      mockClient.permits.getActivePermit = vi.fn(() => ({ hash: '0x1', expiration: 1893456000 }));
      expect(service.getPermitExpiry()).toBe(1893456000);
    });
  });

  // ─── Şifreleme ────────────────────────────────────────────────
  describe('encryptUint64', () => {
    beforeEach(async () => {
      await service.init(makeProvider(SEPOLIA), makeSigner(ALICE), 2);
    });

    it('şifreli girdiyi döner', async () => {
      const encrypted = { ctHash: 1n, securityZone: 0, utype: 5, signature: '0xsig' };
      mockClient.encryptInputs = vi.fn(() => ({ execute: async () => [encrypted] }));

      await expect(service.encryptUint64(1000n)).resolves.toEqual(encrypted);
    });

    it('bağlantı yokken şifrelemeyi reddeder', async () => {
      service.reset();
      await expect(service.encryptUint64(1n)).rejects.toThrow(/not initialized/);
    });
  });

  // ─── Çözme ────────────────────────────────────────────────────
  describe('decryptForView', () => {
    beforeEach(async () => {
      await service.init(makeProvider(SEPOLIA), makeSigner(ALICE), 2);
    });

    /**
     * The SDK's decrypt builders are chainable, so a mock has to return `this` from every
     * link in the chain — `.set404RetryTimeout()` included, since a ciphertext the
     * coprocessor has not ingested yet is retried rather than reported as missing.
     */
    const viewBuilder = (execute: () => Promise<unknown>) => {
      const builder: Record<string, unknown> = { execute };
      builder.set404RetryTimeout = vi.fn(() => builder);
      return builder;
    };

    it('düz değeri döner', async () => {
      mockClient.decryptForView = vi.fn(() => viewBuilder(async () => 4200n));
      await expect(service.decryptForView(123n)).resolves.toBe(4200n);
    });

    it('404 yeniden deneme süresi ayarlanır', async () => {
      const builder = viewBuilder(async () => 1n);
      mockClient.decryptForView = vi.fn(() => builder);

      await service.decryptForView(123n);

      // A balance read straight after shielding legitimately 404s until the coprocessor
      // ingests the handle; without the retry it would render as an empty balance.
      expect(builder.set404RetryTimeout).toHaveBeenCalledWith(expect.any(Number));
    });

    it('eksik ciphertext için tipli hata üretir', async () => {
      // Hiç shield yapmamış hesap için normal durum — arayüz bunu sıfır bakiye sayar.
      mockClient.decryptForView = vi.fn(() =>
        viewBuilder(async () => { throw new Error('Ciphertext not found for handle'); }));
      await expect(service.decryptForView(123n)).rejects.toBeInstanceOf(CiphertextNotFoundError);
    });

    it('ağ permiti reddederse saklanan permiti siler', async () => {
      mockClient.permits.getActivePermit = vi.fn(() => ({ hash: '0x1', expiration: 9_999_999_999 }));
      mockClient.decryptForView = vi.fn(() =>
        viewBuilder(async () => { throw Object.assign(new Error('denied'), { code: 'PERMIT_NOT_FOUND' }); }));

      await expect(service.decryptForView(123n)).rejects.toThrow();
      expect(mockClient.permits.removeActivePermit).toHaveBeenCalled();
    });
  });

  describe('decryptForTx', () => {
    beforeEach(async () => {
      await service.init(makeProvider(SEPOLIA), makeSigner(ALICE), 2);
    });

    it('permitsiz çözer ve imzayı döner', async () => {
      const result = { ctHash: 1n, decryptedValue: 500n, signature: '0xproof' };
      const withoutPermit = vi.fn(() => ({ execute: async () => result }));
      const builder: Record<string, unknown> = { withoutPermit };
      builder.set404RetryTimeout = vi.fn(() => builder);
      mockClient.decryptForTx = vi.fn(() => builder);

      await expect(service.decryptForTx(1n)).resolves.toEqual(result);
      expect(withoutPermit).toHaveBeenCalled();
      // Claims get a longer window: giving up leaves burned balance unsettled.
      expect(builder.set404RetryTimeout).toHaveBeenCalledWith(expect.any(Number));
    });
  });

  // ─── Kilit ────────────────────────────────────────────────────
  describe('reset (cüzdan kilidi)', () => {
    it('bağlantıyı ve worker yaşam döngüsünü kapatır', async () => {
      await service.init(makeProvider(SEPOLIA), makeSigner(ALICE), 2);
      service.reset();

      expect(mockClient.disconnect).toHaveBeenCalled();
      // ZK worker TFHE durumu ve indirilmiş anahtarları tutar; kilitte kalmamalı.
      expect(mockTerminateWorker).toHaveBeenCalled();
      expect(service.isReady()).toBe(false);
      expect(service.isReadyForAccount(ALICE, 2)).toBe(false);
    });

    it('disconnect hata verse bile temizliği tamamlar', async () => {
      await service.init(makeProvider(SEPOLIA), makeSigner(ALICE), 2);
      mockClient.disconnect = vi.fn(() => { throw new Error('boom'); });

      expect(() => service.reset()).not.toThrow();
      expect(service.isReady()).toBe(false);
    });
  });
});
