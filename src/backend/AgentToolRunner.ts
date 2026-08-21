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
 * Every call — including read-only ones — goes through AgentPolicyEngine.evaluate() first:
 * it enforces the forbidden list, and for PROPOSAL_TOOLS, the balance-ratio cap and the
 * per-session proposal count.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * PROPOSAL_TOOLS (propose_send / propose_shield / propose_unshield) are PREVIEW-ONLY.
 * This module never signs or broadcasts a transaction for them — it builds the exact
 * calldata Network.ts would send, runs it through TransactionSimulator.simulateTransaction()
 * (an eth_call, nothing more), and returns the result for the wallet UI to show the user as
 * a confirmation card. There is no path from here to Account.ethers_wallet or
 * Network.sendTransaction for a proposal tool, and there must never be one — executing a
 * confirmed proposal is a separate, explicit user action outside this tool-calling loop.
 * ────────────────────────────────────────────────────────────────────────────────────────
 */

import type { Provider } from "ethers";
import type { Network } from "./Network.js";
import type Account from "./Account.js";
import { TransactionSimulator, type SimResult } from "./TransactionSimulator.js";
import { isDomainName, resolveDomain } from "./DomainResolver.js";
import {
  AgentPolicyEngine,
  READ_ONLY_TOOLS,
  PROPOSAL_TOOLS,
  X402_TOOLS,
  type ReadOnlyTool,
  type ProposalTool,
  type AgentToolArgs,
  type PolicyDecision,
} from "./AgentPolicyEngine.js";
import type { ShieldedHolding, UnshieldClaim } from "../types/fhe.js";
import { X402SettingsService } from "./X402SettingsService.js";
import { X402SpendingLedger } from "./X402SpendingLedger.js";
import { fetchX402PaymentRequirement, settleX402Payment, type X402PaymentRequirement } from "./X402ProxyClient.js";
import {
  signTransferWithAuthorization,
  generateAuthorizationNonce,
  type Eip3009Authorization,
  type Eip3009TokenIdentity,
} from "./X402PaymentService.js";

// ─── Types ──────────────────────────────────────────────────────────

export interface ToolExecutionContext {
  /** Active wallet address the tool call should operate on. */
  account: string;
  /** Active NetworkId (see NetworkTypes.ts), as its string form. */
  networkId: string;
}

/** The confirmation-card payload a proposal tool produces. Never executes anything itself. */
export interface ProposalPreview {
  requiresConfirmation: true;
  toolName: string;
  originalArgs: Record<string, unknown>;
  simulation: SimResult;
}

export interface ToolExecutionResult {
  result?: unknown;
  error?: string;
  /**
   * Set only alongside `error`, and only when it originated from an AgentPolicyEngine denial —
   * see PolicyDecision.reasonKey's own docs. Carried through unchanged so AgentOrchestrator.ts's
   * tool message can include it for AgentProposalHistory.ts's extractPolicyDenials() to pick up;
   * `error` itself (the model-facing English text) is never touched.
   */
  reasonKey?: string;
  reasonParams?: Record<string, string>;
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
  /**
   * Resolves the USDC contract's EIP-712 domain identity for x402 payments on the given
   * networkId, or undefined if x402 isn't supported there yet (Faz 3 only targets Base
   * Sepolia — see AppContext.ts's wiring). Deliberately a caller-supplied resolver rather than
   * this module importing contract addresses itself: those addresses live in
   * components/panels/shared.tsx (CONTRACTS_BASE_SEPOLIA), and backend/ modules never import
   * from components/ — same layering AgentProposalHistory.ts's docs already call out.
   */
  getUsdcTokenIdentity(networkId: string): Eip3009TokenIdentity | undefined;
}

/** Raised for a malformed/unsupported tool_call argument — caught alongside Network.ts errors below. */
class ToolArgumentError extends Error {}

