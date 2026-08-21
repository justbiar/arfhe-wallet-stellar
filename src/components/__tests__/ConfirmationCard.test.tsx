/// <reference types="vitest/globals" />
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { changeLanguage } from '../../i18n.js';
import ConfirmationCard, {
  buildConfirmationOutcomeSummary,
  type ConfirmationCardStatus,
  type ConfirmationOutcome,
} from '../ConfirmationCard';
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
 *
 * `onStatusChange` tek bir callback olduğu için (approve başlangıcı, broadcast, ve terminal
 * confirmed/failed/rejected — hepsi aynı prop üzerinden) çoğu approve akışında BİRDEN FAZLA kez
 * çağrılır: önce "pending" (imza bekleniyor), sonra (send/shield'de) tekrar "pending" (hash
 * bilinir bilinmez), en son terminal durum. Bu yüzden testler genel `toHaveBeenCalled()` yerine
 * belirli bir status'e `toHaveBeenCalledWith(expect.objectContaining({status: ...}))` ile
 * `waitFor` içinde bekler — aksi halde ilk "pending" çağrısı testi erken tetikleyip flaky yapar.
 */

vi.mock('../../backend/DomainResolver.js', () => ({
  isDomainName: vi.fn((input: string) => input.endsWith('.eth')),
  resolveDomain: vi.fn(),
}));

import { isDomainName, resolveDomain } from '../../backend/DomainResolver';

// ─── x402 (Faz 3) mocks ──────────────────────────────────────────────
const { mockRecordPayment } = vi.hoisted(() => ({ mockRecordPayment: vi.fn() }));

vi.mock('../../backend/X402ProxyClient.js', () => ({
  fetchX402PaymentRequirement: vi.fn(),
  settleX402Payment: vi.fn(),
}));
vi.mock('../../backend/X402PaymentService.js', () => ({
  signTransferWithAuthorization: vi.fn(),
  generateAuthorizationNonce: () => '0x' + 'cd'.repeat(32),
}));
vi.mock('../../backend/X402SpendingLedger.js', () => ({
  // ConfirmationCard.tsx instantiates ONE X402SpendingLedger at module scope — mockRecordPayment
  // (hoisted, shared) is the only way tests can assert on that single instance's calls.
  X402SpendingLedger: vi.fn().mockImplementation(function X402SpendingLedgerMock() {
    return { recordPayment: mockRecordPayment };
  }),
}));
// ConfirmationCard now sources the USDC EIP-712 domain from AgentToolRunner's dep (single
// source of truth shared with the auto-pay path, see AgentToolRunner.ts's getUsdcTokenIdentity)
// instead of declaring its own copy — mock just that export rather than pulling in the real
// module (which would drag in Network.ts/X402SettingsService/etc.).
vi.mock('../../backend/AgentToolRunner.js', () => ({
  getUsdcTokenIdentity: vi.fn(),
}));

import { fetchX402PaymentRequirement, settleX402Payment } from '../../backend/X402ProxyClient';
import { signTransferWithAuthorization } from '../../backend/X402PaymentService';
import { getUsdcTokenIdentity } from '../../backend/AgentToolRunner';
import { NetworkId } from '../../backend/NetworkTypes';

const X402_TOKEN_IDENTITY = {
  address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  name: 'USDC', // Base Sepolia testnet USDC domain name — see AppContext.ts's getUsdcTokenIdentity
  version: '2',
  chainId: NetworkId.Base_Sepolia,
};

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

const X402_PAY_TO = '0x00000000000000000000000000000000000000f1';
const X402_RESOURCE = 'https://api.example.com/weather';

function makeX402Preview(overrides: Partial<ProposalPreview> = {}): ProposalPreview {
  return {
    requiresConfirmation: true,
    toolName: 'pay_for_resource',
    originalArgs: { resource: X402_RESOURCE },
    simulation: makeSimResult({
      balanceChanges: [
        {
          tokenAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          symbol: 'USDC',
          decimals: 6,
          amountWei: '10000',
          amountFormatted: '0.01',
          from: TEST_ADDRESS,
          to: X402_PAY_TO,
          type: 'ERC20',
        },
      ],
      warnings: ['Bu bir x402 mikro-ödeme yetkilendirmesidir.'],
    }),
    ...overrides,
  };
}

