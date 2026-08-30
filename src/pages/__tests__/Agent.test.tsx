/// <reference types="vitest/globals" />
import * as React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../i18n.js';
import Agent from '../Agent';
import { WalletContext } from '../../AppContext';
import { ActiveAccountContext } from '../../ActiveAccountProvider';
import { AgentSessionProvider } from '../../AgentSessionProvider';
import type { AppContext } from '../../AppContext';
import type Account from '../../backend/Account';
import type { AgentChatPanelProps } from '../../components/AgentChatPanel';
import type { AgentProposalHistoryPanelProps } from '../../components/AgentProposalHistoryPanel';
import type { ProposalPreview } from '../../backend/AgentToolRunner';

/**
 * Agent.test.tsx
 *
 * Agent.tsx owns per-account chat history (`Record<address, ChatMessage[]>`) and cross-account
 * proposal history (both via usePersistedState — chrome.storage.session falls back to
 * sessionStorage here, same as everywhere else), and is the ONLY thing that reacts to account
 * switches (auto-cancel a pending card left on the OUTGOING account, drop a system notice into
 * the INCOMING account's chat, toast) — see that file's header comment for why this couldn't
 * live inside AgentChatPanel itself. AgentChatPanel/AgentProposalHistoryPanel are mocked here as
 * thin prop-capturing stand-ins (their own behavior is covered by their own test files) so this
 * file isolates exactly Agent.tsx's own orchestration.
 */

let lastChatProps: AgentChatPanelProps | null = null;
let lastHistoryPanelProps: AgentProposalHistoryPanelProps | null = null;
const mockShowToast = vi.fn();

vi.mock('../../components/AgentChatPanel.js', () => ({
  default: (props: AgentChatPanelProps) => {
    lastChatProps = props;
    return <div data-testid="chat-panel">{JSON.stringify(props.conversationHistory)}</div>;
  },
}));

vi.mock('../../components/AgentProposalHistoryPanel.js', () => ({
  default: (props: AgentProposalHistoryPanelProps) => {
    lastHistoryPanelProps = props;
    return <div data-testid="history-panel">{JSON.stringify(props.records)}</div>;
  },
}));

vi.mock('../../components/ToastProvider.js', () => ({
  useToast: () => ({ showToast: mockShowToast, dismissToast: vi.fn() }),
}));