/**
 * Raised only for an AgentPolicyEngine denial inside handlePayForResource (x402_invalid_amount/
 * x402_disabled) — unlike a plain ToolArgumentError, this carries `reasonKey`/`reasonParams`
 * (see PolicyDecision's own docs on AgentPolicyEngine.ts) so the catch block in executeToolCall
 * can attach them to the `{error}` result, exactly like the PROPOSAL_TOOLS denial paths (evaluate()
 * results) already do via `return { error, reasonKey, reasonParams }`. handlePayForResource itself
 * only ever throws (its return type is folded into a `{result}` wrapper at the call site, with no
 * room for a denial variant), so a distinguishable subclass — rather than restructuring that
 * control flow — is the minimal way to thread the same structured data through the same throw/catch
 * path every other error in this function already uses.
 */
class PolicyDenialError extends Error {
  reasonKey?: string;
  reasonParams?: Record<string, string>;

  constructor(decision: PolicyDecision) {
    super(decision.reason);
    this.reasonKey = decision.reasonKey;
    this.reasonParams = decision.reasonParams;
  }
}

// ─── Configuration (singleton, same pattern as FheCofheService) ────

let deps: AgentToolRunnerDeps | null = null;

/** Must be called once (e.g. when the wallet unlocks) before executeToolCall(). */
export function configureAgentToolRunner(newDeps: AgentToolRunnerDeps): void {
  deps = newDeps;
}

/**
 * Single source of truth for the USDC EIP-712 domain — used by both the auto-pay path
 * (handlePayForResource, above) and ConfirmationCard's manual/over-budget approval path, so the
 * two never drift into signing against different domains (which the token contract's
 * transferWithAuthorization would silently reject as an invalid signature).
 */
export function getUsdcTokenIdentity(networkId: string): Eip3009TokenIdentity | undefined {
  return deps?.getUsdcTokenIdentity(networkId);
}

const policyEngine = new AgentPolicyEngine();
/** x402 spending record — chrome.storage.local-backed, see X402SpendingLedger.ts's own docs for why. */
const spendingLedger = new X402SpendingLedger();

/** Test-only escape hatch to reset configuration (and accumulated policy state) between test cases. */
export function resetAgentToolRunner(): void {
  deps = null;
  policyEngine.resetSession();
}

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

function requireNonEmptyString(args: Record<string, unknown>, key: string): string {
  const raw = args[key];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ToolArgumentError(`"${key}" parametresi zorunludur ve boş olmayan bir string olmalıdır.`);
  }
  return raw.trim();
}

/** Validates `amount` and returns both the original decimal string and its numeric form. */
function requirePositiveAmount(args: Record<string, unknown>): { amount: string; amountNumber: number } {
  const amount = requireNonEmptyString(args, "amount");
  const amountNumber = Number(amount);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    throw new ToolArgumentError('"amount" pozitif bir sayısal string olmalıdır.');
  }
  return { amount, amountNumber };
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

// ─── Read-only tool handlers ─────────────────────────────────────────

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

// ─── Proposal tool handlers (preview-only — see file header) ────────

async function getEthersProvider(network: Network): Promise<Provider> {
  if (!network.rpc_url) {
    throw new ToolArgumentError("Aktif ağ için RPC URL ayarlanmamış.");
  }
  const { JsonRpcProvider } = await import("ethers");
  return new JsonRpcProvider(network.rpc_url);
}

/**
 * Runs the simulation and turns a determined-to-fail result (insufficient balance, invalid
 * recipient, a revert — anything simulateTransaction itself decided rather than threw) into
 * a thrown ToolArgumentError, so the single catch in executeToolCall reports it as `{error}`
 * exactly like every other failure mode. A proposal that would fail never becomes a
 * confirmation card.
 */
async function simulateAndEnrich(
  provider: Provider,
  tx: { from: string; to: string; value?: string; data?: string }
): Promise<SimResult> {
  const simulator = new TransactionSimulator(provider);
  const simulation = await simulator.simulateTransaction(tx);

  if (!simulation.success) {
    throw new ToolArgumentError(
      simulation.error ?? "İşlem simülasyonu başarısız oldu — muhtemelen yetersiz bakiye veya geçersiz adres."
    );
  }

  await simulator.enrichBalanceChanges(simulation);
  return simulation;
}

