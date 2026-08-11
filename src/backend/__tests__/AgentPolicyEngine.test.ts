/// <reference types="vitest/globals" />
import {
  AgentPolicyEngine,
  READ_ONLY_TOOLS,
  PROPOSAL_TOOLS,
  FORBIDDEN_TOOLS,
} from '../AgentPolicyEngine';

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
      const decision = engine.evaluate('send_transaction', { amount: 60 }, { balance: 100 });
      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe('exceeds_balance_ratio');
    });

    it('bakiyenin %50si veya altındaki öneriye izin verilir (onay gerektirir)', () => {
      const decision = engine.evaluate('send_transaction', { amount: 50 }, { balance: 100 });
      expect(decision.allowed).toBe(true);
      expect(decision.requiresConfirmation).toBe(true);
      expect(decision.reasonCode).toBe('allowed_proposal');
    });

    it('config ile maxProposalRatio değiştirilebilir', () => {
      const strictEngine = new AgentPolicyEngine({ maxProposalRatio: 0.1 });
      const decision = strictEngine.evaluate('send_transaction', { amount: 20 }, { balance: 100 });
      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe('exceeds_balance_ratio');
    });
  });

  // ─── evaluate: session proposal cap ──────────────────────────
  describe('evaluate — maxProposalsPerSession', () => {
    it('varsayılan limit (10) aşıldığında yeni öneriler reddedilir', () => {
      const limitedEngine = new AgentPolicyEngine({ maxProposalRatio: 1 });
      for (let i = 0; i < 10; i++) {
        const decision = limitedEngine.evaluate('send_transaction', { amount: 1 }, { balance: 100 });
        expect(decision.allowed).toBe(true);
      }
      const eleventh = limitedEngine.evaluate('send_transaction', { amount: 1 }, { balance: 100 });
      expect(eleventh.allowed).toBe(false);
      expect(eleventh.reasonCode).toBe('session_proposal_limit_reached');
    });

    it('resetSession sayaç sıfırlar', () => {
      const limitedEngine = new AgentPolicyEngine({ maxProposalRatio: 1, maxProposalsPerSession: 1 });
      expect(limitedEngine.evaluate('send_transaction', { amount: 1 }, { balance: 100 }).allowed).toBe(true);
      expect(limitedEngine.evaluate('send_transaction', { amount: 1 }, { balance: 100 }).allowed).toBe(false);
      limitedEngine.resetSession();
      expect(limitedEngine.evaluate('send_transaction', { amount: 1 }, { balance: 100 }).allowed).toBe(true);
    });

    it('reddedilen öneriler sayaca dahil edilmez', () => {
      const strictEngine = new AgentPolicyEngine({ maxProposalRatio: 0.1 });
      strictEngine.evaluate('send_transaction', { amount: 90 }, { balance: 100 }); // reddedilir
      expect(strictEngine.getProposalCount()).toBe(0);
    });
  });
});