const ADDRESS_A = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ADDRESS_B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function makeWallet(): AppContext {
  return {
    networkProvider: { getActiveNetworkId: () => 11155111 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal mock for unit tests
  } as any as AppContext;
}

function makeAccount(address: string, name: string): Account {
  return { GetAddress: () => address, GetName: () => name } as unknown as Account;
}

function makePreview(overrides: Partial<ProposalPreview> = {}): ProposalPreview {
  return {
    requiresConfirmation: true,
    toolName: 'propose_send',
    originalArgs: { to: '0x1111111111111111111111111111111111111111', amount: '0.1' },
    simulation: { success: true, balanceChanges: [], warnings: [], riskLevel: 'LOW' },
    ...overrides,
  };
}

/** A tool_call turn ending in a still-pending ProposalPreview — mirrors AgentChatPanel.test.tsx. */
function makePendingProposalHistory(toolCallId: string, preview: ProposalPreview) {
  return [
    { role: 'user' as const, content: 'send 0.1 eth' },
    {
      role: 'assistant' as const,
      content: '',
      tool_calls: [{ id: toolCallId, type: 'function' as const, function: { name: preview.toolName, arguments: '{}' } }],
    },
    { role: 'tool' as const, tool_call_id: toolCallId, name: preview.toolName, content: JSON.stringify({ result: preview }) },
  ];
}

function renderAgent(account: Account | undefined) {
  const result = render(
    <WalletContext.Provider value={makeWallet()}>
      <AgentSessionProvider>
        <ActiveAccountContext.Provider value={{ activeIndex: 0, activeAccount: account, setActiveIndex: vi.fn() }}>
          <Agent />
        </ActiveAccountContext.Provider>
      </AgentSessionProvider>
    </WalletContext.Provider>
  );
  return {
    ...result,
    rerenderWithAccount: (acc: Account | undefined) =>
      result.rerender(
        <WalletContext.Provider value={makeWallet()}>
          <AgentSessionProvider>
            <ActiveAccountContext.Provider value={{ activeIndex: 0, activeAccount: acc, setActiveIndex: vi.fn() }}>
              <Agent />
            </ActiveAccountContext.Provider>
          </AgentSessionProvider>
        </WalletContext.Provider>
      ),
  };
}

describe('Agent (hesap-değişim orkestrasyonu)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    mockShowToast.mockReset();
    lastChatProps = null;
    lastHistoryPanelProps = null;
  });

  it('ilk mount\'ta (hesap değişmemiş) toast veya sistem notu tetiklenmez', () => {
    renderAgent(makeAccount(ADDRESS_A, 'Account 1'));
    expect(mockShowToast).not.toHaveBeenCalled();
    expect(lastChatProps?.conversationHistory).toEqual([]);
  });

  it('kilitli → açık geçişinde (undefined → hesap) bir "switch" sayılmaz, bildirim tetiklenmez', () => {
    const { rerenderWithAccount } = renderAgent(undefined);
    expect(mockShowToast).not.toHaveBeenCalled();

    act(() => rerenderWithAccount(makeAccount(ADDRESS_A, 'Account 1')));
    expect(mockShowToast).not.toHaveBeenCalled();
    expect(lastChatProps?.conversationHistory).toEqual([]);
  });

  it('gerçek bir hesap değişiminde toast gösterir ve INCOMING hesabın sohbetine sistem notu ekler', () => {
    const { rerenderWithAccount } = renderAgent(makeAccount(ADDRESS_A, 'Account 1'));

    act(() => rerenderWithAccount(makeAccount(ADDRESS_B, 'Account 2')));

    expect(mockShowToast).toHaveBeenCalledWith(expect.stringContaining('Account 2'), 'info');

    const incomingHistory = lastChatProps?.conversationHistory ?? [];
    const notice = incomingHistory.find((m) => m.role === 'system');
    expect(notice).toBeDefined();
    const parsed = JSON.parse(notice!.content) as { accountSwitchNotice: true; label: string };
    expect(parsed.accountSwitchNotice).toBe(true);
    expect(parsed.label).toContain('Account 2');
  });

  it('OUTGOING hesapta bekleyen bir öneri varsa otomatik iptal edilir ve Agent Geçmişi\'ne accountAddress ile kaydedilir', () => {
    const { rerenderWithAccount } = renderAgent(makeAccount(ADDRESS_A, 'Account 1'));

    // Seed account A's history with a still-pending proposal, exactly as AgentChatPanel would
    // leave it after a propose_send tool call the user hasn't approved/rejected yet.
    act(() => lastChatProps!.setConversationHistory(makePendingProposalHistory('call_1', makePreview())));

    act(() => rerenderWithAccount(makeAccount(ADDRESS_B, 'Account 2')));

    // AgentProposalHistoryPanel only mounts on the "Agent Geçmişi" tab — switch to it so the
    // mock actually captures the current `records` prop (proposalHistory itself was already
    // updated by the effect above; this just makes it observable in this test).
    fireEvent.click(screen.getByRole('tab', { name: /agent activity/i }));

    // Proposal history now has a user_cancelled record for the OUTGOING account (A), reason
    // matching ConfirmationCard's own ACCOUNT_CHANGED_REASON exactly.
    const records = lastHistoryPanelProps?.records ?? [];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: 'call_1',
      accountAddress: ADDRESS_A,
      toolName: 'propose_send',
      status: 'user_cancelled',
      reason: 'Active account changed before approval',
    });
  });

  it('OUTGOING hesapta bekleyen bir şey yoksa proposal history\'ye ekstra kayıt eklenmez', () => {
    const { rerenderWithAccount } = renderAgent(makeAccount(ADDRESS_A, 'Account 1'));
    act(() => rerenderWithAccount(makeAccount(ADDRESS_B, 'Account 2')));

    fireEvent.click(screen.getByRole('tab', { name: /agent activity/i }));
    expect(lastHistoryPanelProps?.records ?? []).toHaveLength(0);
  });

  it('hesap A\'ya geri dönüldüğünde A\'nın (iptal edilmiş öneriyle birlikte) sohbeti kaybolmadan geri gelir', () => {
    const { rerenderWithAccount } = renderAgent(makeAccount(ADDRESS_A, 'Account 1'));
    act(() => lastChatProps!.setConversationHistory(makePendingProposalHistory('call_1', makePreview())));

    act(() => rerenderWithAccount(makeAccount(ADDRESS_B, 'Account 2')));
    // While B is active, A's messages are out of view...
    expect(lastChatProps?.conversationHistory.some((m) => m.tool_call_id === 'call_1')).toBe(false);

    act(() => rerenderWithAccount(makeAccount(ADDRESS_A, 'Account 1')));
    // ...but switching back to A shows them again, now with the cancelled marker instead of
    // the raw pending preview.
    const restored = lastChatProps?.conversationHistory ?? [];
    const toolMessage = restored.find((m) => m.tool_call_id === 'call_1');
    expect(toolMessage).toBeDefined();
    const parsed = JSON.parse(toolMessage!.content) as { result: { settled: true; status: string } };
    expect(parsed.result.settled).toBe(true);
    expect(parsed.result.status).toBe('rejected');
  });

  it('sekme geçişi bozulmadan çalışır: Agent Geçmişi sekmesine geçince AgentProposalHistoryPanel render edilir', () => {
    renderAgent(makeAccount(ADDRESS_A, 'Account 1'));
    expect(screen.getByTestId('chat-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /agent activity/i }));

    expect(screen.getByTestId('history-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-panel')).not.toBeInTheDocument();
  });
});
