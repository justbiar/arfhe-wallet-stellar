/// <reference types="vitest/globals" />
import { runAgentTurn, buildSystemPrompt, configureAgentOrchestrator, type ChatMessage } from '../AgentOrchestrator';
import { executeToolCall } from '../AgentToolRunner';
import { findLeakedInternalReference } from '../internalLeakGuard';

/**
 * @vitest-environment node
 *
 * AgentOrchestrator testleri
 *
 * Backend proxy fetch ile mock'lanır (Network.callBatch testlerindeki stubFetch pattern'i
 * kullanılır), AgentToolRunner.executeToolCall vi.mock ile taklit edilir. Gerçek ağ/RPC/AI
 * çağrısı yapılmaz. Tek turlu cevap, çok turlu tool-calling akışı, max tur limiti, proxy
 * hata senaryoları ve RAG bağlam enjeksiyonu test edilir.
 *
 * runAgentTurn her kullanıcı turunda /agent/retrieve-context'e bir kez, /agent/chat'e ise
 * tool-calling döngüsündeki her round-trip için bir kez istek atar — bu yüzden fetch mock'u
 * URL'e göre yönlendirilir (stubFetchRouter), sabit bir çağrı sayısı varsaymaz.
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

/**
 * Routes /agent/retrieve-context to a default "no context" response (overridable via
 * `contextResponse`) and /agent/chat calls to the provided queue, in order. Keeps the
 * existing chat-flow tests oblivious to the extra retrieval round-trip.
 */
