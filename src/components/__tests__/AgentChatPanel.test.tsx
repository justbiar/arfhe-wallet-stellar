/// <reference types="vitest/globals" />
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../i18n.js';
import * as React from 'react';
import AgentChatPanel from '../AgentChatPanel';
import { WalletContext } from '../../AppContext';
import { ActiveAccountContext } from '../../ActiveAccountProvider';
import { runAgentTurn } from '../../backend/AgentOrchestrator';
import { executeToolCall } from '../../backend/AgentToolRunner';
import type { AppContext } from '../../AppContext';
import type Account from '../../backend/Account';
import type { ChatMessage, RunAgentTurnResult } from '../../backend/AgentOrchestrator';
import type { ProposalPreview } from '../../backend/AgentToolRunner';
import type { ProposalRecord } from '../../backend/AgentProposalHistory';
import { PROPOSAL_TOOLS, X402_TOOLS } from '../../backend/AgentPolicyEngine';

/**
 * AgentChatPanel testleri
 *
 * runAgentTurn (AgentOrchestrator) mock'lanır — gerçek proxy/ağ çağrısı yapılmaz. ConfirmationCard
 * da mock'lanır (kendi Network/imzalama mantığı zaten ConfirmationCard.test.tsx'te test
 * ediliyor) — burada yalnızca AgentChatPanel'in kendi kablolaması test edilir: kartın doğru
 * anda render edilmesi, onStatusChange geldiğinde history'nin doğru güncellenip runAgentTurn'ün
 * doğru argümanlarla tekrar çağrılması, input kilidi ve "aynı anda tek kart" garantisi. Gerçek
 * i18n (en.json) kullanılır. Mesaj listesi, loading göstergesi ve aktif hesap bulunamama
 * durumu da test edilir.
 *
 * AgentChatPanel artık conversationHistory/setConversationHistory/setProposalHistory'yi prop
 * olarak alıyor (gerçek sahibi pages/Agent.tsx — hesap-bazlı depolama orada yönetiliyor, bkz.
 * Agent.test.tsx). Burada bir test-harness bileşeni bu prop'ları gerçek React state'iyle
 * besliyor ve proposalHistory'yi (harness dışına render edilmeyen bir state) gizli bir
 * data-testid'li elemente JSON olarak yazıp test'lerin okumasını sağlıyor — AgentChatPanel'in
 * setProposalHistory'yi doğru çağırdığını, gerçek storage'a dokunmadan doğrular.
 */

vi.mock('../../backend/AgentOrchestrator.js', async () => {
  const actual = await vi.importActual<typeof import('../../backend/AgentOrchestrator')>(
    '../../backend/AgentOrchestrator'
  );
  return { ...actual, runAgentTurn: vi.fn() };
});

vi.mock('../ConfirmationCard.js', async () => {
  const actual = await vi.importActual<typeof import('../ConfirmationCard')>('../ConfirmationCard');
  return {
    ...actual,
    default: ({
      preview,
      onStatusChange,
      onRetry,
    }: {
      preview: ProposalPreview;
      onStatusChange: (status: unknown) => void;
      onRetry?: (toolName: string, originalArgs: Record<string, unknown>) => void;
    }) => (
      <div data-testid="confirmation-card">
        <span data-testid="confirmation-tool">{preview.toolName}</span>
        <button
          onClick={() =>
            onStatusChange({
              status: 'confirmed',
              toolName: preview.toolName,
              originalArgs: preview.originalArgs,
              txHash: '0xMOCKHASH',
            })
          }
        >
          mock-approve
        </button>
        <button onClick={() => onStatusChange({ status: 'rejected', toolName: preview.toolName })}>
          mock-reject
        </button>
        <button
          onClick={() => onStatusChange({ status: 'pending', toolName: preview.toolName, originalArgs: preview.originalArgs })}
        >
          mock-pending
        </button>
        <button
          onClick={() =>
            onStatusChange({
              status: 'pending',
              toolName: preview.toolName,
              originalArgs: preview.originalArgs,
              txHash: '0xBROADCASTHASH',
            })
          }
        >
          mock-pending-with-hash
        </button>
        <button
          onClick={() =>
            onStatusChange({
              status: 'failed',
              toolName: preview.toolName,
              originalArgs: preview.originalArgs,
              message: 'boom',
            })
          }
        >
          mock-fail
        </button>
        {/* onRetry is only ever wired up by the real ConfirmationCard's own failed-phase
            TransactionResultCard, which never actually paints once this mock's onStatusChange has
            fired the terminal status (AgentChatPanel swaps this whole card for its own "result"
            item in the same React commit — see AgentChatPanel's isSettledMarker docs). This
            button exists only so a wiring-focused test can assert the prop reaches
            ConfirmationCard at all. */}
        <button onClick={() => onRetry?.(preview.toolName, preview.originalArgs)}>mock-retry-prop-wired</button>
      </div>
    ),
  };
});

vi.mock('../../backend/AgentToolRunner.js', async () => {
  const actual = await vi.importActual<typeof import('../../backend/AgentToolRunner')>(
    '../../backend/AgentToolRunner'
  );
  return { ...actual, executeToolCall: vi.fn() };
});

const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

