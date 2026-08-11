/// <reference types="vitest/globals" />
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../i18n.js';
import AgentChatPanel from '../AgentChatPanel';
import { WalletContext } from '../../AppContext';
import { ActiveAccountContext } from '../../ActiveAccountProvider';
import { runAgentTurn } from '../../backend/AgentOrchestrator';
import type { AppContext } from '../../AppContext';
import type Account from '../../backend/Account';
import type { ChatMessage, RunAgentTurnResult } from '../../backend/AgentOrchestrator';
import type { ProposalPreview } from '../../backend/AgentToolRunner';

/**
 * AgentChatPanel testleri
 *
 * runAgentTurn (AgentOrchestrator) mock'lanır — gerçek proxy/ağ çağrısı yapılmaz. ConfirmationCard
 * da mock'lanır (kendi Network/imzalama mantığı zaten ConfirmationCard.test.tsx'te test
 * ediliyor) — burada yalnızca AgentChatPanel'in kendi kablolaması test edilir: kartın doğru
 * anda render edilmesi, onResolved geldiğinde history'nin doğru güncellenip runAgentTurn'ün
 * doğru argümanlarla tekrar çağrılması, input kilidi ve "aynı anda tek kart" garantisi. Gerçek
 * i18n (en.json) kullanılır. Mesaj listesi, loading göstergesi ve aktif hesap bulunamama
 * durumu da test edilir.
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
    default: ({ preview, onResolved }: { preview: ProposalPreview; onResolved: (o: unknown) => void }) => (
      <div data-testid="confirmation-card">
        <span data-testid="confirmation-tool">{preview.toolName}</span>
        <button onClick={() => onResolved({ status: 'confirmed', toolName: preview.toolName, txHash: '0xMOCKHASH' })}>
          mock-approve
        </button>
        <button onClick={() => onResolved({ status: 'rejected', toolName: preview.toolName })}>
          mock-reject
        </button>
      </div>
    ),
  };
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
    networkProvider: { getActiveNetworkId: () => 11155111 },
    ...overrides,
  } as unknown as AppContext;
}

function makeAccount(address: string | undefined = TEST_ADDRESS): Account | undefined {
  if (address === undefined) return undefined;
  return { GetAddress: () => address } as unknown as Account;
}

function renderPanel(opts: { withAccount?: boolean; withWallet?: boolean } = {}) {
  const { withAccount = true, withWallet = true } = opts;

  return render(
    <WalletContext.Provider value={withWallet ? makeWallet() : undefined}>
      <ActiveAccountContext.Provider
        value={{
          activeIndex: 0,
          activeAccount: withAccount ? makeAccount() : undefined,
          setActiveIndex: vi.fn(),
        }}
      >
        <AgentChatPanel />
      </ActiveAccountContext.Provider>
    </WalletContext.Provider>
  );
}

describe('AgentChatPanel', () => {
  beforeEach(() => {
    vi.mocked(runAgentTurn).mockReset();
  });

  // ─── Boş / aktif hesap yok durumları ─────────────────────────────
  it('mesaj yokken boş durum metnini gösterir', () => {
    renderPanel();
    expect(screen.getByText(/Ask a question about your wallet/i)).toBeInTheDocument();
  });

  it('aktif hesap yoksa uyarı gösterir ve input devre dışı kalır', () => {
    renderPanel({ withAccount: false });
    expect(screen.getByText(/No active account found/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Ask about your balance/i)).toBeDisabled();
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
    const input = screen.getByPlaceholderText(/Ask about your balance/i);
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
    fireEvent.change(screen.getByPlaceholderText(/Ask about your balance/i), { target: { value: 'merhaba' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    expect(await screen.findByText('Thinking...')).toBeInTheDocument();

    await act(async () => {
      resolveTurn({
        reply: 'Merhaba!',
        updatedHistory: [
          { role: 'user', content: 'merhaba' },
          { role: 'assistant', content: 'Merhaba!' },
        ],
      });
    });

    await waitFor(() => expect(screen.queryByText('Thinking...')).not.toBeInTheDocument());
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
    const input = screen.getByPlaceholderText(/Ask about your balance/i);
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
    const input = screen.getByPlaceholderText(/Ask about your balance/i);
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
    fireEvent.change(screen.getByPlaceholderText(/Ask about your balance/i), { target: { value: 'test' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => expect(screen.getByText(/couldn't process that/i)).toBeInTheDocument());
  });

  // ─── Sohbeti temizle ────────────────────────────────────────────
  describe('sohbeti temizle', () => {
    it('mesaj yokken temizle butonu devre dışıdır', () => {
      renderPanel();
      expect(screen.getByRole('button', { name: /clear conversation/i })).toBeDisabled();
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
      fireEvent.change(screen.getByPlaceholderText(/Ask about your balance/i), { target: { value: 'soru' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
      await waitFor(() => expect(screen.getByText('cevap')).toBeInTheDocument());

      const clearButton = screen.getByRole('button', { name: /clear conversation/i });
      expect(clearButton).toBeEnabled();
      fireEvent.click(clearButton);

      expect(screen.queryByText('soru')).not.toBeInTheDocument();
      expect(screen.queryByText('cevap')).not.toBeInTheDocument();
      expect(screen.getByText(/Ask a question about your wallet/i)).toBeInTheDocument();
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
      fireEvent.change(screen.getByPlaceholderText(/Ask about your balance/i), { target: { value: 'send 0.1 eth' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => expect(screen.getByTestId('confirmation-card')).toBeInTheDocument());
      expect(screen.getByTestId('confirmation-tool')).toHaveTextContent('propose_send');
      // Aynı turdaki metin cevabı da normal şekilde render edilmeli
      expect(screen.getByText('İşte önizleme, onaylar mısınız?')).toBeInTheDocument();
    });

    it('bir ConfirmationCard aktifken input ve gönder butonu devre dışı kalır', async () => {
      const preview = makeProposalPreview();
      vi.mocked(runAgentTurn).mockResolvedValueOnce({
        reply: '',
        updatedHistory: makeProposalHistory('call_1', preview),
      });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask about your balance/i), { target: { value: 'send 0.1 eth' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => expect(screen.getByTestId('confirmation-card')).toBeInTheDocument());
      expect(screen.getByPlaceholderText(/Ask about your balance/i)).toBeDisabled();
      expect(screen.getByRole('button', { name: /send message/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /clear conversation/i })).toBeDisabled();
    });

    it('onaylama: tool mesajı özetle güncellenir, runAgentTurn boş userMessage ile yeni history üzerinden tekrar çağrılır', async () => {
      const preview = makeProposalPreview();
      const historyWithProposal = makeProposalHistory('call_1', preview);
      vi.mocked(runAgentTurn).mockResolvedValueOnce({ reply: '', updatedHistory: historyWithProposal });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask about your balance/i), { target: { value: 'send 0.1 eth' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
      await waitFor(() => expect(screen.getByTestId('confirmation-card')).toBeInTheDocument());

      vi.mocked(runAgentTurn).mockResolvedValueOnce({
        reply: 'İşleminiz onaylandı, tebrikler.',
        updatedHistory: [
          ...historyWithProposal.map((m) =>
            m.role === 'tool' ? { ...m, content: JSON.stringify({ result: 'user approved' }) } : m
          ),
          { role: 'assistant', content: 'İşleminiz onaylandı, tebrikler.' },
        ],
      });

      fireEvent.click(screen.getByText('mock-approve'));

      await waitFor(() => expect(runAgentTurn).toHaveBeenCalledTimes(2));
      const [userMessageArg, historyArg, contextArg] = vi.mocked(runAgentTurn).mock.calls[1];
      expect(userMessageArg).toBe('');
      expect(contextArg).toEqual({ account: TEST_ADDRESS, networkId: '11155111' });

      const toolMessage = (historyArg as ChatMessage[]).find((m) => m.tool_call_id === 'call_1');
      expect(toolMessage).toBeDefined();
      const parsedContent = JSON.parse(toolMessage!.content) as { result: string };
      expect(parsedContent.result).toContain('propose_send');
      expect(parsedContent.result.toLowerCase()).toContain('approved');

      await waitFor(() => expect(screen.getByText('İşleminiz onaylandı, tebrikler.')).toBeInTheDocument());
      expect(screen.queryByTestId('confirmation-card')).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText(/Ask about your balance/i)).toBeEnabled();
    });

    it('reddetme: benzer akış çalışır — tool mesajı "rejected" özetiyle güncellenir, kart kapanır', async () => {
      const preview = makeProposalPreview();
      const historyWithProposal = makeProposalHistory('call_1', preview);
      vi.mocked(runAgentTurn).mockResolvedValueOnce({ reply: '', updatedHistory: historyWithProposal });

      renderPanel();
      fireEvent.change(screen.getByPlaceholderText(/Ask about your balance/i), { target: { value: 'send 0.1 eth' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
      await waitFor(() => expect(screen.getByTestId('confirmation-card')).toBeInTheDocument());

      vi.mocked(runAgentTurn).mockResolvedValueOnce({
        reply: 'Anladım, iptal ettiniz.',
        updatedHistory: [
          ...historyWithProposal.map((m) =>
            m.role === 'tool' ? { ...m, content: JSON.stringify({ result: 'user rejected' }) } : m
          ),
          { role: 'assistant', content: 'Anladım, iptal ettiniz.' },
        ],
      });

      fireEvent.click(screen.getByText('mock-reject'));

      await waitFor(() => expect(runAgentTurn).toHaveBeenCalledTimes(2));
      const [userMessageArg, historyArg] = vi.mocked(runAgentTurn).mock.calls[1];
      expect(userMessageArg).toBe('');

      const toolMessage = (historyArg as ChatMessage[]).find((m) => m.tool_call_id === 'call_1');
      const parsedContent = JSON.parse(toolMessage!.content) as { result: string };
      expect(parsedContent.result.toLowerCase()).toContain('rejected');

      await waitFor(() => expect(screen.getByText('Anladım, iptal ettiniz.')).toBeInTheDocument());
      expect(screen.queryByTestId('confirmation-card')).not.toBeInTheDocument();
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
      fireEvent.change(screen.getByPlaceholderText(/Ask about your balance/i), { target: { value: 'do two things' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => expect(screen.getAllByTestId('confirmation-card')).toHaveLength(1));
      expect(screen.getByTestId('confirmation-tool')).toHaveTextContent('propose_send');

      // İlkini onayladıktan sonra ikincisi görünür hale gelmeli
      vi.mocked(runAgentTurn).mockResolvedValueOnce({
        reply: '',
        updatedHistory: [
          ...makeProposalHistory('call_1', firstPreview).map((m) =>
            m.role === 'tool' ? { ...m, content: JSON.stringify({ result: 'user approved' }) } : m
          ),
          ...makeProposalHistory('call_2', secondPreview, 'and also shield 0.2 eth'),
        ],
      });

      fireEvent.click(screen.getByText('mock-approve'));

      await waitFor(() => expect(screen.getAllByTestId('confirmation-card')).toHaveLength(1));
      expect(screen.getByTestId('confirmation-tool')).toHaveTextContent('propose_shield');
    });
  });
});
