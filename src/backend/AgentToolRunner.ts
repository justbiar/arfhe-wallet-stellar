/**
 * AgentToolRunner — bridges tool_calls the model returns (per agentTools.ts's OpenAI-style
 * definitions) to the real Network.ts functions, gated by AgentPolicyEngine.
 *
 * IMPORTANT: This module runs ONLY inside the extension, same as AgentPolicyEngine.ts. It
 * never ships to a backend — it calls Network.ts directly against the user's own unlocked
 * wallet state in the browser.
 *
 * Resolving a live Network instance from a networkId, and the full Account (with signer)
 * from an address, are both owned by the UI layer (NetworkProvider / AccountManager), not
 * this module — a backend bridge shouldn't hardcode wallet lifecycle wiring. So, same
 * pattern as FheCofheService's singleton, the caller configures resolvers once via
 * configureAgentToolRunner() before executeToolCall() is used.
 *
 * Every call — including read-only ones — goes through AgentPolicyEngine.evaluate() first.
 * Right now that's a no-op for READ_ONLY_TOOLS (always allowed), but routing all calls
 * through it keeps this module's shape correct for when PROPOSAL_TOOLS get wired in here
 * too: a tool that comes back `requiresConfirmation: true` is refused rather than executed,
 * since there is no confirmation UI hooked up to this runner yet.
 */

import type { Network } from "./Network.js";
import type Account from "./Account.js";
import { AgentPolicyEngine, type ReadOnlyTool } from "./AgentPolicyEngine.js";
import type { ShieldedHolding, UnshieldClaim } from "../types/fhe.js";

// ─── Types ──────────────────────────────────────────────────────────

export interface ToolExecutionContext {
  /** Active wallet address the tool call should operate on. */
  account: string;
  /** Active NetworkId (see NetworkTypes.ts), as its string form. */
  networkId: string;
}

export interface ToolExecutionResult {
  result?: unknown;
  error?: string;
}

export interface AgentToolRunnerDeps {
  /** Resolves a live Network.ts instance for the given networkId. */
  getNetwork(networkId: string): Network;
  /**
   * Resolves the full Account (with signer) for the given address.
   * Needed for the shielded-balance tools, which require a signer to create/reuse a
   * decryption permit — undefined (account not found / wallet locked) fails those tools
   * gracefully rather than throwing.
   */
  getAccount(address: string): Account | undefined;
}

/** Raised for a malformed tool_call argument — caught alongside Network.ts errors below. */
class ToolArgumentError extends Error {}

// ─── Configuration (singleton, same pattern as FheCofheService) ────

let deps: AgentToolRunnerDeps | null = null;

/** Must be called once (e.g. when the wallet unlocks) before executeToolCall(). */
export function configureAgentToolRunner(newDeps: AgentToolRunnerDeps): void {
  deps = newDeps;
}

/** Test-only escape hatch to reset configuration between test cases. */
export function resetAgentToolRunner(): void {
  deps = null;
}

const policyEngine = new AgentPolicyEngine();

// ─── Argument validation ────────────────────────────────────────────

function requireTokenSymbol(args: Record<string, unknown>, required: boolean): string | undefined {
  const raw = args.tokenSymbol;

  if (raw === undefined || raw === null || raw === "") {
    if (required) {
      throw new ToolArgumentError('"tokenSymbol" parametresi zorunludur ve boş olmayan bir string olmalıdır.');
    }
    return undefined;
  }

  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ToolArgumentError('"tokenSymbol" boş olmayan bir string olmalıdır.');
  }

  return raw.trim();
}

function requireAccount(context: ToolExecutionContext): Account {
  const account = deps!.getAccount(context.account);
  if (!account) {
    throw new ToolArgumentError(`Hesap bulunamadı veya cüzdan kilitli: "${context.account}".`);
  }
  return account;
}

// ─── Serialization — bigint fields can't cross JSON.stringify as-is ─

function serializeShieldedHolding(holding: ShieldedHolding) {
  return {
    wrapper: holding.wrapper,
    underlying: holding.underlying,
    symbol: holding.symbol,
    confidentialDecimals: holding.confidentialDecimals,
    rate: holding.rate.toString(),
    isNative: holding.isNative,
    balance: holding.balance,
    isLegacy: holding.isLegacy,
  };
}

function serializeUnshieldClaim(claim: UnshieldClaim) {
  return {
    to: claim.to,
    ctHash: claim.ctHash,
    requestedAmount: claim.requestedAmount.toString(),
    decryptedAmount: claim.decryptedAmount.toString(),
    claimed: claim.claimed,
  };
}

// ─── Tool handlers ──────────────────────────────────────────────────