function makeProposalPreview(overrides: Partial<ProposalPreview> = {}): ProposalPreview {
  return {
    requiresConfirmation: true,
    toolName: 'propose_send',
    originalArgs: { to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', amount: '0.1' },
    simulation: {
      success: true,
      balanceChanges: [],
      warnings: [],
      riskLevel: 'LOW',
    },
    ...overrides,
  };
}

/** A tool_call turn: assistant requests the tool, then the tool answers with a proposal preview. */
function makeProposalHistory(toolCallId: string, preview: ProposalPreview, userText = 'send 0.1 eth'): ChatMessage[] {
  return [
    { role: 'user', content: userText },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: toolCallId, type: 'function', function: { name: preview.toolName, arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: toolCallId, name: preview.toolName, content: JSON.stringify({ result: preview }) },
  ];
}

function makeWallet(overrides: Record<string, unknown> = {}): AppContext {
  return {
    networkProvider: {
      getActiveNetworkId: () => 11155111,
      // "result" chat items (TransactionResultCard) read this for the Explorer link + native
      // currency symbol fallback — same object ConfirmationCard itself reads in the real app.
      getActiveNetwork: () => ({ network_id: 4, currency_symbol: 'ETH' }),
    },
    ...overrides,
  } as unknown as AppContext;
}

function makeAccount(address: string | undefined = TEST_ADDRESS): Account | undefined {
  if (address === undefined) return undefined;
  return { GetAddress: () => address } as unknown as Account;
}

/**
 * Stand-in for pages/Agent.tsx: holds the real React state AgentChatPanel now receives as
 * props, so tests exercise the exact same prop contract without needing chrome.storage.session
 * or a real Agent.tsx account-switch effect (that orchestration is covered separately in
 * Agent.test.tsx). proposalHistory is exposed via a hidden JSON element so tests can assert on
 * what AgentChatPanel wrote, without reaching into storage.
 */
function Harness({ withAccount = true, withWallet = true }: { withAccount?: boolean; withWallet?: boolean }) {
  const [conversationHistory, setConversationHistory] = React.useState<ChatMessage[]>([]);
  const [proposalHistory, setProposalHistory] = React.useState<ProposalRecord[]>([]);

  return (
    <WalletContext.Provider value={withWallet ? makeWallet() : undefined}>
      <ActiveAccountContext.Provider
        value={{
          activeIndex: 0,
          activeAccount: withAccount ? makeAccount() : undefined,
          setActiveIndex: vi.fn(),
        }}
      >
        <AgentChatPanel
          conversationHistory={conversationHistory}
          setConversationHistory={setConversationHistory}
          setProposalHistory={setProposalHistory}
        />
        {/* script tags are excluded from Testing Library's getByText by default (unlike a
            plain div), so this JSON dump can never collide with a getByText query elsewhere
            in the suite just because it happens to contain the same substring as a real
            message bubble. */}
        <script type="application/json" data-testid="debug-proposal-history">
          {JSON.stringify(proposalHistory)}
        </script>
        <script type="application/json" data-testid="debug-conversation-history">
          {JSON.stringify(conversationHistory)}
        </script>
      </ActiveAccountContext.Provider>
    </WalletContext.Provider>
  );
}

function renderPanel(opts: { withAccount?: boolean; withWallet?: boolean } = {}) {
  const { withAccount = true, withWallet = true } = opts;
  return render(<Harness withAccount={withAccount} withWallet={withWallet} />);
}

function readDebugProposalHistory(): ProposalRecord[] {
  return JSON.parse(screen.getByTestId('debug-proposal-history').textContent || '[]');
}

function readDebugConversationHistory(): ChatMessage[] {
  return JSON.parse(screen.getByTestId('debug-conversation-history').textContent || '[]');
}

describe('AgentChatPanel', () => {
  beforeEach(() => {
    vi.mocked(runAgentTurn).mockReset();
    vi.mocked(executeToolCall).mockReset();
    sessionStorage.clear();
  });

  // ─── Boş / aktif hesap yok durumları ─────────────────────────────
  it('mesaj yokken boş durum metnini gösterir', () => {
    renderPanel();
    expect(screen.getByText(/Ask Arfio a question about your wallet/i)).toBeInTheDocument();
  });

  it('aktif hesap yoksa uyarı gösterir ve input devre dışı kalır', () => {
    renderPanel({ withAccount: false });
    expect(screen.getByText(/No active account found/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Ask Arfio about your balance/i)).toBeDisabled();
  });

  it('gönder butonu input boşken devre dışıdır', () => {
    renderPanel();
    const sendButton = screen.getByRole('button', { name: /send message/i });
    expect(sendButton).toBeDisabled();
  });

  // ─── Mesaj gönderme akışı ─────────────────────────────────────────
  it('mesaj gönderildiğinde runAgentTurn doğru context ile çağrılır ve cevap render edilir', async () => {
    const result: RunAgentTurnResult = {
      reply: 'Bakiyeniz 1 ETH.',
      updatedHistory: [
        { role: 'user', content: 'bakiyem ne kadar' },
        { role: 'assistant', content: 'Bakiyeniz 1 ETH.' },
      ],
    };
    vi.mocked(runAgentTurn).mockResolvedValueOnce(result);

    renderPanel();
    const input = screen.getByPlaceholderText(/Ask Arfio about your balance/i);
    fireEvent.change(input, { target: { value: 'bakiyem ne kadar' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => expect(screen.getByText('Bakiyeniz 1 ETH.')).toBeInTheDocument());

    expect(screen.getByText('bakiyem ne kadar')).toBeInTheDocument();
    expect(runAgentTurn).toHaveBeenCalledWith('bakiyem ne kadar', [], {
      account: TEST_ADDRESS,
      networkId: '11155111',
    });
  });

  it('gönderim sırasında loading göstergesi belirir, cevap gelince kaybolur', async () => {
    let resolveTurn!: (value: RunAgentTurnResult) => void;
    vi.mocked(runAgentTurn).mockImplementationOnce(
      () => new Promise((resolve) => { resolveTurn = resolve; })
    );

    renderPanel();
    fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'merhaba' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    expect(await screen.findByText('Arfio is thinking...')).toBeInTheDocument();

    await act(async () => {
      resolveTurn({
        reply: 'Merhaba!',
        updatedHistory: [
          { role: 'user', content: 'merhaba' },
          { role: 'assistant', content: 'Merhaba!' },
        ],
      });
    });

    await waitFor(() => expect(screen.queryByText('Arfio is thinking...')).not.toBeInTheDocument());
    expect(screen.getByText('Merhaba!')).toBeInTheDocument();
  });

  it('Enter tuşu (shift olmadan) mesajı gönderir', async () => {
    vi.mocked(runAgentTurn).mockResolvedValueOnce({
      reply: 'ok',
      updatedHistory: [
        { role: 'user', content: 'selam' },
        { role: 'assistant', content: 'ok' },
      ],
    });

    renderPanel();
    const input = screen.getByPlaceholderText(/Ask Arfio about your balance/i);
    fireEvent.change(input, { target: { value: 'selam' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    await waitFor(() => expect(runAgentTurn).toHaveBeenCalledTimes(1));
  });

  it('sonraki turda güncel conversationHistory önceki tur olarak geçirilir', async () => {
    const firstTurn: RunAgentTurnResult = {
      reply: 'ilk cevap',
      updatedHistory: [
        { role: 'user', content: 'ilk soru' },
        { role: 'assistant', content: 'ilk cevap' },
      ],
    };
    vi.mocked(runAgentTurn).mockResolvedValueOnce(firstTurn);

    renderPanel();
    const input = screen.getByPlaceholderText(/Ask Arfio about your balance/i);
    fireEvent.change(input, { target: { value: 'ilk soru' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    await waitFor(() => expect(screen.getByText('ilk cevap')).toBeInTheDocument());

    vi.mocked(runAgentTurn).mockResolvedValueOnce({
      reply: 'ikinci cevap',
      updatedHistory: [...firstTurn.updatedHistory, { role: 'user', content: 'ikinci soru' }, { role: 'assistant', content: 'ikinci cevap' }],
    });

    fireEvent.change(input, { target: { value: 'ikinci soru' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    await waitFor(() => expect(screen.getByText('ikinci cevap')).toBeInTheDocument());

    expect(runAgentTurn).toHaveBeenLastCalledWith('ikinci soru', firstTurn.updatedHistory, {
      account: TEST_ADDRESS,
      networkId: '11155111',
    });
  });

  it('runAgentTurn beklenmedik şekilde throw ederse çökmez, güvenli mesaj gösterir', async () => {
    vi.mocked(runAgentTurn).mockRejectedValueOnce(new Error('boom'));

    renderPanel();
    fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'test' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => expect(screen.getByText(/couldn't process that/i)).toBeInTheDocument());
  });

  // ─── Yeni sohbet ────────────────────────────────────────────
  describe('yeni sohbet', () => {
    it('mesaj yokken yeni sohbet butonu devre dışıdır', () => {
      renderPanel();
      expect(screen.getByRole('button', { name: /new chat/i })).toBeDisabled();
    });

    it('mesajlar varken tıklanınca conversationHistory ve görünümü sıfırlar', async () => {
      vi.mocked(runAgentTurn).mockResolvedValueOnce({
        reply: 'cevap',
        updatedHistory: [
          { role: 'user', content: 'soru' },
          { role: 'assistant', content: 'cevap' },
        ],
      });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'soru' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
      await waitFor(() => expect(screen.getByText('cevap')).toBeInTheDocument());

      const clearButton = screen.getByRole('button', { name: /new chat/i });
      expect(clearButton).toBeEnabled();
      fireEvent.click(clearButton);

      expect(screen.queryByText('soru')).not.toBeInTheDocument();
      expect(screen.queryByText('cevap')).not.toBeInTheDocument();
      expect(screen.getByText(/Ask Arfio a question about your wallet/i)).toBeInTheDocument();
      expect(clearButton).toBeDisabled();
    });
  });

  // ─── ConfirmationCard entegrasyonu ────────────────────────────────
  describe('confirmation card entegrasyonu', () => {
    it('requiresConfirmation içeren tool sonucu geldiğinde ConfirmationCard render edilir', async () => {
      const preview = makeProposalPreview();
      vi.mocked(runAgentTurn).mockResolvedValueOnce({
        reply: 'İşte önizleme, onaylar mısınız?',
        updatedHistory: [
          ...makeProposalHistory('call_1', preview),
          { role: 'assistant', content: 'İşte önizleme, onaylar mısınız?' },
        ],
      });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'send 0.1 eth' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => expect(screen.getByTestId('confirmation-card')).toBeInTheDocument());
      expect(screen.getByTestId('confirmation-tool')).toHaveTextContent('propose_send');
      // Aynı turdaki metin cevabı da normal şekilde render edilmeli
      expect(screen.getByText('İşte önizleme, onaylar mısınız?')).toBeInTheDocument();
    });

    // Invariant: buildChatItems/ConfirmationCard render yolu toolName'e göre dallanmıyor
    // (kasıtlı olarak — bkz. AgentChatPanel.tsx'teki buildChatItems ve findPendingConfirmation,
    // ikisi de yalnızca { requiresConfirmation: true, toolName, originalArgs, simulation } şeklini
    // kontrol eder, belirli bir toolName listesiyle eşleştirmez). Bu test, requiresConfirmation
    // döndürebilen HER tool (PROPOSAL_TOOLS ∪ X402_TOOLS — AgentOrchestrator.ts'teki
    // CONFIRMABLE_TOOLS ile birebir aynı küme) için kartın gerçekten render edildiğini kanıtlar
    // — biri ileride buraya toolName-özel bir filtre eklerse (ör. yalnızca propose_* için kart
    // göster gibi bir "iyileştirme"), pay_for_resource sessizce düz metne düşer ve bu test kırılır.
    const CONFIRMABLE_TOOLS = [...PROPOSAL_TOOLS, ...X402_TOOLS];
    it.each(CONFIRMABLE_TOOLS)(
      'requiresConfirmation:true dönen "%s" için de ConfirmationCard render edilir',
      async (toolName) => {
        const preview = makeProposalPreview({ toolName, originalArgs: { resource: 'https://api.example.com/weather' } });
        vi.mocked(runAgentTurn).mockResolvedValueOnce({
          reply: '',
          updatedHistory: makeProposalHistory('call_1', preview),
        });

        renderPanel();
        fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'test' } });
        fireEvent.click(screen.getByRole('button', { name: /send message/i }));

        await waitFor(() => expect(screen.getByTestId('confirmation-card')).toBeInTheDocument());
        expect(screen.getByTestId('confirmation-tool')).toHaveTextContent(toolName);
      }
    );

    it('bir ConfirmationCard aktifken input ve gönder butonu devre dışı kalır', async () => {
      const preview = makeProposalPreview();
      vi.mocked(runAgentTurn).mockResolvedValueOnce({
        reply: '',
        updatedHistory: makeProposalHistory('call_1', preview),
      });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'send 0.1 eth' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => expect(screen.getByTestId('confirmation-card')).toBeInTheDocument());
      expect(screen.getByPlaceholderText(/Ask Arfio about your balance/i)).toBeDisabled();
      expect(screen.getByRole('button', { name: /send message/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /new chat/i })).toBeDisabled();
    });

    it('onaylama: tool mesajı settled özetiyle senkron güncellenir, runAgentTurn TEKRAR ÇAĞRILMAZ (model bir sonraki cevabı üretmez)', async () => {
      const preview = makeProposalPreview();
      const historyWithProposal = makeProposalHistory('call_1', preview);
      vi.mocked(runAgentTurn).mockResolvedValueOnce({ reply: '', updatedHistory: historyWithProposal });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'send 0.1 eth' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
      await waitFor(() => expect(screen.getByTestId('confirmation-card')).toBeInTheDocument());

      fireEvent.click(screen.getByText('mock-approve'));

      // Kart hemen kapanmalı ve giriş alanı hemen serbest kalmalı — hiçbir proxy/model
      // round-trip'i beklenmiyor, çünkü sonuç zaten senkron olarak history'ye yazıldı.
      await waitFor(() => expect(screen.queryByTestId('confirmation-card')).not.toBeInTheDocument());
      expect(screen.getByPlaceholderText(/Ask Arfio about your balance/i)).toBeEnabled();
      // ConfirmationCard'ın mock'u kapandı, yerine gerçek TransactionResultCard (success receipt)
      // geldi — ham tool adı ("propose_send") asla kullanıcıya gösterilmemeli.
      expect(screen.getByText('Transfer successful')).toBeInTheDocument();
      expect(screen.queryByText(/propose_send/)).not.toBeInTheDocument();

      // runAgentTurn yalnızca ilk (kullanıcının "send 0.1 eth" mesajını gönderdiği) turdan
      // geliyor — onay sonrası İKİNCİ bir çağrı ASLA yapılmamalı.
      expect(runAgentTurn).toHaveBeenCalledTimes(1);
    });

    it('onaylanan tool mesajı, gerçek settled özetiyle (durum/toolName/txHash) senkron güncellenir', async () => {
      const preview = makeProposalPreview();
      const historyWithProposal = makeProposalHistory('call_1', preview);
      vi.mocked(runAgentTurn).mockResolvedValueOnce({ reply: '', updatedHistory: historyWithProposal });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'send 0.1 eth' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
      await waitFor(() => expect(screen.getByTestId('confirmation-card')).toBeInTheDocument());

      fireEvent.click(screen.getByText('mock-approve'));
      await waitFor(() => expect(screen.queryByTestId('confirmation-card')).not.toBeInTheDocument());

      // handleConfirmationResolved artık runAgentTurn'ün dönüşünü değil, kendi senkron
      // state güncellemesini yazıyor — Harness'in gerçek conversationHistory state'inden okuyoruz.
      const finalHistory = readDebugConversationHistory();
      const toolMessage = finalHistory.find((m) => m.tool_call_id === 'call_1');
      expect(toolMessage).toBeDefined();
      const parsedContent = JSON.parse(toolMessage!.content) as {
        result: { settled: true; status: string; toolName: string; summary: string };
      };
      expect(parsedContent.result.settled).toBe(true);
      expect(parsedContent.result.status).toBe('confirmed');
      expect(parsedContent.result.toolName).toBe('propose_send');
      expect(parsedContent.result.summary).toContain('propose_send');
      expect(parsedContent.result.summary.toLowerCase()).toContain('approved');
    });

    it('onaydan SONRA kullanıcı yeni bir mesaj gönderirse, model settled bilgisini history üzerinden görür (proaktif değil, yalnızca sorulunca)', async () => {
      const preview = makeProposalPreview();
      const historyWithProposal = makeProposalHistory('call_1', preview);
      vi.mocked(runAgentTurn).mockResolvedValueOnce({ reply: '', updatedHistory: historyWithProposal });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'send 0.1 eth' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
      await waitFor(() => expect(screen.getByTestId('confirmation-card')).toBeInTheDocument());

      fireEvent.click(screen.getByText('mock-approve'));
      await waitFor(() => expect(screen.queryByTestId('confirmation-card')).not.toBeInTheDocument());
      expect(runAgentTurn).toHaveBeenCalledTimes(1); // onay tek başına ikinci bir çağrı yapmadı

      const historyAfterApprove = readDebugConversationHistory();

      // Kullanıcı kendi isteğiyle yeni bir mesaj gönderir — işte BURADA modelin cevap
      // üretmesi meşrudur, çünkü bu kullanıcı tetiklemeli bir tur, otomatik devam değil.
      vi.mocked(runAgentTurn).mockResolvedValueOnce({
        reply: 'Evet, 0.1 ETH gönderiminiz onaylanmıştı.',
        updatedHistory: [
          ...historyAfterApprove,
          { role: 'user', content: 'az önceki gönderim onaylandı mı?' },
          { role: 'assistant', content: 'Evet, 0.1 ETH gönderiminiz onaylanmıştı.' },
        ],
      });
      fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), {
        target: { value: 'az önceki gönderim onaylandı mı?' },
      });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => expect(runAgentTurn).toHaveBeenCalledTimes(2));
      const [userMessageArg, historyArg] = vi.mocked(runAgentTurn).mock.calls[1];
      expect(userMessageArg).toBe('az önceki gönderim onaylandı mı?');

      // Bu ikinci çağrıya giden history'de call_1'in tool mesajı settled:true olarak
      // görünmeli — yani model, proaktif bir cevap üretmese de, kendisine sorulduğunda
      // gerçek sonucu (kod tarafından yazılmış veriden) doğru şekilde bilir.
      const toolMessage = (historyArg as ChatMessage[]).find((m) => m.tool_call_id === 'call_1');
      expect(toolMessage).toBeDefined();
      const parsedToolContent = JSON.parse(toolMessage!.content) as {
        result: { settled: true; status: string; toolName: string; summary: string };
      };
      expect(parsedToolContent.result.settled).toBe(true);
      expect(parsedToolContent.result.status).toBe('confirmed');
      expect(parsedToolContent.result.toolName).toBe('propose_send');

      await waitFor(() => expect(screen.getByText('Evet, 0.1 ETH gönderiminiz onaylanmıştı.')).toBeInTheDocument());
    });

    it('reddetme: tool mesajı "rejected" özetiyle senkron güncellenir, kart kapanır, runAgentTurn tekrar çağrılmaz', async () => {
      const preview = makeProposalPreview();
      const historyWithProposal = makeProposalHistory('call_1', preview);
      vi.mocked(runAgentTurn).mockResolvedValueOnce({ reply: '', updatedHistory: historyWithProposal });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'send 0.1 eth' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
      await waitFor(() => expect(screen.getByTestId('confirmation-card')).toBeInTheDocument());

      fireEvent.click(screen.getByText('mock-reject'));

      await waitFor(() => expect(screen.queryByTestId('confirmation-card')).not.toBeInTheDocument());

      const finalHistory = readDebugConversationHistory();
      const toolMessage = finalHistory.find((m) => m.tool_call_id === 'call_1');
      const parsedContent = JSON.parse(toolMessage!.content) as {
        result: { settled: true; status: string; toolName: string; summary: string };
      };
      expect(parsedContent.result.status).toBe('rejected');
      expect(parsedContent.result.summary.toLowerCase()).toContain('rejected');

      expect(runAgentTurn).toHaveBeenCalledTimes(1);
    });

    it('birden fazla çözülmemiş öneri varsa yalnızca ilki gösterilir', async () => {
      const firstPreview = makeProposalPreview({ toolName: 'propose_send' });
      const secondPreview = makeProposalPreview({ toolName: 'propose_shield', originalArgs: { amount: '0.2', tokenSymbol: 'ETH' } });

      vi.mocked(runAgentTurn).mockResolvedValueOnce({
        reply: '',
        updatedHistory: [
          ...makeProposalHistory('call_1', firstPreview),
          ...makeProposalHistory('call_2', secondPreview, 'and also shield 0.2 eth'),
        ],
      });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'do two things' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => expect(screen.getAllByTestId('confirmation-card')).toHaveLength(1));
      expect(screen.getByTestId('confirmation-tool')).toHaveTextContent('propose_send');

      // İlkini onaylamak artık senkron — call_1'in tool mesajı yerinde settled ile
      // güncellenir, call_2'nin tool mesajı hiç dokunulmadığı için zaten pending kalır ve
      // hemen görünür hale gelir. runAgentTurn tekrar çağrılmadan.
      fireEvent.click(screen.getByText('mock-approve'));

      await waitFor(() => expect(screen.getAllByTestId('confirmation-card')).toHaveLength(1));
      expect(screen.getByTestId('confirmation-tool')).toHaveTextContent('propose_shield');
      expect(runAgentTurn).toHaveBeenCalledTimes(1);
    });
  });

  // ─── "pending" durumu — Sorun 2 (settling breadcrumb yerine gerçek receipt) ────────
  describe('pending durumu (onStatusChange "pending")', () => {
    it('onStatusChange "pending" ile çağrılınca ham/teknik "settling" breadcrumb\'ı DEĞİL, gerçek TransactionResultCard (pending) render edilir', async () => {
      const preview = makeProposalPreview();
      vi.mocked(runAgentTurn).mockResolvedValueOnce({ reply: '', updatedHistory: makeProposalHistory('call_1', preview) });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'send 0.1 eth' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
      await waitFor(() => expect(screen.getByTestId('confirmation-card')).toBeInTheDocument());

      fireEvent.click(screen.getByText('mock-pending'));

      // Mock kart kapanır (buildChatItems artık bu tool_call_id için "confirmation" değil
      // "result" phase="pending" üretir), yerini gerçek TransactionResultCard'ın receipt'i alır.
      await waitFor(() => expect(screen.queryByTestId('confirmation-card')).not.toBeInTheDocument());
      expect(screen.getByText('Transfer confirming...')).toBeInTheDocument();
      expect(screen.queryByText(/transaction you approved to settle/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/propose_send/)).not.toBeInTheDocument();
    });

    it('broadcast hash bilinince ("pending" + txHash) receipt Explorer linkini gösterir', async () => {
      const preview = makeProposalPreview();
      vi.mocked(runAgentTurn).mockResolvedValueOnce({ reply: '', updatedHistory: makeProposalHistory('call_1', preview) });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'send 0.1 eth' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
      await waitFor(() => expect(screen.getByTestId('confirmation-card')).toBeInTheDocument());

      fireEvent.click(screen.getByText('mock-pending-with-hash'));

      await waitFor(() => expect(screen.getByRole('link', { name: /view on explorer/i })).toBeInTheDocument());
      expect(screen.getByRole('link', { name: /view on explorer/i })).toHaveAttribute(
        'href',
        expect.stringContaining('0xBROADCASTHASH')
      );
    });
  });

  // ─── "Tekrar dene" (başarısız önerinin yeniden önerilmesi) ────────
  //
  // ConfirmationCard mock'lanmış olsa da, bir öneri sonuçlandığında (mock-fail) AgentChatPanel
  // kendi "result" kalemini (gerçek TransactionResultCard, mock değil) render eder — gerçek
  // uygulamada da böyle çalışır: ConfirmationCard, onResolved'ı kendi terminal state
  // güncellemesiyle AYNI tick'te çağırır, React bunları tek commit'te birleştirir, bu yüzden
  // ConfirmationCard'ın kendi başarısız/başarılı render'ı hiç ekrana basılmadan kaldırılır —
  // "Tekrar dene" butonuna asıl tıklanan yer burasıdır, mock kartın içi değil.
  describe('tekrar dene', () => {
    it('başarısız bir öneride "Tekrar dene", aynı toolName+args ile executeToolCall\'ı çağırır ve yeni bir ConfirmationCard doğurur — runAgentTurn TEKRAR ÇAĞRILMAZ', async () => {
      const preview = makeProposalPreview();
      vi.mocked(runAgentTurn).mockResolvedValueOnce({ reply: '', updatedHistory: makeProposalHistory('call_1', preview) });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'send 0.1 eth' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
      await waitFor(() => expect(screen.getByTestId('confirmation-card')).toBeInTheDocument());

      // Onay başarısız oldu — mock kart kapanır, yerine gerçek TransactionResultCard (failed) gelir.
      fireEvent.click(screen.getByText('mock-fail'));
      await waitFor(() => expect(screen.queryByTestId('confirmation-card')).not.toBeInTheDocument());
      const retryButton = await screen.findByRole('button', { name: /try again/i });
      expect(retryButton).toBeEnabled();

      const retryPreview = makeProposalPreview({ originalArgs: preview.originalArgs });
      vi.mocked(executeToolCall).mockResolvedValueOnce({ result: retryPreview });

      fireEvent.click(retryButton);

      await waitFor(() =>
        expect(executeToolCall).toHaveBeenCalledWith('propose_send', preview.originalArgs, {
          account: TEST_ADDRESS,
          networkId: '11155111',
        })
      );

      // runAgentTurn modelden geçmedi — yalnızca ilk turdan (1 kez) çağrıldı.
      expect(runAgentTurn).toHaveBeenCalledTimes(1);

      // Yeni preview senkron olarak history'ye yazıldı ve otomatik yeni bir ConfirmationCard render edildi.
      await waitFor(() => expect(screen.getByTestId('confirmation-card')).toBeInTheDocument());
      expect(screen.getByTestId('confirmation-tool')).toHaveTextContent('propose_send');
    });

    it('executeToolCall hata dönerse, yeni bir kart doğmaz ve hata metni asistan mesajı olarak eklenir', async () => {
      const preview = makeProposalPreview();
      vi.mocked(runAgentTurn).mockResolvedValueOnce({ reply: '', updatedHistory: makeProposalHistory('call_1', preview) });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'send 0.1 eth' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
      await waitFor(() => expect(screen.getByTestId('confirmation-card')).toBeInTheDocument());

      fireEvent.click(screen.getByText('mock-fail'));
      const retryButton = await screen.findByRole('button', { name: /try again/i });

      vi.mocked(executeToolCall).mockResolvedValueOnce({ error: 'Bakiye yetersiz.' });
      fireEvent.click(retryButton);

      await waitFor(() => expect(screen.getByText('Bakiye yetersiz.')).toBeInTheDocument());
      expect(screen.queryByTestId('confirmation-card')).not.toBeInTheDocument();
    });

    it('onRetry prop\'u ConfirmationCard\'a doğru toolName+originalArgs ile geçirilir (kablolama testi)', async () => {
      const preview = makeProposalPreview();
      vi.mocked(runAgentTurn).mockResolvedValueOnce({ reply: '', updatedHistory: makeProposalHistory('call_1', preview) });
      vi.mocked(executeToolCall).mockResolvedValueOnce({ result: makeProposalPreview() });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'send 0.1 eth' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
      await waitFor(() => expect(screen.getByTestId('confirmation-card')).toBeInTheDocument());

      fireEvent.click(screen.getByText('mock-retry-prop-wired'));

      await waitFor(() =>
        expect(executeToolCall).toHaveBeenCalledWith('propose_send', preview.originalArgs, {
          account: TEST_ADDRESS,
          networkId: '11155111',
        })
      );
    });
  });

  // ─── Hazır sorular (boş ekran) ────────────────────────────────────
  describe('hazır sorular', () => {
    it('boş ekranda hazır soru butonları görünür ve tıklanınca metin gönderilir', async () => {
      vi.mocked(runAgentTurn).mockResolvedValueOnce({
        reply: 'Bakiyeniz 1 ETH.',
        updatedHistory: [
          { role: 'user', content: "What's my balance?" },
          { role: 'assistant', content: 'Bakiyeniz 1 ETH.' },
        ],
      });

      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: "What's my balance?" }));

      await waitFor(() =>
        expect(runAgentTurn).toHaveBeenCalledWith("What's my balance?", [], {
          account: TEST_ADDRESS,
          networkId: '11155111',
        })
      );
      await waitFor(() => expect(screen.getByText('Bakiyeniz 1 ETH.')).toBeInTheDocument());
    });

    it('aktif hesap yoksa hazır soru butonları gösterilmez', () => {
      renderPanel({ withAccount: false });
      expect(screen.queryByRole('button', { name: "What's my balance?" })).not.toBeInTheDocument();
    });
  });

  // ─── Sonuçlanmış öneri göstergesi ──────────────────────────────────
  describe('sonuçlanmış öneri göstergesi', () => {
    it('settled marker taşıyan tool mesajı minimal bir "tamamlandı" göstergesi olarak render edilir', async () => {
      vi.mocked(runAgentTurn).mockResolvedValueOnce({
        reply: 'Tamamdır.',
        updatedHistory: [
          { role: 'user', content: 'send 0.1 eth' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'propose_send', arguments: '{}' } }],
          },
          {
            role: 'tool',
            tool_call_id: 'call_1',
            name: 'propose_send',
            content: JSON.stringify({ result: { settled: true, status: 'confirmed', toolName: 'propose_send', summary: 'ok' } }),
          },
          { role: 'assistant', content: 'Tamamdır.' },
        ],
      });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'send 0.1 eth' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => expect(screen.getByText('Tamamdır.')).toBeInTheDocument());
      // Ham tool adı ("propose_send") asla kullanıcıya gösterilmemeli — çevrilmiş etiket görünür.
      expect(screen.getByText('Send completed')).toBeInTheDocument();
      expect(screen.queryByText(/propose_send/)).not.toBeInTheDocument();
      expect(screen.queryByTestId('confirmation-card')).not.toBeInTheDocument();
    });

    it('originalArgs taşımayan eski format bir pendingSettlement marker\'ı (eski build\'den kalma) "settling" breadcrumb\'ına düşer, çökmez', async () => {
      vi.mocked(runAgentTurn).mockResolvedValueOnce({
        reply: 'Tamamdır.',
        updatedHistory: [
          { role: 'user', content: 'send 0.1 eth' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'propose_send', arguments: '{}' } }],
          },
          {
            role: 'tool',
            tool_call_id: 'call_1',
            name: 'propose_send',
            content: JSON.stringify({ result: { pendingSettlement: true, toolName: 'propose_send' } }),
          },
          { role: 'assistant', content: 'Tamamdır.' },
        ],
      });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'send 0.1 eth' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => expect(screen.getByText('Tamamdır.')).toBeInTheDocument());
      expect(screen.getByText('Waiting for the Send transaction you approved to settle...')).toBeInTheDocument();
    });
  });

  // ─── x402 otomatik ödeme kartı (Faz 3) ─────────────────────────────
  describe('x402 otomatik ödeme (autoPaid) göstergesi', () => {
    /**
     * AgentToolRunner.handlePayForResource, bütçe içi bir ödemede tool mesajını doğrudan
     * `{ result: { autoPaid: true, ... } }` şeklinde yazar (ConfirmationCard/onStatusChange hiç
     * devreye girmez — bkz. CONTEXT.md bölüm 14). buildChatItems bu şekli henüz tanımıyor, bu
     * yüzden bu test önce KIRMIZI olmalı: ne X402PaymentCard'ın başlığı ne de tutar/servis bilgisi
     * hiçbir yerde görünmemeli (mesaj sessizce hiçbir ChatItem'a dönüşmüyor).
     */
    function autoPaidHistory(): ChatMessage[] {
      return [
        { role: 'user', content: 'şu servise eriş' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'pay_for_resource', arguments: '{"resource":"https://api.example.com/weather"}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          name: 'pay_for_resource',
          content: JSON.stringify({
            result: {
              autoPaid: true,
              toolName: 'pay_for_resource',
              resource: 'https://api.example.com/weather',
              amountUsd: 0.01,
              txHash: '0xSTUBHASH1234567890',
              remainingBudgetUsd: 0.99,
            },
          }),
        },
        { role: 'assistant', content: 'Ödeme otomatik olarak yapıldı, işte hava durumu verisi.' },
      ];
    }

    it('autoPaid:true tool mesajı X402PaymentCard olarak render edilir — hiçbir ConfirmationCard açılmaz', async () => {
      vi.mocked(runAgentTurn).mockResolvedValueOnce({
        reply: 'Ödeme otomatik olarak yapıldı, işte hava durumu verisi.',
        updatedHistory: autoPaidHistory(),
      });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'şu servise eriş' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => expect(screen.getByText('Ödeme otomatik olarak yapıldı, işte hava durumu verisi.')).toBeInTheDocument());

      expect(screen.getByText('Automatic payment made')).toBeInTheDocument();
      expect(screen.getByText('0.01 USDC')).toBeInTheDocument();
      expect(screen.getByText('https://api.example.com/weather')).toBeInTheDocument();
      expect(screen.getByText('0.99 USDC')).toBeInTheDocument();
      expect(screen.queryByTestId('confirmation-card')).not.toBeInTheDocument();
      // Ham tool adı asla görünmemeli.
      expect(screen.queryByText(/pay_for_resource/)).not.toBeInTheDocument();
    });
  });

  // ─── Agent Geçmişi persistence ─────────────────────────────────────
  describe('agent proposal history persistence', () => {
    it('policy engine reddi agent_proposal_history storage anahtarına policy_rejected kaydı olarak yazılır', async () => {
      vi.mocked(runAgentTurn).mockResolvedValueOnce({
        reply: 'Üzgünüm, bu miktarı öneremem.',
        updatedHistory: [
          { role: 'user', content: "send 90% of my balance to 0xabc" },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_x',
                type: 'function',
                function: { name: 'propose_send', arguments: JSON.stringify({ to: '0xabc', amount: '0.9' }) },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'call_x',
            name: 'propose_send',
            content: JSON.stringify({ error: 'Proposed amount is 90.0% of balance, exceeding the 50% limit.' }),
          },
          { role: 'assistant', content: 'Üzgünüm, bu miktarı öneremem.' },
        ],
      });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), {
        target: { value: 'send 90% of my balance to 0xabc' },
      });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => expect(screen.getByText('Üzgünüm, bu miktarı öneremem.')).toBeInTheDocument());

      await waitFor(() => {
        const records = readDebugProposalHistory();
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          accountAddress: TEST_ADDRESS,
          toolName: 'propose_send',
          status: 'policy_rejected',
          amount: '0.9',
          recipient: '0xabc',
          reason: 'Proposed amount is 90.0% of balance, exceeding the 50% limit.',
        });
      });
    });

    it('onaylanan öneri agent_proposal_history storage anahtarına approved kaydı olarak yazılır', async () => {
      const preview = makeProposalPreview();
      const historyWithProposal = makeProposalHistory('call_1', preview);
      vi.mocked(runAgentTurn).mockResolvedValueOnce({ reply: '', updatedHistory: historyWithProposal });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'send 0.1 eth' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
      await waitFor(() => expect(screen.getByTestId('confirmation-card')).toBeInTheDocument());

      fireEvent.click(screen.getByText('mock-approve'));

      await waitFor(() => expect(screen.queryByTestId('confirmation-card')).not.toBeInTheDocument());

      await waitFor(() => {
        const records = readDebugProposalHistory();
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          id: 'call_1',
          accountAddress: TEST_ADDRESS,
          toolName: 'propose_send',
          status: 'approved',
          txHash: '0xMOCKHASH',
        });
      });
    });
  });
});
