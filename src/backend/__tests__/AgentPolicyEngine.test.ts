/// <reference types="vitest/globals" />
import {
  AgentPolicyEngine,
  READ_ONLY_TOOLS,
  PROPOSAL_TOOLS,
  FORBIDDEN_TOOLS,
  X402_ABSOLUTE_CAPS,
  type X402PaymentSettings,
} from '../AgentPolicyEngine';

// Mocked so the "settings service bypassed" test can make X402SettingsService.getSettings()
// resolve an UNCLAMPED value, as if some future code path wrote arfhe_x402_settings directly
// and skipped X402SettingsService's own Math.min clamp — see that test for what it proves.
vi.mock('../X402SettingsService.js', () => ({
  X402SettingsService: { getSettings: vi.fn(), saveSettings: vi.fn() },
}));
import { X402SettingsService } from '../X402SettingsService.js';

/**
 * @vitest-environment node
 *
 * AgentPolicyEngine testleri
 *
 * Tool sınıflandırması, forbidden tool engeli, bakiye oranı limiti ve
 * oturum başına öneri limiti test edilir. Ağ/RPC çağrısı yapılmaz.
 */
describe('AgentPolicyEngine', () => {
  let engine: AgentPolicyEngine;

  beforeEach(() => {
    engine = new AgentPolicyEngine();
  });

  // ─── Tool taxonomy ───────────────────────────────────────────
  describe('tool sets', () => {
    it('forbidden tool listesi read-only ve proposal setleriyle çakışmaz', () => {
      for (const tool of FORBIDDEN_TOOLS) {
        expect(READ_ONLY_TOOLS).not.toContain(tool);
        expect(PROPOSAL_TOOLS).not.toContain(tool);
      }
    });

    it('getAvailableTools forbidden tool döndürmez', () => {
      const { readOnly, proposal } = engine.getAvailableTools();
      const all = [...readOnly, ...proposal];
      for (const tool of FORBIDDEN_TOOLS) {
        expect(all).not.toContain(tool);
      }
    });
  });

  // ─── evaluate: read-only ─────────────────────────────────────
  describe('evaluate — read-only tools', () => {
    it('read-only tool her zaman onaysız izin verilir', () => {
      const decision = engine.evaluate('get_balance', {}, { balance: 100 });
      expect(decision.allowed).toBe(true);
      expect(decision.requiresConfirmation).toBe(false);
      expect(decision.reasonCode).toBe('allowed_read_only');
    });
  });

  // ─── evaluate: forbidden ─────────────────────────────────────
  describe('evaluate — forbidden tools', () => {
    it('set_operator reddedilir', () => {
      const decision = engine.evaluate('set_operator', {}, { balance: 100 });
      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe('forbidden_tool');
    });

    it('claim_unshielded_batch benzeri bilinmeyen tehlikeli tool "unknown_tool" olarak reddedilir', () => {
      const decision = engine.evaluate('claim_unshielded_batch', {}, { balance: 100 });
      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe('unknown_tool');
    });

    it('claim_unshielded reddedilir', () => {
      const decision = engine.evaluate('claim_unshielded', {}, { balance: 100 });
      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe('forbidden_tool');
    });
  });

  // ─── evaluate: proposal ratio cap ────────────────────────────
  describe('evaluate — maxProposalRatio', () => {
    it('bakiyenin %50sini aşan öneri reddedilir', () => {
      const decision = engine.evaluate('propose_send', { amount: 60 }, { balance: 100 });
      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe('exceeds_balance_ratio');
    });

    it('bakiyenin %50si veya altındaki öneriye izin verilir (onay gerektirir)', () => {
      const decision = engine.evaluate('propose_send', { amount: 50 }, { balance: 100 });
      expect(decision.allowed).toBe(true);
      expect(decision.requiresConfirmation).toBe(true);
      expect(decision.reasonCode).toBe('allowed_proposal');
    });

    it('config ile maxProposalRatio değiştirilebilir', () => {
      const strictEngine = new AgentPolicyEngine({ maxProposalRatio: 0.1 });
      const decision = strictEngine.evaluate('propose_send', { amount: 20 }, { balance: 100 });
      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe('exceeds_balance_ratio');
    });
  });

  // ─── evaluate: session proposal cap ──────────────────────────
  describe('evaluate — maxProposalsPerSession', () => {
    it('varsayılan limit (10) aşıldığında yeni öneriler reddedilir', () => {
      const limitedEngine = new AgentPolicyEngine({ maxProposalRatio: 1 });
      for (let i = 0; i < 10; i++) {
        const decision = limitedEngine.evaluate('propose_send', { amount: 1 }, { balance: 100 });
        expect(decision.allowed).toBe(true);
      }
      const eleventh = limitedEngine.evaluate('propose_send', { amount: 1 }, { balance: 100 });
      expect(eleventh.allowed).toBe(false);
      expect(eleventh.reasonCode).toBe('session_proposal_limit_reached');
    });

    it('resetSession sayaç sıfırlar', () => {
      const limitedEngine = new AgentPolicyEngine({ maxProposalRatio: 1, maxProposalsPerSession: 1 });
      expect(limitedEngine.evaluate('propose_send', { amount: 1 }, { balance: 100 }).allowed).toBe(true);
      expect(limitedEngine.evaluate('propose_send', { amount: 1 }, { balance: 100 }).allowed).toBe(false);
      limitedEngine.resetSession();
      expect(limitedEngine.evaluate('propose_send', { amount: 1 }, { balance: 100 }).allowed).toBe(true);
    });

    it('reddedilen öneriler sayaca dahil edilmez', () => {
      const strictEngine = new AgentPolicyEngine({ maxProposalRatio: 0.1 });
      strictEngine.evaluate('propose_send', { amount: 90 }, { balance: 100 }); // reddedilir
      expect(strictEngine.getProposalCount()).toBe(0);
    });
  });

  // ─── evaluateX402Payment ───────────────────────────────────────
  describe('evaluateX402Payment', () => {
    function settings(overrides: Partial<X402PaymentSettings> = {}): X402PaymentSettings {
      return { enabled: true, perTransactionCapUsd: 0.5, dailyBudgetCapUsd: 5, ...overrides };
    }

    it('bütçe ve tavan içindeyse otomatik ödenir (onaysız)', () => {
      const decision = engine.evaluateX402Payment(0.1, settings(), 0);
      expect(decision.allowed).toBe(true);
      expect(decision.requiresConfirmation).toBe(false);
      expect(decision.reasonCode).toBe('x402_auto_paid');
      expect(decision.remainingBudgetUsd).toBeCloseTo(5 - 0.1, 10);
    });

    it('x402 kapalıysa reddedilir, onay akışına da düşmez', () => {
      const decision = engine.evaluateX402Payment(0.1, settings({ enabled: false }), 0);
      expect(decision.allowed).toBe(false);
      expect(decision.requiresConfirmation).toBe(false);
      expect(decision.reasonCode).toBe('x402_disabled');
    });

    it('geçersiz (negatif/0/NaN) tutar reddedilir', () => {
      expect(engine.evaluateX402Payment(0, settings(), 0).reasonCode).toBe('x402_invalid_amount');
      expect(engine.evaluateX402Payment(-1, settings(), 0).reasonCode).toBe('x402_invalid_amount');
      expect(engine.evaluateX402Payment(Number.NaN, settings(), 0).reasonCode).toBe('x402_invalid_amount');
    });

    it('kullanıcının işlem-başı tavanını aşan ödeme reddedilmez ama onay ister (ConfirmationCard akışına düşer)', () => {
      const decision = engine.evaluateX402Payment(0.6, settings({ perTransactionCapUsd: 0.5 }), 0);
      expect(decision.allowed).toBe(true);
      expect(decision.requiresConfirmation).toBe(true);
      expect(decision.reasonCode).toBe('x402_requires_confirmation');
    });

    it('günlük bütçe tükenmişse (tavan altında olsa bile) onay ister', () => {
      // perTransactionCapUsd 0.5 — tek başına tutar bu tavanın altında, ama bugün zaten
      // 4.95 harcanmış, kalan bütçe 0.05 — 0.1'lik ödeme bunu aşıyor.
      const decision = engine.evaluateX402Payment(0.1, settings({ dailyBudgetCapUsd: 5 }), 4.95);
      expect(decision.allowed).toBe(true);
      expect(decision.requiresConfirmation).toBe(true);
      expect(decision.reasonCode).toBe('x402_requires_confirmation');
    });

    it('tam olarak kalan bütçeye eşit ödeme otomatik ödenir (sınır durumu, kapsayıcı)', () => {
      const decision = engine.evaluateX402Payment(0.05, settings({ dailyBudgetCapUsd: 5 }), 4.95);
      expect(decision.requiresConfirmation).toBe(false);
      expect(decision.remainingBudgetUsd).toBeCloseTo(0, 10);
    });

    // ─── Mutlak tavan: defense-in-depth ────────────────────────────
    describe('mutlak tavan — settings clamp bypass edilse bile', () => {
      it('X402SettingsService.getSettings kırpılmamış (mutlak tavanın üstünde) bir değer dönse bile evaluateX402Payment otomatik ödemeye asla izin vermez', async () => {
        // X402SettingsService normalde Math.min ile clamp eder (bkz. X402SettingsService.ts) —
        // burada o servisi mock'layarak, sanki bir bug ya da storage'a doğrudan yazan başka bir
        // kod yolu bu clamp'i atlamış gibi, kasıtlı olarak mutlak tavanın ÇOK üzerinde bir
        // değer döndürüyoruz. evaluateX402Payment kendi içinde İKİNCİ bir clamp uygulamalı.
        vi.mocked(X402SettingsService.getSettings).mockResolvedValueOnce({
          enabled: true,
          perTransactionCapUsd: X402_ABSOLUTE_CAPS.maxPerTransactionUsd * 1000,
          dailyBudgetCapUsd: X402_ABSOLUTE_CAPS.maxDailyBudgetUsd * 1000,
        });

        const bypassedSettings = await X402SettingsService.getSettings();
        // Sanity check: mock gerçekten mutlak tavanın üstünde bir değer döndürdü — yoksa test
        // yanlışlıkla hiçbir şey kanıtlamadan geçer.
        expect(bypassedSettings.perTransactionCapUsd).toBeGreaterThan(X402_ABSOLUTE_CAPS.maxPerTransactionUsd);

        // Mutlak tavanın (çok) üzerinde bir ödeme — settings buna izin veriyormuş gibi görünse de.
        const overCapAmount = X402_ABSOLUTE_CAPS.maxPerTransactionUsd + 10;
        const decision = engine.evaluateX402Payment(overCapAmount, bypassedSettings, 0);

        expect(decision.requiresConfirmation).toBe(true);
        expect(decision.allowed).toBe(true); // reddedilmiyor — ConfirmationCard'a düşüyor, otomatik ödenmiyor
        expect(decision.reasonCode).toBe('x402_requires_confirmation');
      });

      it('mutlak tavanın hemen altındaki bir ödeme, settings kırpılmamış olsa bile otomatik ödenir — clamp doğru sınırda çalışıyor', async () => {
        vi.mocked(X402SettingsService.getSettings).mockResolvedValueOnce({
          enabled: true,
          perTransactionCapUsd: X402_ABSOLUTE_CAPS.maxPerTransactionUsd * 1000,
          dailyBudgetCapUsd: X402_ABSOLUTE_CAPS.maxDailyBudgetUsd * 1000,
        });
        const bypassedSettings = await X402SettingsService.getSettings();

        const justUnderCap = X402_ABSOLUTE_CAPS.maxPerTransactionUsd - 0.01;
        const decision = engine.evaluateX402Payment(justUnderCap, bypassedSettings, 0);

        expect(decision.requiresConfirmation).toBe(false);
        expect(decision.reasonCode).toBe('x402_auto_paid');
      });

      it('günlük bütçe için de aynı defense-in-depth geçerli: kırpılmamış dailyBudgetCapUsd, mutlak günlük tavanın üzerinde otomatik ödemeye izin vermez', async () => {
        vi.mocked(X402SettingsService.getSettings).mockResolvedValueOnce({
          enabled: true,
          perTransactionCapUsd: X402_ABSOLUTE_CAPS.maxPerTransactionUsd, // tek başına tavan sorunu yok
          dailyBudgetCapUsd: X402_ABSOLUTE_CAPS.maxDailyBudgetUsd * 1000, // ama günlük bütçe kırpılmamış
        });
        const bypassedSettings = await X402SettingsService.getSettings();

        // Bugün zaten mutlak günlük tavan kadar harcanmış olsun — gerçek (clamp'lenmiş) bütçe
        // tükenmiş demektir, ama kırpılmamış dailyBudgetCapUsd'ye göre hâlâ "bolca bütçe var" gibi görünür.
        const spentToday = X402_ABSOLUTE_CAPS.maxDailyBudgetUsd;
        const decision = engine.evaluateX402Payment(0.01, bypassedSettings, spentToday);

        expect(decision.requiresConfirmation).toBe(true);
        expect(decision.reasonCode).toBe('x402_requires_confirmation');
      });
    });
  });
});
