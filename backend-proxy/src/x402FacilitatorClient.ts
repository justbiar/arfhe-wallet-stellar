/**
 * x402FacilitatorClient.ts — real x402 (v1/"legacy") facilitator client, x402Stub.ts's
 * eventual replacement when `X402_USE_REAL_FACILITATOR` (wrangler.toml [vars]) is "true".
 *
 * Talks to Coinbase's open x402 facilitator — default `https://x402.org/facilitator`, no auth
 * required (override via X402_FACILITATOR_URL if ever needed). This project targets the v1
 * ("legacy") wire protocol: flat `network: "base-sepolia"` string, `maxAmountRequired`,
 * `resource: string` — NOT the newer CAIP-network v2 protocol (`network: "eip155:84532"`,
 * `amount`, nested `resource` object). Both are served by the same public facilitator today —
 * confirmed live via `GET /facilitator/supported`, whose `kinds` array lists
 * `{"x402Version":1,"scheme":"exact","network":"base-sepolia"}` alongside the v2 kinds. v1 was
 * picked because it needs far less rework of the existing stub/extension code; the trade-off is
 * that Coinbase could drop v1 support later without notice (bkz. CONTEXT.md bölüm 14).
 *
 * Request/response shapes below were confirmed against the LIVE facilitator while building this
 * (not from documentation alone — docs.cdp.coinbase.com's public page didn't include field-level
 * detail):
 *   - `POST {url}/verify` body `{x402Version, paymentPayload, paymentRequirements}` →
 *     `{isValid: boolean, invalidReason?, invalidMessage?, payer?}`. Same response shape
 *     regardless of the request's x402Version — there is no separate "v1 verify response" type.
 *   - `POST {url}/settle` same body shape → `{success, network, transaction, errorReason?,
 *     errorMessage?, payer?}`. The field is `transaction`, NOT `txHash` — index.ts is
 *     responsible for renaming it before it reaches the extension, so X402ProxyClient.ts's
 *     `txHash` contract on the extension side never has to change.
 *
 * The EIP-3009 payload sub-shape (`{signature, authorization: {from,to,value,validAfter,
 * validBefore,nonce}}`) is identical between v1 and v2 and matches what the extension's
 * X402PaymentService.ts already produces — no changes needed there. One real mismatch DOES
 * exist: X402PaymentService.ts's `Eip3009Authorization.validAfter`/`validBefore` are `number`
 * (unix seconds), but the facilitator's EIP-3009 payload type requires them as strings —
 * `buildFacilitatorPaymentPayload` below coerces them; sending bare JSON numbers was not
 * re-tested against a real signature here, so this coercion is a defensive read of coinbase/
 * x402's own EVM mechanism types, not something observed to fail live.
 */

const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";
const X402_VERSION = 1 as const;
const NETWORK = "base-sepolia" as const;
/** $0.01 in USDC atomic units (6 decimals) — same arbitrary-but-plausible amount x402Stub.ts used. */
const AMOUNT_ATOMIC = "10000";

export interface X402Env {
  X402_PAYTO_ADDRESS?: string;
  X402_USDC_ASSET_ADDRESS?: string;
  X402_FACILITATOR_URL?: string;
}

export interface RealPaymentRequirements {
  scheme: "exact";
  network: typeof NETWORK;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  /** Part of the real x402 v1 spec; the facilitator didn't reject an omitted one in live testing, kept anyway for spec fidelity. */
  outputSchema: Record<string, unknown>;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: { name: string; version: string };
}

export interface RealPaymentRequiredBody {
  x402Version: typeof X402_VERSION;
  accepts: RealPaymentRequirements[];
}

function requireEnvValue(value: string | undefined, varName: string): string {
  if (!value) {
    throw new Error(`${varName} yapılandırılmamış (wrangler.toml [vars]).`);
  }
  return value;
}

/**
 * Builds the (deterministic) payment requirements for `resource` — same inputs always produce
 * the same requirements, which is what lets handleX402Settle (index.ts) reconstruct the exact
 * requirements an earlier payment-required call produced, without the extension having to send
 * them back at settle time.
 */
export function buildRealPaymentRequirements(resource: string, env: X402Env): RealPaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: AMOUNT_ATOMIC,
    resource,
    description: `Access to ${resource}`,
    mimeType: "application/json",
    outputSchema: {},
    payTo: requireEnvValue(env.X402_PAYTO_ADDRESS, "X402_PAYTO_ADDRESS"),
    maxTimeoutSeconds: 60,
    asset: requireEnvValue(env.X402_USDC_ASSET_ADDRESS, "X402_USDC_ASSET_ADDRESS"),
    // Base Sepolia testnet USDC'nin GERÇEK EIP-712 domain name'i — extension'ın
    // (src/AppContext.ts'teki getUsdcTokenIdentity dep'i) imzaladığı domain'le BİREBİR AYNI
    // olmalı. Facilitator, imzayı doğrularken burada bildirilen name/version'ı kullanarak EIP-712
    // domain'ini yeniden kurup ecrecover yapıyor — extension "USDC" ile imzalarken burada hâlâ
    // "USD Coin" yazıyorsa, iki taraf farklı domain hash'i üretir ve facilitator her seferinde
    // invalid_exact_evm_signature ile reddeder (imzanın kendisi doğru olsa bile).
    extra: { name: "USDC", version: "2" },
  };
}

