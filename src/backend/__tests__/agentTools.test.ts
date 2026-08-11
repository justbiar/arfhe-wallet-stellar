/// <reference types="vitest/globals" />
import { AGENT_TOOLS } from '../agentTools';
import { READ_ONLY_TOOLS } from '../AgentPolicyEngine';

/**
 * @vitest-environment node
 *
 * agentTools testleri
 *
 * Her tool tanımının OpenAI function-calling formatına uygun geçerli bir JSON şeması
 * olduğunu ve AgentPolicyEngine'in READ_ONLY_TOOLS set'iyle birebir eşleştiğini doğrular.
 * Ağ/RPC çağrısı yapılmaz.
 */
describe('agentTools', () => {
  it('AGENT_TOOLS boş değildir', () => {
    expect(AGENT_TOOLS.length).toBeGreaterThan(0);
  });

  it('4 read-only tool tanımlıdır', () => {
    expect(AGENT_TOOLS).toHaveLength(4);
  });

  describe('her tool geçerli bir OpenAI function-calling şemasına sahiptir', () => {
    for (const tool of [
      'get_balance',
      'get_shielded_balance',
      'get_shielded_portfolio',
      'get_pending_claims',
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
  describe('READ_ONLY_TOOLS ile birebir eşleşme', () => {
    it('her AGENT_TOOLS ismi READ_ONLY_TOOLS içinde bulunur', () => {
      for (const tool of AGENT_TOOLS) {
        expect(READ_ONLY_TOOLS).toContain(tool.function.name);
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

  // ─── JSON serileştirilebilirlik ───────────────────────────────
  it('tüm tanımlar JSON.stringify ile sorunsuz serileştirilir (OpenRouter isteğine konabilir)', () => {
    expect(() => JSON.stringify(AGENT_TOOLS)).not.toThrow();
    const roundTripped = JSON.parse(JSON.stringify(AGENT_TOOLS));
    expect(roundTripped).toHaveLength(AGENT_TOOLS.length);
  });
});
