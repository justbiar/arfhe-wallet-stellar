/// <reference types="vitest/globals" />
import StorageManager from '../StorageManager';

/**
 * StorageManager unit tests
 *
 * Bu testler chrome.storage mock'u üzerinden çalışır (setup.ts'de tanımlı).
 * Web Crypto API testleri jsdom'un crypto.subtle desteğine bağlıdır.
 */
describe('StorageManager', () => {
  let sm: StorageManager;

  beforeEach(() => {
    // localStorage'ı temizle (testler arası kalıntı olmaması için)
    localStorage.clear();
    sm = new StorageManager();
  });

  // ─── Local Storage (unencrypted) ─────────────────────────────
  describe('getLocal / setLocal', () => {
    it('değer yazılır ve okunur', () => {
      sm.setLocal('test_key', { foo: 'bar' });
      const result = sm.getLocal<{ foo: string }>('test_key');
      expect(result).toEqual({ foo: 'bar' });
    });

    it('olmayan anahtar null döner', () => {
      const result = sm.getLocal('nonexistent');
      expect(result).toBeNull();
    });

    it('string değer yazılır ve okunur', () => {
      sm.setLocal('str_key', 'hello world');
      expect(sm.getLocal('str_key')).toBe('hello world');
    });

    it('array değer yazılır ve okunur', () => {
      sm.setLocal('arr_key', [1, 2, 3]);
      expect(sm.getLocal('arr_key')).toEqual([1, 2, 3]);
    });

    it('removeLocal ile değer silinir', () => {
      sm.setLocal('del_key', 'value');
      sm.removeLocal('del_key');
      expect(sm.getLocal('del_key')).toBeNull();
    });

    it('üzerine yazma doğru çalışır', () => {
      sm.setLocal('overwrite', 'first');
      sm.setLocal('overwrite', 'second');
      expect(sm.getLocal('overwrite')).toBe('second');
    });
  });

  // ─── Encryption Lifecycle ────────────────────────────────────
  describe('Encryption Lifecycle', () => {
    const TEST_PASSWORD = 'TestPassword123!';

    it('başlangıçta kilitli (unlocked=false)', () => {
      expect(sm.isUnlocked()).toBe(false);
    });

    it('şifre ile başlatıldıktan sonra açık', async () => {
      await sm.initEncryption(TEST_PASSWORD);
      expect(sm.isUnlocked()).toBe(true);
    });

    it('hasPassword şifre ayarlandıktan sonra true döner', async () => {
      await sm.initEncryption(TEST_PASSWORD);
      expect(sm.hasPassword()).toBe(true);
    });

    it('lock() sonrası kilitli', async () => {
      await sm.initEncryption(TEST_PASSWORD);
      sm.lock();
      expect(sm.isUnlocked()).toBe(false);
    });

    it('lock callback çağrılır', async () => {
      const callback = vi.fn();
      sm.onLock(callback);
      await sm.initEncryption(TEST_PASSWORD);
      sm.lock();
      expect(callback).toHaveBeenCalled();
    });
  });

  // ─── Encrypt & Decrypt Cycle ─────────────────────────────────
  describe('encryptAndStore / decryptAndRetrieve', () => {
    const TEST_PASSWORD = 'SecurePass!456';

    it('veri şifrelenir, deşifrelenir ve orijinale eşittir', async () => {
      await sm.initEncryption(TEST_PASSWORD);

      const secretData = { wallet: '0xABC', balance: 100 };
      await sm.encryptAndStore('secret_wallet', secretData);

      const decrypted = await sm.decryptAndRetrieve<typeof secretData>('secret_wallet');
      expect(decrypted).toEqual(secretData);
    });

    it('string veri şifreleme/deşifreleme', async () => {
      await sm.initEncryption(TEST_PASSWORD);
      await sm.encryptAndStore('secret_string', 'my-private-key');
      const result = await sm.decryptAndRetrieve<string>('secret_string');
      expect(result).toBe('my-private-key');
    });

    it('kilitliyken deşifreleme null döner', async () => {
      await sm.initEncryption(TEST_PASSWORD);
      await sm.encryptAndStore('locked_data', 'secret');
      sm.lock();

      const result = await sm.decryptAndRetrieve('locked_data');
      expect(result).toBeNull();
    });

    it('kilitliyken şifreleme false döner', async () => {
      sm.lock();
      const success = await sm.encryptAndStore('key', 'value');
      expect(success).toBe(false);
    });

    it('şifrelenmiş veri silinebilir', async () => {
      await sm.initEncryption(TEST_PASSWORD);
      await sm.encryptAndStore('to_delete', 'value');
      sm.removeEncrypted('to_delete');
      const result = await sm.decryptAndRetrieve('to_delete');
      expect(result).toBeNull();
    });
  });

  // ─── Change Password ────────────────────────────────────────
  describe('changePassword()', () => {
    it('şifre değiştirme sonrası eski şifre çalışmaz, yeni şifre çalışır', async () => {
      const OLD_PASS = 'OldPass123!';
      const NEW_PASS = 'NewPass456!';

      await sm.initEncryption(OLD_PASS);
      await sm.encryptAndStore('test_data', 'secret-value');

      await sm.changePassword(OLD_PASS, NEW_PASS);

      // Yeni şifre ile erişim
      // changePassword yeni key ile re-encrypt eder, yani unlock durumda kalmalı
      expect(sm.isUnlocked()).toBe(true);
      const result = await sm.decryptAndRetrieve<string>('test_data');
      expect(result).toBe('secret-value');
    });
  });
});

