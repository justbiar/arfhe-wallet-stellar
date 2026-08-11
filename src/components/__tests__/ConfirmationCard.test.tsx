/// <reference types="vitest/globals" />
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../i18n.js';
import ConfirmationCard, { buildConfirmationOutcomeSummary, type ConfirmationOutcome } from '../ConfirmationCard';
import { WalletContext } from '../../AppContext';
import { ActiveAccountContext } from '../../ActiveAccountProvider';
import type { AppContext } from '../../AppContext';
import type Account from '../../backend/Account';
import type { ProposalPreview } from '../../backend/AgentToolRunner';
import type { SimResult } from '../../backend/TransactionSimulator';

/**
 * ConfirmationCard testleri
 *
 * Network.ts çağrıları (sendTransaction/shieldNative/unshieldAndClaim/getBalance/
 * getShieldedPortfolio/waitForTransaction) mock'lanır — gerçek RPC/imza işlemi yapılmaz.
 * DomainResolver mock'lanır. Gerçek i18n kullanılır. Onay/red senaryoları, her 3 propose_*
 * tool'u için doğru Network fonksiyonunun doğru parametrelerle çağrıldığı, simulation
 * gösterimi ve rate/2-aşama notları test edilir.
 */

vi.mock('../../backend/DomainResolver.js', () => ({
  isDomainName: vi.fn((input: string) => input.endsWith('.eth')),
  resolveDomain: vi.fn(),
}));

import { isDomainName, resolveDomain } from '../../backend/DomainResolver';

const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const WRAPPER = '0x1111111111111111111111111111111111111111';

function makeSimResult(overrides: Partial<SimResult> = {}): SimResult {
  return {
    success: true,
    balanceChanges: [],
    warnings: [],
    riskLevel: 'LOW',
    operationType: 'transfer',
    isContractInteraction: false,
    isNewRecipient: false,
    contractAgeDays: null,
    ...overrides,
  };
}

function makePreview(overrides: Partial<ProposalPreview> = {}): ProposalPreview {
  return {
    requiresConfirmation: true,
    toolName: 'propose_send',
    originalArgs: { to: RECIPIENT, amount: '0.1' },
    simulation: makeSimResult({
      balanceChanges: [
        {
          tokenAddress: 'ETH',
          symbol: 'ETH',
          decimals: 18,
          amountWei: '100000000000000000',
          amountFormatted: '0.1',
          from: TEST_ADDRESS,
          to: RECIPIENT,
          type: 'NATIVE',
        },
      ],
    }),
    ...overrides,
  };
}