/** Finds the last call whose status matches — used since onStatusChange fires multiple times. */
function lastCallWithStatus(
  mockFn: ReturnType<typeof vi.fn<(status: ConfirmationCardStatus) => void>>,
  status: ConfirmationCardStatus['status']
): ConfirmationCardStatus | undefined {
  const calls = mockFn.mock.calls.filter(([s]) => s.status === status);
  return calls.length > 0 ? calls[calls.length - 1][0] : undefined;
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
  let onStatusChange: ReturnType<typeof vi.fn<(status: ConfirmationCardStatus) => void>>;

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
    mockAccount = {
      GetAddress: () => TEST_ADDRESS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal signer stand-in for x402 tests
      ethers_wallet: { signTypedData: vi.fn() } as any,
    } as unknown as Account;
    onStatusChange = vi.fn();

    mockRecordPayment.mockReset().mockResolvedValue(undefined);
    vi.mocked(fetchX402PaymentRequirement).mockReset().mockResolvedValue({
      scheme: 'exact',
      network: 'base-sepolia',
      maxAmountRequired: '10000', // $0.01
      resource: 'https://api.example.com/weather',
      description: 'Access to weather data',
      mimeType: 'application/json',
      payTo: '0x00000000000000000000000000000000000000f1',
      maxTimeoutSeconds: 60,
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      extra: { name: 'USD Coin', version: '2' },
    });
    vi.mocked(settleX402Payment).mockReset().mockResolvedValue({ success: true, txHash: '0xX402SETTLEDHASH' });
    vi.mocked(signTransferWithAuthorization).mockReset().mockResolvedValue({
      authorization: { from: TEST_ADDRESS, to: '0x00000000000000000000000000000000000000f1', value: '10000', validAfter: 0, validBefore: 9999999999, nonce: '0x' + 'cd'.repeat(32) },
      signature: '0xX402SIGNATURE',
    });
    vi.mocked(getUsdcTokenIdentity).mockReset().mockReturnValue(X402_TOKEN_IDENTITY);
  });

  function renderCard(preview: ProposalPreview) {
    return render(
      <WalletContext.Provider value={mockWallet}>
        <ActiveAccountContext.Provider value={{ activeIndex: 0, activeAccount: mockAccount, setActiveIndex: vi.fn() }}>
          <ConfirmationCard preview={preview} onStatusChange={onStatusChange} />
        </ActiveAccountContext.Provider>
      </WalletContext.Provider>
    );
  }

  /** Same tree as renderCard, but lets the test swap `activeAccount` afterwards via rerender. */
  function renderCardAs(preview: ProposalPreview, account: Account) {
    const tree = (acc: Account) => (
      <WalletContext.Provider value={mockWallet}>
        <ActiveAccountContext.Provider value={{ activeIndex: 0, activeAccount: acc, setActiveIndex: vi.fn() }}>
          <ConfirmationCard preview={preview} onStatusChange={onStatusChange} />
        </ActiveAccountContext.Provider>
      </WalletContext.Provider>
    );
    const result = render(tree(account));
    return { ...result, rerenderWithAccount: (acc: Account) => result.rerender(tree(acc)) };
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
    it("Reddet'e basınca hiçbir Network fonksiyonu çağrılmaz, onStatusChange rejected ile çağrılır", () => {
      renderCard(makePreview());
      fireEvent.click(screen.getByRole('button', { name: /reject/i }));

      expect(mockNetwork.sendTransaction).not.toHaveBeenCalled();
      expect(onStatusChange).toHaveBeenCalledTimes(1);
      expect(onStatusChange).toHaveBeenCalledWith({ status: 'rejected', toolName: 'propose_send' });
    });

    // Bütçe/limit dışı bir pay_for_resource önerisi de dahil, her PROPOSAL_TOOLS/X402_TOOLS
    // üyesi için Reddet'e basmak hiçbir imzalama/broadcast/settle yan etkisi tetiklememeli —
    // ve özellikle x402 için ledger'a (X402SpendingLedger) KESİNLİKLE yazılmamalı, çünkü ledger
    // bütçe takibinin tek kaynağı: reddedilen bir ödeme yanlışlıkla harcanmış gibi sayılırsa,
    // kullanıcının gerçek günlük bütçesi sessizce yanlış hesaplanır. handleReject cardPhase'i
    // hiç değiştirmediği için kart "review" fazında kalır — bu yüzden hiçbir
    // TransactionResultCard (pending/success/failed receipt) hiçbir zaman render edilmemeli.
    const REJECT_CASES: Array<{ toolName: string; makePreview: () => ProposalPreview }> = [
      { toolName: 'propose_send', makePreview: () => makePreview() },
      {
        toolName: 'propose_shield',
        makePreview: () => makePreview({ toolName: 'propose_shield', originalArgs: { amount: '0.1', tokenSymbol: 'ETH' } }),
      },
      {
        toolName: 'propose_unshield',
        makePreview: () => makePreview({ toolName: 'propose_unshield', originalArgs: { amount: '0.2', tokenSymbol: 'aeETH' } }),
      },
      { toolName: 'pay_for_resource', makePreview: () => makeX402Preview() },
    ];

    it.each(REJECT_CASES)(
      '"$toolName" reddedildiğinde: hiçbir yan etki tetiklenmez, ledger\'a yazılmaz, TransactionResultCard render edilmez',
      ({ toolName, makePreview: buildPreview }) => {
        renderCard(buildPreview());
        fireEvent.click(screen.getByRole('button', { name: /reject/i }));

        expect(onStatusChange).toHaveBeenCalledTimes(1);
        expect(onStatusChange).toHaveBeenCalledWith({ status: 'rejected', toolName });

        expect(mockNetwork.sendTransaction).not.toHaveBeenCalled();
        expect(mockNetwork.shieldNative).not.toHaveBeenCalled();
        expect(mockNetwork.unshieldAndClaim).not.toHaveBeenCalled();
        expect(signTransferWithAuthorization).not.toHaveBeenCalled();
        expect(settleX402Payment).not.toHaveBeenCalled();

        // Bütçe dışı bir x402 reddi ledger'ı KESİNLİKLE etkilememeli.
        expect(mockRecordPayment).not.toHaveBeenCalled();

        // Kart hâlâ review fazında (Reject/Approve butonları hâlâ orada) — hiçbir receipt yok.
        expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
        expect(screen.queryByText(/successful/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/^Transfer failed$/i)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: /view on explorer/i })).not.toBeInTheDocument();
      }
    );
  });

  // ─── Aktif hesap değişimi ────────────────────────────────────────
  describe('aktif hesap değişimi', () => {
    const otherAccount = { GetAddress: () => '0x00000000000000000000000000000000000bad' } as unknown as Account;

    it('kart review fazındayken aktif hesap değişirse otomatik iptal edilir', async () => {
      const { rerenderWithAccount } = renderCardAs(makePreview(), mockAccount);
      expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();

      rerenderWithAccount(otherAccount);

      await waitFor(() =>
        expect(onStatusChange).toHaveBeenCalledWith({
          status: 'rejected',
          toolName: 'propose_send',
          reason: 'Active account changed before approval',
        })
      );
      expect(onStatusChange).toHaveBeenCalledTimes(1);
      expect(mockNetwork.sendTransaction).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
      expect(screen.getByText(/active account changed/i)).toBeInTheDocument();
    });

    // Regresyon: ACCOUNT_CHANGED_REASON eskiden sabit bir İngilizce string'di ve bu değer
    // AgentProposalHistoryPanel'in `record.reason`'ı hiç çevirmeden ham gösterdiği için, aktif
    // dil Türkçe olsa bile "Agent Geçmişi"nde her zaman İngilizce görünüyordu. Artık bir i18n
    // ANAHTARI (ACCOUNT_CHANGED_REASON_KEY) — bu test, aktif dil Türkçe iken onStatusChange'e
    // giden `reason`'ın da gerçekten Türkçe olduğunu (İngilizce sabitin sızmadığını) kanıtlıyor.
    it('dil Türkçe iken hesap değişimi reason\'ı Türkçe çevrilir (sabit İngilizce metin sızmaz)', async () => {
      await act(async () => {
        changeLanguage('tr');
      });
      try {
        const { rerenderWithAccount } = renderCardAs(makePreview(), mockAccount);
        rerenderWithAccount(otherAccount);

        await waitFor(() =>
          expect(onStatusChange).toHaveBeenCalledWith({
            status: 'rejected',
            toolName: 'propose_send',
            reason: 'Onaydan önce aktif hesap değişti',
          })
        );
        expect(onStatusChange).not.toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'Active account changed before approval' })
        );
      } finally {
        await act(async () => {
          changeLanguage('en');
        });
      }
    });

    it('aynı hesaba "değişim" (referans değişse de adres aynıysa) iptal tetiklemez', () => {
      const sameAddressDifferentInstance = { GetAddress: () => TEST_ADDRESS } as unknown as Account;
      const { rerenderWithAccount } = renderCardAs(makePreview(), mockAccount);

      rerenderWithAccount(sameAddressDifferentInstance);

      expect(onStatusChange).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    });

    it("işlem zaten onaylanmış/tamamlanmışken hesap değişimi onStatusChange'i terminal durumdan sonra tekrar tetiklemez", async () => {
      const { rerenderWithAccount } = renderCardAs(makePreview(), mockAccount);
      fireEvent.click(screen.getByRole('button', { name: /approve/i }));
      await waitFor(() => expect(lastCallWithStatus(onStatusChange, 'confirmed')).toBeDefined());

      const callsAfterResolve = onStatusChange.mock.calls.length;
      rerenderWithAccount(otherAccount);

      expect(onStatusChange).toHaveBeenCalledTimes(callsAfterResolve);
    });
  });

  // ─── propose_send onayı ────────────────────────────────────────
  describe('propose_send onayı', () => {
    it('sendTransaction doğru parametrelerle çağrılır, waitForTransaction beklenir, başarı gösterilir', async () => {
      renderCard(makePreview());
      fireEvent.click(screen.getByRole('button', { name: /approve/i }));

      await waitFor(() => expect(lastCallWithStatus(onStatusChange, 'confirmed')).toBeDefined());

      expect(mockNetwork.sendTransaction).toHaveBeenCalledWith(
        mockAccount,
        { to: RECIPIENT, value: '0.1' },
        expect.any(Function)
      );
      expect(mockNetwork.waitForTransaction).toHaveBeenCalledWith('0xsendhash');
      expect(lastCallWithStatus(onStatusChange, 'confirmed')).toEqual({
        status: 'confirmed',
        toolName: 'propose_send',
        originalArgs: { to: RECIPIENT, amount: '0.1' },
        txHash: '0xsendhash',
        newBalance: { amount: '1.0', symbol: 'ETH' },
      });
      expect(await screen.findByText('Transfer successful')).toBeInTheDocument();
    });

    it('approve başlangıcında ve broadcast anında onStatusChange "pending" ile (sonra txHash ile) çağrılır', async () => {
      let resolveWait!: () => void;
      mockNetwork.waitForTransaction.mockReturnValue(new Promise<void>((resolve) => { resolveWait = resolve; }));
      mockNetwork.sendTransaction.mockImplementation(
        async (_account: unknown, _params: unknown, onBroadcast: (hash: string) => void) => {
          onBroadcast('0xsendhash');
          return '0xsendhash';
        }
      );
      renderCard(makePreview());
      fireEvent.click(screen.getByRole('button', { name: /approve/i }));

      // İlk çağrı: onay anında, henüz hash yok.
      expect(onStatusChange.mock.calls[0][0]).toEqual({
        status: 'pending',
        toolName: 'propose_send',
        originalArgs: { to: RECIPIENT, amount: '0.1' },
      });

      // İkinci çağrı: broadcast anında, artık hash biliniyor.
      await waitFor(() =>
        expect(onStatusChange).toHaveBeenCalledWith({
          status: 'pending',
          toolName: 'propose_send',
          originalArgs: { to: RECIPIENT, amount: '0.1' },
          txHash: '0xsendhash',
        })
      );

      resolveWait();
      await waitFor(() => expect(lastCallWithStatus(onStatusChange, 'confirmed')).toBeDefined());
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

    it('sendTransaction başarısız olursa hata gösterilir, onStatusChange failed ile çağrılır', async () => {
      mockNetwork.sendTransaction.mockRejectedValueOnce(new Error('insufficient funds'));
      renderCard(makePreview());

      fireEvent.click(screen.getByRole('button', { name: /approve/i }));
      await waitFor(() => expect(lastCallWithStatus(onStatusChange, 'failed')).toBeDefined());

      const call = lastCallWithStatus(onStatusChange, 'failed') as ConfirmationOutcome & { status: 'failed' };
      expect(mockNetwork.waitForTransaction).not.toHaveBeenCalled();
      expect(screen.getByText('Transfer failed')).toBeInTheDocument();
      expect(screen.getByText(call.message)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    });

    it('"Tekrar dene" butonuna tıklamak onRetry\'ı aynı toolName+originalArgs ile tetikler', async () => {
      mockNetwork.sendTransaction.mockRejectedValueOnce(new Error('insufficient funds'));
      const preview = makePreview();
      const onRetry = vi.fn();
      render(
        <WalletContext.Provider value={mockWallet}>
          <ActiveAccountContext.Provider value={{ activeIndex: 0, activeAccount: mockAccount, setActiveIndex: vi.fn() }}>
            <ConfirmationCard preview={preview} onStatusChange={onStatusChange} onRetry={onRetry} />
          </ActiveAccountContext.Provider>
        </WalletContext.Provider>
      );

      fireEvent.click(screen.getByRole('button', { name: /approve/i }));
      await waitFor(() => expect(screen.getByRole('button', { name: /try again/i })).toBeEnabled());

      fireEvent.click(screen.getByRole('button', { name: /try again/i }));

      expect(onRetry).toHaveBeenCalledWith('propose_send', preview.originalArgs);
    });

    it('onRetry sağlanmazsa "Tekrar dene" butonu devre dışıdır', async () => {
      mockNetwork.sendTransaction.mockRejectedValueOnce(new Error('insufficient funds'));
      renderCard(makePreview());

      fireEvent.click(screen.getByRole('button', { name: /approve/i }));
      await waitFor(() => expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument());

      expect(screen.getByRole('button', { name: /try again/i })).toBeDisabled();
    });

    // ─── TransactionResultCard entegrasyonu: gerçek Network.ts verisinden render ────
    it('broadcast anında (waitForTransaction henüz dönmeden) hash+Explorer linki gerçek veriden gösterilir', async () => {
      let resolveWait!: () => void;
      mockNetwork.waitForTransaction.mockReturnValue(new Promise<void>((resolve) => { resolveWait = resolve; }));
      // Gerçek Network.sendTransaction, işlem zincire yayınlanır yayınlanmaz (henüz teyit
      // edilmeden) onBroadcast callback'ini çağırır — mock bunu taklit etmeli, aksi halde bu
      // test sadece kendi varsayımını test eder.
      mockNetwork.sendTransaction.mockImplementation(
        async (_account: unknown, _params: unknown, onBroadcast: (hash: string) => void) => {
          onBroadcast('0xsendhash');
          return '0xsendhash';
        }
      );
      renderCard(makePreview());

      fireEvent.click(screen.getByRole('button', { name: /approve/i }));

      // sendTransaction'ın onBroadcast callback'i tetiklenince (waitForTransaction hâlâ
      // bekliyorken) hash ve Explorer linki görünmeli — model hiç devrede değil.
      const link = await screen.findByRole('link', { name: /view on explorer/i });
      expect(link).toHaveAttribute('href', expect.stringContaining('0xsendhash'));
      expect(screen.queryByText('Transfer successful')).not.toBeInTheDocument();

      resolveWait();
      expect(await screen.findByText('Transfer successful')).toBeInTheDocument();
    });

    it('onay sonrası yeni bakiye gerçek getBalance çağrısından render edilir', async () => {
      renderCard(makePreview());
      fireEvent.click(screen.getByRole('button', { name: /approve/i }));

      await screen.findByText('Transfer successful');

      // mockNetwork.getBalance 1 ETH döndürüyor (beforeBalance ile aynı mock) — bu satırın
      // component state'inden (loadNewBalance → network.getBalance) geldiğini doğrular.
      expect(await screen.findByText(/remaining balance/i)).toBeInTheDocument();
      expect(screen.getByText('1.0 ETH')).toBeInTheDocument();
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

      await waitFor(() => expect(lastCallWithStatus(onStatusChange, 'confirmed')).toBeDefined());

      expect(mockNetwork.shieldNative).toHaveBeenCalledWith(mockAccount, WRAPPER, '0.1');
      expect(mockNetwork.waitForTransaction).toHaveBeenCalledWith('0xshieldhash');
      expect(lastCallWithStatus(onStatusChange, 'confirmed')).toEqual({
        status: 'confirmed',
        toolName: 'propose_shield',
        originalArgs: { amount: '0.1', tokenSymbol: 'ETH' },
        txHash: '0xshieldhash',
        newBalance: { amount: '1.0', symbol: 'ETH' },
      });
    });

    it('native wrapper bulunamazsa {error} gösterilir, shieldNative çağrılmaz', async () => {
      mockNetwork.getShieldedPortfolio.mockResolvedValue([]);
      renderCard(makePreview({ toolName: 'propose_shield', originalArgs: { amount: '0.1', tokenSymbol: 'ETH' } }));

      fireEvent.click(screen.getByRole('button', { name: /approve/i }));
      await waitFor(() => expect(lastCallWithStatus(onStatusChange, 'failed')).toBeDefined());

      expect(mockNetwork.shieldNative).not.toHaveBeenCalled();
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

      await waitFor(() => expect(lastCallWithStatus(onStatusChange, 'confirmed')).toBeDefined());

      expect(mockNetwork.unshieldAndClaim).toHaveBeenCalledWith(
        mockAccount,
        WRAPPER,
        '0.2',
        mockWallet.pendingClaimQueue,
        'aeETH',
        expect.any(Function)
      );
      expect(mockNetwork.waitForTransaction).not.toHaveBeenCalled();
      expect(lastCallWithStatus(onStatusChange, 'confirmed')).toEqual({
        status: 'confirmed',
        toolName: 'propose_unshield',
        originalArgs: { amount: '0.2', tokenSymbol: 'aeETH' },
        txHash: '0xunshieldhash',
        newBalance: { amount: '0.5', symbol: 'aeETH' },
      });
    });

    it('bilinmeyen shielded tokenSymbol için unshieldAndClaim çağrılmaz, failed döner', async () => {
      mockNetwork.getShieldedPortfolio.mockResolvedValue([]);
      renderCard(makePreview({ toolName: 'propose_unshield', originalArgs: { amount: '0.2', tokenSymbol: 'aeUSDC' } }));

      fireEvent.click(screen.getByRole('button', { name: /approve/i }));
      await waitFor(() => expect(lastCallWithStatus(onStatusChange, 'failed')).toBeDefined());

      expect(mockNetwork.unshieldAndClaim).not.toHaveBeenCalled();
    });
  });

  // ─── buildConfirmationOutcomeSummary ───────────────────────────
  describe('buildConfirmationOutcomeSummary', () => {
    const t = (key: string, params?: Record<string, string>) => {
      // Minimal stand-in translator matching en.json's interpolation for these keys.
      const map: Record<string, string> = {
        'agent.confirmationCardOutcomeRejected': `rejected:${params?.toolName}`,
        'agent.confirmationCardOutcomeCancelled': `cancelled:${params?.toolName}:${params?.reason}`,
        'agent.confirmationCardOutcomeConfirmed': `confirmed:${params?.toolName}:${params?.txHash}`,
        'agent.confirmationCardOutcomeFailed': `failed:${params?.toolName}:${params?.message}`,
      };
      return map[key] ?? key;
    };

    it('rejected için doğru mesajı üretir', () => {
      expect(buildConfirmationOutcomeSummary({ status: 'rejected', toolName: 'propose_send' }, t)).toBe('rejected:propose_send');
    });

    it('reason\'lı rejected (otomatik iptal) için ayrı bir mesaj üretir', () => {
      expect(
        buildConfirmationOutcomeSummary(
          { status: 'rejected', toolName: 'propose_send', reason: 'Active account changed before approval' },
          t
        )
      ).toBe('cancelled:propose_send:Active account changed before approval');
    });

    it('confirmed için tx hash içeren mesajı üretir', () => {
      expect(
        buildConfirmationOutcomeSummary(
          { status: 'confirmed', toolName: 'propose_shield', originalArgs: {}, txHash: '0xabc' },
          t
        )
      ).toBe('confirmed:propose_shield:0xabc');
    });

    it('failed için hata mesajını içeren mesajı üretir', () => {
      expect(
        buildConfirmationOutcomeSummary(
          { status: 'failed', toolName: 'propose_unshield', originalArgs: {}, message: 'boom' },
          t
        )
      ).toBe('failed:propose_unshield:boom');
    });
  });

  // ─── pay_for_resource (x402, Faz 3) onayı ───────────────────────
  describe('pay_for_resource onayı', () => {
    /** Base Sepolia network mock — the only network x402 approval currently supports. */
    function makeBaseSepoliaWallet(): AppContext {
      const baseSepoliaNetwork = { ...mockNetwork, network_id: NetworkId.Base_Sepolia };
      return {
        networkProvider: { getActiveNetwork: () => baseSepoliaNetwork },
        pendingClaimQueue: { marker: 'pending-claim-queue' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal mock for unit tests
      } as any as AppContext;
    }

    function renderX402Card(preview: ProposalPreview) {
      return render(
        <WalletContext.Provider value={makeBaseSepoliaWallet()}>
          <ActiveAccountContext.Provider value={{ activeIndex: 0, activeAccount: mockAccount, setActiveIndex: vi.fn() }}>
            <ConfirmationCard preview={preview} onStatusChange={onStatusChange} />
          </ActiveAccountContext.Provider>
        </WalletContext.Provider>
      );
    }

    it('önizlemede tutar/sembol (USDC) ve kaynak (resource) gösterilir', () => {
      renderX402Card(makeX402Preview());
      expect(screen.getByText('0.01 USDC will be paid')).toBeInTheDocument();
      expect(screen.getByText(X402_RESOURCE)).toBeInTheDocument();
    });

    it('onaylanınca: gereksinim yeniden çekilir (frozen preview\'a güvenilmez), imzalanır, settle edilir, ledger\'a kaydedilir', async () => {
      renderX402Card(makeX402Preview());
      fireEvent.click(screen.getByRole('button', { name: /approve/i }));

      await waitFor(() => expect(lastCallWithStatus(onStatusChange, 'confirmed')).toBeDefined());

      expect(fetchX402PaymentRequirement).toHaveBeenCalledWith(X402_RESOURCE);
      expect(signTransferWithAuthorization).toHaveBeenCalledWith(
        mockAccount.ethers_wallet,
        X402_TOKEN_IDENTITY,
        expect.objectContaining({ from: TEST_ADDRESS, to: X402_PAY_TO, value: '10000' })
      );
      expect(settleX402Payment).toHaveBeenCalledWith(X402_RESOURCE, expect.objectContaining({ signature: '0xX402SIGNATURE' }));
      expect(mockRecordPayment).toHaveBeenCalledWith(
        expect.objectContaining({ accountAddress: TEST_ADDRESS, amountUsd: 0.01, txHash: '0xX402SETTLEDHASH', service: X402_RESOURCE })
      );

      expect(lastCallWithStatus(onStatusChange, 'confirmed')).toEqual({
        status: 'confirmed',
        toolName: 'pay_for_resource',
        originalArgs: { resource: X402_RESOURCE },
        txHash: '0xX402SETTLEDHASH',
        newBalance: null,
      });
    });

    it('Base Sepolia dışındaki bir ağda onaylanmaya çalışılırsa {failed} ile sonuçlanır, hiçbir şey imzalanmaz', async () => {
      // Varsayılan mockWallet (network_id: 4 — Ethereum Sepolia, x402 için desteklenmiyor).
      render(
        <WalletContext.Provider value={mockWallet}>
          <ActiveAccountContext.Provider value={{ activeIndex: 0, activeAccount: mockAccount, setActiveIndex: vi.fn() }}>
            <ConfirmationCard preview={makeX402Preview()} onStatusChange={onStatusChange} />
          </ActiveAccountContext.Provider>
        </WalletContext.Provider>
      );
      fireEvent.click(screen.getByRole('button', { name: /approve/i }));

      await waitFor(() => expect(lastCallWithStatus(onStatusChange, 'failed')).toBeDefined());
      expect(signTransferWithAuthorization).not.toHaveBeenCalled();
      expect(mockRecordPayment).not.toHaveBeenCalled();
    });

    it('getUsdcTokenIdentity (AgentToolRunner dep) undefined dönerse {failed} ile sonuçlanır, hiçbir şey imzalanmaz', async () => {
      // AgentToolRunner henüz configureAgentToolRunner() ile yapılandırılmamışsa dep undefined
      // döner — Base Sepolia'da bile, USD Coin/USDC domain mismatch'ini önlemek için burada da
      // imzalamadan önce sert biçimde durmalı.
      vi.mocked(getUsdcTokenIdentity).mockReturnValue(undefined);
      renderX402Card(makeX402Preview());
      fireEvent.click(screen.getByRole('button', { name: /approve/i }));

      await waitFor(() => expect(lastCallWithStatus(onStatusChange, 'failed')).toBeDefined());
      expect(signTransferWithAuthorization).not.toHaveBeenCalled();
      expect(mockRecordPayment).not.toHaveBeenCalled();
    });

    it('hesabın ethers_wallet\'ı yoksa (kilitli) {failed} ile sonuçlanır', async () => {
      const lockedAccount = { GetAddress: () => TEST_ADDRESS, ethers_wallet: undefined } as unknown as Account;
      render(
        <WalletContext.Provider value={makeBaseSepoliaWallet()}>
          <ActiveAccountContext.Provider value={{ activeIndex: 0, activeAccount: lockedAccount, setActiveIndex: vi.fn() }}>
            <ConfirmationCard preview={makeX402Preview()} onStatusChange={onStatusChange} />
          </ActiveAccountContext.Provider>
        </WalletContext.Provider>
      );
      fireEvent.click(screen.getByRole('button', { name: /approve/i }));

      await waitFor(() => expect(lastCallWithStatus(onStatusChange, 'failed')).toBeDefined());
      expect(signTransferWithAuthorization).not.toHaveBeenCalled();
    });

    it('settle isteği başarısız olursa {failed} ile sonuçlanır, ledger\'a kaydedilmez', async () => {
      vi.mocked(settleX402Payment).mockRejectedValueOnce(new Error('proxy down'));
      renderX402Card(makeX402Preview());
      fireEvent.click(screen.getByRole('button', { name: /approve/i }));

      await waitFor(() => expect(lastCallWithStatus(onStatusChange, 'failed')).toBeDefined());
      expect(mockRecordPayment).not.toHaveBeenCalled();
    });

    // ── Facilitator hata yolu (gerçek settle reddi) ────────────────────────────────
    //
    // X402ProxyClient.settleX402Payment artık backend-proxy'nin `{error: <ham facilitator
    // nedeni>}` gövdesini gerçekten okuyup thrown Error mesajı olarak taşıyor (bkz.
    // X402ProxyClient.test.tsx) — burada da settleX402Payment'ın mock'u AYNI şekilde davranıyor:
    // gerçek entegrasyondaki gibi facilitator'ın ham nedenini (insufficient_funds,
    // invalid_exact_evm_payload_authorization_valid_before, invalid_exact_evm_signature,
    // invalid_exact_evm_token_name_mismatch, ya da bir route-seviyesi 5xx status koduyla)
    // reddediyor. Her senaryo için üç şey kanıtlanıyor:
    //   (a) ekranda gösterilen mesaj ANLAŞILIR (UserFacingError.ts'in çevirdiği metin) — ham
    //       facilitator kodu asla ekrana sızmıyor,
    //   (b) ledger'a KESİNLİKLE yazılmıyor (başarısız bir ödeme bütçeyi tüketmemeli),
    //   (c) TransactionResultCard "failed" fazını doğru render ediyor ("x402 Payment failed" +
    //       "Tekrar dene" butonu).
    const FACILITATOR_ERROR_CASES: Array<{
      name: string;
      rawError: string;
      expectedMessage: string;
    }> = [
      {
        name: 'yetersiz bakiye (insufficient_funds)',
        rawError: 'insufficient_funds',
        expectedMessage: 'Not enough balance to cover the amount and network fee.',
      },
      {
        name: 'süresi geçmiş EIP-3009 yetkilendirmesi (validBefore)',
        rawError: 'invalid_exact_evm_payload_authorization_valid_before',
        expectedMessage: 'Your payment authorization expired before it could settle. Try again to sign a fresh one.',
      },
      {
        name: 'invalid_exact_evm_signature (EIP-712 domain uyuşmazlığı)',
        rawError: 'invalid_exact_evm_signature',
        expectedMessage: 'The payment facilitator rejected this payment. Please contact support if this keeps happening.',
      },
      {
        name: 'invalid_exact_evm_token_name_mismatch (CONTEXT.md, bölüm 16 Bug 2)',
        rawError: 'invalid_exact_evm_token_name_mismatch',
        expectedMessage: 'The payment facilitator rejected this payment. Please contact support if this keeps happening.',
      },
      {
        name: "facilitator'ın kendisine ulaşılamadı — genel 5xx (X402ProxyClient'ın durum koduna geri düşen mesajı)",
        rawError: 'x402 settle isteği başarısız oldu: 502',
        expectedMessage: 'Server is temporarily unavailable. Please try again later.',
      },
    ];

    it.each(FACILITATOR_ERROR_CASES)(
      '$name: anlaşılır bir mesaj gösterilir, ledger\'a yazılmaz, TransactionResultCard "failed" fazını render eder',
      async ({ rawError, expectedMessage }) => {
        vi.mocked(settleX402Payment).mockRejectedValueOnce(new Error(rawError));
        renderX402Card(makeX402Preview());
        fireEvent.click(screen.getByRole('button', { name: /approve/i }));

        await waitFor(() => expect(lastCallWithStatus(onStatusChange, 'failed')).toBeDefined());

        // (a) Ham facilitator kodu asla ekranda görünmez; anlaşılır çeviri görünür.
        expect(screen.queryByText(rawError)).not.toBeInTheDocument();
        expect(screen.getByText(expectedMessage)).toBeInTheDocument();

        // (b) Başarısız ödeme ledger'ı KESİNLİKLE etkilemedi.
        expect(mockRecordPayment).not.toHaveBeenCalled();

        // (c) Gerçek TransactionResultCard'ın "failed" fazı render edildi.
        expect(screen.getByText('x402 Payment failed')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      }
    );

    it('"Remaining balance" satırı gösterilmez (yanlış varlık — USDC yerine native/shielded olurdu)', () => {
      renderX402Card(makeX402Preview());
      expect(screen.queryByText(/will remain afterwards/i)).not.toBeInTheDocument();
    });
  });
});