/**
 * What a proposal tool needs resolved before AgentPolicyEngine.evaluate() can run with a
 * real balance: the ratio cap is meaningless against a placeholder, so the balance (and
 * whatever Network/Account data the actual preview will need) is fetched up front, then
 * `buildPreview` reuses it — no re-fetching after the policy check passes.
 */
interface PreparedProposal {
  /** Balance of the asset this proposal would move, in the same unit as `amount`. */
  balance: number;
  amountNumber: number;
  buildPreview: () => Promise<ProposalPreview>;
}

async function prepareProposeSend(
  network: Network,
  context: ToolExecutionContext,
  args: Record<string, unknown>
): Promise<PreparedProposal> {
  const toInput = requireNonEmptyString(args, "to");
  const { amount, amountNumber } = requirePositiveAmount(args);
  const tokenSymbolRaw = args.tokenSymbol;
  const tokenSymbol = typeof tokenSymbolRaw === "string" && tokenSymbolRaw.trim() ? tokenSymbolRaw.trim() : undefined;

  // Only the native token can be previewed: there is no symbol → contract-address registry
  // available to this bridge (that's TokenCache, owned by the UI layer), so an arbitrary
  // ERC-20 "USDC" can't be resolved to the right contract here. Refusing explicitly beats
  // silently simulating against the wrong address.
  if (tokenSymbol && tokenSymbol.toLowerCase() !== network.currency_symbol.toLowerCase()) {
    throw new ToolArgumentError(
      `"${tokenSymbol}" için gönderim önizlemesi şu an desteklenmiyor — bu araç yalnızca native token ` +
      `(${network.currency_symbol}) gönderimlerini önizleyebilir.`
    );
  }

  // The tool schema advertises ENS/UD recipients, so resolution has to actually happen here
  // — otherwise every domain-addressed proposal would fail simulation for a reason the user
  // never sees explained.
  let to = toInput;
  if (isDomainName(toInput)) {
    const resolved = await resolveDomain(toInput);
    if (!resolved.address) {
      throw new ToolArgumentError(resolved.error ?? `"${toInput}" bir adrese çözümlenemedi.`);
    }
    to = resolved.address;
  }

  const balanceWei = await network.getBalance(context.account);
  const { formatEther } = await import("ethers");
  const balance = Number(formatEther(balanceWei));

  return {
    balance,
    amountNumber,
    buildPreview: async () => {
      const { parseEther } = await import("ethers");
      const valueWei = parseEther(amount).toString();
      const provider = await getEthersProvider(network);
      const simulation = await simulateAndEnrich(provider, { from: context.account, to, value: valueWei });
      return { requiresConfirmation: true, toolName: "propose_send", originalArgs: args, simulation };
    },
  };
}

