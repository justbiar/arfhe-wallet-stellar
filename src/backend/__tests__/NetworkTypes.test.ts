import { describe, it, expect } from 'vitest';
import {
  NetworkId,
  isFheNetwork,
  isTestnetNetwork,
  FHE_NETWORK_IDS,
  TESTNET_IDS,
  toChainId,
} from '../NetworkTypes';

describe('NetworkTypes helpers', () => {
  // ─── isFheNetwork ───────────────────────────────────────────────
  describe('isFheNetwork', () => {
    it('returns true for Ethereum Sepolia (FHE testnet)', () => {
      expect(isFheNetwork(NetworkId.Ethereum_Sepolia)).toBe(true);
    });

    it('returns true for Arbitrum Sepolia (FHE testnet)', () => {
      expect(isFheNetwork(NetworkId.Arbitrum_Sepolia)).toBe(true);
    });

    it('returns true for Base Sepolia (FHE testnet)', () => {
      expect(isFheNetwork(NetworkId.Base_Sepolia)).toBe(true);
    });

    it('returns false for Ethereum Mainnet', () => {
      expect(isFheNetwork(NetworkId.Ethereum_Mainnet)).toBe(false);
    });

    it('returns false for Arbitrum One (mainnet)', () => {
      expect(isFheNetwork(NetworkId.Arbitrum_One)).toBe(false);
    });

    it('returns false for Base Mainnet', () => {
      expect(isFheNetwork(NetworkId.Base_Mainnet)).toBe(false);
    });

    it('returns false for Unknown network', () => {
      expect(isFheNetwork(NetworkId.Unknown)).toBe(false);
    });

    it('returns false for Zama network', () => {
      expect(isFheNetwork(NetworkId.Zama)).toBe(false);
    });
  });

  // ─── isTestnetNetwork ──────────────────────────────────────────
  describe('isTestnetNetwork', () => {
    it('returns true for all testnets', () => {
      expect(isTestnetNetwork(NetworkId.Ethereum_Sepolia)).toBe(true);
      expect(isTestnetNetwork(NetworkId.Arbitrum_Sepolia)).toBe(true);
      expect(isTestnetNetwork(NetworkId.Base_Sepolia)).toBe(true);
    });

    it('returns false for all mainnets', () => {
      expect(isTestnetNetwork(NetworkId.Ethereum_Mainnet)).toBe(false);
      expect(isTestnetNetwork(NetworkId.Arbitrum_One)).toBe(false);
      expect(isTestnetNetwork(NetworkId.Base_Mainnet)).toBe(false);
    });

    it('returns false for Unknown', () => {
      expect(isTestnetNetwork(NetworkId.Unknown)).toBe(false);
    });
  });

  // ─── FHE_NETWORK_IDS set ──────────────────────────────────────
  describe('FHE_NETWORK_IDS', () => {
    // Pinned to CoFHE's official support list. Adding a network here without a
    // coprocessor behind it silently offers shielding that cannot work.
    it('contains exactly the three CoFHE-supported chains', () => {
      expect([...FHE_NETWORK_IDS].sort()).toEqual(
        [NetworkId.Ethereum_Sepolia, NetworkId.Arbitrum_Sepolia, NetworkId.Base_Sepolia].sort()
      );
    });

    it('does not contain any mainnet', () => {
      expect(FHE_NETWORK_IDS.has(NetworkId.Ethereum_Mainnet)).toBe(false);
      expect(FHE_NETWORK_IDS.has(NetworkId.Arbitrum_One)).toBe(false);
      expect(FHE_NETWORK_IDS.has(NetworkId.Base_Mainnet)).toBe(false);
    });
  });

  // ─── TESTNET_IDS set ──────────────────────────────────────────
  describe('TESTNET_IDS', () => {
    it('lists every testnet the wallet ships', () => {
      expect([...TESTNET_IDS].sort()).toEqual(
        [
          NetworkId.Ethereum_Sepolia,
          NetworkId.Arbitrum_Sepolia,
          NetworkId.Base_Sepolia,
          NetworkId.Monad_Testnet,
          NetworkId.Avalanche_Fuji,
        ].sort()
      );
    });

    it('all FHE networks are testnets (FHE ⊆ Testnet)', () => {
      for (const id of FHE_NETWORK_IDS) {
        expect(TESTNET_IDS.has(id)).toBe(true);
      }
    });
  });

  // ─── Mainnet vs Testnet wallet behavior ────────────────────────
  describe('Mainnet wallet behavior', () => {
    const MAINNET_IDS = [
      NetworkId.Ethereum_Mainnet,
      NetworkId.Arbitrum_One,
      NetworkId.Base_Mainnet,
    ];

    it('all mainnets should NOT have FHE support', () => {
      for (const id of MAINNET_IDS) {
        expect(isFheNetwork(id)).toBe(false);
      }
    });

    it('all mainnets should NOT be testnets', () => {
      for (const id of MAINNET_IDS) {
        expect(isTestnetNetwork(id)).toBe(false);
      }
    });

    it('mainnet chain IDs are correct', () => {
      expect(NetworkId.Ethereum_Mainnet).toBe(1);
      expect(NetworkId.Arbitrum_One).toBe(42161);
      expect(NetworkId.Base_Mainnet).toBe(8453);
    });

    it('testnet chain IDs are correct', () => {
      expect(NetworkId.Ethereum_Sepolia).toBe(4);
      expect(NetworkId.Arbitrum_Sepolia).toBe(421614);
      expect(NetworkId.Base_Sepolia).toBe(84532);
    });
  });
});
/**
 * `NetworkId` is the wallet's internal identifier and does not always equal the chain id.
 * Anything leaving the wallet — a signed transaction, an EIP-1193 answer, a WalletConnect
 * comparison — must use the real one. Sepolia is the trap: internally 4, actually 11155111,
 * and 4 is Rinkeby's old id.
 */
describe('toChainId', () => {
  it('Sepolia için gerçek zincir kimliğini döner', () => {
    expect(toChainId(NetworkId.Ethereum_Sepolia)).toBe(11155111);
    expect(toChainId(NetworkId.Ethereum_Sepolia)).not.toBe(4);
  });

  it('zaten doğru olan kimlikleri değiştirmez', () => {
    expect(toChainId(NetworkId.Ethereum_Mainnet)).toBe(1);
    expect(toChainId(NetworkId.Arbitrum_Sepolia)).toBe(421614);
    expect(toChainId(NetworkId.Base_Sepolia)).toBe(84532);
    expect(toChainId(NetworkId.Arbitrum_One)).toBe(42161);
    expect(toChainId(NetworkId.Base_Mainnet)).toBe(8453);
    expect(toChainId(NetworkId.Polygon)).toBe(137);
  });

  it('özel ağlar kendi zincir kimliğiyle geçer', () => {
    // Custom networks are added by real chain id, so they must pass through untouched.
    expect(toChainId(59144)).toBe(59144);
    expect(toChainId(1337)).toBe(1337);
  });

  it('FHE ağlarının hepsi CoFHE zincirleriyle eşleşir', () => {
    // The three chains the coprocessor runs on. A mismatch here means encryption is
    // attempted against a chain that has no coprocessor behind it.
    const fheChainIds = [...FHE_NETWORK_IDS].map(toChainId).sort((a, b) => a - b);
    expect(fheChainIds).toEqual([84532, 421614, 11155111].sort((a, b) => a - b));
  });
});