describe('ConfirmationCard', () => {
  let mockNetwork: {
    getBalance: ReturnType<typeof vi.fn>;
    getShieldedPortfolio: ReturnType<typeof vi.fn>;
    sendTransaction: ReturnType<typeof vi.fn>;
    shieldNative: ReturnType<typeof vi.fn>;
    unshieldAndClaim: ReturnType<typeof vi.fn>;
    waitForTransaction: ReturnType<typeof vi.fn>;
    currency_symbol: string;
    network_id: number;
  };
  let mockWallet: AppContext;
  let mockAccount: Account;
  let onResolved: ReturnType<typeof vi.fn<(outcome: ConfirmationOutcome) => void>>;

  beforeEach(() => {
    vi.mocked(isDomainName).mockReset().mockImplementation((input: string) => input.endsWith('.eth'));
    vi.mocked(resolveDomain).mockReset();

    mockNetwork = {
      getBalance: vi.fn().mockResolvedValue('1000000000000000000'), // 1 ETH
      getShieldedPortfolio: vi.fn().mockResolvedValue([]),
      sendTransaction: vi.fn().mockResolvedValue('0xsendhash'),
      shieldNative: vi.fn().mockResolvedValue('0xshieldhash'),
      unshieldAndClaim: vi.fn().mockResolvedValue('0xunshieldhash'),
      waitForTransaction: vi.fn().mockResolvedValue(undefined),
      currency_symbol: 'ETH',
      network_id: 4,
    };
    mockWallet = {
      networkProvider: { getActiveNetwork: () => mockNetwork },
      pendingClaimQueue: { marker: 'pending-claim-queue' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal mock for unit tests
    } as any as AppContext;
    mockAccount = { GetAddress: () => TEST_ADDRESS } as unknown as Account;
    onResolved = vi.fn();
  });

  function renderCard(preview: ProposalPreview) {
    return render(
      <WalletContext.Provider value={mockWallet}>
        <ActiveAccountContext.Provider value={{ activeIndex: 0, activeAccount: mockAccount, setActiveIndex: vi.fn() }}>
          <ConfirmationCard preview={preview} onResolved={onResolved} />
        </ActiveAccountContext.Provider>
      </WalletContext.Provider>
    );
  }

  // ─── Genel gösterim ────────────────────────────────────────────
  describe('gösterim', () => {
    it('bakiye değişimini (simulation) "X ETH gönderilecek" olarak gösterir', () => {
      renderCard(makePreview());
      expect(screen.getByText('0.1 ETH will be sent')).toBeInTheDocument();
      expect(screen.getByText(RECIPIENT)).toBeInTheDocument();
    });

    it('propose_unshield için originalArgstan miktar/sembol gösterir (simulation balanceChanges boş)', () => {
      renderCard(
        makePreview({
          toolName: 'propose_unshield',
          originalArgs: { amount: '0.5', tokenSymbol: 'aeETH' },
          simulation: makeSimResult({ balanceChanges: [], warnings: ['🔓 Kalkan Kaldırma (Unshield): ...'] }),
        })
      );
      expect(screen.getByText('0.5 aeETH will be unshielded')).toBeInTheDocument();
    });

    it('propose_shield için rate kırpma uyarısını gösterir', () => {
      renderCard(makePreview({ toolName: 'propose_shield', originalArgs: { amount: '1.5000005', tokenSymbol: 'ETH' } }));
      expect(screen.getByText(/6 decimal places/)).toBeInTheDocument();
    });

    it('propose_unshield için 2 aşamalı süreç notunu gösterir', () => {
      renderCard(makePreview({ toolName: 'propose_unshield', originalArgs: { amount: '0.5', tokenSymbol: 'aeETH' } }));
      expect(screen.getByText(/two-step process/)).toBeInTheDocument();
    });

    it('CRITICAL risk seviyesinde Onayla butonu devre dışıdır', () => {
      renderCard(makePreview({ simulation: makeSimResult({ riskLevel: 'CRITICAL' }) }));
      const approveButton = screen.getByRole('button', { name: /blocked/i });
      expect(approveButton).toBeDisabled();
    });
  });

  // ─── Reddet ──────────────────────────────────────────────────────
  describe('reddet', () => {
    it('Reddet\'e basınca hiçbir Network fonksiyonu çağrılmaz, onResolved rejected ile çağrılır', () => {
      renderCard(makePreview());
      fireEvent.click(screen.getByRole('button', { name: /reject/i }));

      expect(mockNetwork.sendTransaction).not.toHaveBeenCalled();
      expect(onResolved).toHaveBeenCalledWith({ status: 'rejected', toolName: 'propose_send' });
    });
  });

  // ─── propose_send onayı ────────────────────────────────────────
  describe('propose_send onayı', () => {
    it('sendTransaction doğru parametrelerle çağrılır, waitForTransaction beklenir, başarı gösterilir', async () => {
      renderCard(makePreview());
      fireEvent.click(screen.getByRole('button', { name: /approve/i }));

      await waitFor(() => expect(onResolved).toHaveBeenCalled());

      expect(mockNetwork.sendTransaction).toHaveBeenCalledWith(
        mockAccount,
        { to: RECIPIENT, value: '0.1' },
        expect.any(Function)
      );
      expect(mockNetwork.waitForTransaction).toHaveBeenCalledWith('0xsendhash');
      expect(onResolved).toHaveBeenCalledWith({ status: 'confirmed', toolName: 'propose_send', txHash: '0xsendhash' });
      expect(await screen.findByText('Confirmed')).toBeInTheDocument();
    });

    it('ENS alan adı onay anında yeniden çözümlenip kullanılır', async () => {
      vi.mocked(resolveDomain).mockResolvedValueOnce({ address: RECIPIENT, method: 'ens', error: null });
      renderCard(makePreview({ originalArgs: { to: 'vitalik.eth', amount: '0.1' } }));

      fireEvent.click(screen.getByRole('button', { name: /approve/i }));
      await waitFor(() => expect(mockNetwork.sendTransaction).toHaveBeenCalled());

      expect(mockNetwork.sendTransaction).toHaveBeenCalledWith(
        mockAccount,
        { to: RECIPIENT, value: '0.1' },
        expect.any(Function)
      );
    });

    it('sendTransaction başarısız olursa hata gösterilir, onResolved failed ile çağrılır', async () => {
      mockNetwork.sendTransaction.mockRejectedValueOnce(new Error('insufficient funds'));
      renderCard(makePreview());

      fireEvent.click(screen.getByRole('button', { name: /approve/i }));
      await waitFor(() => expect(onResolved).toHaveBeenCalled());

      const call = onResolved.mock.calls[0][0] as ConfirmationOutcome;
      expect(call.status).toBe('failed');
      expect(mockNetwork.waitForTransaction).not.toHaveBeenCalled();
    });
  });

  // ─── propose_shield onayı ──────────────────────────────────────
  describe('propose_shield onayı', () => {
    it('shieldNative native wrapper adresiyle çağrılır, waitForTransaction beklenir', async () => {
      mockNetwork.getShieldedPortfolio.mockResolvedValue([
        { wrapper: WRAPPER, underlying: '', symbol: 'aeETH', confidentialDecimals: 6, rate: 1000000000000n, isNative: true, balance: '0.2', isLegacy: false },
      ]);

      renderCard(makePreview({ toolName: 'propose_shield', originalArgs: { amount: '0.1', tokenSymbol: 'ETH' } }));
      fireEvent.click(screen.getByRole('button', { name: /approve/i }));

      await waitFor(() => expect(onResolved).toHaveBeenCalled());

      expect(mockNetwork.shieldNative).toHaveBeenCalledWith(mockAccount, WRAPPER, '0.1');
      expect(mockNetwork.waitForTransaction).toHaveBeenCalledWith('0xshieldhash');
      expect(onResolved).toHaveBeenCalledWith({ status: 'confirmed', toolName: 'propose_shield', txHash: '0xshieldhash' });
    });

    it('native wrapper bulunamazsa {error} gösterilir, shieldNative çağrılmaz', async () => {
      mockNetwork.getShieldedPortfolio.mockResolvedValue([]);
      renderCard(makePreview({ toolName: 'propose_shield', originalArgs: { amount: '0.1', tokenSymbol: 'ETH' } }));

      fireEvent.click(screen.getByRole('button', { name: /approve/i }));
      await waitFor(() => expect(onResolved).toHaveBeenCalled());

      expect(mockNetwork.shieldNative).not.toHaveBeenCalled();
      expect((onResolved.mock.calls[0][0] as ConfirmationOutcome).status).toBe('failed');
    });
  });

  // ─── propose_unshield onayı ────────────────────────────────────
  describe('propose_unshield onayı', () => {
    it('unshieldAndClaim doğru parametrelerle çağrılır, ayrıca waitForTransaction çağrılmaz', async () => {
      mockNetwork.getShieldedPortfolio.mockResolvedValue([
        { wrapper: WRAPPER, underlying: '', symbol: 'aeETH', confidentialDecimals: 6, rate: 1000000000000n, isNative: true, balance: '0.5', isLegacy: false },
      ]);

      renderCard(makePreview({ toolName: 'propose_unshield', originalArgs: { amount: '0.2', tokenSymbol: 'aeETH' } }));
      fireEvent.click(screen.getByRole('button', { name: /approve/i }));

      await waitFor(() => expect(onResolved).toHaveBeenCalled());

      expect(mockNetwork.unshieldAndClaim).toHaveBeenCalledWith(
        mockAccount,
        WRAPPER,
        '0.2',
        mockWallet.pendingClaimQueue,
        'aeETH',
        expect.any(Function)
      );
      expect(mockNetwork.waitForTransaction).not.toHaveBeenCalled();
      expect(onResolved).toHaveBeenCalledWith({ status: 'confirmed', toolName: 'propose_unshield', txHash: '0xunshieldhash' });
    });

    it('bilinmeyen shielded tokenSymbol için unshieldAndClaim çağrılmaz, failed döner', async () => {
      mockNetwork.getShieldedPortfolio.mockResolvedValue([]);
      renderCard(makePreview({ toolName: 'propose_unshield', originalArgs: { amount: '0.2', tokenSymbol: 'aeUSDC' } }));

      fireEvent.click(screen.getByRole('button', { name: /approve/i }));
      await waitFor(() => expect(onResolved).toHaveBeenCalled());

      expect(mockNetwork.unshieldAndClaim).not.toHaveBeenCalled();
      expect((onResolved.mock.calls[0][0] as ConfirmationOutcome).status).toBe('failed');
    });
  });

  // ─── buildConfirmationOutcomeSummary ───────────────────────────
  describe('buildConfirmationOutcomeSummary', () => {
    const t = (key: string, params?: Record<string, string>) => {
      // Minimal stand-in translator matching en.json's interpolation for these keys.
      const map: Record<string, string> = {
        'agent.confirmationCardOutcomeRejected': `rejected:${params?.toolName}`,
        'agent.confirmationCardOutcomeConfirmed': `confirmed:${params?.toolName}:${params?.txHash}`,
        'agent.confirmationCardOutcomeFailed': `failed:${params?.toolName}:${params?.message}`,
      };
      return map[key] ?? key;
    };

    it('rejected için doğru mesajı üretir', () => {
      expect(buildConfirmationOutcomeSummary({ status: 'rejected', toolName: 'propose_send' }, t)).toBe('rejected:propose_send');
    });

    it('confirmed için tx hash içeren mesajı üretir', () => {
      expect(
        buildConfirmationOutcomeSummary({ status: 'confirmed', toolName: 'propose_shield', txHash: '0xabc' }, t)
      ).toBe('confirmed:propose_shield:0xabc');
    });

    it('failed için hata mesajını içeren mesajı üretir', () => {
      expect(
        buildConfirmationOutcomeSummary({ status: 'failed', toolName: 'propose_unshield', message: 'boom' }, t)
      ).toBe('failed:propose_unshield:boom');
    });
  });
});