async function prepareProposeShield(
  network: Network,
  context: ToolExecutionContext,
  args: Record<string, unknown>
): Promise<PreparedProposal> {
  const { amount, amountNumber } = requirePositiveAmount(args);
  const tokenSymbol = requireTokenSymbol(args, true)!;

  // Same registry gap as propose_send: only the native wrapper's address is resolvable
  // without TokenCache, so ERC-20 shielding can't be safely previewed here yet.
  if (tokenSymbol.toLowerCase() !== network.currency_symbol.toLowerCase()) {
    throw new ToolArgumentError(
      `"${tokenSymbol}" için shield önizlemesi şu an desteklenmiyor — bu araç yalnızca native token ` +
      `(${network.currency_symbol}) shield işlemlerini önizleyebilir.`
    );
  }

  const account = requireAccount(context);
  const balanceWei = await network.getBalance(context.account);
  const { formatEther } = await import("ethers");
  const balance = Number(formatEther(balanceWei));

  return {
    balance,
    amountNumber,
    buildPreview: async () => {
      // Resolved here (only once the proposal has passed policy) rather than during
      // prepare — shieldNative's wrapper address doesn't require decrypting a portfolio,
      // just its own address, so this avoids a needless decrypt pass when the balance
      // check alone already rejects the proposal.
      const portfolio = await network.getShieldedPortfolio(account);
      const nativeHolding = portfolio.find((h) => h.isNative);
      if (!nativeHolding) {
        throw new ToolArgumentError("Bu ağda native shielded wrapper bulunamadı.");
      }

      const { Interface, parseEther } = await import("ethers");
      // Mirrors Network.SHIELDED_ABI's shieldNative fragment exactly — must encode
      // identically to what Network.shieldNative() itself would send.
      const iface = new Interface(["function shieldNative(address to)"]);
      const valueWei = parseEther(amount).toString();

      const provider = await getEthersProvider(network);
      const simulation = await simulateAndEnrich(provider, {
        from: context.account,
        to: nativeHolding.wrapper,
        value: valueWei,
        data: iface.encodeFunctionData("shieldNative", [context.account]),
      });

      return { requiresConfirmation: true, toolName: "propose_shield", originalArgs: args, simulation };
    },
  };
}

async function prepareProposeUnshield(
  network: Network,
  context: ToolExecutionContext,
  args: Record<string, unknown>
): Promise<PreparedProposal> {
  const { amount, amountNumber } = requirePositiveAmount(args);
  const tokenSymbol = requireTokenSymbol(args, true)!;
  const account = requireAccount(context);

  // Unlike send/shield, the confidential symbol space here matches get_shielded_balance's
  // exactly (both describe the shielded wrapper, e.g. "aeETH") — no registry gap, so this
  // works for any shielded token, not just the native wrapper.
  const portfolio = await network.getShieldedPortfolio(account);
  const holding = portfolio.find((h) => h.symbol.toLowerCase() === tokenSymbol.toLowerCase());
  if (!holding) {
    throw new ToolArgumentError(`Shielded token bulunamadı: "${tokenSymbol}".`);
  }

  return {
    // Confidential balance, already decrypted and decimal-formatted by getShieldedPortfolio
    // — exactly the unit `amount` is in, so no conversion needed for the ratio check.
    balance: Number(holding.balance),
    amountNumber,
    buildPreview: async () => {
      const { Interface, parseUnits } = await import("ethers");
      // Mirrors Network.SHIELDED_ABI's unshield fragment exactly (see Network.unshield()).
      const iface = new Interface(["function unshield(address from, address to, uint64 amount)"]);
      const amountValue = parseUnits(amount, holding.confidentialDecimals);

      const provider = await getEthersProvider(network);
      const simulation = await simulateAndEnrich(provider, {
        from: context.account,
        to: holding.wrapper,
        value: "0",
        data: iface.encodeFunctionData("unshield", [context.account, context.account, amountValue]),
      });

      return { requiresConfirmation: true, toolName: "propose_unshield", originalArgs: args, simulation };
    },
  };
}

async function prepareProposal(
  toolName: ProposalTool,
  network: Network,
  context: ToolExecutionContext,
  args: Record<string, unknown>
): Promise<PreparedProposal> {
  switch (toolName) {
    case "propose_send":
      return prepareProposeSend(network, context, args);
    case "propose_shield":
      return prepareProposeShield(network, context, args);
    case "propose_unshield":
      return prepareProposeUnshield(network, context, args);
  }
}

// ─── x402 payment tool (Faz 3) ───────────────────────────────────────
//
// pay_for_resource is NOT a PROPOSAL_TOOLS call — see AgentPolicyEngine.X402_TOOLS's own docs.
// Its confirmation decision comes from evaluateX402Payment() (budget/ceiling check), not
// evaluate() (balance-ratio/session-count). Two shapes can come back:
//   - requiresConfirmation:true — a ConfirmationCard-compatible ProposalPreview (see below),
//     same as any propose_* tool. No signing has happened.
//   - autoPaid:true — the payment already happened (signed + settled + recorded to the
//     ledger) before this function returns. The model/agent never decided this; it only sees
//     the outcome, same as it only ever sees a settled propose_send's outcome after the fact.