/**
 * Session restore — the gate that decides whether a reopened popup needs the password.
 *
 * This is the only thing protecting a wallet whose popup was closed: the in-page auto-lock
 * timer dies with the page, so on reopen the age of `arfhe_last_active` is the whole
 * decision. It defeated itself twice — first WalletProvider stamped the timestamp on
 * mount before Auth read it, then a mouse move over the freshly opened popup did the same.
 * The value is now frozen when the module loads, so these tests reload the module after
 * planting a timestamp, which is exactly what a real popup open does.
 */
describe('StorageManager — session restore', () => {
  const PASSWORD = 'correct horse battery staple';
  const FIVE_MINUTES = 5 * 60 * 1000;

  /**
   * Simulate opening the popup: plant the last-activity time, reload the module so it is
   * captured at import, and return a fresh instance with no key in memory.
   */
  const reopenWith = async (lastActiveAgoMs: number | null) => {
    if (lastActiveAgoMs === null) localStorage.removeItem('arfhe_last_active');
    else localStorage.setItem('arfhe_last_active', String(Date.now() - lastActiveAgoMs));

    vi.resetModules();
    const { default: Reloaded } = await import('../StorageManager');
    return new Reloaded();
  };

  /** Establish a real encrypted wallet and a stored session key. */
  const createWallet = async () => {
    vi.resetModules();
    const { default: Fresh } = await import('../StorageManager');
    const sm = new Fresh();
    await sm.initEncryption(PASSWORD);
    return sm;
  };

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('yakın zamanda aktifse oturumu geri yükler', async () => {
    await createWallet();
    const reopened = await reopenWith(30_000);

    await expect(reopened.restoreSession(FIVE_MINUTES)).resolves.toBe(true);
    expect(reopened.isUnlocked()).toBe(true);
  });

  it('süre dolduysa oturumu geri yüklemez ve şifre ister', async () => {
    // The reported bug: wallet left for hours, reopened without a password.
    await createWallet();
    const reopened = await reopenWith(3 * 60 * 60 * 1000);

    await expect(reopened.restoreSession(FIVE_MINUTES)).resolves.toBe(false);
    expect(reopened.isUnlocked()).toBe(false);
  });

  it('açılıştan sonraki aktivite damgası kararı etkilemez', async () => {
    // The second regression: a mouse move over the opening popup refreshed the stamp
    // before the check ran. The frozen value must ignore anything written after load.
    await createWallet();
    const reopened = await reopenWith(20 * 60 * 1000);

    localStorage.setItem('arfhe_last_active', String(Date.now()));

    await expect(reopened.restoreSession(FIVE_MINUTES)).resolves.toBe(false);
    expect(reopened.isUnlocked()).toBe(false);
  });

  it('süresi dolan oturumun anahtarını da siler', async () => {
    await createWallet();
    const reopened = await reopenWith(3 * 60 * 60 * 1000);
    await reopened.restoreSession(FIVE_MINUTES);

    // A later open must not succeed either — the key is gone, not merely refused.
    const again = await reopenWith(1_000);
    await expect(again.restoreSession(FIVE_MINUTES)).resolves.toBe(false);
  });

  it('sınırın hemen dışındaki oturum reddedilir', async () => {
    await createWallet();
    const reopened = await reopenWith(FIVE_MINUTES + 5_000);
    await expect(reopened.restoreSession(FIVE_MINUTES)).resolves.toBe(false);
  });

  it('hiç aktivite damgası yoksa geri yüklemez', async () => {
    await createWallet();
    const reopened = await reopenWith(null);
    await expect(reopened.restoreSession(FIVE_MINUTES)).resolves.toBe(false);
  });

  it('kilitleme oturum anahtarını temizler', async () => {
    const sm = await createWallet();
    sm.lock();

    const reopened = await reopenWith(1_000);
    await expect(reopened.restoreSession(FIVE_MINUTES)).resolves.toBe(false);
  });

  it('"asla kilitleme" seçiliyse yaş kontrolü uygulanmaz', async () => {
    // 0 is the explicit "never" setting; the browser session still ends it.
    await createWallet();
    const reopened = await reopenWith(24 * 60 * 60 * 1000);
    await expect(reopened.restoreSession(0)).resolves.toBe(true);
  });
});
