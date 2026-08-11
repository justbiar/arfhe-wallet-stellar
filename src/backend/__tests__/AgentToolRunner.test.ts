/// <reference types="vitest/globals" />
import {
  executeToolCall,
  configureAgentToolRunner,
  resetAgentToolRunner,
  type AgentToolRunnerDeps,
} from '../AgentToolRunner';
import type { Network } from '../Network';
import type Account from '../Account';
import type { ShieldedHolding, UnshieldClaim } from '../../types/fhe';

/**
 * @vitest-environment node
 *
 * AgentToolRunner testleri
 *
 * Network.ts çağrıları mock'lanır — gerçek RPC/FHE işlemi yapılmaz. Her tool için başarılı
 * çağrı, policy reddi (forbidden/unknown/proposal-requires-confirmation) ve hata yutma
 * senaryoları test edilir.
 */
describe('AgentToolRunner', () => {
  const context = { account: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', networkId: '11155111' };

  let mockNetwork: {
    getBalance: ReturnType<typeof vi.fn>;
    getShieldedPortfolio: ReturnType<typeof vi.fn>;
    getPendingClaims: ReturnType<typeof vi.fn>;
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

  beforeEach(() => {
    resetAgentToolRunner();
    mockNetwork = {
      getBalance: vi.fn().mockResolvedValue('1000000000000000000'),
      getShieldedPortfolio: vi.fn().mockResolvedValue([]),
      getPendingClaims: vi.fn().mockResolvedValue([]),
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

  // ─── Policy gating ──────────────────────────────────────────────
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

    it('proposal tool (send_transaction) henüz bu runner üzerinden çalıştırılmaz', async () => {
      const res = await executeToolCall('send_transaction', { amount: 1 }, context);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('send_transaction');
    });
  });
});