/** USDC has 6 decimals — every amount x402 moves is expressed in USD 1:1 with USDC. */
const USDC_ATOMIC_UNITS_PER_USD = 1_000_000;

function amountUsdFromAtomicUnits(atomic: string): number {
  const value = Number(atomic);
  if (!Number.isFinite(value)) return NaN;
  return value / USDC_ATOMIC_UNITS_PER_USD;
}

/**
 * A structurally-honest, NOT eth_call-simulated SimResult for the ConfirmationCard preview:
 * the balanceChange really is what will happen (USDC leaves `account` to `requirement.payTo`)
 * even though — unlike propose_send/shield/unshield — no TransactionSimulator eth_call ever
 * ran to produce it (there's nothing to eth_call: EIP-3009 is an off-chain signature, not a
 * transaction). The warning makes that distinction explicit to the user rather than letting the
 * reused shape imply a simulation that didn't happen.
 */
function buildX402SimResult(requirement: X402PaymentRequirement, amountUsd: number, account: string): SimResult {
  return {
    success: true,
    balanceChanges: [
      {
        tokenAddress: requirement.asset,
        symbol: "USDC",
        decimals: 6,
        amountWei: requirement.maxAmountRequired,
        amountFormatted: amountUsd.toFixed(2),
        from: account,
        to: requirement.payTo,
        type: "ERC20",
      },
    ],
    warnings: [
      `Bu bir x402 mikro-ödeme yetkilendirmesidir ("${requirement.resource}" için) — normal bir işlem ` +
        "simülasyonu değildir. EIP-3009 ile imzalanır, gaz ücreti alınmaz; bir facilitator imzayı " +
        "zincire gönderip ödemeyi sonuçlandırır.",
    ],
    riskLevel: "LOW",
    operationType: "transfer",
  };
}

async function handlePayForResource(
  context: ToolExecutionContext,
  args: Record<string, unknown>
): Promise<unknown> {
  const resource = requireNonEmptyString(args, "resource");

  const requirement = await fetchX402PaymentRequirement(resource);
  const amountUsd = amountUsdFromAtomicUnits(requirement.maxAmountRequired);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new ToolArgumentError("x402 proxy geçersiz bir ödeme tutarı döndürdü.");
  }

  const settings = await X402SettingsService.getSettings();
  const spentToday = await spendingLedger.getSpentToday(context.account);
  const decision = policyEngine.evaluateX402Payment(amountUsd, settings, spentToday);

  if (!decision.allowed) {
    throw new PolicyDenialError(decision);
  }

  if (decision.requiresConfirmation) {
    return {
      requiresConfirmation: true,
      toolName: "pay_for_resource",
      originalArgs: args,
      simulation: buildX402SimResult(requirement, amountUsd, context.account),
    };
  }

  // ── Auto-pay: no ConfirmationCard, no human in the loop — evaluateX402Payment() already
  //    established this is within budget. Sign, settle, record; only then return. ──
  const tokenIdentity = deps!.getUsdcTokenIdentity(context.networkId);
  if (!tokenIdentity) {
    throw new ToolArgumentError(`x402 ödemeleri bu ağda ("${context.networkId}") desteklenmiyor.`);
  }
  const account = requireAccount(context);
  if (!account.ethers_wallet) {
    throw new ToolArgumentError("Hesap kilitli veya imza için kullanılamıyor.");
  }

  const authorization: Eip3009Authorization = {
    from: context.account,
    to: requirement.payTo,
    value: requirement.maxAmountRequired,
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + requirement.maxTimeoutSeconds,
    nonce: generateAuthorizationNonce(),
  };

  const signed = await signTransferWithAuthorization(account.ethers_wallet, tokenIdentity, authorization);
  const settlement = await settleX402Payment(resource, signed);

  await spendingLedger.recordPayment({
    id: settlement.txHash,
    accountAddress: context.account,
    amountUsd,
    timestamp: Date.now(),
    service: resource,
    txHash: settlement.txHash,
  });

  return {
    autoPaid: true,
    toolName: "pay_for_resource",
    resource,
    amountUsd,
    txHash: settlement.txHash,
    remainingBudgetUsd: decision.remainingBudgetUsd,
  };
}

