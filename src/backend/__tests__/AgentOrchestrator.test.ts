/// <reference types="vitest/globals" />
import { runAgentTurn, buildSystemPrompt, configureAgentOrchestrator, type ChatMessage } from '../AgentOrchestrator';
import { executeToolCall } from '../AgentToolRunner';

/**
 * @vitest-environment node
 *
 * AgentOrchestrator testleri
 *
 * Backend proxy fetch ile mock'lanır (Network.callBatch testlerindeki stubFetch pattern'i
 * kullanılır), AgentToolRunner.executeToolCall vi.mock ile taklit edilir. Gerçek ağ/RPC/AI
 * çağrısı yapılmaz. Tek turlu cevap, çok turlu tool-calling akışı, max tur limiti ve proxy
 * hata senaryoları test edilir.
 */

vi.mock('../AgentToolRunner.js', () => ({
  executeToolCall: vi.fn(),
}));

const context = { account: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', networkId: '11155111' };

function proxyResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function assistantChoice(message: Record<string, unknown>) {
  return { choices: [{ message: { role: 'assistant', ...message } }] };
}

describe('AgentOrchestrator', () => {
  beforeEach(() => {
    configureAgentOrchestrator({ proxyBaseUrl: 'https://proxy.example.test' });
    vi.mocked(executeToolCall).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ─── buildSystemPrompt ──────────────────────────────────────────
  describe('buildSystemPrompt', () => {
    it('kendini Arfio olarak tanıtır', () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain('Arfio');
    });

    it('işlem imzalama yetkisi olmadığını belirtir', () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain('imzalama');
      expect(prompt).toMatch(/yetki.*YOK/i);
    });

    it('unshield işleminin iki aşamalı olduğunu belirtir', () => {
      const prompt = buildSystemPrompt();
      expect(prompt.toLowerCase()).toContain('unshield');
      expect(prompt).toContain('claim');
      expect(prompt).toContain('İKİ AŞAMALIDIR');
    });

    it('FHE terminolojisini (shield/confidential transfer/tutamaç) içerir', () => {
      const prompt = buildSystemPrompt();
      expect(prompt.toLowerCase()).toContain('shield');
      expect(prompt.toLowerCase()).toContain('confidential transfer');
      expect(prompt).toContain('tutamaç');
    });
  });

  // ─── Tek turlu basit cevap ───────────────────────────────────────
  describe('tek turlu akış', () => {
    it('tool_calls yoksa modelin cevabını doğrudan döner', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(proxyResponse(200, assistantChoice({ content: 'Merhaba! Nasıl yardımcı olabilirim?' })));
      vi.stubGlobal('fetch', fetchSpy);

      const res = await runAgentTurn('Merhaba', [], context);

      expect(res.reply).toBe('Merhaba! Nasıl yardımcı olabilirim?');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(executeToolCall).not.toHaveBeenCalled();

      // updatedHistory: user + assistant, sistem promptu dahil edilmemeli
      expect(res.updatedHistory).toHaveLength(2);
      expect(res.updatedHistory[0]).toEqual({ role: 'user', content: 'Merhaba' });
      expect(res.updatedHistory[1].role).toBe('assistant');
      expect(res.updatedHistory[1].content).toBe('Merhaba! Nasıl yardımcı olabilirim?');
    });

    it('proxy isteği system + geçmiş + yeni mesajı doğru sırayla gönderir', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(proxyResponse(200, assistantChoice({ content: 'ok' })));
      vi.stubGlobal('fetch', fetchSpy);

      const history: ChatMessage[] = [
        { role: 'user', content: 'önceki soru' },
        { role: 'assistant', content: 'önceki cevap' },
      ];
      await runAgentTurn('yeni soru', history, context);

      const [, init] = fetchSpy.mock.calls[0];
      const sentBody = JSON.parse(init.body);
      expect(sentBody.messages[0].role).toBe('system');
      expect(sentBody.messages[1]).toEqual(history[0]);
      expect(sentBody.messages[2]).toEqual(history[1]);
      expect(sentBody.messages[3]).toEqual({ role: 'user', content: 'yeni soru' });
      expect(Array.isArray(sentBody.tools)).toBe(true);
      expect(sentBody.tools.length).toBeGreaterThan(0);
    });
  });

  // ─── Çok turlu tool-calling akışı ─────────────────────────────────
  describe('tool-calling akışı', () => {
    it('tool_call çalıştırılır, sonuç modele geri gönderilir, nihai cevap dönülür', async () => {
      const toolCallResponse = proxyResponse(
        200,
        assistantChoice({
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_balance', arguments: '{}' } }],
        })
      );
      const finalResponse = proxyResponse(200, assistantChoice({ content: 'Bakiyeniz 1 ETH.' }));

      const fetchSpy = vi.fn().mockResolvedValueOnce(toolCallResponse).mockResolvedValueOnce(finalResponse);
      vi.stubGlobal('fetch', fetchSpy);
      vi.mocked(executeToolCall).mockResolvedValueOnce({ result: { address: context.account, balanceWei: '1000000000000000000' } });

      const res = await runAgentTurn('bakiyem ne kadar', [], context);

      expect(res.reply).toBe('Bakiyeniz 1 ETH.');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(executeToolCall).toHaveBeenCalledWith('get_balance', {}, context);

      // İkinci proxy isteği, tool sonucunu role:"tool" mesajı olarak içermeli
      const [, secondInit] = fetchSpy.mock.calls[1];
      const secondBody = JSON.parse(secondInit.body);
      const toolMessage = secondBody.messages.find((m: ChatMessage) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(toolMessage.tool_call_id).toBe('call_1');
      expect(JSON.parse(toolMessage.content)).toEqual({ result: { address: context.account, balanceWei: '1000000000000000000' } });

      // updatedHistory: user, assistant(tool_calls), tool, assistant(final)
      expect(res.updatedHistory).toHaveLength(4);
      expect(res.updatedHistory[1].tool_calls).toBeDefined();
      expect(res.updatedHistory[2].role).toBe('tool');
      expect(res.updatedHistory[3].content).toBe('Bakiyeniz 1 ETH.');
    });

    it('AgentToolRunner {error} dönerse bunu tool mesajı içinde modele iletir, throw etmez', async () => {
      const toolCallResponse = proxyResponse(
        200,
        assistantChoice({
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_shielded_balance', arguments: '{}' } }],
        })
      );
      const finalResponse = proxyResponse(200, assistantChoice({ content: 'tokenSymbol belirtmelisiniz.' }));

      const fetchSpy = vi.fn().mockResolvedValueOnce(toolCallResponse).mockResolvedValueOnce(finalResponse);
      vi.stubGlobal('fetch', fetchSpy);
      vi.mocked(executeToolCall).mockResolvedValueOnce({ error: '"tokenSymbol" parametresi zorunludur.' });

      const res = await runAgentTurn('gizli bakiyem ne kadar', [], context);

      expect(res.reply).toBe('tokenSymbol belirtmelisiniz.');
      const [, secondInit] = fetchSpy.mock.calls[1];
      const toolMessage = JSON.parse(secondInit.body).messages.find((m: ChatMessage) => m.role === 'tool');
      expect(JSON.parse(toolMessage.content)).toEqual({ error: '"tokenSymbol" parametresi zorunludur.' });
    });
  });

  // ─── Max tur limiti ────────────────────────────────────────────
  describe('max tur limiti', () => {
    it('5 turdan fazla tool_calls dönerse güvenli bir mesajla durur, sonsuz döngüye girmez', async () => {
      const alwaysToolCall = proxyResponse(
        200,
        assistantChoice({
          content: '',
          tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'get_balance', arguments: '{}' } }],
        })
      );
      const fetchSpy = vi.fn().mockResolvedValue(alwaysToolCall);
      vi.stubGlobal('fetch', fetchSpy);
      vi.mocked(executeToolCall).mockResolvedValue({ result: { balanceWei: '0' } });

      const res = await runAgentTurn('sürekli tool çağır', [], context);

      expect(res.reply).toMatch(/tamamlayamadım/i);
      expect(fetchSpy).toHaveBeenCalledTimes(5);
    });
  });

  // ─── Proxy hata senaryoları ────────────────────────────────────
  describe('proxy hataları', () => {
    it('429 rate limit hatasında anlaşılır Türkçe mesaj döner, teknik detay sızdırmaz', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(proxyResponse(429, { error: 'Rate limit exceeded. Try again shortly.' }));
      vi.stubGlobal('fetch', fetchSpy);

      const res = await runAgentTurn('merhaba', [], context);

      expect(res.reply).not.toContain('Rate limit exceeded');
      expect(res.reply.length).toBeGreaterThan(0);
      expect(res.reply).toMatch(/çok fazla istek|bekleyip/i);
    });

    it('502/503 (tüm modeller tükendi) durumunda anlaşılır mesaj döner', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        proxyResponse(503, { error: 'All models in the fallback chain are currently rate limited.', attemptedModels: ['a', 'b'] })
      );
      vi.stubGlobal('fetch', fetchSpy);

      const res = await runAgentTurn('merhaba', [], context);

      expect(res.reply).not.toContain('attemptedModels');
      expect(res.reply).not.toContain('fallback chain');
      expect(res.reply.length).toBeGreaterThan(0);
    });

    it('fetch network hatası fırlatırsa (proxy erişilemez) anlaşılır mesaj döner, throw etmez', async () => {
      const fetchSpy = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      vi.stubGlobal('fetch', fetchSpy);

      const result = await runAgentTurn('merhaba', [], context);
      expect(result.reply.length).toBeGreaterThan(0);
      expect(result.reply).not.toContain('Failed to fetch');
    });

    it('proxyBaseUrl yapılandırılmamışsa fetch hiç çağrılmadan güvenli mesaj döner', async () => {
      configureAgentOrchestrator({ proxyBaseUrl: '' });
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const res = await runAgentTurn('merhaba', [], context);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(res.reply.length).toBeGreaterThan(0);
    });
  });
});
