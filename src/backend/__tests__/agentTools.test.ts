/// <reference types="vitest/globals" />
import { AGENT_TOOLS } from '../agentTools';
import { READ_ONLY_TOOLS, PROPOSAL_TOOLS, X402_TOOLS } from '../AgentPolicyEngine';

/**
 * @vitest-environment node
 *
 * agentTools testleri
 *
 * Her tool tanımının OpenAI function-calling formatına uygun geçerli bir JSON şeması
 * olduğunu ve AgentPolicyEngine'in READ_ONLY_TOOLS + PROPOSAL_TOOLS + X402_TOOLS setleriyle
 * birebir eşleştiğini doğrular. Ağ/RPC çağrısı yapılmaz.
 */
describe('agentTools', () => {
  it('AGENT_TOOLS boş değildir', () => {
    expect(AGENT_TOOLS.length).toBeGreaterThan(0);
  });

  it('4 read-only + 3 proposal + 1 x402 tool tanımlıdır', () => {
    expect(AGENT_TOOLS).toHaveLength(8);
  });

  describe('her tool geçerli bir OpenAI function-calling şemasına sahiptir', () => {
    for (const tool of [
      'get_balance',
      'get_shielded_balance',
      'get_shielded_portfolio',
      'get_pending_claims',
      'propose_send',
      'propose_shield',
      'propose_unshield',
      'pay_for_resource',
    ] as const) {
      it(`${tool} tanımlıdır ve şeması geçerlidir`, () => {
        const def = AGENT_TOOLS.find((t) => t.function.name === tool);
        expect(def).toBeDefined();
        if (!def) return;

        expect(def.type).toBe('function');
        expect(typeof def.function.name).toBe('string');
        expect(def.function.name.length).toBeGreaterThan(0);

        // description modelin tool'u ne zaman/nasıl kullanacağını anlaması için yeterince
        // dolu olmalı — boş veya tek kelimelik bir açıklama pratikte işe yaramaz.
        expect(typeof def.function.description).toBe('string');
        expect(def.function.description.length).toBeGreaterThan(20);

        const params = def.function.parameters;
        expect(params.type).toBe('object');
        expect(typeof params.properties).toBe('object');
        expect(Array.isArray(params.required)).toBe(true);
        expect(params.additionalProperties).toBe(false);

        // required listesindeki her isim properties içinde de tanımlı olmalı.
        for (const requiredProp of params.required) {
          expect(params.properties).toHaveProperty(requiredProp);
        }

        // Her property'nin geçerli bir JSON Schema tipi ve açıklaması olmalı.
        for (const [, schema] of Object.entries(params.properties)) {
          expect(['string', 'number', 'boolean']).toContain(schema.type);
          expect(typeof schema.description).toBe('string');
          expect(schema.description.length).toBeGreaterThan(0);
        }
      });
    }
  });

  // ─── AgentPolicyEngine ile isim tutarlılığı ───────────────────
  describe('READ_ONLY_TOOLS / PROPOSAL_TOOLS / X402_TOOLS ile birebir eşleşme', () => {
    it('her AGENT_TOOLS ismi READ_ONLY_TOOLS, PROPOSAL_TOOLS veya X402_TOOLS içinde bulunur', () => {
      const allowed = new Set<string>([...READ_ONLY_TOOLS, ...PROPOSAL_TOOLS, ...X402_TOOLS]);
      for (const tool of AGENT_TOOLS) {
        expect(allowed.has(tool.function.name)).toBe(true);
      }
    });

    it('PROPOSAL_TOOLS içindeki her isim için bir AGENT_TOOLS tanımı vardır', () => {
      const names = new Set(AGENT_TOOLS.map((t) => t.function.name));
      for (const tool of PROPOSAL_TOOLS) {
        expect(names.has(tool)).toBe(true);
      }
    });

    /**
     * Yapısal kilit — pay_for_resource'un AGENT_TOOLS'ta hiç tanımlı olmadığı (Chrome'da elle
     * test sırasında bulunan gerçek bug, bkz. CONTEXT.md bölüm 14) bir daha sessizce
     * yaşanmasın diye: AgentOrchestrator'daki CONFIRMABLE_TOOLS ile birebir aynı küme
     * (PROPOSAL_TOOLS ∪ X402_TOOLS, CONFIRMABLE_TOOLS'un kendi tanımı) — model bu isimlerden
     * birini hiç göremiyorsa asla çağıramaz, tool_call sonucu geldiğinde döngüyü kırma kararı
     * (isAwaitingConfirmation) hiçbir zaman devreye girmez. Bu test AgentPolicyEngine'e yeni
     * bir X402_TOOLS/PROPOSAL_TOOLS üyesi eklenip agentTools.ts'e eklenmesi unutulursa kırmızı
     * olur — tool eklendiğinde AGENT_TOOLS'a eklenmeyi ELLE hatırlamaya güvenmek yerine.
     */
    it('X402_TOOLS içindeki her isim için bir AGENT_TOOLS tanımı vardır (CONFIRMABLE_TOOLS kilidi)', () => {
      const names = new Set(AGENT_TOOLS.map((t) => t.function.name));
      for (const tool of X402_TOOLS) {
        expect(names.has(tool)).toBe(true);
      }
    });

    it('AGENT_TOOLS içindeki isimler benzersizdir (tekrar yok)', () => {
      const names = AGENT_TOOLS.map((t) => t.function.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('get_shielded_balance ve get_pending_claims tokenSymbol parametresi barındırır', () => {
      const shieldedBalance = AGENT_TOOLS.find((t) => t.function.name === 'get_shielded_balance');
      const pendingClaims = AGENT_TOOLS.find((t) => t.function.name === 'get_pending_claims');

      expect(shieldedBalance?.function.parameters.properties.tokenSymbol).toBeDefined();
      expect(shieldedBalance?.function.parameters.required).toContain('tokenSymbol');

      expect(pendingClaims?.function.parameters.properties.tokenSymbol).toBeDefined();
      // get_pending_claims için tokenSymbol opsiyoneldir: belirtilmezse tüm tokenlar taranır.
      expect(pendingClaims?.function.parameters.required).not.toContain('tokenSymbol');
    });
  });

  // ─── propose_* tool'lara özgü davranışlar ─────────────────────
  describe('proposal tool şemaları', () => {
    it('propose_send: to ve amount zorunlu, tokenSymbol opsiyoneldir', () => {
      const def = AGENT_TOOLS.find((t) => t.function.name === 'propose_send');
      expect(def?.function.parameters.required).toEqual(expect.arrayContaining(['to', 'amount']));
      expect(def?.function.parameters.required).not.toContain('tokenSymbol');
      expect(def?.function.parameters.properties.tokenSymbol).toBeDefined();
    });

    it('propose_shield: amount ve tokenSymbol zorunludur, rate kırpma uyarısını içerir', () => {
      const def = AGENT_TOOLS.find((t) => t.function.name === 'propose_shield');
      expect(def?.function.parameters.required).toEqual(expect.arrayContaining(['amount', 'tokenSymbol']));
      expect(def?.function.description).toMatch(/KIRPILIR/);
    });

    it('propose_unshield: amount ve tokenSymbol zorunludur, iki aşamalı süreç uyarısını içerir', () => {
      const def = AGENT_TOOLS.find((t) => t.function.name === 'propose_unshield');
      expect(def?.function.parameters.required).toEqual(expect.arrayContaining(['amount', 'tokenSymbol']));
      expect(def?.function.description).toContain('İKİ AYRI zincir işlemi');
      expect(def?.function.description.toLowerCase()).toContain('claim');
    });

    it('hiçbir proposal tool açıklaması işlemi kendisinin gönderdiğini iddia etmez', () => {
      for (const name of ['propose_send', 'propose_shield', 'propose_unshield'] as const) {
        const def = AGENT_TOOLS.find((t) => t.function.name === name);
        expect(def?.function.description).toMatch(/önizleme|ÖNERİ/);
      }
    });
  });

  // ─── JSON serileştirilebilirlik ───────────────────────────────
  it('tüm tanımlar JSON.stringify ile sorunsuz serileştirilir (OpenRouter isteğine konabilir)', () => {
    expect(() => JSON.stringify(AGENT_TOOLS)).not.toThrow();
    const roundTripped = JSON.parse(JSON.stringify(AGENT_TOOLS));
    expect(roundTripped).toHaveLength(AGENT_TOOLS.length);
  });
});
