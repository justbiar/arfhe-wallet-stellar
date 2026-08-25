/**
 * Turns raw errors into something a wallet user can act on.
 *
 * Errors reaching the UI come from three very different places — the CoFHE SDK, the RPC
 * provider, and Solidity reverts — and none of them are written for end users. Showing
 * `execution reverted: 0x8f4eb604` or `SEAL_OUTPUT_FAILED` tells someone nothing about
 * what went wrong or what to do next.
 *
 * Each entry maps a recognisable signature to an i18n key. Anything unrecognised falls
 * back to the network-level classifier, and finally to a generic message — the raw text
 * is never shown, but it is preserved on the returned object for logs and bug reports.
 */

import { classifyError } from "./NetworkErrorHandler.js";

export interface UserFacingError {
  /** i18n key for the message to display. */
  key: string;
  /** Interpolation values for the key, when it takes any. */
  params?: Record<string, string>;
  /** Original message — for logs and support, not for display. */
  raw: string;
  /** Whether retrying the same action could plausibly succeed. */
  retryable: boolean;
}

/**
 * Ordered matchers. First hit wins, so the specific FHE cases are listed before the
 * generic chain ones — "insufficient balance" from the shielded guard must not be
 * mistaken for "not enough gas".
 */
const MATCHERS: Array<{ test: (m: string) => boolean; key: string; retryable: boolean }> = [
  // ── Wallet-side guards (already user-readable, but keyed for translation) ──
  {
    test: (m) => m.includes("insufficient shielded balance"),
    key: "errors.insufficientShielded",
    retryable: false,
  },
  {
    test: (m) => m.includes("no shielded balance"),
    key: "errors.noShieldedBalance",
    retryable: false,
  },
  {
    test: (m) => m.includes("below the confidential precision") || m.includes("amounttoosmall"),
    key: "errors.amountTooSmall",
    retryable: false,
  },
  {
    test: (m) => m.includes("amount must be greater than zero"),
    key: "errors.amountZero",
    retryable: false,
  },
  {
    test: (m) => m.includes("invalid recipient") || m.includes("zero address"),
    key: "errors.invalidRecipient",
    retryable: false,
  },

  // ── FHE availability ──
  {
    test: (m) => m.includes("fhe is not available") || m.includes("not available on chain"),
    key: "errors.fheUnsupportedNetwork",
    retryable: false,
  },
  {
    test: (m) => m.includes("wallet is locked") || m.includes("not initialized"),
    key: "errors.walletLocked",
    retryable: true,
  },
  {
    test: (m) => m.includes("does not look like a confidential wrapper") || m.includes("not deployed"),
    key: "errors.wrapperMissing",
    retryable: false,
  },

  // ── CoFHE coprocessor ──
  {
    test: (m) => m.includes("ciphertext not found"),
    key: "errors.noEncryptedData",
    retryable: false,
  },
  {
    test: (m) => m.includes("permit_denied") || m.includes("permit is expired") || m.includes("permit_not_found"),
    key: "errors.permitExpired",
    retryable: true,
  },
  {
    test: (m) => m.includes("not_publicly_allowed"),
    key: "errors.decryptNotAllowed",
    retryable: false,
  },
  {
    test: (m) => m.includes("proof failed verification"),
    key: "errors.proofInvalid",
    retryable: true,
  },
  {
    test: (m) => m.includes("zk_pack") || m.includes("zk_prove") || m.includes("zk_verify"),
    key: "errors.encryptionFailed",
    retryable: true,
  },
  {
    test: (m) => m.includes("seal_output") || m.includes("decrypt_failed") || m.includes("decrypt request failed"),
    key: "errors.decryptFailed",
    retryable: true,
  },
  {
    test: (m) => m.includes("init_tfhe") || m.includes("fetch_keys") || m.includes("missing_fhe_key"),
    key: "errors.fheSetupFailed",
    retryable: true,
  },

  // ── Chain / wallet ──
  {
    test: (m) => m.includes("user rejected") || m.includes("user denied") || m.includes("action_rejected"),
    key: "errors.userRejected",
    retryable: true,
  },
  {
    test: (m) => m.includes("insufficient funds") || m.includes("insufficient balance") || m.includes("insufficient_funds"),
    key: "errors.insufficientFunds",
    retryable: false,
  },

  // ── x402 facilitator (real settle failures, Faz 3 — bkz. X402ProxyClient.settleX402Payment,
  // backend-proxy/src/x402FacilitatorClient.ts). The facilitator's `invalidReason`/`errorReason`
  // codes are raw machine strings ("invalid_exact_evm_signature" etc.) — never shown as-is.
  // Listed before the generic "expired"-less invalid_exact_evm_* catch-all so the specific
  // deadline case gets its own (retryable — a retry re-signs with a fresh validBefore, see
  // ConfirmationCard's handleApprove) message instead of the generic non-retryable one.
  {
    test: (m) =>
      m.includes("valid_before") || (m.includes("authorization") && m.includes("expired")) || m.includes("authorization_expired"),
    key: "errors.x402AuthorizationExpired",
    retryable: true,
  },
  {
    test: (m) => m.includes("invalid_exact_evm"),
    key: "errors.x402PaymentRejected",
    retryable: false,
  },
  {
    test: (m) => m.includes("unexpected_error"),
    key: "errors.x402FacilitatorError",
    retryable: true,
  },
  {
    test: (m) => m.includes("nonce too low") || m.includes("replacement transaction underpriced"),
    key: "errors.nonceConflict",
    retryable: true,
  },
  {
    test: (m) => m.includes("gas required exceeds") || m.includes("intrinsic gas too low") || m.includes("out of gas"),
    key: "errors.gasTooLow",
    retryable: true,
  },
  {
    test: (m) => m.includes("execution reverted") || m.includes("call_exception"),
    key: "errors.transactionReverted",
    retryable: false,
  },
];

/** Classify an error into a translatable, user-appropriate message. */
export function toUserFacingError(error: unknown): UserFacingError {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.toLowerCase();

  for (const matcher of MATCHERS) {
    if (matcher.test(normalized)) {
      return { key: matcher.key, raw, retryable: matcher.retryable };
    }
  }

  // Nothing FHE- or chain-specific matched; fall back to network classification, which
  // already covers offline, timeout, rate limiting and server errors.
  const classified = classifyError(error);
  return {
    key: classified.i18nKey ?? "errors.unknown",
    raw,
    retryable: classified.retryable,
  };
}

/**
 * Convenience wrapper for components: returns a ready-to-display string.
 *
 * @param t i18n translator.
 */
export function toUserMessage(error: unknown, t: (key: string, params?: Record<string, string>) => string): string {
  const { key, params } = toUserFacingError(error);
  return t(key, params);
}
