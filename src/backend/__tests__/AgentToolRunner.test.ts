/// <reference types="vitest/globals" />
import {
  executeToolCall,
  configureAgentToolRunner,
  resetAgentToolRunner,
  type AgentToolRunnerDeps,
  type ProposalPreview,
} from '../AgentToolRunner';
import type { Network } from '../Network';
import type Account from '../Account';
import { NetworkId } from '../NetworkTypes';
import type { ShieldedHolding, UnshieldClaim } from '../../types/fhe';
import type { SimResult } from '../TransactionSimulator';

/**
 * @vitest-environment node
 *
 * AgentToolRunner testleri
 *
 * Network.ts, TransactionSimulator ve DomainResolver çağrıları mock'lanır — gerçek RPC/FHE
 * işlemi yapılmaz. Her tool için başarılı çağrı, policy reddi (forbidden/unknown, proposal
 * tool'lar için ratio aşımı) ve hata yutma senaryoları test edilir. propose_* tool'ları için
 * ayrıca: başarılı önizleme, policy reddi (ratio aşımı) ve simülasyon başarısızlığı
 * senaryoları eklenmiştir.
 */

const { mockSimulateTransaction, mockEnrichBalanceChanges } = vi.hoisted(() => ({
  mockSimulateTransaction: vi.fn(),
  mockEnrichBalanceChanges: vi.fn(),
}));

vi.mock('../TransactionSimulator.js', () => ({
  // Must be a real `function`, not an arrow — AgentToolRunner calls `new TransactionSimulator(...)`,
  // and arrow functions can never be used as constructors.
  TransactionSimulator: vi.fn().mockImplementation(function TransactionSimulatorMock() {
    return {
      simulateTransaction: mockSimulateTransaction,
      enrichBalanceChanges: mockEnrichBalanceChanges,
    };
  }),
}));

const { mockIsDomainName, mockResolveDomain } = vi.hoisted(() => ({
  mockIsDomainName: vi.fn((input: string) => input.endsWith('.eth')),
  mockResolveDomain: vi.fn(),
}));

vi.mock('../DomainResolver.js', () => ({
  isDomainName: mockIsDomainName,
  resolveDomain: mockResolveDomain,
}));

// ─── x402 (Faz 3) mocks ──────────────────────────────────────────────
const { mockGetX402Settings, mockGetSpentToday, mockRecordPayment, mockFetchPaymentRequirement, mockSettleX402Payment, mockSignTransferWithAuthorization } = vi.hoisted(() => ({
  mockGetX402Settings: vi.fn(),
  mockGetSpentToday: vi.fn(),
  mockRecordPayment: vi.fn(),
  mockFetchPaymentRequirement: vi.fn(),
  mockSettleX402Payment: vi.fn(),
  mockSignTransferWithAuthorization: vi.fn(),
}));

vi.mock('../X402SettingsService.js', () => ({
  X402SettingsService: { getSettings: mockGetX402Settings },
}));

vi.mock('../X402SpendingLedger.js', () => ({
  // Must be a real `function`, not an arrow — AgentToolRunner calls `new X402SpendingLedger()`.
  X402SpendingLedger: vi.fn().mockImplementation(function X402SpendingLedgerMock() {
    return { getSpentToday: mockGetSpentToday, recordPayment: mockRecordPayment };
  }),
}));

vi.mock('../X402ProxyClient.js', () => ({
  fetchX402PaymentRequirement: mockFetchPaymentRequirement,
  settleX402Payment: mockSettleX402Payment,
}));

vi.mock('../X402PaymentService.js', () => ({
  signTransferWithAuthorization: mockSignTransferWithAuthorization,
  generateAuthorizationNonce: () => '0x' + 'ab'.repeat(32),
}));

