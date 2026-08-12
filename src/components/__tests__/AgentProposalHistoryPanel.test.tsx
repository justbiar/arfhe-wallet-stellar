/// <reference types="vitest/globals" />
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../i18n.js';
import AgentProposalHistoryPanel from '../AgentProposalHistoryPanel';
import { WalletContext } from '../../AppContext';
import { ActiveAccountContext } from '../../ActiveAccountProvider';
import type { AppContext } from '../../AppContext';
import type Account from '../../backend/Account';
import type { ProposalRecord } from '../../backend/AgentProposalHistory';

/**
 * AgentProposalHistoryPanel testleri
 *
 * Bu panel salt-okunur ve artık `records`'ı prop olarak alıyor (storage'ı Agent.tsx sahipleniyor
 * — tek usePersistedState örneği, bkz. Agent.tsx'in dosya başı yorumu). Panel yalnızca aktif
 * hesaba (`useActiveAccount()`) göre filtreleyip render ediyor, hiçbir yazma yapmıyor.
 */

const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OTHER_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function makeWallet(): AppContext {
  return {
    networkProvider: {
      getActiveNetwork: () => ({ currency_symbol: 'ETH', network_id: 11155111 }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal mock for unit tests
  } as any as AppContext;
}

// `null` (not `undefined`) signals "no active account" — a JS default parameter only kicks in
// for an explicit `undefined` argument, so `null` is the only way a caller can opt out of it.
function renderPanel(records: ProposalRecord[], address: string | null = TEST_ADDRESS) {
  const account = address ? ({ GetAddress: () => address } as unknown as Account) : undefined;
  return render(
    <WalletContext.Provider value={makeWallet()}>
      <ActiveAccountContext.Provider value={{ activeIndex: 0, activeAccount: account, setActiveIndex: vi.fn() }}>
        <AgentProposalHistoryPanel records={records} />
      </ActiveAccountContext.Provider>
    </WalletContext.Provider>
  );
}

function makeRecord(overrides: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    id: 'call_1',
    accountAddress: TEST_ADDRESS,
    toolName: 'propose_send',
    amount: '0.1',
    tokenSymbol: undefined,
    recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    status: 'approved',
    timestamp: Date.parse('2026-08-12T10:00:00Z'),
    ...overrides,
  };
}

describe('AgentProposalHistoryPanel', () => {
  it('kayıt yokken boş durum metnini gösterir', () => {
    renderPanel([]);
    expect(screen.getByText(/No proposal history yet/i)).toBeInTheDocument();
  });

  it('onaylanan bir kaydı ikon, özet ve tarihle render eder, explorer linki içerir', () => {
    renderPanel([makeRecord({ status: 'approved', txHash: '0xdeadbeef' })]);

    expect(screen.getByText(/Send — Approved/i)).toBeInTheDocument();
    expect(screen.getByText(/0\.1.*→.*7099\.\.\.79C8|0\.1/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /View on Explorer/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('/tx/0xdeadbeef'));
  });

  it('policy tarafından reddedilen bir kayıt reason metnini gösterir', () => {
    renderPanel([
      makeRecord({
        id: 'call_2',
        status: 'policy_rejected',
        txHash: undefined,
        reason: 'Proposed amount is 90.0% of balance, exceeding the 50% limit.',
      }),
    ]);

    expect(screen.getByText(/Send — Denied by policy/i)).toBeInTheDocument();
    expect(screen.getByText(/exceeding the 50% limit/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View on Explorer/i })).not.toBeInTheDocument();
  });

  it('kullanıcı tarafından iptal edilen bir kayıt için explorer linki göstermez', () => {
    renderPanel([makeRecord({ id: 'call_3', status: 'user_cancelled', txHash: undefined })]);

    expect(screen.getByText(/Send — Cancelled/i)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('en yeni kayıt en üstte gösterilir', () => {
    renderPanel([
      makeRecord({ id: 'older', toolName: 'propose_shield', timestamp: Date.parse('2026-08-10T10:00:00Z') }),
      makeRecord({ id: 'newer', toolName: 'propose_unshield', timestamp: Date.parse('2026-08-12T10:00:00Z') }),
    ]);

    const headings = screen.getAllByText(/— Approved/i);
    expect(headings[0]).toHaveTextContent('Unshield');
    expect(headings[1]).toHaveTextContent('Shield');
  });

  // ─── Hesap-bazlı filtreleme ───────────────────────────────────────
  describe('hesap filtreleme', () => {
    it('yalnızca aktif hesabın kayıtlarını gösterir, başka hesaba ait kayıtları gizler', () => {
      renderPanel([
        makeRecord({ id: 'mine', accountAddress: TEST_ADDRESS }),
        makeRecord({ id: 'not-mine', accountAddress: OTHER_ADDRESS, toolName: 'propose_shield' }),
      ]);

      expect(screen.getByText(/Send — Approved/i)).toBeInTheDocument();
      expect(screen.queryByText(/Shield — Approved/i)).not.toBeInTheDocument();
    });

    it('aktif hesap yoksa hiçbir kayıt göstermez (boş durum)', () => {
      renderPanel([makeRecord()], null);
      expect(screen.getByText(/No proposal history yet/i)).toBeInTheDocument();
    });
  });
});
