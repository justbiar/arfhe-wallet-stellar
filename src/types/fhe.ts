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
   * True when a ciphertext exists on-chain but could not be decrypted on this attempt.
   *
   * The two cases are not the same and must never be collapsed: an empty balance is a
   * fact, while a failed decrypt is a missing answer. The coprocessor lags behind the
   * chain for a few seconds after a shield, a permit can expire, the threshold network can
   * be briefly unreachable — in every one of those the tokens are still there.
   *
   * `balance` reads "0.0" in this state so arithmetic downstream stays safe, which is
   * precisely why callers must check this flag before filtering a row out or showing the
   * figure as real. A wallet that hides an asset because it could not read it has lost
   * the asset as far as the user is concerned.
   */
  decryptFailed: boolean;
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
  /**
   * How the claim is referenced on-chain — the argument `claimUnshielded` takes.
   *
   * Deliberately NOT the ciphertext handle. The contracts derive it from the claimant and
   * a per-claimant nonce, so one address can hold several claims against the same handle.
   * Passing the handle here reverts with `ClaimNotFound`.
   */
  id: string;
  /** Address that receives the underlying tokens once claimed. */
  to: string;
  /**
   * The burned ciphertext handle. This is what gets decrypted, and the proof is bound to
   * it — so settlement needs both this and {@link id}, for different arguments.
   */
  ctHash: string;
  /** Actual decrypted amount; only meaningful once `claimed` is true. */
  decryptedAmount: bigint;
  /** Whether the underlying tokens have already been released. */
  claimed: boolean;
}
