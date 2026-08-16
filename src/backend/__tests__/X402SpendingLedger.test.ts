/// <reference types="vitest/globals" />
import { X402SpendingLedger, MAX_X402_SPENDING_RECORDS, type X402SpendingRecord } from '../X402SpendingLedger';

/**
 * X402SpendingLedger testleri
 *
 * SitePermissionService.test.ts ile aynı desen: chrome.storage.local yerine geçen bellek-içi
 * bir store enjekte edilir, böylece testler gerçek chrome API'sine bağımlı olmaz ve storage'ın
 * ne tuttuğunu doğrudan gözlemleyebiliriz. Odak noktası: periyot (gün) hesaplaması sınır
 * durumları (tam gün başlangıcı, gün sonu, önceki günün kaydı) ve hesap bazlı izolasyon.
 */

const ALICE = '0xAbCdEf0000000000000000000000000000000001';
const BOB = '0x1234560000000000000000000000000000000002';

function makeStore() {
  const memory = new Map<string, unknown>();
  return {
    async get(key: string) {
      return memory.has(key) ? { [key]: memory.get(key) } : {};
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) memory.set(k, v);
    },
    _memory: memory,
  };
}

function makeRecord(overrides: Partial<X402SpendingRecord> = {}): Omit<X402SpendingRecord, 'accountAddress'> & { accountAddress: string } {
  return {
    id: `pay_${Math.random().toString(36).slice(2)}`,
    accountAddress: ALICE,
    amountUsd: 0.1,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('X402SpendingLedger', () => {
  let store: ReturnType<typeof makeStore>;
  let ledger: X402SpendingLedger;

  beforeEach(() => {
    store = makeStore();
    ledger = new X402SpendingLedger(store);
  });

  // ─── Temel kayıt ────────────────────────────────────────────────
  describe('kayıt', () => {
    it('başlangıçta boştur', async () => {
      expect(await ledger.getAll()).toEqual([]);
    });

    it('bir ödeme kaydeder ve geri okur', async () => {
      const recorded = await ledger.recordPayment(makeRecord({ amountUsd: 0.25, service: 'weather-api' }));
      const all = await ledger.getAll();
      expect(all).toHaveLength(1);
      expect(all[0]).toEqual(recorded);
      expect(all[0].accountAddress).toBe(ALICE.toLowerCase());
    });

    it('accountAddress her zaman lowercase saklanır (SitePermissionService ile tutarlı)', async () => {
      await ledger.recordPayment(makeRecord({ accountAddress: ALICE }));
      const all = await ledger.getAll();
      expect(all[0].accountAddress).toBe(ALICE.toLowerCase());
    });

    it('bozuk/geçersiz bir kayıt storage\'da olsa bile getAll çökmez, onu atlar', async () => {
      await store.set({
        arfhe_x402_spending_ledger: [
          { id: 'ok', accountAddress: ALICE, amountUsd: 0.1, timestamp: Date.now() },
          { id: 'bad', accountAddress: ALICE, amountUsd: 'not-a-number', timestamp: Date.now() },
          { id: 'missing-timestamp', accountAddress: ALICE, amountUsd: 0.2 },
          null,
        ],
      });
      const all = await ledger.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe('ok');
    });
  });

  // ─── Hesap bazlı izolasyon ────────────────────────────────────────
  describe('hesap bazlı izolasyon', () => {
    it('bir hesabın kayıtları diğerini etkilemez', async () => {
      await ledger.recordPayment(makeRecord({ accountAddress: ALICE, amountUsd: 0.1 }));
      await ledger.recordPayment(makeRecord({ accountAddress: BOB, amountUsd: 0.2 }));

      const aliceRecords = await ledger.getRecordsForAccount(ALICE);
      const bobRecords = await ledger.getRecordsForAccount(BOB);
      expect(aliceRecords).toHaveLength(1);
      expect(bobRecords).toHaveLength(1);
      expect(aliceRecords[0].amountUsd).toBe(0.1);
      expect(bobRecords[0].amountUsd).toBe(0.2);
    });
  });

  // ─── Periyot (gün) hesaplaması ────────────────────────────────────
  describe('getSpentInPeriod / getSpentToday', () => {
    it('boş ledger için 0 döner', async () => {
      expect(await ledger.getSpentToday(ALICE)).toBe(0);
    });

    it('bugünkü ödemeleri toplar', async () => {
      const now = new Date(2026, 5, 15, 14, 30, 0).getTime(); // 15 Haziran 2026, 14:30 local
      await ledger.recordPayment(makeRecord({ amountUsd: 0.1, timestamp: new Date(2026, 5, 15, 9, 0, 0).getTime() }));
      await ledger.recordPayment(makeRecord({ amountUsd: 0.2, timestamp: new Date(2026, 5, 15, 13, 59, 59).getTime() }));

      expect(await ledger.getSpentToday(ALICE, now)).toBeCloseTo(0.3, 10);
    });

    it('önceki günün ödemesini bugüne dahil ETMEZ', async () => {
      const now = new Date(2026, 5, 15, 10, 0, 0).getTime();
      await ledger.recordPayment(makeRecord({ amountUsd: 5, timestamp: new Date(2026, 5, 14, 23, 59, 59).getTime() }));

      expect(await ledger.getSpentToday(ALICE, now)).toBe(0);
    });

    it('gün başlangıcı (00:00:00.000) dahildir, bir önceki günün son milisaniyesi dahil değildir', async () => {
      const dayStart = new Date(2026, 5, 15, 0, 0, 0, 0).getTime();
      const now = dayStart + 60_000; // aynı günün biraz ilerisi

      await ledger.recordPayment(makeRecord({ amountUsd: 1, timestamp: dayStart })); // tam gün başlangıcı — dahil
      await ledger.recordPayment(makeRecord({ amountUsd: 2, timestamp: dayStart - 1 })); // bir önceki günün son ms'i — dahil değil

      expect(await ledger.getSpentToday(ALICE, now)).toBe(1);
    });

    it('yarının ödemesini bugüne dahil ETMEZ', async () => {
      const now = new Date(2026, 5, 15, 23, 0, 0).getTime();
      await ledger.recordPayment(makeRecord({ amountUsd: 5, timestamp: new Date(2026, 5, 16, 0, 0, 1).getTime() }));

      expect(await ledger.getSpentToday(ALICE, now)).toBe(0);
    });

    it('farklı hesapların bugünkü harcaması karışmaz', async () => {
      const now = new Date(2026, 5, 15, 12, 0, 0).getTime();
      await ledger.recordPayment(makeRecord({ accountAddress: ALICE, amountUsd: 0.3, timestamp: now }));
      await ledger.recordPayment(makeRecord({ accountAddress: BOB, amountUsd: 0.7, timestamp: now }));

      expect(await ledger.getSpentToday(ALICE, now)).toBeCloseTo(0.3, 10);
      expect(await ledger.getSpentToday(BOB, now)).toBeCloseTo(0.7, 10);
    });

    it('genel getSpentInPeriod keyfi bir pencerede de doğru toplar', async () => {
      await ledger.recordPayment(makeRecord({ amountUsd: 1, timestamp: 1000 }));
      await ledger.recordPayment(makeRecord({ amountUsd: 2, timestamp: 2000 }));
      await ledger.recordPayment(makeRecord({ amountUsd: 4, timestamp: 3000 }));

      expect(await ledger.getSpentInPeriod(ALICE, 1000, 3000)).toBe(3); // [1000,3000) -> 1000 ve 2000 dahil, 3000 dahil değil
      expect(await ledger.getSpentInPeriod(ALICE, 0, 4000)).toBe(7);
    });
  });

  // ─── Kalan bütçe ────────────────────────────────────────────────
  describe('getRemainingDailyBudget', () => {
    it('hiç harcama yoksa tüm bütçe kalır', async () => {
      expect(await ledger.getRemainingDailyBudget(ALICE, 1)).toBe(1);
    });

    it('kısmi harcama sonrası doğru kalan bütçeyi hesaplar', async () => {
      const now = new Date(2026, 5, 15, 12, 0, 0).getTime();
      await ledger.recordPayment(makeRecord({ amountUsd: 0.4, timestamp: now }));

      expect(await ledger.getRemainingDailyBudget(ALICE, 1, now)).toBeCloseTo(0.6, 10);
    });

    it('bütçe aşılmışsa negatif değil 0 döner', async () => {
      const now = new Date(2026, 5, 15, 12, 0, 0).getTime();
      await ledger.recordPayment(makeRecord({ amountUsd: 5, timestamp: now }));

      expect(await ledger.getRemainingDailyBudget(ALICE, 1, now)).toBe(0);
    });

    it('tam bütçe kadar harcanmışsa 0 döner (sınır durumu)', async () => {
      const now = new Date(2026, 5, 15, 12, 0, 0).getTime();
      await ledger.recordPayment(makeRecord({ amountUsd: 1, timestamp: now }));

      expect(await ledger.getRemainingDailyBudget(ALICE, 1, now)).toBe(0);
    });
  });

  // ─── FIFO trim (hesap bazlı) ────────────────────────────────────
  describe('MAX_X402_SPENDING_RECORDS trim', () => {
    it('bir hesap limiti aştığında en eski kayıtlar silinir, diğer hesap etkilenmez', async () => {
      for (let i = 0; i < MAX_X402_SPENDING_RECORDS + 10; i++) {
        await ledger.recordPayment(makeRecord({ id: `alice_${i}`, accountAddress: ALICE, timestamp: i }));
      }
      await ledger.recordPayment(makeRecord({ id: 'bob_1', accountAddress: BOB, timestamp: 999999 }));

      const aliceRecords = await ledger.getRecordsForAccount(ALICE);
      const bobRecords = await ledger.getRecordsForAccount(BOB);

      expect(aliceRecords).toHaveLength(MAX_X402_SPENDING_RECORDS);
      // En eskiler (id 0..9) silinmiş olmalı, en yeniler (son MAX_X402_SPENDING_RECORDS tanesi) kalmalı.
      expect(aliceRecords.some((r) => r.id === 'alice_0')).toBe(false);
      expect(aliceRecords.some((r) => r.id === `alice_${MAX_X402_SPENDING_RECORDS + 9}`)).toBe(true);
      expect(bobRecords).toHaveLength(1);
    });
  });

  describe('clearAll', () => {
    it('tüm hesapların kayıtlarını temizler', async () => {
      await ledger.recordPayment(makeRecord({ accountAddress: ALICE }));
      await ledger.recordPayment(makeRecord({ accountAddress: BOB }));
      await ledger.clearAll();
      expect(await ledger.getAll()).toEqual([]);
    });
  });
});