export function buildRealPaymentRequiredBody(resource: string, env: X402Env): RealPaymentRequiredBody {
  return { x402Version: X402_VERSION, accepts: [buildRealPaymentRequirements(resource, env)] };
}

/** The EIP-3009 payload shape the extension actually sends (X402PaymentService.ts's Eip3009SignedAuthorization). */
export interface ExtensionSignedPayload {
  signature: string;
  authorization: {
    from: string;
    to: string;
    value: string;
    validAfter: number | string;
    validBefore: number | string;
    nonce: string;
  };
}

/**
 * Structural check — the old stub accepted literally anything under `paymentPayload` (never
 * validated it, see x402Stub.ts's own JSDoc: "never checks a signature"). The real facilitator
 * needs a genuine EIP-3009 payload or `/verify` will fail with a confusing facilitator-side
 * error instead of a clear one from us; this rejects malformed input before it ever leaves
 * this Worker.
 */
export function isExtensionSignedPayload(value: unknown): value is ExtensionSignedPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.signature !== "string") return false;
  if (typeof v.authorization !== "object" || v.authorization === null) return false;
  const a = v.authorization as Record<string, unknown>;
  return (
    typeof a.from === "string" &&
    typeof a.to === "string" &&
    typeof a.value === "string" &&
    (typeof a.validAfter === "number" || typeof a.validAfter === "string") &&
    (typeof a.validBefore === "number" || typeof a.validBefore === "string") &&
    typeof a.nonce === "string"
  );
}

/** Wraps the extension's signed authorization into the facilitator's v1 PaymentPayload. */
export function buildFacilitatorPaymentPayload(
  network: string,
  paymentPayload: unknown
): { x402Version: typeof X402_VERSION; scheme: "exact"; network: string; payload: Record<string, unknown> } {
  if (!isExtensionSignedPayload(paymentPayload)) {
    throw new Error("paymentPayload beklenen EIP-3009 imza şeklinde değil (signature/authorization).");
  }
  const { signature, authorization } = paymentPayload;
  return {
    x402Version: X402_VERSION,
    scheme: "exact",
    network,
    payload: {
      signature,
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: String(authorization.value),
        validAfter: String(authorization.validAfter),
        validBefore: String(authorization.validBefore),
        nonce: authorization.nonce,
      },
    },
  };
}

export interface FacilitatorVerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
}

export interface FacilitatorSettleResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
}

async function callFacilitator(facilitatorUrl: string, path: "verify" | "settle", body: unknown): Promise<unknown> {
  const base = (facilitatorUrl || DEFAULT_FACILITATOR_URL).replace(/\/+$/, "");

  let response: Response;
  try {
    response = await fetch(`${base}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`x402 facilitator ${path} çağrısı başarısız: ${err instanceof Error ? err.message : String(err)}`);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(`x402 facilitator ${path} geçerli bir JSON gövdesi döndürmedi (status ${response.status}).`);
  }
  return data;
}

export async function verifyWithFacilitator(
  paymentPayload: unknown,
  paymentRequirements: RealPaymentRequirements,
  env: X402Env
): Promise<FacilitatorVerifyResponse> {
  const wrapped = buildFacilitatorPaymentPayload(paymentRequirements.network, paymentPayload);
  const data = await callFacilitator(env.X402_FACILITATOR_URL ?? DEFAULT_FACILITATOR_URL, "verify", {
    x402Version: X402_VERSION,
    paymentPayload: wrapped,
    paymentRequirements,
  });
  return data as FacilitatorVerifyResponse;
}

export async function settleWithFacilitator(
  paymentPayload: unknown,
  paymentRequirements: RealPaymentRequirements,
  env: X402Env
): Promise<FacilitatorSettleResponse> {
  const wrapped = buildFacilitatorPaymentPayload(paymentRequirements.network, paymentPayload);
  const data = await callFacilitator(env.X402_FACILITATOR_URL ?? DEFAULT_FACILITATOR_URL, "settle", {
    x402Version: X402_VERSION,
    paymentPayload: wrapped,
    paymentRequirements,
  });
  return data as FacilitatorSettleResponse;
}

export type X402RealSettleResult = { success: true; txHash: string; network: string } | { success: false; error: string };

/**
 * Orchestrates the real two-step facilitator flow (verify, then settle) for one `/agent/x402/
 * settle` request. `paymentRequirements` is rebuilt here from `resource` + env — deterministic,
 * so it always matches what an earlier `/agent/x402/payment-required` call for the same
 * `resource` produced, without trusting anything the extension might send back.
 */
export async function settleX402PaymentReal(
  resource: string,
  rawPaymentPayload: unknown,
  env: X402Env
): Promise<X402RealSettleResult> {
  const requirements = buildRealPaymentRequirements(resource, env);

  const verify = await verifyWithFacilitator(rawPaymentPayload, requirements, env);
  if (!verify.isValid) {
    return { success: false, error: verify.invalidMessage || verify.invalidReason || "x402 ödemesi doğrulanamadı." };
  }

  const settle = await settleWithFacilitator(rawPaymentPayload, requirements, env);
  if (!settle.success || !settle.transaction) {
    return { success: false, error: settle.errorMessage || settle.errorReason || "x402 ödemesi sonuçlandırılamadı." };
  }

  return { success: true, txHash: settle.transaction, network: settle.network ?? requirements.network };
}
