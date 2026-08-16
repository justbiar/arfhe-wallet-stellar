/**
 * X402ProxyClient.ts — talks to backend-proxy's `/agent/x402/*` endpoints (Faz 3).
 *
 * ⚠️ Those endpoints are themselves STUBS right now (see backend-proxy/src/x402Stub.ts) — they
 * fake a resource server's 402 response and a facilitator's settlement result, never contacting
 * anything real. This client doesn't know or care that they're stubs; it just speaks the same
 * request/response shapes the real integration will use, so nothing here needs to change once
 * the proxy side is swapped for the real thing.
 *
 * Deliberately its own module, separate from X402PaymentService.ts: that module's whole
 * boundary is "produces a signature and nothing else" (see its own JSDoc) — the HTTP round trip
 * to our own backend-proxy is a different concern (network I/O, not signing mechanics), same
 * separation AgentOrchestrator.ts's `callProxy` keeps from AgentToolRunner.ts's Network.ts
 * calls. Neither this module nor its caller ever talks to a resource server or facilitator
 * directly — that's backend-proxy's job specifically so the extension's own network egress
 * stays limited to the user's RPC and this one proxy (see AgentOrchestrator.ts's config).
 */

import type { Eip3009SignedAuthorization } from "./X402PaymentService.js";

/** The x402 "exact" scheme's PaymentRequirements shape (x402 spec) — one entry of a 402 response's `accepts` array. */
export interface X402PaymentRequirement {
  scheme: "exact";
  network: string;
  /** Atomic units of `asset` (USDC has 6 decimals), as a decimal string. */
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: { name: string; version: string };
}

let proxyBaseUrl: string = (import.meta.env.VITE_AGENT_PROXY_URL as string | undefined) ?? "";

/** Overrides the proxy base URL — used by tests, mirrors AgentOrchestrator.configureAgentOrchestrator(). */
export function configureX402ProxyClient(overrides: { proxyBaseUrl?: string }): void {
  if (overrides.proxyBaseUrl !== undefined) proxyBaseUrl = overrides.proxyBaseUrl;
}

function requireProxyBaseUrl(): string {
  if (!proxyBaseUrl) {
    throw new Error("x402 proxy yapılandırılmadı (VITE_AGENT_PROXY_URL eksik).");
  }
  return proxyBaseUrl.replace(/\/+$/, "");
}

/**
 * Asks the proxy what payment `resource` requires — mirrors a client hitting a paid resource
 * server and getting a real HTTP 402 back. Returns the first ("exact" scheme) entry of
 * `accepts`; throws if the proxy is unreachable, returns something other than 402, or the body
 * doesn't have at least one payment option (all of which mean the caller has nothing usable to
 * act on, so there's nothing a partial/degraded result would let it do).
 */
export async function fetchX402PaymentRequirement(resource: string): Promise<X402PaymentRequirement> {
  const base = requireProxyBaseUrl();

  let response: Response;
  try {
    response = await fetch(`${base}/agent/x402/payment-required`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource }),
    });
  } catch (err) {
    throw new Error(`x402 ödeme gereksinimleri alınamadı: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (response.status !== 402) {
    throw new Error(`x402 proxy beklenmeyen bir durum kodu döndürdü: ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("x402 proxy geçerli bir JSON gövdesi döndürmedi.");
  }

  const accepts = (body as { accepts?: unknown })?.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    throw new Error("x402 proxy hiçbir ödeme seçeneği döndürmedi.");
  }
  return accepts[0] as X402PaymentRequirement;
}

export interface X402SettlementResult {
  success: true;
  txHash: string;
}

/**
 * Sends a signed EIP-3009 authorization to the proxy for settlement — mirrors handing a signed
 * payment to a real x402 facilitator and getting back proof it settled. Throws on any failure
 * (unreachable proxy, non-200, malformed body) rather than returning a "maybe it worked"
 * result — the caller (AgentToolRunner) only records a ledger entry once this resolves, so a
 * thrown error here correctly means "nothing was recorded as spent."
 */
export async function settleX402Payment(
  resource: string,
  signed: Eip3009SignedAuthorization
): Promise<X402SettlementResult> {
  const base = requireProxyBaseUrl();

  let response: Response;
  try {
    response = await fetch(`${base}/agent/x402/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource, paymentPayload: signed }),
    });
  } catch (err) {
    throw new Error(`x402 ödemesi sonuçlandırılamadı: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    throw new Error(`x402 settle isteği başarısız oldu: ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("x402 settle yanıtı geçerli bir JSON gövdesi değil.");
  }

  const parsed = body as { success?: unknown; txHash?: unknown };
  if (parsed.success !== true || typeof parsed.txHash !== "string") {
    throw new Error("x402 settle yanıtı beklenen alanları içermiyor (success/txHash).");
  }
  return { success: true, txHash: parsed.txHash };
}