// ─── Entry point ────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Execute one tool_call the model returned.
 *
 * Never throws: policy denials, bad arguments, and any exception Network.ts or
 * TransactionSimulator raises are all caught and reported as `{ error }` so a malformed or
 * hallucinated tool_call can't crash the agent loop — the model gets a normal message back
 * and can retry or explain.
 */
export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
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
    // ── Read-only tools: policy is a trivial always-allow, no balance needed. ──
    if ((READ_ONLY_TOOLS as readonly string[]).includes(toolName)) {
      const decision = policyEngine.evaluate(toolName, args, { balance: 0 });
      if (!decision.allowed) return { error: decision.reason, reasonKey: decision.reasonKey, reasonParams: decision.reasonParams };

      switch (toolName as ReadOnlyTool) {
        case "get_balance":
          return { result: await handleGetBalance(network, context) };
        case "get_shielded_balance":
          return { result: await handleGetShieldedBalance(network, requireAccount(context), args) };
        case "get_shielded_portfolio":
          return { result: await handleGetShieldedPortfolio(network, requireAccount(context)) };
        case "get_pending_claims":
          return { result: await handleGetPendingClaims(network, requireAccount(context), args, context) };
      }
    }

    // ── Proposal tools: resolve the real balance/capability BEFORE evaluate(), since the
    //    ratio cap is meaningless against a placeholder — see prepareProposal. ──
    if ((PROPOSAL_TOOLS as readonly string[]).includes(toolName)) {
      const prepared = await prepareProposal(toolName as ProposalTool, network, context, args);

      const policyArgs: AgentToolArgs = { ...args, amount: prepared.amountNumber };
      const decision = policyEngine.evaluate(toolName, policyArgs, { balance: prepared.balance });
      if (!decision.allowed) return { error: decision.reason, reasonKey: decision.reasonKey, reasonParams: decision.reasonParams };

      return { result: await prepared.buildPreview() };
    }

    // ── x402 payment tool: its own decision path (evaluateX402Payment), not evaluate() —
    //    see handlePayForResource's own docs for why this is a separate branch entirely. ──
    if ((X402_TOOLS as readonly string[]).includes(toolName)) {
      return { result: await handlePayForResource(context, args) };
    }

    // Forbidden or genuinely unrecognized — evaluate() supplies the precise reason
    // (forbidden_tool vs unknown_tool) without needing any Network/Account lookup.
    const decision = policyEngine.evaluate(toolName, args, { balance: 0 });
    return { error: decision.reason, reasonKey: decision.reasonKey, reasonParams: decision.reasonParams };
  } catch (err) {
    // A PolicyDenialError (handlePayForResource's own AgentPolicyEngine denial) carries
    // reasonKey/reasonParams — attach them the same way the PROPOSAL_TOOLS denial paths above
    // do, so AgentProposalHistory.ts's extractPolicyDenials() can translate it for a human.
    if (err instanceof PolicyDenialError) {
      return { error: err.message, reasonKey: err.reasonKey, reasonParams: err.reasonParams };
    }
    // Covers ToolArgumentError, a determined-to-fail simulation (see simulateAndEnrich),
    // and anything Network.ts throws (e.g. an FHE decrypt failure other than
    // CiphertextNotFoundError, which Network.ts already normalizes to a "0.0" balance
    // internally and never throws in the first place).
    return { error: errorMessage(err) };
  }
}
