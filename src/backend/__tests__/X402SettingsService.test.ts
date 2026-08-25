/// <reference types="vitest/globals" />
import { X402SettingsService, DEFAULT_X402_SETTINGS, type X402Settings } from '../X402SettingsService';
import { X402_ABSOLUTE_CAPS } from '../AgentPolicyEngine';

/**
 * X402SettingsService testleri
 *
 * NotificationService.test.ts ile aynı desen: global chrome mock, promise tabanlı API
 * bekliyor (setup.ts'deki mock hem callback hem promise formunu destekliyor), bu yüzden
 * chrome mock'unu olduğu gibi kullanıyoruz — sadece localStorage fallback yolunu da ayrı
 * test ediyoruz.
 */
describe('X402SettingsService', () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    localStorage.clear();
  });

  it('varsayılan ayarlar: kapalı, konservatif tavan/bütçe', async () => {
    const settings = await X402SettingsService.getSettings();
    expect(settings).toEqual(DEFAULT_X402_SETTINGS);
    expect(settings.enabled).toBe(false);
  });

  it('ayarları kaydeder ve geri okur', async () => {
    const custom: X402Settings = { enabled: true, perTransactionCapUsd: 0.25, dailyBudgetCapUsd: 3 };
    await X402SettingsService.saveSettings(custom);

    const loaded = await X402SettingsService.getSettings();
    expect(loaded).toEqual(custom);
  });

  // ─── Mutlak clamp ────────────────────────────────────────────────
  describe('mutlak tavan clamp', () => {
    it('kullanıcı işlem-başı tavanı mutlak sınırın üstüne çıkaramaz — kaydederken kırpılır', async () => {
      const attempted: X402Settings = {
        enabled: true,
        perTransactionCapUsd: X402_ABSOLUTE_CAPS.maxPerTransactionUsd + 100,
        dailyBudgetCapUsd: 1,
      };
      const saved = await X402SettingsService.saveSettings(attempted);
      expect(saved.perTransactionCapUsd).toBe(X402_ABSOLUTE_CAPS.maxPerTransactionUsd);

      const loaded = await X402SettingsService.getSettings();
      expect(loaded.perTransactionCapUsd).toBe(X402_ABSOLUTE_CAPS.maxPerTransactionUsd);
    });

    it('kullanıcı günlük bütçeyi mutlak sınırın üstüne çıkaramaz — kaydederken kırpılır', async () => {
      const attempted: X402Settings = {
        enabled: true,
        perTransactionCapUsd: 0.1,
        dailyBudgetCapUsd: X402_ABSOLUTE_CAPS.maxDailyBudgetUsd + 1000,
      };
      const saved = await X402SettingsService.saveSettings(attempted);
      expect(saved.dailyBudgetCapUsd).toBe(X402_ABSOLUTE_CAPS.maxDailyBudgetUsd);
    });

    it('mutlak sınırın altındaki değerler olduğu gibi kaydedilir (clamp sadece üst sınırda etkili)', async () => {
      const attempted: X402Settings = { enabled: true, perTransactionCapUsd: 0.5, dailyBudgetCapUsd: 5 };
      const saved = await X402SettingsService.saveSettings(attempted);
      expect(saved).toEqual(attempted);
    });

    it('negatif veya NaN değerler 0\'a kırpılır (silently ignore değil, "bütçe yok" anlamına gelir)', async () => {
      const saved = await X402SettingsService.saveSettings({
        enabled: true,
        perTransactionCapUsd: -5,
        dailyBudgetCapUsd: Number.NaN,
      });
      expect(saved.perTransactionCapUsd).toBe(0);
      expect(saved.dailyBudgetCapUsd).toBe(0);
    });

    it('storage\'a doğrudan (uygulama dışından) mutlak sınırın üstünde bir değer yazılsa bile getSettings okurken kırpar', async () => {
      // Manually edited / pre-cap-lowering stored blob — defense-in-depth, not the primary
      // enforcement point (see this service's own JSDoc).
      await chrome.storage.local.set({
        arfhe_x402_settings: { enabled: true, perTransactionCapUsd: 999, dailyBudgetCapUsd: 999 },
      });
      const loaded = await X402SettingsService.getSettings();
      expect(loaded.perTransactionCapUsd).toBe(X402_ABSOLUTE_CAPS.maxPerTransactionUsd);
      expect(loaded.dailyBudgetCapUsd).toBe(X402_ABSOLUTE_CAPS.maxDailyBudgetUsd);
    });
  });

  // ─── localStorage fallback (chrome yokken) ────────────────────────
  describe('localStorage fallback', () => {
    let originalChrome: typeof chrome | undefined;

    beforeEach(() => {
      originalChrome = (globalThis as unknown as { chrome?: typeof chrome }).chrome;
      (globalThis as unknown as { chrome?: typeof chrome }).chrome = undefined;
    });

    afterEach(() => {
      (globalThis as unknown as { chrome?: typeof chrome }).chrome = originalChrome;
    });

    it('chrome.storage yokken localStorage üzerinden kaydeder/okur ve yine clamp uygular', async () => {
      const attempted: X402Settings = {
        enabled: true,
        perTransactionCapUsd: X402_ABSOLUTE_CAPS.maxPerTransactionUsd + 5,
        dailyBudgetCapUsd: 2,
      };
      await X402SettingsService.saveSettings(attempted);

      const loaded = await X402SettingsService.getSettings();
      expect(loaded.perTransactionCapUsd).toBe(X402_ABSOLUTE_CAPS.maxPerTransactionUsd);
      expect(loaded.dailyBudgetCapUsd).toBe(2);
    });

    it('hiçbir şey kaydedilmemişse varsayılanları döner', async () => {
      const loaded = await X402SettingsService.getSettings();
      expect(loaded).toEqual(DEFAULT_X402_SETTINGS);
    });
  });
});
