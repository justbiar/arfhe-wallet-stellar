/**
 * Shared FHE (Fully Homomorphic Encryption) types
 * Used across FheCofheService.ts, Network.ts and the privacy UI.
 */

// ─── Confidential token metadata ──────────────────────────────────

/**
 * On-chain parameters of a confidential wrapper, read once and cached.
 *
 * Encrypted balances are `euint64`, so the confidential layer is capped at 6 decimals
 * regardless of the underlying token. `rate` is the factor between the two layers:
 * `underlyingAmount = confidentialAmount * rate`. For 18-decimal ETH that is 1e12.
 */
export interface ShieldedTokenMeta {
  /** Decimals of the encrypted balance — min(underlying decimals, 6). */
  confidentialDecimals: number;
  /** Conversion factor from confidential units to underlying units. */
  rate: bigint;
}

/**
 * A confidential wrapper an account holds, resolved from the on-chain registry.
 *
 * Discovery cannot be driven by the public token list: shielding an entire balance leaves
 * the public balance at zero, so the wrapper would vanish from the wallet exactly when it
 * holds the most. The wallet enumerates the factory registry instead and keeps whichever
 * wrappers have a ciphertext for this account.
 */
export interface ShieldedHolding {
  /** Address of the confidential wrapper contract. */
  wrapper: string;
  /** Underlying ERC-20; empty string for the native (ETH) wrapper. */
  underlying: string;
  /** Confidential token symbol, e.g. "aeETH". */
  symbol: string;
  /** Decimals of the encrypted balance — min(underlying decimals, 6). */
  confidentialDecimals: number;
  /** Conversion factor from confidential units to underlying units. */
  rate: bigint;
  /** True for the native ETH wrapper, which shields with `shieldNative`. */
  isNative: boolean;
  /** Decrypted balance in confidential units, as a decimal string ("0.0" when empty). */
  balance: string;
  /**
   * True when a *different* wrapper is the registry's canonical one for this underlying.
   *
   * Two wrappers around one token hold two separate backing pools: what was shielded
   * through this one can only be unshielded through this one. Superseded wrappers stay
   * visible and withdrawable so no balance is stranded, but they must never be a shield
   * target — that would keep adding to a pool the rest of the wallet has moved off.
   */
  isLegacy: boolean;
}

// ─── Unshield claims ──────────────────────────────────────────────

/**
 * A pending unshield, mirroring `FHERC20WrapperClaimHelper.Claim`.
 *
 * Unshielding is asynchronous: `unshield` burns the confidential balance and opens a
 * claim, the burned handle is decrypted off-chain, and `claimUnshielded` verifies that
 * decryption proof before the underlying tokens are released.
 */
export interface UnshieldClaim {
  /** Address that receives the underlying tokens once claimed. */
  to: string;
  /** Ciphertext handle identifying this claim — the id passed to `claimUnshielded`. */
  ctHash: string;
  /** Amount requested at unshield time, in confidential units. */
  requestedAmount: bigint;
  /** Actual decrypted amount; only meaningful once `claimed` is true. */
  decryptedAmount: bigint;
  /** Whether the underlying tokens have already been released. */
  claimed: boolean;
}