function stubFetchRouter(
  chatResponses: unknown[],
  options: { contextResponse?: unknown } = {}
) {
  const queue = [...chatResponses];
  const fetchSpy = vi.fn(async (url: string) => {
    if (String(url).includes('/agent/retrieve-context')) {
      return options.contextResponse ?? proxyResponse(200, { chunks: [] });
    }
    const next = queue.shift();
    if (!next) throw new Error('stubFetchRouter: unexpected extra /agent/chat call');
    return next;
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function chatCalls(fetchSpy: ReturnType<typeof vi.fn>) {
  return fetchSpy.mock.calls.filter(([url]) => String(url).includes('/agent/chat'));
}

function contextCalls(fetchSpy: ReturnType<typeof vi.fn>) {
  return fetchSpy.mock.calls.filter(([url]) => String(url).includes('/agent/retrieve-context'));
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
      expect(prompt).toContain('imzalayamaz');
    });

    it('propose_* araçlarının gerçek işlem yapmadığını ve requiresConfirmation sonrası durması gerektiğini belirtir', () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain('propose_send');
      expect(prompt).toContain('requiresConfirmation');
      expect(prompt).toMatch(/HİÇBİR ZAMAN gerçek bir işlem yapmaz/);
      expect(prompt).toMatch(/DUR\./);
    });

    it('gerçek sonuç gelmeden "işlem gönderildi/tamamlandı" dememesi ve tx hash uydurmaması gerektiğini belirtir', () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toMatch(/ASLA.*tx hash.*uydurma|uydurman.*yanlış/i);
      expect(prompt).toContain('Kullanıcı HENÜZ onaylamadı');
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

    it('dil kuralını hem başta hem sonda tekrarlar (otomatik devam turlarında sapma riskine karşı)', () => {
      const prompt = buildSystemPrompt();
      const lines = prompt.split('\n');
      const languageLines = lines.filter((l) => /DİL:|SON HATIRLATMA/.test(l));
      expect(languageLines.length).toBeGreaterThanOrEqual(2);
      // "başta" — ilk birkaç satır içinde; "sonda" — son birkaç satır içinde.
      expect(lines.slice(0, 5).some((l) => l.includes('DİL:'))).toBe(true);
      expect(lines.slice(-3).some((l) => l.includes('SON HATIRLATMA'))).toBe(true);
    });
  });

  // ─── Tek turlu basit cevap ───────────────────────────────────────
  describe('tek turlu akış', () => {
    it('tool_calls yoksa modelin cevabını doğrudan döner', async () => {
      const fetchSpy = stubFetchRouter([
        proxyResponse(200, assistantChoice({ content: 'Merhaba! Nasıl yardımcı olabilirim?' })),
      ]);

      const res = await runAgentTurn('Merhaba', [], context);

      expect(res.reply).toBe('Merhaba! Nasıl yardımcı olabilirim?');
      expect(chatCalls(fetchSpy)).toHaveLength(1);
      expect(executeToolCall).not.toHaveBeenCalled();

      // updatedHistory: user + assistant, sistem promptu dahil edilmemeli
      expect(res.updatedHistory).toHaveLength(2);
      expect(res.updatedHistory[0]).toEqual({ role: 'user', content: 'Merhaba' });
      expect(res.updatedHistory[1].role).toBe('assistant');
      expect(res.updatedHistory[1].content).toBe('Merhaba! Nasıl yardımcı olabilirim?');
    });

    it('proxy isteği system + geçmiş + yeni mesajı doğru sırayla gönderir (context yoksa)', async () => {
      const fetchSpy = stubFetchRouter([proxyResponse(200, assistantChoice({ content: 'ok' }))]);

      const history: ChatMessage[] = [
        { role: 'user', content: 'önceki soru' },
        { role: 'assistant', content: 'önceki cevap' },
      ];
      await runAgentTurn('yeni soru', history, context);

      const [, init] = chatCalls(fetchSpy)[0];
      const sentBody = JSON.parse(init.body);
      expect(sentBody.messages[0].role).toBe('system');
      expect(sentBody.messages[1]).toEqual(history[0]);
      expect(sentBody.messages[2]).toEqual(history[1]);
      expect(sentBody.messages[3]).toEqual({ role: 'user', content: 'yeni soru' });
      expect(Array.isArray(sentBody.tools)).toBe(true);
      expect(sentBody.tools.length).toBeGreaterThan(0);
    });
  });

  // ─── İç kod detayı sızıntısı (regresyon) ────────────────────────
  describe('iç kod detayı sızıntısı', () => {
    it('buildSystemPrompt gündelik dil kuralını ve kötü/iyi örnek çiftini içerir', () => {
      const prompt = buildSystemPrompt();
      const lower = prompt.toLocaleLowerCase('tr');
      expect(lower).toMatch(/gündelik|insan diliyle/);
      expect(prompt).toContain('propose_send');
      expect(lower).toContain('kötü');
      expect(lower).toContain('iyi');
    });

    it('proxy dönen cevap iç kod referansı sızdırırsa console.warn ile loglanır, cevap yine de kullanıcıya iletilir', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const leakedReply = 'propose_send aracını çağırıyorum. Ancak önce hedef adresi belirtmeniz gerekiyor.';
      stubFetchRouter([
        {
          ok: true,
          status: 200,
          json: async () => ({
            model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
            ...assistantChoice({ content: leakedReply }),
          }),
        },
      ]);

      const res = await runAgentTurn('eth göndermek istiyorum', [], context);

      expect(res.reply).toBe(leakedReply);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('propose_send'),
        leakedReply
      );
      expect(warnSpy.mock.calls[0][0]).toContain('nvidia/nemotron-3-ultra-550b-a55b:free');
    });

    it('temiz bir cevapta console.warn hiç çağrılmaz', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stubFetchRouter([
        proxyResponse(200, assistantChoice({ content: 'ETH göndermek için hedef adresi lazım, nereye göndermek istiyorsun?' })),
      ]);

      await runAgentTurn('eth göndermek istiyorum', [], context);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('bilinen tüm tool isimleri ve mekanik kalıplar temiz bir cevapta geçmez (sanity)', () => {
      const cleanReplies = [
        'Bakiyeniz 1 ETH.',
        'ETH göndermek için önce hedef adresi öğrenmem gerekiyor, nereye göndermek istiyorsun?',
        'Bekleyen bir talebiniz görünmüyor.',
        'Shield işlemini hazırladım, onayınızı bekliyorum.',
      ];
      for (const reply of cleanReplies) {
        expect(findLeakedInternalReference(reply)).toBeNull();
      }
    });
  });

  // ─── RAG bağlam enjeksiyonu ────────────────────────────────────
  describe('RAG bağlam enjeksiyonu', () => {
    it('retrieve-context chunk döndürürse, ekstra bir system mesajı olarak proxy isteğine eklenir', async () => {
      const fetchSpy = stubFetchRouter(
        [proxyResponse(200, assistantChoice({ content: 'unshield iki aşamalıdır.' }))],
        {
          contextResponse: proxyResponse(200, {
            chunks: [
              { title: 'Genel mimari ve unshield neden iki aşamalı', text: 'unshield iki adımdan oluşur...', score: 0.61 },
            ],
          }),
        }
      );

      const history: ChatMessage[] = [];
      await runAgentTurn('unshield nasıl çalışır', history, context);

      // /agent/retrieve-context tam olarak bir kez, kullanıcı mesajıyla çağrılmalı
      const ctxCalls = contextCalls(fetchSpy);
      expect(ctxCalls).toHaveLength(1);
      const [, ctxInit] = ctxCalls[0];
      expect(JSON.parse(ctxInit.body)).toEqual({ query: 'unshield nasıl çalışır' });

      // Proxy'ye giden mesajlarda: system (kimlik) + system (bağlam) + user
      const [, chatInit] = chatCalls(fetchSpy)[0];
      const sentBody = JSON.parse(chatInit.body);
      expect(sentBody.messages[0].role).toBe('system');
      expect(sentBody.messages[1].role).toBe('system');
      expect(sentBody.messages[1].content).toContain('Genel mimari ve unshield neden iki aşamalı');
      expect(sentBody.messages[1].content).toContain('unshield iki adımdan oluşur');
      expect(sentBody.messages[2]).toEqual({ role: 'user', content: 'unshield nasıl çalışır' });
    });

    it('retrieve-context boş chunk listesi döndürürse (alakasız sorgu), ekstra system mesajı eklenmez', async () => {
      const fetchSpy = stubFetchRouter([proxyResponse(200, assistantChoice({ content: 'ok' }))], {
        contextResponse: proxyResponse(200, { chunks: [] }),
      });

      await runAgentTurn('bugün hava nasıl', [], context);

      const [, chatInit] = chatCalls(fetchSpy)[0];
      const sentBody = JSON.parse(chatInit.body);
      expect(sentBody.messages[0].role).toBe('system');
      expect(sentBody.messages[1]).toEqual({ role: 'user', content: 'bugün hava nasıl' });
    });

    it('retrieve-context isteği başarısız olursa (5xx), sohbet yine de context olmadan devam eder', async () => {
      const fetchSpy = stubFetchRouter([proxyResponse(200, assistantChoice({ content: 'ok' }))], {
        contextResponse: proxyResponse(500, { error: 'internal' }),
      });

      const res = await runAgentTurn('unshield nasıl çalışır', [], context);

      expect(res.reply).toBe('ok');
      const [, chatInit] = chatCalls(fetchSpy)[0];
      const sentBody = JSON.parse(chatInit.body);
      expect(sentBody.messages[0].role).toBe('system');
      expect(sentBody.messages[1]).toEqual({ role: 'user', content: 'unshield nasıl çalışır' });
    });

    it('retrieve-context isteği network hatası fırlatırsa throw etmez, context olmadan devam eder', async () => {
      const queue = [proxyResponse(200, assistantChoice({ content: 'ok' }))];
      const fetchSpy = vi.fn(async (url: string) => {
        if (String(url).includes('/agent/retrieve-context')) {
          throw new TypeError('Failed to fetch');
        }
        return queue.shift();
      });
      vi.stubGlobal('fetch', fetchSpy);

      const res = await runAgentTurn('unshield nasıl çalışır', [], context);

      expect(res.reply).toBe('ok');
    });

    it('çok turlu tool-calling akışında retrieve-context yalnızca bir kez çağrılır, her round-trip tekrarında değil', async () => {
      const toolCallResponse = proxyResponse(
        200,
        assistantChoice({
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_balance', arguments: '{}' } }],
        })
      );
      const finalResponse = proxyResponse(200, assistantChoice({ content: 'Bakiyeniz 1 ETH.' }));
      const fetchSpy = stubFetchRouter([toolCallResponse, finalResponse]);
      vi.mocked(executeToolCall).mockResolvedValueOnce({ result: { balanceWei: '1000000000000000000' } });

      await runAgentTurn('bakiyem ne kadar', [], context);

      expect(contextCalls(fetchSpy)).toHaveLength(1);
      expect(chatCalls(fetchSpy)).toHaveLength(2);
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

      const fetchSpy = stubFetchRouter([toolCallResponse, finalResponse]);
      vi.mocked(executeToolCall).mockResolvedValueOnce({ result: { address: context.account, balanceWei: '1000000000000000000' } });

      const res = await runAgentTurn('bakiyem ne kadar', [], context);

      expect(res.reply).toBe('Bakiyeniz 1 ETH.');
      expect(chatCalls(fetchSpy)).toHaveLength(2);
      expect(executeToolCall).toHaveBeenCalledWith('get_balance', {}, context);

      // İkinci proxy isteği, tool sonucunu role:"tool" mesajı olarak içermeli
      const [, secondInit] = chatCalls(fetchSpy)[1];
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

      const fetchSpy = stubFetchRouter([toolCallResponse, finalResponse]);
      vi.mocked(executeToolCall).mockResolvedValueOnce({ error: '"tokenSymbol" parametresi zorunludur.' });

      const res = await runAgentTurn('gizli bakiyem ne kadar', [], context);

      expect(res.reply).toBe('tokenSymbol belirtmelisiniz.');
      const [, secondInit] = chatCalls(fetchSpy)[1];
      const toolMessage = JSON.parse(secondInit.body).messages.find((m: ChatMessage) => m.role === 'tool');
      expect(JSON.parse(toolMessage.content)).toEqual({ error: '"tokenSymbol" parametresi zorunludur.' });
    });
  });

  // ─── PROPOSAL_TOOLS sonrası döngü kırılması ─────────────────────
  describe('PROPOSAL_TOOLS onay bekleyen sonuç sonrası döngü kırılması', () => {
    it('propose_send requiresConfirmation:true dönerse ikinci bir /agent/chat isteği ASLA atılmaz', async () => {
      const proposalResponse = proxyResponse(
        200,
        assistantChoice({
          content: 'Tamam, 0.01 ETH gönderme işlemini hazırladım.',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'propose_send', arguments: '{"to":"0xabc","amount":"0.01"}' },
            },
          ],
        })
      );
      // Kuyrukta yalnızca TEK yanıt var — döngü ikinci bir istek atarsa
      // stubFetchRouter "unexpected extra /agent/chat call" fırlatır.
      const fetchSpy = stubFetchRouter([proposalResponse]);
      vi.mocked(executeToolCall).mockResolvedValueOnce({
        result: { requiresConfirmation: true, toolName: 'propose_send', originalArgs: {}, simulation: {} },
      });

      const res = await runAgentTurn('0.01 ETH gönder', [], context);

      expect(chatCalls(fetchSpy)).toHaveLength(1);
      expect(res.reply).toBe('Tamam, 0.01 ETH gönderme işlemini hazırladım.');

      // updatedHistory: user, assistant(tool_calls + özet), tool(requiresConfirmation) —
      // ekstra bir assistant "tamamlandı" mesajı ASLA eklenmemeli.
      expect(res.updatedHistory).toHaveLength(3);
      expect(res.updatedHistory[1].tool_calls).toBeDefined();
      expect(res.updatedHistory[2].role).toBe('tool');
      const toolResult = JSON.parse(res.updatedHistory[2].content);
      expect(toolResult.result.requiresConfirmation).toBe(true);
    });

    it('modelin tool_call ile birlikte özeti yoksa (content boş), boş bir final mesaj eklenir, halüsinasyon metni eklenmez', async () => {
      const proposalResponse = proxyResponse(
        200,
        assistantChoice({
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'propose_send', arguments: '{}' } },
          ],
        })
      );
      const fetchSpy = stubFetchRouter([proposalResponse]);
      vi.mocked(executeToolCall).mockResolvedValueOnce({
        result: { requiresConfirmation: true, toolName: 'propose_send', originalArgs: {}, simulation: {} },
      });

      const res = await runAgentTurn('0.01 ETH gönder', [], context);

      expect(chatCalls(fetchSpy)).toHaveLength(1);
      expect(res.reply).toBe('');
    });

    it('propose_send hata dönerse (requiresConfirmation yok), döngü normal şekilde devam eder', async () => {
      const errorToolCallResponse = proxyResponse(
        200,
        assistantChoice({
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'propose_send', arguments: '{}' } }],
        })
      );
      const finalResponse = proxyResponse(200, assistantChoice({ content: 'Hedef adres eksik, tekrar dener misiniz?' }));
      const fetchSpy = stubFetchRouter([errorToolCallResponse, finalResponse]);
      vi.mocked(executeToolCall).mockResolvedValueOnce({ error: '"to" parametresi zorunludur.' });

      const res = await runAgentTurn('eth gönder', [], context);

      expect(chatCalls(fetchSpy)).toHaveLength(2);
      expect(res.reply).toBe('Hedef adres eksik, tekrar dener misiniz?');
    });

    it('READ_ONLY_TOOLS (ör. get_balance) requiresConfirmation benzeri bir alan dönse bile döngüyü kırmaz', async () => {
      const toolCallResponse = proxyResponse(
        200,
        assistantChoice({
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_balance', arguments: '{}' } }],
        })
      );
      const finalResponse = proxyResponse(200, assistantChoice({ content: 'Bakiyeniz 1 ETH.' }));
      const fetchSpy = stubFetchRouter([toolCallResponse, finalResponse]);
      // get_balance normalde requiresConfirmation döndürmez ama döngü kırma mantığının
      // PROPOSAL_TOOLS listesine göre çalıştığını (alan varlığına göre değil) doğrulamak için.
      vi.mocked(executeToolCall).mockResolvedValueOnce({
        result: { requiresConfirmation: true, balanceWei: '0' },
      });

      const res = await runAgentTurn('bakiyem ne kadar', [], context);

      expect(chatCalls(fetchSpy)).toHaveLength(2);
      expect(res.reply).toBe('Bakiyeniz 1 ETH.');
    });
  });

  // ─── x402 (pay_for_resource) sonrası döngü davranışı ────────────
  //
  // pay_for_resource, PROPOSAL_TOOLS setinde DEĞİL (semantiği farklı — bkz. CONTEXT.md bölüm
  // 14) ama aynı "requiresConfirmation:true görünce döngü kırılmalı" garantisine tabi: bütçe
  // dışı bir ödeme, tıpkı bir propose_* önerisi gibi ConfirmationCard'a düşer ve model devam
  // etmemeli. Bütçe içiyse (autoPaid:true, requiresConfirmation hiç yok) döngü normal şekilde
  // devam etmeli — otomatik ödeme sonucu modele iletilsin ki cevabında bahsedebilsin.
  describe('pay_for_resource sonrası döngü davranışı', () => {
    it('requiresConfirmation:true (bütçe dışı) dönerse, propose_* ile BİREBİR AYNI şekilde ikinci bir /agent/chat isteği ASLA atılmaz', async () => {
      const paymentResponse = proxyResponse(
        200,
        assistantChoice({
          content: 'Bu servise erişim için ödeme onayınız gerekiyor.',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'pay_for_resource', arguments: '{"resource":"https://api.example.com/weather"}' } },
          ],
        })
      );
      // Kuyrukta yalnızca TEK yanıt var — döngü ikinci bir istek atarsa
      // stubFetchRouter "unexpected extra /agent/chat call" fırlatır.
      const fetchSpy = stubFetchRouter([paymentResponse]);
      vi.mocked(executeToolCall).mockResolvedValueOnce({
        result: {
          requiresConfirmation: true,
          toolName: 'pay_for_resource',
          originalArgs: { resource: 'https://api.example.com/weather' },
          simulation: {},
        },
      });

      const res = await runAgentTurn('şu servise eriş', [], context);

      expect(chatCalls(fetchSpy)).toHaveLength(1);
      expect(res.reply).toBe('Bu servise erişim için ödeme onayınız gerekiyor.');
      expect(res.updatedHistory).toHaveLength(3);
      const toolResult = JSON.parse(res.updatedHistory[2].content);
      expect(toolResult.result.requiresConfirmation).toBe(true);
    });

    it('autoPaid:true (bütçe içi) dönerse, requiresConfirmation hiç YOK — döngü kırılmaz, sonuç modele iletilir, model normal cevabını verir', async () => {
      const paymentResponse = proxyResponse(
        200,
        assistantChoice({
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'pay_for_resource', arguments: '{"resource":"https://api.example.com/weather"}' } },
          ],
        })
      );
      const finalResponse = proxyResponse(200, assistantChoice({ content: 'Ödeme otomatik olarak yapıldı, işte hava durumu verisi.' }));
      const fetchSpy = stubFetchRouter([paymentResponse, finalResponse]);
      vi.mocked(executeToolCall).mockResolvedValueOnce({
        result: {
          autoPaid: true,
          toolName: 'pay_for_resource',
          resource: 'https://api.example.com/weather',
          amountUsd: 0.01,
          txHash: '0xSETTLEDHASH',
          remainingBudgetUsd: 0.99,
        },
      });

      const res = await runAgentTurn('şu servise eriş', [], context);

      expect(chatCalls(fetchSpy)).toHaveLength(2);
      expect(res.reply).toBe('Ödeme otomatik olarak yapıldı, işte hava durumu verisi.');
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
      const fetchSpy = stubFetchRouter(Array(5).fill(alwaysToolCall));
      vi.mocked(executeToolCall).mockResolvedValue({ result: { balanceWei: '0' } });

      const res = await runAgentTurn('sürekli tool çağır', [], context);

      expect(res.reply).toMatch(/tamamlayamadım/i);
      expect(chatCalls(fetchSpy)).toHaveLength(5);
      expect(contextCalls(fetchSpy)).toHaveLength(1);
    });
  });

  // ─── Proxy hata senaryoları ────────────────────────────────────
  describe('proxy hataları', () => {
    it('429 rate limit hatasında anlaşılır Türkçe mesaj döner, teknik detay sızdırmaz', async () => {
      stubFetchRouter([proxyResponse(429, { error: 'Rate limit exceeded. Try again shortly.' })]);

      const res = await runAgentTurn('merhaba', [], context);

      expect(res.reply).not.toContain('Rate limit exceeded');
      expect(res.reply.length).toBeGreaterThan(0);
      expect(res.reply).toMatch(/çok fazla istek|bekleyip/i);
    });

    it('502/503 (tüm modeller tükendi) durumunda anlaşılır mesaj döner', async () => {
      stubFetchRouter([
        proxyResponse(503, { error: 'All models in the fallback chain are currently rate limited.', attemptedModels: ['a', 'b'] }),
      ]);

      const res = await runAgentTurn('merhaba', [], context);

      expect(res.reply).not.toContain('attemptedModels');
      expect(res.reply).not.toContain('fallback chain');
      expect(res.reply.length).toBeGreaterThan(0);
    });

    it('fetch network hatası fırlatırsa (proxy erişilemez) anlaşılır mesaj döner, throw etmez', async () => {
      const fetchSpy = vi.fn(async (url: string) => {
        if (String(url).includes('/agent/retrieve-context')) {
          return proxyResponse(200, { chunks: [] });
        }
        throw new TypeError('Failed to fetch');
      });
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