async function handleGetBalance(network: Network, context: ToolExecutionContext): Promise<unknown> {
  // Network.getBalance returns the native balance in wei, not a display-formatted amount —
  // formatting for the user is the chat UI's job, not this bridge's.
  const balanceWei = await network.getBalance(context.account);
  return { address: context.account, balanceWei };
}

async function handleGetShieldedBalance(
  network: Network,
  account: Account,
  args: Record<string, unknown>
): Promise<unknown> {
  const tokenSymbol = requireTokenSymbol(args, true)!;

  // Network.ts has no public symbol → wrapper-address lookup, only getShieldedPortfolio's
  // registry walk. Reusing it here costs an extra decrypt pass per call, but it's the only
  // public API that maps a symbol to a balance.
  const portfolio = await network.getShieldedPortfolio(account);
  const holding = portfolio.find((h) => h.symbol.toLowerCase() === tokenSymbol.toLowerCase());

  if (!holding) {
    return { tokenSymbol, found: false, balance: "0.0" };
  }
  return { ...serializeShieldedHolding(holding), found: true };
}

async function handleGetShieldedPortfolio(network: Network, account: Account): Promise<unknown> {
  const holdings = await network.getShieldedPortfolio(account);
  return holdings.map(serializeShieldedHolding);
}

async function handleGetPendingClaims(
  network: Network,
  account: Account,
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<unknown> {
  const tokenSymbol = requireTokenSymbol(args, false);

  // getPendingClaims itself only needs the address (claim data is read on-chain, no permit
  // required), but resolving which wrapper(s) to check still goes through the portfolio —
  // same trade-off as handleGetShieldedBalance above.
  const portfolio = await network.getShieldedPortfolio(account);
  const targets = tokenSymbol
    ? portfolio.filter((h) => h.symbol.toLowerCase() === tokenSymbol.toLowerCase())
    : portfolio;

  const perToken = await Promise.all(
    targets.map(async (holding) => ({
      tokenSymbol: holding.symbol,
      wrapper: holding.wrapper,
      claims: (await network.getPendingClaims(holding.wrapper, context.account)).map(serializeUnshieldClaim),
    }))
  );

  // Only surface tokens that actually have something pending — an empty list per token
  // would just be noise for the model to filter back out.
  return perToken.filter((entry) => entry.claims.length > 0);
}

// ─── Entry point ────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Execute one tool_call the model returned.
 *
 * Never throws: policy denials, bad arguments, and any exception Network.ts raises are all
 * caught and reported as `{ error }` so a malformed or hallucinated tool_call can't crash
 * the agent loop — the model gets a normal message back and can retry or explain.
 */
export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  // walletContext.balance only matters for PROPOSAL_TOOLS' ratio cap; every tool routed
  // through this runner today is read-only, so the placeholder is never consulted.
  const decision = policyEngine.evaluate(toolName, args, { balance: 0 });
  if (!decision.allowed) {
    return { error: decision.reason };
  }
  if (decision.requiresConfirmation) {
    return {
      error: `"${toolName}" kullanıcı onayı gerektiren bir işlemdir ve bu araç sürümü henüz PROPOSAL_TOOLS çalıştırmıyor.`,
    };
  }

  if (!deps) {
    return { error: "AgentToolRunner yapılandırılmadı: önce configureAgentToolRunner() çağrılmalı." };
  }

  let network: Network;
  try {
    network = deps.getNetwork(context.networkId);
  } catch (err) {
    return { error: `Ağ çözümlenemedi ("${context.networkId}"): ${errorMessage(err)}` };
  }

  try {
    switch (toolName as ReadOnlyTool) {
      case "get_balance":
        return { result: await handleGetBalance(network, context) };

      case "get_shielded_balance":
        return { result: await handleGetShieldedBalance(network, requireAccount(context), args) };

      case "get_shielded_portfolio":
        return { result: await handleGetShieldedPortfolio(network, requireAccount(context)) };

      case "get_pending_claims":
        return { result: await handleGetPendingClaims(network, requireAccount(context), args, context) };

      default:
        // Reached only if READ_ONLY_TOOLS grows a name this runner hasn't implemented yet —
        // evaluate() already rejects anything outside READ_ONLY_TOOLS/PROPOSAL_TOOLS.
        return { error: `Bilinmeyen tool: "${toolName}".` };
    }
  } catch (err) {
    // Covers both ToolArgumentError and anything Network.ts throws (e.g. an FHE decrypt
    // failure other than CiphertextNotFoundError, which Network.ts already normalizes to a
    // "0.0" balance internally and never throws in the first place).
    return { error: errorMessage(err) };
  }
}
