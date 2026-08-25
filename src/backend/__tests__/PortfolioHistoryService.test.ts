/**
 * Tests for the recorded portfolio series.
 *
 * The chart this feeds replaced one built from `Math.random()`, so the property that
 * matters most is the one that is easy to lose again: **it must never claim to know
 * something it did not observe.** A wallet opened once has a single measurement, and the
 * difference between "no change today" and "no comparison yet" is the difference between a
 * fact and an invention.
 *
 * The other half is that the series measures *time*, not how often the user navigated.
 * Home refetches on every navigation and after every confirmation; without a floor between
 * points, a single busy session would fill the window and a day would look like a minute.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PortfolioHistoryService } from "../PortfolioHistoryService.js";

const ALICE = "0xAbCdEf0000000000000000000000000000000001";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("PortfolioHistoryService", () => {
  let service: PortfolioHistoryService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
    service = new PortfolioHistoryService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advance the clock and record, the way a refresh would. */
  function recordAfter(ms: number, usd: number, networks = 1) {
    vi.advanceTimersByTime(ms);
    service.record(ALICE, usd, networks);
  }

  describe("kayıt", () => {
    it("ilk ölçümü saklar", () => {
      service.record(ALICE, 100, 1);
      expect(service.getSeries(ALICE, "ALL")).toHaveLength(1);
    });

    it("hiçbir ağ yüklenmemişken kayıt yapmaz", () => {
      // A zero here describes what the wallet knows, not what the user holds. Writing it
      // would carve a crash to zero into the chart on every cold start.
      service.record(ALICE, 0, 0);
      expect(service.getSeries(ALICE, "ALL")).toHaveLength(0);
    });

    it("gerçek sıfır bakiyeyi kaydeder", () => {
      // A loaded network that genuinely holds nothing is an observation, and dropping it
      // would hide someone emptying their wallet.
      service.record(ALICE, 0, 2);
      expect(service.getSeries(ALICE, "ALL")).toHaveLength(1);
    });

    it("kısa aralıkta yeni nokta eklemez, sonuncuyu günceller", () => {
      service.record(ALICE, 100, 1);
      recordAfter(MINUTE, 110, 1);
      recordAfter(MINUTE, 120, 1);

      const points = service.getSeries(ALICE, "ALL");
      // Three refreshes inside one session are one moment, not three.
      expect(points).toHaveLength(1);
      // …but the series still reflects the newest figure.
      expect(points[0].usd).toBe(120);
    });

    it("aralık geçince yeni nokta ekler", () => {
      service.record(ALICE, 100, 1);
      recordAfter(20 * MINUTE, 150, 1);
      expect(service.getSeries(ALICE, "ALL")).toHaveLength(2);
    });

    it("hesapları ayrı tutar", () => {
      const bob = "0xBbBbBb0000000000000000000000000000000002";
      service.record(ALICE, 100, 1);
      service.record(bob, 999, 1);

      expect(service.getSeries(ALICE, "ALL")[0].usd).toBe(100);
      expect(service.getSeries(bob, "ALL")[0].usd).toBe(999);
    });

    it("geçersiz toplamı yok sayar", () => {
      service.record(ALICE, Number.NaN, 1);
      service.record(ALICE, -5, 1);
      expect(service.getSeries(ALICE, "ALL")).toHaveLength(0);
    });
  });

  describe("günlük değişim", () => {
    it("karşılaştıracak bir şey yokken değişim uydurmaz", () => {
      service.record(ALICE, 100, 1);
      const change = service.getDailyChange(ALICE);

      // The regression this guards: reporting 0.00% would assert the balance held steady
      // over a day the wallet never watched.
      expect(change.hasBaseline).toBe(false);
      expect(change.absolute).toBe(0);
    });

    it("hiç veri yokken de temel yok der", () => {
      expect(service.getDailyChange(ALICE).hasBaseline).toBe(false);
    });

    it("bir günü aşan aralıkta miktar ve yüzdeyi hesaplar", () => {
      service.record(ALICE, 100, 1);
      recordAfter(DAY + HOUR, 125, 1);

      const change = service.getDailyChange(ALICE);
      expect(change.hasBaseline).toBe(true);
      expect(change.absolute).toBe(25);
      expect(change.percent).toBeCloseTo(25, 5);
    });

    it("düşüşü negatif bildirir", () => {
      service.record(ALICE, 200, 1);
      recordAfter(DAY + HOUR, 150, 1);

      const change = service.getDailyChange(ALICE);
      expect(change.absolute).toBe(-50);
      expect(change.percent).toBeCloseTo(-25, 5);
    });

    it("temel olarak 24 saatten eski EN YENİ noktayı seçer", () => {
      // A wallet used, abandoned for a week, then opened again. Comparing against the
      // oldest point in the series would label a week's drift as today's move.
      service.record(ALICE, 100, 1);          // 7 days ago
      recordAfter(6 * DAY, 400, 1);           // 1 day + margin ago
      recordAfter(DAY + HOUR, 440, 1);        // now

      const change = service.getDailyChange(ALICE);
      expect(change.absolute).toBe(40);
      expect(change.percent).toBeCloseTo(10, 5);
    });

    it("sıfırdan başlayan artışta yüzde uydurmaz", () => {
      service.record(ALICE, 0, 1);
      recordAfter(DAY + HOUR, 500, 1);

      const change = service.getDailyChange(ALICE);
      expect(change.absolute).toBe(500);
      // Going from nothing to something is not "infinity percent"; the amount stands alone.
      expect(change.percent).toBe(0);
      expect(Number.isFinite(change.percent)).toBe(true);
    });
  });

  describe("aralıklar", () => {
    it("yalnızca pencereye düşen noktaları döner", () => {
      service.record(ALICE, 10, 1);   // t = 0
      recordAfter(2 * DAY, 20, 1);    // t = 2d
      recordAfter(6 * DAY, 30, 1);    // t = 8d, and "now"

      expect(service.getSeries(ALICE, "ALL")).toHaveLength(3);
      // A week back from t=8d is t=1d, so the opening point falls outside it.
      expect(service.getSeries(ALICE, "1W")).toHaveLength(2);
      // Nothing is synthesised to fill an otherwise empty window.
      expect(service.getSeries(ALICE, "1D")).toHaveLength(1);
    });

    it("saklama süresini aşan noktaları düşürür", () => {
      service.record(ALICE, 10, 1);
      recordAfter(100 * DAY, 20, 1);
      // The old point is past the 90-day horizon and must not linger in the blob that is
      // decrypted on every unlock.
      expect(service.getSeries(ALICE, "ALL")).toHaveLength(1);
    });
  });

  it("clear hesabın geçmişini siler", () => {
    service.record(ALICE, 100, 1);
    service.clear(ALICE);
    expect(service.getSeries(ALICE, "ALL")).toHaveLength(0);
  });

  it("clearMemory bellekte iz bırakmaz", () => {
    service.record(ALICE, 100, 1);
    service.clearMemory();
    // Wallet lock must not leave the account's value history readable in the heap.
    expect(service.getSeries(ALICE, "ALL")).toHaveLength(0);
  });
});
