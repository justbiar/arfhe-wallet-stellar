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
import type { RunAgentTurnResult } from '../../backend/AgentOrchestrator';

/**
 * AgentChatPanel testleri
 *
 * runAgentTurn (AgentOrchestrator) mock'lanır — gerçek proxy/ağ çağrısı yapılmaz. Gerçek
 * i18n (en.json) kullanılır, böylece eklenen agent.panel* key'lerinin fiilen var olduğu ve
 * doğru render edildiği de dolaylı olarak doğrulanır. Mesaj listesi, loading göstergesi ve
 * aktif hesap bulunamama durumu test edilir.
 */

vi.mock('../../backend/AgentOrchestrator.js', async () => {
  const actual = await vi.importActual<typeof import('../../backend/AgentOrchestrator')>(
    '../../backend/AgentOrchestrator'
  );
  return { ...actual, runAgentTurn: vi.fn() };
});

const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

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
});