describe('AgentToolRunner', () => {
  const context = { account: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', networkId: '11155111' };
  const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

  let mockNetwork: {
    getBalance: ReturnType<typeof vi.fn>;
    getTokenBalance: ReturnType<typeof vi.fn>;
    getWrapperFor: ReturnType<typeof vi.fn>;
    getShieldedPortfolio: ReturnType<typeof vi.fn>;
    getPendingClaims: ReturnType<typeof vi.fn>;
    rpc_url: string;
    currency_symbol: string;
    network_id: NetworkId;
    network_name: string;
  };
  let mockAccount: Account;
  let deps: AgentToolRunnerDeps;

  function makeHolding(overrides: Partial<ShieldedHolding> = {}): ShieldedHolding {
    return {
      wrapper: '0x1111111111111111111111111111111111111111',
      underlying: '0x2222222222222222222222222222222222222222',
      symbol: 'aeETH',
      confidentialDecimals: 6,
      rate: 1000000000000n,
      isNative: true,
      balance: '1.5',
      // A holding whose decrypt succeeded — the flag only turns true when the ciphertext
      // exists on-chain but could not be read.
      decryptFailed: false,
      isLegacy: false,
      ...overrides,
    };
  }

  function makeClaim(overrides: Partial<UnshieldClaim> = {}): UnshieldClaim {
    return {
      // The claim id keys the claim on-chain; the handle carries the amount. Settlement
      // needs both, so a fixture missing either would not exercise the real path.
      id: '0xc1a1m',
      to: context.account,
      ctHash: '0xabc',
      decryptedAmount: 0n,
      claimed: false,
      ...overrides,
    };
  }

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

  beforeEach(() => {
    resetAgentToolRunner();
    mockSimulateTransaction.mockReset();
    mockEnrichBalanceChanges.mockReset().mockResolvedValue(undefined);
    mockIsDomainName.mockReset().mockImplementation((input: string) => input.endsWith('.eth'));
    mockResolveDomain.mockReset();

    mockGetX402Settings.mockReset().mockResolvedValue({ enabled: true, perTransactionCapUsd: 0.5, dailyBudgetCapUsd: 5 });
    mockGetSpentToday.mockReset().mockResolvedValue(0);
    mockRecordPayment.mockReset().mockResolvedValue(undefined);
    mockFetchPaymentRequirement.mockReset().mockResolvedValue({
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
    mockSettleX402Payment.mockReset().mockResolvedValue({ success: true, txHash: '0xSETTLEDHASH' });
    mockSignTransferWithAuthorization.mockReset().mockResolvedValue({
      authorization: { from: context.account, to: '0x00000000000000000000000000000000000000f1', value: '10000', validAfter: 0, validBefore: 9999999999, nonce: '0x' + 'ab'.repeat(32) },
      signature: '0xSIGNATURE',
    });

    mockNetwork = {
      getBalance: vi.fn().mockResolvedValue('1000000000000000000'), // 1 ETH
      getTokenBalance: vi.fn().mockResolvedValue('1000'), // 1000 USDC
      // Varsayılan: bu ağda o token için henüz wrapper deploy edilmemiş. Wrapper bekleyen
      // testler bunu kendi içinde override eder.
      getWrapperFor: vi.fn().mockResolvedValue(null),
      getShieldedPortfolio: vi.fn().mockResolvedValue([]),
      getPendingClaims: vi.fn().mockResolvedValue([]),
      rpc_url: 'https://rpc.example.test',
      currency_symbol: 'ETH',
      // Sepolia because that is the network SwapService's curated registry actually carries
      // USDC on — the ERC-20 send path resolves its symbol through that registry, so a
      // placeholder id here would make every token test fail for the wrong reason.
      network_id: NetworkId.Ethereum_Sepolia,
      network_name: 'Sepolia',
    };
    mockAccount = {
      GetAddress: () => context.account,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal signer stand-in for x402 tests
      ethers_wallet: { signTypedData: vi.fn() } as any,
    } as unknown as Account;
    deps = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal mock for unit tests
      getNetwork: vi.fn(() => mockNetwork as any as Network),
      getAccount: vi.fn(() => mockAccount),
      getUsdcTokenIdentity: vi.fn(() => ({
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        name: 'USD Coin',
        version: '2',
        chainId: 84532,
      })),
      getConnectedSites: vi.fn().mockResolvedValue({ injectedSites: [], walletConnectSessions: [] }),
      createAccount: vi.fn((name?: string) => ({ index: 1, address: '0xNEWACCOUNT', name: name ?? 'Account 2' })),
      listAccounts: vi.fn(() => [
        { index: 0, name: 'biar', address: '0xc27c79000000000000000000000000000000a1a1', isActive: false },
        { index: 1, name: 'New User #1', address: '0x003c36c8Eaa07e61165D06F2fC7c72B32cd1d0df', isActive: true },
        { index: 2, name: 'Ikiz', address: '0x1111111111111111111111111111111111111111', isActive: false },
        { index: 3, name: 'Ikiz', address: '0x2222222222222222222222222222222222222222', isActive: false },
      ]),
    };
    configureAgentToolRunner(deps);
  });

  // ─── Not configured ────────────────────────────────────────────
  it('configureAgentToolRunner çağrılmadan hata döner, throw etmez', async () => {
    resetAgentToolRunner();
    const res = await executeToolCall('get_balance', {}, context);
    expect(res.error).toBeDefined();
    expect(res.result).toBeUndefined();
  });

  // ─── get_accounts ──────────────────────────────────────────────
  describe('get_accounts', () => {
    it('tüm hesapları isim/adres ve aktif bayrağıyla döner', async () => {
      const res = await executeToolCall('get_accounts', {}, context);
      expect(res.error).toBeUndefined();
      const result = res.result as { count: number; accounts: { name: string; address: string; isActive: boolean }[] };
      expect(result.count).toBe(4);
      expect(result.accounts.map((a) => a.name)).toContain('biar');
      expect(result.accounts.filter((a) => a.isActive)).toHaveLength(1);
    });
  });

  // ─── hesap adıyla gönderim ─────────────────────────────────────
  describe('propose_send — alıcı olarak hesap adı', () => {
    it('hesap adı adrese çözümlenir ve onaya RESOLVED adres taşınır', async () => {
      mockSimulateTransaction.mockResolvedValueOnce(makeSimResult());
      const res = await executeToolCall('propose_send', { to: 'biar', amount: '0.1' }, context);

      expect(res.error).toBeUndefined();
      const [tx] = mockSimulateTransaction.mock.calls.at(-1)!;
      expect(tx.to).toBe('0xc27c79000000000000000000000000000000a1a1');

      // ConfirmationCard originalArgs.to'yu okuyup ona imza atıyor — orada isim kalırsa
      // önizlenen alıcı ile imzalanan alıcı ayrışabilir.
      const preview = res.result as { originalArgs: { to: string } };
      expect(preview.originalArgs.to).toBe('0xc27c79000000000000000000000000000000a1a1');
    });

    it('büyük/küçük harf ve boşluk farkı tolere edilir', async () => {
      mockSimulateTransaction.mockResolvedValueOnce(makeSimResult());
      const res = await executeToolCall('propose_send', { to: '  BIAR ', amount: '0.1' }, context);
      expect(res.error).toBeUndefined();
      const [tx] = mockSimulateTransaction.mock.calls.at(-1)!;
      expect(tx.to).toBe('0xc27c79000000000000000000000000000000a1a1');
    });

    it('kısmi eşleşme kabul edilmez — yanlış hesaba göndermez', async () => {
      // 'New User' tek başına 'New User #1'i seçmemeli.
      const res = await executeToolCall('propose_send', { to: 'New User', amount: '0.1' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('New User');
      expect(mockSimulateTransaction).not.toHaveBeenCalled();
    });

    it('aynı isimde iki hesap varsa seçim yapmaz, hata verir', async () => {
      const res = await executeToolCall('propose_send', { to: 'Ikiz', amount: '0.1' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toMatch(/birden fazla/);
      expect(mockSimulateTransaction).not.toHaveBeenCalled();
    });

    it('bilinmeyen isim için mevcut hesap adlarını sayar, simüle etmez', async () => {
      const res = await executeToolCall('propose_send', { to: 'yok-boyle-hesap', amount: '0.1' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('biar');
      expect(mockSimulateTransaction).not.toHaveBeenCalled();
    });

    it('0x adresi hesap adı çözümlemesine hiç girmez', async () => {
      mockSimulateTransaction.mockResolvedValueOnce(makeSimResult());
      const res = await executeToolCall('propose_send', { to: RECIPIENT, amount: '0.1' }, context);
      expect(res.error).toBeUndefined();
      expect(deps.listAccounts).not.toHaveBeenCalled();
    });
  });

  // ─── get_token_balances ────────────────────────────────────────
  describe('get_token_balances', () => {
    it('native bakiyeyi ve ağın kayıtlı ERC-20 bakiyelerini birlikte döner', async () => {
      const res = await executeToolCall('get_token_balances', {}, context);
      expect(res.error).toBeUndefined();

      const result = res.result as {
        address: string;
        network: string;
        native: { symbol: string; balance: string };
        tokens: { symbol: string; address: string; decimals: number; balance: string }[];
      };
      expect(result.address).toBe(context.account);
      expect(result.native).toEqual({ symbol: 'ETH', balance: '1.0' });

      // Sepolia'nın kayıtlı ERC-20'leri — native listeye girmemeli.
      const symbols = result.tokens.map((t) => t.symbol);
      expect(symbols).toContain('USDC');
      expect(symbols).toContain('LINK');
      expect(symbols).not.toContain('ETH');

      // USDC 6 haneli; yanlış decimals gönderim miktarını milyon kat kaydırır.
      expect(result.tokens.find((t) => t.symbol === 'USDC')?.decimals).toBe(6);
      expect(mockNetwork.getTokenBalance).toHaveBeenCalled();
    });

    it('bakiyesi 0 olan token listeden düşmez', async () => {
      mockNetwork.getTokenBalance.mockResolvedValue('0');
      const res = await executeToolCall('get_token_balances', {}, context);
      const result = res.result as { tokens: { symbol: string; balance: string }[] };
      // "USDC'niz yok" gerçek bir cevap; satırı gizlemek modele tokenın o ağda hiç
      // bulunmadığını söyletiyor.
      expect(result.tokens.length).toBeGreaterThan(0);
      expect(result.tokens.every((t) => t.balance === '0')).toBe(true);
    });
  });

  // ─── get_balance ───────────────────────────────────────────────
  describe('get_balance', () => {
    it('başarılı çağrı network.getBalance sonucunu döner', async () => {
      const res = await executeToolCall('get_balance', {}, context);
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({ address: context.account, network: 'Sepolia', balance: '1.0', balanceWei: '1000000000000000000' });
      expect(mockNetwork.getBalance).toHaveBeenCalledWith(context.account);
    });

    it('Network.ts hata fırlatırsa ham exception sızmaz, {error} döner', async () => {
      mockNetwork.getBalance.mockRejectedValueOnce(new Error('RPC boom'));
      const res = await executeToolCall('get_balance', {}, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('RPC boom');
    });
  });

  // ─── get_shielded_balance ────────────────────────────────────
  describe('get_shielded_balance', () => {
    it('eşleşen sembol bulunursa serileştirilmiş bakiyeyi döner', async () => {
      mockNetwork.getShieldedPortfolio.mockResolvedValueOnce([makeHolding()]);
      const res = await executeToolCall('get_shielded_balance', { tokenSymbol: 'aeeth' }, context);
      expect(res.error).toBeUndefined();
      const result = res.result as Record<string, unknown>;
      expect(result.found).toBe(true);
      expect(result.balance).toBe('1.5');
      // bigint rate JSON-güvenli bir string olarak dönmeli
      expect(result.rate).toBe('1000000000000');
      expect(typeof result.rate).toBe('string');
    });

    it('eşleşen sembol yoksa found:false ve "0.0" bakiye döner (throw etmez)', async () => {
      mockNetwork.getShieldedPortfolio.mockResolvedValueOnce([makeHolding({ symbol: 'aeUSDC' })]);
      const res = await executeToolCall('get_shielded_balance', { tokenSymbol: 'aeETH' }, context);
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({ tokenSymbol: 'aeETH', found: false, balance: '0.0' });
    });

    it('tokenSymbol eksikse {error} döner', async () => {
      const res = await executeToolCall('get_shielded_balance', {}, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('tokenSymbol');
    });

    it('hesap bulunamazsa (kilitli cüzdan) {error} döner', async () => {
      deps.getAccount = vi.fn(() => undefined);
      configureAgentToolRunner(deps);
      const res = await executeToolCall('get_shielded_balance', { tokenSymbol: 'aeETH' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('Hesap bulunamadı');
    });
  });

  // ─── get_shielded_portfolio ────────────────────────────────────
  describe('get_shielded_portfolio', () => {
    it('tüm holdingleri bigint alanlar stringlenmiş halde döner', async () => {
      mockNetwork.getShieldedPortfolio.mockResolvedValueOnce([makeHolding(), makeHolding({ symbol: 'aeUSDC', rate: 1n })]);
      const res = await executeToolCall('get_shielded_portfolio', {}, context);
      expect(res.error).toBeUndefined();
      const result = res.result as Record<string, unknown>[];
      expect(result).toHaveLength(2);
      expect(result[0].rate).toBe('1000000000000');
      expect(result[1].rate).toBe('1');
    });
  });

  // ─── get_pending_claims ────────────────────────────────────────
  describe('get_pending_claims', () => {
    it('bekleyen talebi olan tokenlar için stringlenmiş claim listesi döner', async () => {
      mockNetwork.getShieldedPortfolio.mockResolvedValueOnce([makeHolding()]);
      mockNetwork.getPendingClaims.mockResolvedValueOnce([makeClaim()]);

      const res = await executeToolCall('get_pending_claims', {}, context);
      expect(res.error).toBeUndefined();
      const result = res.result as Record<string, unknown>[];
      expect(result).toHaveLength(1);
      expect(result[0].tokenSymbol).toBe('aeETH');
      const claims = result[0].claims as Record<string, unknown>[];
      // The contracts dropped `requestedAmount` in confidential-contracts 0.4; only the
      // amount proven at settlement survives, and the claim id is what settles it.
      expect(claims[0].id).toBe('0xc1a1m');
      expect(claims[0].decryptedAmount).toBe('0');
      // Serialized as a string: these are uint64 on-chain and JSON has no bigint.
      expect(typeof claims[0].decryptedAmount).toBe('string');
    });

    it('bekleyen talebi olmayan tokenlar sonuçtan filtrelenir', async () => {
      mockNetwork.getShieldedPortfolio.mockResolvedValueOnce([makeHolding()]);
      mockNetwork.getPendingClaims.mockResolvedValueOnce([]);

      const res = await executeToolCall('get_pending_claims', {}, context);
      expect(res.result).toEqual([]);
    });

    it('tokenSymbol verilirse sadece o token için getPendingClaims çağrılır', async () => {
      mockNetwork.getShieldedPortfolio.mockResolvedValueOnce([
        makeHolding({ symbol: 'aeETH', wrapper: '0xAAA' }),
        makeHolding({ symbol: 'aeUSDC', wrapper: '0xBBB' }),
      ]);
      mockNetwork.getPendingClaims.mockResolvedValue([makeClaim()]);

      await executeToolCall('get_pending_claims', { tokenSymbol: 'aeUSDC' }, context);
      expect(mockNetwork.getPendingClaims).toHaveBeenCalledTimes(1);
      expect(mockNetwork.getPendingClaims).toHaveBeenCalledWith('0xBBB', context.account);
    });
  });

  // ─── Policy gating (forbidden / unknown) ─────────────────────────
  describe('policy gating', () => {
    it('bilinmeyen tool throw etmez, {error} döner', async () => {
      const res = await executeToolCall('drain_wallet', {}, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toBeDefined();
    });

    it('forbidden tool (set_operator) reddedilir', async () => {
      const res = await executeToolCall('set_operator', {}, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toBeDefined();
      expect(mockNetwork.getBalance).not.toHaveBeenCalled();
    });

    // AgentPolicyEngine.evaluate()'in reasonKey/reasonParams'ı — kullanıcıya-gösterilen çeviri
    // anahtarı — executeToolCall'ın {error} sonucuna da taşınıyor mu? Bu, AgentOrchestrator.ts'in
    // wire-format tool mesajına (runOneToolCall) ve oradan AgentProposalHistory.ts'in
    // extractPolicyDenials()'ına ulaşmasının TEK yolu — bkz. ToolExecutionResult'ın kendi JSDoc'u.
    it('forbidden tool reddi: {error} ile birlikte reasonKey + reasonParams da döner (ham "reason" İngilizce metinle birebir aynı kalır)', async () => {
      const res = await executeToolCall('set_operator', {}, context);
      expect(res.reasonKey).toBe('agent.policyReasonForbiddenTool');
      expect(res.reasonParams).toEqual({ toolName: 'set_operator' });
      expect(res.error).toBe('"set_operator" is a forbidden tool and is never exposed to the agent.');
    });

    it('bilinmeyen tool reddi de reasonKey + reasonParams taşır', async () => {
      const res = await executeToolCall('drain_wallet', {}, context);
      expect(res.reasonKey).toBe('agent.policyReasonUnknownTool');
      expect(res.reasonParams).toEqual({ toolName: 'drain_wallet' });
    });
  });

  // ─── propose_send ─────────────────────────────────────────────
  describe('propose_send', () => {
    it('başarılı önizleme: requiresConfirmation + simulation + toolName + originalArgs döner', async () => {
      const simResult = makeSimResult({ balanceChanges: [{ tokenAddress: 'ETH', symbol: 'ETH', decimals: 18, amountWei: '100000000000000000', from: context.account, to: RECIPIENT, type: 'NATIVE' }] });
      mockSimulateTransaction.mockResolvedValueOnce(simResult);

      const args = { to: RECIPIENT, amount: '0.1' };
      const res = await executeToolCall('propose_send', args, context);

      expect(res.error).toBeUndefined();
      const preview = res.result as ProposalPreview;
      expect(preview.requiresConfirmation).toBe(true);
      expect(preview.toolName).toBe('propose_send');
      expect(preview.originalArgs).toEqual(args);
      expect(preview.simulation).toBe(simResult);

      expect(mockSimulateTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ from: context.account, to: RECIPIENT, value: '100000000000000000' })
      );
      expect(mockEnrichBalanceChanges).toHaveBeenCalledWith(simResult);
    });

    it('bakiyenin %50sini aşan öneri policy tarafından reddedilir, simüle edilmez', async () => {
      // Balance 1 ETH (mockNetwork.getBalance default), 0.6 ETH gönderimi %60 eder.
      const res = await executeToolCall('propose_send', { to: RECIPIENT, amount: '0.6' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toMatch(/50/);
      expect(mockSimulateTransaction).not.toHaveBeenCalled();
    });

    it('simülasyon başarısız olursa (ör. yetersiz bakiye) throw etmeden {error} döner', async () => {
      mockSimulateTransaction.mockResolvedValueOnce(
        makeSimResult({ success: false, error: 'Yetersiz Bakiye: bu işlemi karşılamak için yeterli ETH yok.', riskLevel: 'CRITICAL' })
      );
      const res = await executeToolCall('propose_send', { to: RECIPIENT, amount: '0.1' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('Yetersiz Bakiye');
    });

    it('to/amount eksikse simüle etmeden {error} döner', async () => {
      const res = await executeToolCall('propose_send', { to: RECIPIENT }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('amount');
      expect(mockSimulateTransaction).not.toHaveBeenCalled();
    });

    it('tanınan bir ERC-20 sembolü token kontratına transfer olarak simüle edilir', async () => {
      mockSimulateTransaction.mockResolvedValueOnce(makeSimResult());
      const res = await executeToolCall('propose_send', { to: RECIPIENT, amount: '1', tokenSymbol: 'USDC' }, context);

      expect(res.error).toBeUndefined();
      expect(res.result).toMatchObject({ requiresConfirmation: true, toolName: 'propose_send' });

      // Sepolia USDC. `to` alıcı DEĞİL token kontratıdır, value 0'dır ve miktar calldata'da
      // taşınır — 6 haneli USDC için 1 token = 1_000_000, 1e18 değil.
      const [tx] = mockSimulateTransaction.mock.calls.at(-1)!;
      expect(tx.to.toLowerCase()).toBe('0x1c7d4b196cb0c7b01d743fbc6116a902379c7238');
      expect(tx.value).toBe('0');
      expect(tx.data).toMatch(/^0xa9059cbb/); // transfer(address,uint256)
      expect(tx.data.toLowerCase()).toContain(RECIPIENT.slice(2).toLowerCase());
      expect(BigInt('0x' + tx.data.slice(-64))).toBe(1_000_000n);
    });

    it('ERC-20 gönderiminde policy oranı native değil TOKEN bakiyesine göre uygulanır', async () => {
      // 1000 USDC bakiye (mockNetwork.getTokenBalance), 600 USDC gönderimi %60 eder —
      // native bakiye 1 ETH olduğu halde reddedilmeli.
      const res = await executeToolCall('propose_send', { to: RECIPIENT, amount: '600', tokenSymbol: 'USDC' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toMatch(/50/);
      expect(mockSimulateTransaction).not.toHaveBeenCalled();
    });

    it('tanınmayan tokenSymbol için hangi tokenların gönderilebileceğini söyler, simüle etmez', async () => {
      const res = await executeToolCall('propose_send', { to: RECIPIENT, amount: '1', tokenSymbol: 'DOGE' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('DOGE');
      expect(res.error).toContain('USDC'); // ne gönderilebileceğini isimlendirir
      expect(mockSimulateTransaction).not.toHaveBeenCalled();
    });

    it('ENS alan adı reddedilir — çözümlenmez, simüle edilmez', async () => {
      // Bu sürüm testnet-only; alan adları ise DomainResolver tarafından her zaman
      // MAINNET'ten çözümleniyor. Çözümleme başarılı olsa bile alıcı olarak kabul edilmemeli.
      mockResolveDomain.mockResolvedValueOnce({ address: RECIPIENT, method: 'ens', error: null });

      const res = await executeToolCall('propose_send', { to: 'vitalik.eth', amount: '0.1' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('vitalik.eth');
      expect(res.error).toMatch(/testnet/i);
      expect(mockResolveDomain).not.toHaveBeenCalled(); // mainnet'e hiç sorulmamalı
      expect(mockSimulateTransaction).not.toHaveBeenCalled();
    });

    it('Unstoppable alan adı da reddedilir', async () => {
      const res = await executeToolCall('propose_send', { to: 'birisi.crypto', amount: '0.1' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('birisi.crypto');
      expect(mockResolveDomain).not.toHaveBeenCalled();
      expect(mockSimulateTransaction).not.toHaveBeenCalled();
    });

    it('gizli transferde de alan adı reddedilir', async () => {
      mockNetwork.getShieldedPortfolio.mockResolvedValueOnce([makeHolding({ isNative: true })]);
      const res = await executeToolCall(
        'propose_confidential_transfer',
        { to: 'vitalik.eth', amount: '0.1', tokenSymbol: 'aeETH' },
        context
      );
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('vitalik.eth');
      expect(mockResolveDomain).not.toHaveBeenCalled();
    });
  });

  // ─── propose_shield ───────────────────────────────────────────
  describe('propose_shield', () => {
    it('başarılı önizleme: native wrapper adresine shieldNative çağrısı simüle edilir', async () => {
      mockNetwork.getShieldedPortfolio.mockResolvedValueOnce([makeHolding({ isNative: true, wrapper: '0xWRAP' })]);
      const simResult = makeSimResult({ operationType: 'wrapETH' });
      mockSimulateTransaction.mockResolvedValueOnce(simResult);

      const args = { amount: '0.1', tokenSymbol: 'ETH' };
      const res = await executeToolCall('propose_shield', args, context);

      expect(res.error).toBeUndefined();
      const preview = res.result as ProposalPreview;
      expect(preview.requiresConfirmation).toBe(true);
      expect(preview.toolName).toBe('propose_shield');
      expect(preview.simulation).toBe(simResult);

      expect(mockSimulateTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ from: context.account, to: '0xWRAP', value: '100000000000000000' })
      );
    });

    it('bakiyenin %50sini aşan öneri reddedilir, portfolio hiç sorgulanmaz', async () => {
      const res = await executeToolCall('propose_shield', { amount: '0.6', tokenSymbol: 'ETH' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toMatch(/50/);
      expect(mockNetwork.getShieldedPortfolio).not.toHaveBeenCalled();
      expect(mockSimulateTransaction).not.toHaveBeenCalled();
    });

    it('simülasyon başarısız olursa {error} döner, throw etmez', async () => {
      mockNetwork.getShieldedPortfolio.mockResolvedValueOnce([makeHolding({ isNative: true, wrapper: '0xWRAP' })]);
      mockSimulateTransaction.mockResolvedValueOnce(makeSimResult({ success: false, error: 'İşlem başarısız olacak.' }));

      const res = await executeToolCall('propose_shield', { amount: '0.1', tokenSymbol: 'ETH' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('İşlem başarısız olacak');
    });

    it('tanınan ERC-20 için wrapper yoksa deploy edilmediğini söyler, simüle etmez', async () => {
      // USDC kayıtlı bir token, dolayısıyla registry'yi geçer — burada duran şey wrapper'ın
      // yokluğu. Eski hali bu testi mock'ta network_id olmadığı için geçiyordu ve kodun
      // ERC-20 shield'ı desteklemediğini iddia ediyordu; desteklıyor.
      const res = await executeToolCall('propose_shield', { amount: '1', tokenSymbol: 'USDC' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('deploy edilmemiş');
      expect(mockSimulateTransaction).not.toHaveBeenCalled();
    });

    it('registry\'de olmayan tokenSymbol için desteklenmediğini belirtir', async () => {
      const res = await executeToolCall('propose_shield', { amount: '1', tokenSymbol: 'DOGE' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('desteklenmiyor');
      expect(mockNetwork.getWrapperFor).not.toHaveBeenCalled();
      expect(mockSimulateTransaction).not.toHaveBeenCalled();
    });

    it('hesap bulunamazsa {error} döner', async () => {
      deps.getAccount = vi.fn(() => undefined);
      configureAgentToolRunner(deps);
      const res = await executeToolCall('propose_shield', { amount: '0.1', tokenSymbol: 'ETH' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('Hesap bulunamadı');
    });
  });

  // ─── propose_unshield ─────────────────────────────────────────
  describe('propose_unshield', () => {
    it('başarılı önizleme: shielded wrapper adresine unshield çağrısı simüle edilir', async () => {
      mockNetwork.getShieldedPortfolio.mockResolvedValueOnce([makeHolding({ symbol: 'aeETH', wrapper: '0xWRAP', balance: '1.5', confidentialDecimals: 6 })]);
      const simResult = makeSimResult({ operationType: 'unwrap' });
      mockSimulateTransaction.mockResolvedValueOnce(simResult);

      const args = { amount: '0.5', tokenSymbol: 'aeETH' };
      const res = await executeToolCall('propose_unshield', args, context);

      expect(res.error).toBeUndefined();
      const preview = res.result as ProposalPreview;
      expect(preview.requiresConfirmation).toBe(true);
      expect(preview.toolName).toBe('propose_unshield');
      expect(preview.simulation).toBe(simResult);

      expect(mockSimulateTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ from: context.account, to: '0xWRAP', value: '0' })
      );
    });

    it('bakiyenin %50sini aşan öneri reddedilir (confidential bakiyeye göre)', async () => {
      // balance 1.5, %50'si 0.75 — 1.0 istemek reddedilmeli.
      mockNetwork.getShieldedPortfolio.mockResolvedValueOnce([makeHolding({ symbol: 'aeETH', balance: '1.5' })]);
      const res = await executeToolCall('propose_unshield', { amount: '1.0', tokenSymbol: 'aeETH' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toMatch(/50/);
      expect(mockSimulateTransaction).not.toHaveBeenCalled();
    });

    it('simülasyon başarısız olursa {error} döner, throw etmez', async () => {
      mockNetwork.getShieldedPortfolio.mockResolvedValueOnce([makeHolding({ symbol: 'aeETH', balance: '1.5' })]);
      mockSimulateTransaction.mockResolvedValueOnce(makeSimResult({ success: false, error: 'Geçersiz alıcı adresi.' }));

      const res = await executeToolCall('propose_unshield', { amount: '0.5', tokenSymbol: 'aeETH' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('Geçersiz alıcı adresi');
    });

    it('bilinmeyen shielded tokenSymbol için {error} döner, simüle etmez', async () => {
      mockNetwork.getShieldedPortfolio.mockResolvedValueOnce([makeHolding({ symbol: 'aeUSDC' })]);
      const res = await executeToolCall('propose_unshield', { amount: '0.1', tokenSymbol: 'aeETH' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('aeETH');
      expect(mockSimulateTransaction).not.toHaveBeenCalled();
    });
  });

  // ─── Proposal oturum limiti ile etkileşim ─────────────────────
  describe('proposal session limiti', () => {
    it('reddedilen bir öneri session sayacını tüketmez (aynı tool tekrar denenebilir)', async () => {
      // İlk deneme ratio aşımından reddedilir.
      const denied = await executeToolCall('propose_send', { to: RECIPIENT, amount: '0.6' }, context);
      expect(denied.error).toBeDefined();

      // İkinci deneme (geçerli miktar) başarıyla önizlenebilmeli — reddedilen ilk deneme
      // AgentPolicyEngine'in oturum sayacını tüketmemiş olmalı.
      mockSimulateTransaction.mockResolvedValueOnce(makeSimResult());
      const allowed = await executeToolCall('propose_send', { to: RECIPIENT, amount: '0.1' }, context);
      expect(allowed.error).toBeUndefined();
      expect((allowed.result as ProposalPreview).requiresConfirmation).toBe(true);
    });

    it('bakiye oranı aşımıyla reddedilen bir öneri de reasonKey + reasonParams taşır (kullanıcıya-gösterilen çeviri için)', async () => {
      const denied = await executeToolCall('propose_send', { to: RECIPIENT, amount: '0.6' }, context);
      expect(denied.reasonKey).toBe('agent.policyReasonExceedsBalanceRatio');
      expect(denied.reasonParams).toBeDefined();
      expect(denied.reasonParams?.ratio).toBeDefined();
      expect(denied.reasonParams?.limit).toBeDefined();
    });
  });

  // ─── pay_for_resource (x402, Faz 3) ────────────────────────────
  describe('pay_for_resource', () => {
    const RESOURCE = 'https://api.example.com/weather';

    it('"resource" eksikse {error} döner, proxy hiç çağrılmaz', async () => {
      const res = await executeToolCall('pay_for_resource', {}, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toMatch(/resource/);
      expect(mockFetchPaymentRequirement).not.toHaveBeenCalled();
    });

    it('proxy (payment-required) hata fırlatırsa {error} döner, throw etmez', async () => {
      mockFetchPaymentRequirement.mockRejectedValueOnce(new Error('proxy unreachable'));
      const res = await executeToolCall('pay_for_resource', { resource: RESOURCE }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('proxy unreachable');
    });

    it('x402 kapalıysa {error} döner, ledger\'a hiçbir şey yazılmaz, imzalanmaz', async () => {
      mockGetX402Settings.mockResolvedValueOnce({ enabled: false, perTransactionCapUsd: 0.5, dailyBudgetCapUsd: 5 });
      const res = await executeToolCall('pay_for_resource', { resource: RESOURCE }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toBeDefined();
      expect(mockSignTransferWithAuthorization).not.toHaveBeenCalled();
      expect(mockRecordPayment).not.toHaveBeenCalled();
    });

    // AgentPolicyEngine.evaluateX402Payment()'ın x402_disabled reasonKey'i — PROPOSAL_TOOLS'un
    // evaluate() denial'ları gibi — artık pay_for_resource'un {error} sonucuna da taşınıyor.
    // Önceden handlePayForResource bunu düz bir ToolArgumentError olarak throw ediyordu (ham
    // "reason" metni korunuyordu ama reasonKey/reasonParams tamamen kayboluyordu) — bkz.
    // AgentToolRunner.ts'teki PolicyDenialError. Bu, AgentProposalHistory.extractPolicyDenials()'ın
    // bir pay_for_resource reddini de çevrilebilir hâle getirmesinin TEK yolu.
    it('x402 kapalıyken dönen {error} reasonKey + reasonParams de taşır (kullanıcıya-gösterilen çeviri için)', async () => {
      mockGetX402Settings.mockResolvedValueOnce({ enabled: false, perTransactionCapUsd: 0.5, dailyBudgetCapUsd: 5 });
      const res = await executeToolCall('pay_for_resource', { resource: RESOURCE }, context);
      expect(res.reasonKey).toBe('agent.policyReasonX402Disabled');
      expect(res.reasonParams).toBeUndefined();
      expect(res.error).toBe('x402 payments are disabled in settings.');
    });

    it('limit içindeyse OTOMATİK öder: imzalar, settle eder, ledger\'a kaydeder, autoPaid:true döner — model hiçbir karar vermez', async () => {
      const res = await executeToolCall('pay_for_resource', { resource: RESOURCE }, context);

      expect(res.error).toBeUndefined();
      const result = res.result as { autoPaid: true; toolName: string; resource: string; amountUsd: number; txHash: string; remainingBudgetUsd: number };
      expect(result.autoPaid).toBe(true);
      expect(result.toolName).toBe('pay_for_resource');
      expect(result.resource).toBe(RESOURCE);
      expect(result.amountUsd).toBeCloseTo(0.01, 10);
      expect(result.txHash).toBe('0xSETTLEDHASH');
      expect(result.remainingBudgetUsd).toBeCloseTo(5 - 0.01, 10);

      // Doğru sırayla: imzala -> settle et -> ledger'a kaydet.
      expect(mockSignTransferWithAuthorization).toHaveBeenCalledWith(
        mockAccount.ethers_wallet,
        { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', name: 'USD Coin', version: '2', chainId: 84532 },
        expect.objectContaining({
          from: context.account,
          to: '0x00000000000000000000000000000000000000f1',
          value: '10000',
        })
      );
      expect(mockSettleX402Payment).toHaveBeenCalledWith(RESOURCE, expect.objectContaining({ signature: '0xSIGNATURE' }));
      expect(mockRecordPayment).toHaveBeenCalledWith(
        expect.objectContaining({ accountAddress: context.account, amountUsd: 0.01, txHash: '0xSETTLEDHASH', service: RESOURCE })
      );
    });

    it('limit dışındaysa ConfirmationCard uyumlu bir preview döner (requiresConfirmation:true) — İMZALANMAZ, ödenmez, ledger\'a yazılmaz', async () => {
      mockGetX402Settings.mockResolvedValueOnce({ enabled: true, perTransactionCapUsd: 0.001, dailyBudgetCapUsd: 5 }); // 0.01 > 0.001 tavanı

      const res = await executeToolCall('pay_for_resource', { resource: RESOURCE }, context);

      expect(res.error).toBeUndefined();
      const preview = res.result as ProposalPreview;
      expect(preview.requiresConfirmation).toBe(true);
      expect(preview.toolName).toBe('pay_for_resource');
      expect(preview.originalArgs).toEqual({ resource: RESOURCE });
      expect(preview.simulation.success).toBe(true);
      expect(preview.simulation.balanceChanges[0]).toMatchObject({
        symbol: 'USDC',
        amountFormatted: '0.01',
        to: '0x00000000000000000000000000000000000000f1',
      });

      expect(mockSignTransferWithAuthorization).not.toHaveBeenCalled();
      expect(mockSettleX402Payment).not.toHaveBeenCalled();
      expect(mockRecordPayment).not.toHaveBeenCalled();
    });

    // Kök neden analizi: x402 ayarı gerçekten enabled:true olsa BİLE (bu describe bloğunun
    // varsayılan mock'u, satır ~143), context.networkId Base Sepolia değilse auto-pay yolu bu
    // ToolArgumentError'da biter — SettingsX402/X402SettingsService'te hiçbir kopukluk yok, bu
    // sadece ayrı bir kısıt (x402 şu an yalnızca Base Sepolia'da çalışıyor). reasonKey artık
    // taşınıyor ki AgentOrchestrator'ın sistem promptu bunu "ayarlar kapalı" mesajıyla
    // karıştırmasın (bkz. AgentOrchestrator.ts'in ilgili talimatı).
    it('mevcut ağda x402 desteklenmiyorsa (getUsdcTokenIdentity undefined döner) otomatik ödeme yolunda {error} + ayrı bir reasonKey döner', async () => {
      (deps.getUsdcTokenIdentity as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);
      const res = await executeToolCall('pay_for_resource', { resource: RESOURCE }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toMatch(/desteklenmiyor/);
      expect(res.reasonKey).toBe('agent.confirmationCardX402UnsupportedNetwork');
      expect(mockSignTransferWithAuthorization).not.toHaveBeenCalled();
    });

    it('hesabın ethers_wallet\'ı yoksa (kilitli) otomatik ödeme yolunda {error} döner', async () => {
      (deps.getAccount as ReturnType<typeof vi.fn>).mockReturnValueOnce({ GetAddress: () => context.account, ethers_wallet: undefined } as unknown as Account);
      const res = await executeToolCall('pay_for_resource', { resource: RESOURCE }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toBeDefined();
      expect(mockSignTransferWithAuthorization).not.toHaveBeenCalled();
    });

    it('proxy geçersiz bir tutar döndürürse {error} döner, policy motoruna hiç gitmez', async () => {
      mockFetchPaymentRequirement.mockResolvedValueOnce({
        scheme: 'exact', network: 'base-sepolia', maxAmountRequired: 'not-a-number', resource: RESOURCE,
        description: '', mimeType: 'application/json', payTo: '0x1', maxTimeoutSeconds: 60, asset: '0x2', extra: { name: 'USD Coin', version: '2' },
      });
      const res = await executeToolCall('pay_for_resource', { resource: RESOURCE }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toBeDefined();
      expect(mockGetX402Settings).not.toHaveBeenCalled();
      // Bu bir AgentPolicyEngine denial'ı DEĞİL (policy motoruna hiç gidilmedi) — düz bir
      // ToolArgumentError, PolicyDenialError değil, bu yüzden reasonKey taşımamalı.
      expect(res.reasonKey).toBeUndefined();
    });
  });
});
