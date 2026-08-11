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

describe('AgentToolRunner', () => {
  const context = { account: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', networkId: '11155111' };
  const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

  let mockNetwork: {
    getBalance: ReturnType<typeof vi.fn>;
    getShieldedPortfolio: ReturnType<typeof vi.fn>;
    getPendingClaims: ReturnType<typeof vi.fn>;
    rpc_url: string;
    currency_symbol: string;
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
      isLegacy: false,
      ...overrides,
    };
  }

  function makeClaim(overrides: Partial<UnshieldClaim> = {}): UnshieldClaim {
    return {
      to: context.account,
      ctHash: '0xabc',
      requestedAmount: 500000n,
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

    mockNetwork = {
      getBalance: vi.fn().mockResolvedValue('1000000000000000000'), // 1 ETH
      getShieldedPortfolio: vi.fn().mockResolvedValue([]),
      getPendingClaims: vi.fn().mockResolvedValue([]),
      rpc_url: 'https://rpc.example.test',
      currency_symbol: 'ETH',
    };
    mockAccount = { GetAddress: () => context.account } as unknown as Account;
    deps = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal mock for unit tests
      getNetwork: vi.fn(() => mockNetwork as any as Network),
      getAccount: vi.fn(() => mockAccount),
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

  // ─── get_balance ───────────────────────────────────────────────
  describe('get_balance', () => {
    it('başarılı çağrı network.getBalance sonucunu döner', async () => {
      const res = await executeToolCall('get_balance', {}, context);
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({ address: context.account, balanceWei: '1000000000000000000' });
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
      expect(claims[0].requestedAmount).toBe('500000');
      expect(typeof claims[0].requestedAmount).toBe('string');
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

    it('native olmayan tokenSymbol için desteklenmediğini belirtir, simüle etmez', async () => {
      const res = await executeToolCall('propose_send', { to: RECIPIENT, amount: '1', tokenSymbol: 'USDC' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('desteklenmiyor');
      expect(mockSimulateTransaction).not.toHaveBeenCalled();
    });

    it('ENS/UD alan adı çözümlenip önizlemede kullanılır', async () => {
      mockResolveDomain.mockResolvedValueOnce({ address: RECIPIENT, method: 'ens', error: null });
      mockSimulateTransaction.mockResolvedValueOnce(makeSimResult());

      const res = await executeToolCall('propose_send', { to: 'vitalik.eth', amount: '0.1' }, context);
      expect(res.error).toBeUndefined();
      expect(mockSimulateTransaction).toHaveBeenCalledWith(expect.objectContaining({ to: RECIPIENT }));
    });

    it('alan adı çözümlenemezse {error} döner, simüle etmez', async () => {
      mockResolveDomain.mockResolvedValueOnce({ address: null, method: 'ens', error: 'Could not find an Ethereum address for "vitalik.eth".' });

      const res = await executeToolCall('propose_send', { to: 'vitalik.eth', amount: '0.1' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('vitalik.eth');
      expect(mockSimulateTransaction).not.toHaveBeenCalled();
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

    it('native olmayan tokenSymbol için desteklenmediğini belirtir', async () => {
      const res = await executeToolCall('propose_shield', { amount: '1', tokenSymbol: 'USDC' }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('desteklenmiyor');
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
  });
});
