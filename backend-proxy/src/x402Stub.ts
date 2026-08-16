/**
 * x402Stub.ts — ⚠️ STUB / TEST-ONLY, NOT A REAL x402 INTEGRATION ⚠️
 *
 * This module fakes both sides of an x402 payment round trip (a paid resource server's 402
 * response, and a facilitator's settlement result) so the extension's auto-pay flow (Faz 3)
 * can be built and end-to-end tested BEFORE a real resource server or a real x402 facilitator
 * exists to talk to. Nothing in here makes an outbound network call, verifies a signature,
 * checks an on-chain balance, or moves a single unit of USDC — it always returns the same
 * canned data, regardless of what the caller sends.
 *
 * DO NOT wire this into anything that could be mistaken for a live payment path. When the real
 * facilitator integration lands (Faz 3, a later turn), it replaces this module's callers in
 * index.ts entirely — this file should be deleted then, not kept as a "fallback".
 *
 * `payTo`/`asset` below are NOT deployed contracts this proxy controls — they are placeholder
 * values for the stub response shape only. `asset` should be reconciled with the extension's
 * own CONTRACTS_BASE_SEPOLIA.USDC (src/components/panels/shared.tsx) once the real integration
 * work starts; the two are not currently kept in sync because this module talks to nothing real.
 */

export const X402_STUB_WARNING =
  "STUB RESPONSE — this backend-proxy endpoint fakes x402 protocol data for development/testing. " +
  "No real resource server or facilitator was contacted, no payment was verified or settled.";

/** The x402 "exact" scheme's PaymentRequirements shape (x402 spec, Coinbase). */
export interface StubPaymentRequirements {
  scheme: "exact";
  network: "base-sepolia";
  /** Atomic units of `asset` (USDC has 6 decimals) — a string per the x402 spec, not a number. */
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: { name: string; version: string };
}

export interface StubPaymentRequiredBody {
  x402Version: 1;
  error: string;
  accepts: StubPaymentRequirements[];
  /** Not part of the real x402 spec — present only so a caller can never mistake this for a real 402. */
  _stub: true;
}

/**
 * Fixed placeholder recipient/asset — deliberately NOT valid hex (the trailing "x2"/"USDC"
 * would fail any real address parser) so these can never be mistaken for, or accidentally
 * used as, a real on-chain address. Must be reconciled with the extension's own
 * CONTRACTS_BASE_SEPOLIA.USDC (src/components/panels/shared.tsx) before any real integration.
 */
const STUB_PAY_TO = "0x000000000000000000000000000000000004x2";
const STUB_USDC_ASSET = "0x0000000000000000000000000000000000USDC";
/** $0.01 in USDC atomic units (6 decimals) — an arbitrary but plausible micro-payment amount for the stub. */
const STUB_AMOUNT_ATOMIC = "10000";

/**
 * Builds a fake "you must pay to access this" response for `resource`, as if this proxy had
 * just relayed a request to a paid resource server and gotten a real HTTP 402 back. Always
 * succeeds, always returns the same shape — there is no real resource server behind this.
 */
export function buildStubPaymentRequirements(resource: string): StubPaymentRequiredBody {
  return {
    x402Version: 1,
    error: X402_STUB_WARNING,
    accepts: [
      {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: STUB_AMOUNT_ATOMIC,
        resource,
        description: `(STUB) Access to ${resource}`,
        mimeType: "application/json",
        payTo: STUB_PAY_TO,
        maxTimeoutSeconds: 60,
        asset: STUB_USDC_ASSET,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
    _stub: true,
  };
}

export interface StubSettleRequestBody {
  resource: string;
  /**
   * The EIP-3009 authorization signature the extension produced (Faz 3, a later step). Its
   * shape isn't validated here — this stub never checks a signature or touches a chain.
   */
  paymentPayload: unknown;
}

export interface StubSettleResultBody {
  success: true;
  /** Not a real broadcast transaction — see module JSDoc. */
  txHash: string;
  network: "base-sepolia";
  /** Not part of the real x402 spec — present only so a caller can never mistake this for a real settlement. */
  _stub: true;
  note: string;
}

/**
 * Builds a fake "payment settled, here's proof" response, as if this proxy had just verified
 * `paymentPayload` with a real x402 facilitator and gotten back a successful settlement. Always
 * succeeds with a synthetic tx hash — no facilitator is contacted, no signature is checked, no
 * on-chain state changes.
 */
export function buildStubSettlement(resource: string): StubSettleResultBody {
  return {
    success: true,
    txHash: `0xSTUB${Date.now().toString(16).padStart(10, "0")}`,
    network: "base-sepolia",
    _stub: true,
    note: `${X402_STUB_WARNING} (resource: ${resource})`,
  };
}
