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
import { formatEther } from "ethers";
import type { Network } from "./Network.js";
import { NetworkId } from "./NetworkTypes.js";
import type Account from "./Account.js";
import { TransactionSimulator, type SimResult } from "./TransactionSimulator.js";
import { isDomainName } from "./DomainResolver.js";
import {
  AgentPolicyEngine,
  READ_ONLY_TOOLS,
  PROPOSAL_TOOLS,
  X402_TOOLS,
  IMMEDIATE_TOOLS,
  type ReadOnlyTool,
  type ProposalTool,
  type ImmediateTool,
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
  /**
   * Resolves what get_connected_sites shows: injected-provider site grants for this address
   * (SitePermissionService) plus active WalletConnect sessions (WalletConnectService) — two
   * separate connection mechanisms, both surfaced together since a user asking "which sites
   * can see my wallet" doesn't distinguish between them. Deliberately not scoped to one
   * account for the WalletConnect half — a WC session isn't tied to a single address the way
   * an injected-provider grant is (see SitePermission.accounts's own docs), so it's listed
   * regardless of which account is currently active.
   */
  getConnectedSites(address: string): Promise<ConnectedSitesInfo>;
  /**
   * Derives a new local account and makes it active — the same call the wallet's own
   * "Create New Account" button makes. Never touches the network or an existing key; see
   * IMMEDIATE_TOOLS's own docs for why create_account is allowed to skip a confirmation card.
   */
  createAccount(name?: string): { index: number; address: string; name: string };
  /**
   * Every account in this wallet — the same list the account switcher shows, in the same
   * order, with the display names the user gave them.
   *
   * Needed because "send 1 LINK to biar" names an account, not an address, and the runner
   * had no way to know that "biar" was one of the user's own wallets. Deliberately the
   * wallet's own accounts only: this is not an address book, and nothing here comes from a
   * counterparty.
   */
  listAccounts(): { index: number; name: string; address: string; isActive: boolean }[];
}

export interface ConnectedSitesInfo {
  injectedSites: { origin: string; grantedAt: number; lastUsedAt: number }[];
  walletConnectSessions: { name: string; url: string; expiry: number }[];
}

/** Raised for a malformed/unsupported tool_call argument — caught alongside Network.ts errors below. */
/**
 * `reasonKey` is optional and only set where the caller has an existing i18n string worth
 * reusing (e.g. the x402 unsupported-network case below, which shares
 * "agent.confirmationCardX402UnsupportedNetwork" with ConfirmationCard's own manual-approve
 * path) — threaded through to the `{error}` result the same way PolicyDenialError's is, so
 * AgentOrchestrator's system prompt can react to it distinctly instead of every ToolArgumentError
 * collapsing into the same unstructured English string.
 */
class ToolArgumentError extends Error {
  reasonKey?: string;

  constructor(message: string, reasonKey?: string) {
    super(message);
    this.reasonKey = reasonKey;
  }
}

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
    // `id` is how the claim is referenced on-chain, and it is not the ciphertext handle —
    // confidential-contracts 0.4 split the two. Both are exposed so the agent can describe
    // a claim without the caller having to know which one settles it.
    id: claim.id,
    to: claim.to,
    ctHash: claim.ctHash,
    // `requestedAmount` no longer exists: the contracts dropped it, keeping only the
    // amount actually proven at settlement.
    decryptedAmount: claim.decryptedAmount.toString(),
    claimed: claim.claimed,
  };
}

// ─── Read-only tool handlers ─────────────────────────────────────────

/**
 * Friendly chain names → the wallet's own built-in testnet ids. Deliberately only the three
 * chains NetworkProvider actually keeps a live instance of (see its class docs — those are the
 * only ones the wallet guarantees exist) — a mainnet id would resolve to nothing here unless the
 * user has separately added it as a custom network, which is why a raw numeric chain id is also
 * accepted below (falls through to NetworkProvider.getNetworkById's customNetworks lookup).
 */
const NAMED_NETWORKS: Record<string, NetworkId> = {
  ethereum: NetworkId.Ethereum_Sepolia,
  eth: NetworkId.Ethereum_Sepolia,
  sepolia: NetworkId.Ethereum_Sepolia,
  arbitrum: NetworkId.Arbitrum_Sepolia,
  base: NetworkId.Base_Sepolia,
};

/**
 * Resolves the `network` arg a cross-chain-aware read-only tool (currently just get_balance)
 * accepts — a friendly name ("base", "arbitrum", "ethereum") or a raw chain id number/string for
 * a custom network the user added themselves. Falls back to `activeNetwork` (the wallet's
 * current active network, same as every other tool already uses) when the arg is absent, so
 * omitting it is always safe and behaves exactly as before this existed.
 *
 * Deliberately NOT used by propose_send/shield/unshield — those must only ever act on the
 * network the user is actually looking at, never one the model picked, since a broadcast on the
 * wrong chain is a real-funds mistake a read-only balance check can't cause.
 */
function resolveBalanceCheckNetwork(args: Record<string, unknown>, activeNetwork: Network): Network {
  const requested = args.network;
  if (requested === undefined || requested === null || requested === "") return activeNetwork;
  if (!deps) return activeNetwork; // unreachable in practice (executeToolCall already checked), keeps this function total

  const raw = String(requested).trim();
  const networkId = /^\d+$/.test(raw) ? Number(raw) : NAMED_NETWORKS[raw.toLowerCase()];
  if (networkId === undefined) {
    throw new Error(`Bilinmeyen ağ: "${raw}". Desteklenen: ethereum, arbitrum, base (ya da eklediğiniz özel bir ağın chain ID'si).`);
  }
  return deps.getNetwork(String(networkId));
}

async function handleGetBalance(network: Network, context: ToolExecutionContext, args: Record<string, unknown>): Promise<unknown> {
  // Network.getBalance returns the native balance in wei. Converting an 18-digit integer to
  // decimal ETH is exactly the kind of arithmetic a model gets wrong under its breath — so
  // this does the division here with ethers' formatEther (same as get_shielded_balance's
  // formatTokenAmount), instead of handing the model raw wei and hoping it divides by 1e18
  // correctly in prose. balanceWei is still included for anything that genuinely needs the
  // exact integer (e.g. comparing against another wei amount).
  const targetNetwork = resolveBalanceCheckNetwork(args, network);
  const balanceWei = await targetNetwork.getBalance(context.account);
  return {
    address: context.account,
    network: targetNetwork.network_name,
    balance: formatEther(balanceWei),
    balanceWei,
  };
}

/**
 * Every curated token on a network, with what this account actually holds of each.
 *
 * get_balance answers for the native coin alone, which left the agent unable to answer the
 * most ordinary question a wallet gets asked — "what do I have?" — for anything else. It
 * would report 0.4 ETH and say nothing about the USDC sitting next to it, and a user asking
 * to send USDC got told the wallet could not see any.
 *
 * The list is SwapService's curated registry (symbol, address and decimals all read off the
 * contracts themselves), not a chain scan: this answers "which of the tokens this wallet
 * understands do I hold", and every entry it names is one the send/shield tools can then act
 * on. A token the wallet has no registry entry for is deliberately absent — naming one the
 * next tool call would reject is worse than not naming it.
 *
 * Zero balances are kept rather than filtered. "You have no USDC" is a real answer, and a
 * model handed only non-empty rows tends to claim the token does not exist on the network.
 */
async function handleGetTokenBalances(network: Network, context: ToolExecutionContext): Promise<unknown> {
  const { default: SwapService } = await import("./SwapService.js");
  const curated = SwapService.getInstance().getTokens(network.network_id);

  const nativeWei = await network.getBalance(context.account);
  const tokens = await Promise.all(
    curated
      .filter((t) => !t.isNative)
      .map(async (t) => ({
        symbol: t.symbol,
        name: t.name,
        address: t.address,
        decimals: t.decimals,
        // Network.getTokenBalance swallows its own failures and returns "0" — a token whose
        // RPC read failed is indistinguishable from one held at zero. Worth knowing, but not
        // worth failing the whole listing over: the other rows are still correct.
        balance: await network.getTokenBalance(t.address, context.account),
      }))
  );

  return {
    address: context.account,
    network: network.network_name,
    native: { symbol: network.currency_symbol, balance: formatEther(nativeWei) },
    tokens,
  };
}

/**
 * The wallet's own accounts, so the agent can act on the names the user actually uses.
 *
 * People do not refer to their wallets by address. "Send it to biar" or "move some to
 * New User #1" is how the request arrives, and until this existed the agent had no way to
 * turn that into anything — it could see only the one active account it was given, so a
 * perfectly clear instruction came back as a request for a 0x address the user already
 * knew the wallet held.
 *
 * Addresses only, never keys or mnemonics: those never leave AccountManager, and no tool
 * here is capable of asking for them.
 *
 * Worth knowing that calling this puts every account address of this wallet into the model's
 * context, and for the hosted agent that means the proxy and OpenRouter see them together —
 * linking addresses the chain itself does not link. That is why it is a tool the model has
 * to choose to call for a reason, rather than something folded into every request's context.
 */
function handleGetAccounts(): unknown {
  const accounts = deps!.listAccounts();
  return {
    count: accounts.length,
    accounts: accounts.map((a) => ({
      name: a.name,
      address: a.address,
      isActive: a.isActive,
    })),
  };
}

/**
 * Well-known, official faucet page for each testnet the wallet supports — deliberately just a
 * URL, never an API endpoint we POST to on the user's behalf. Every mainstream faucet requires a
 * CAPTCHA specifically to stop automated claiming, so there is no honest "auto-claim" version of
 * this tool; handleGetFaucetInfo hands the model a real link + the user's own address to relay,
 * nothing more. Missing entries (e.g. mainnets, or a testnet with no well-known public faucet)
 * fall through to handleGetFaucetInfo's `supported: false` branch rather than guessing a URL.
 */
const FAUCET_URLS: Partial<Record<NetworkId, string>> = {
  [NetworkId.Ethereum_Sepolia]: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia",
  [NetworkId.Arbitrum_Sepolia]: "https://faucet.quicknode.com/arbitrum/sepolia",
  [NetworkId.Base_Sepolia]: "https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet",
  [NetworkId.Avalanche_Fuji]: "https://core.app/tools/testnet-faucet/",
  [NetworkId.Monad_Testnet]: "https://testnet.monad.xyz/",
};

function handleGetFaucetInfo(network: Network, context: ToolExecutionContext): unknown {
  const faucetUrl = FAUCET_URLS[network.network_id];
  if (!faucetUrl) {
    return { supported: false, network: network.network_name };
  }
  return { supported: true, network: network.network_name, faucetUrl, address: context.account };
}

/**
 * Read-only, but a real chain scan (chunked eth_getLogs) — see Network.getTokenApprovals's own
 * docs for why. 500 blocks (not the method's own 10,000 default) matches Revoke.tsx's own live
 * scan depth — the tradeoff that page already accepted between recency and how long a person
 * will wait for a response, agent or manual UI, is the same tradeoff either way.
 */
async function handleGetTokenApprovals(network: Network, context: ToolExecutionContext): Promise<unknown> {
  const approvals = await network.getTokenApprovals(context.account, 500);
  // allowanceRaw is a bigint — can't cross JSON.stringify as-is, and the model never needs the
  // raw unit anyway (the formatted `allowance` string already carries the human-readable value).
  return approvals.map(({ allowanceRaw: _allowanceRaw, tokenDecimals: _tokenDecimals, ...rest }) => rest);
}

async function handleGetConnectedSites(context: ToolExecutionContext): Promise<unknown> {
  return deps!.getConnectedSites(context.account);
}

function handleCreateAccount(args: Record<string, unknown>): unknown {
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : undefined;
  return deps!.createAccount(name);
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

/**
 * Turns one of the user's own account names into its address.
 *
 * Matching is case-insensitive and whitespace-trimmed but otherwise EXACT — no prefix or
 * fuzzy matching. "New User #1" and "New User #5" differ by one character, and a partial
 * match that picked the wrong one would send funds to the wrong wallet while looking like
 * it had understood. For the same reason a name shared by two accounts is an error rather
 * than a choice made here: the wallet cannot know which one was meant, and guessing is the
 * one option with no way back.
 *
 * Not found is also an error, never a fallthrough — an unresolved name reaching the
 * simulator would surface as an unreadable address parsing failure instead of "there is no
 * account called that".
 */
function resolveOwnAccountName(name: string): string {
  const needle = name.trim().toLowerCase();
  const accounts = deps!.listAccounts();
  const matches = accounts.filter((a) => a.name.trim().toLowerCase() === needle);

  if (matches.length === 1) return matches[0].address;

  if (matches.length > 1) {
    throw new ToolArgumentError(
      `"${name}" adında birden fazla hesap var (${matches.map((m) => m.address).join(", ")}). ` +
      `Hangisini kastettiğini adresle belirt.`
    );
  }

  const known = accounts.map((a) => a.name).filter(Boolean);
  throw new ToolArgumentError(
    `"${name}" bir adres değil ve bu isimde bir hesabın yok. ` +
    (known.length ? `Hesapların: ${known.join(", ")}.` : `Bu cüzdanda kayıtlı hesap bulunamadı.`)
  );
}

/**
 * Resolves what a proposal tool may address, for the agent specifically.
 *
 * Accepts a literal 0x address or one of the user's own account names. Deliberately NOT
 * ENS/UD, even though DomainResolver sits right there and the manual Send panel still uses
 * it: this build ships testnets only (see manifest.json's version_name), and domain
 * resolution is answered by MAINNET — see DomainResolver's own header, which resolves
 * against mainnet no matter which network is active. So "send 1 ETH to vitalik.eth" quietly
 * turns a testnet build into one that names a real mainnet identity as the recipient.
 *
 * The manual panel keeps domains because there the user types the name, watches it resolve,
 * and reads the address back before pressing send. Through the agent, none of that happens:
 * the name goes in as prose and an address the user never chose comes out the other side.
 */
function resolveAgentRecipient(toInput: string): string {
  if (isDomainName(toInput)) {
    throw new ToolArgumentError(
      `"${toInput}" gibi alan adları (ENS/Unstoppable) agent üzerinden gönderimde kabul edilmiyor. ` +
      `Alan adları mainnet'ten çözümleniyor, bu sürüm ise yalnızca testnet için. ` +
      `Ya 0x... ile başlayan bir adres ver ya da kendi hesaplarından birinin adını yaz.`
    );
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(toInput)) return toInput;
  return resolveOwnAccountName(toInput);
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

  const isNative = !tokenSymbol || tokenSymbol.toLowerCase() === network.currency_symbol.toLowerCase();

  // An ERC-20 symbol is resolved through SwapService's curated registry — the same one
  // prepareProposeShield already uses, and the only symbol → address map reachable from
  // backend/ (TokenCache is UI-owned). This used to refuse every non-native symbol outright
  // while the tool schema advertised `tokenSymbol: "USDC"`, so the model kept proposing
  // transfers the runner then rejected — the user saw the wallet decline its own offer.
  //
  // Resolution stays strict: an unknown symbol is an error naming what IS available, never
  // a guess. Simulating a transfer against the wrong contract is how funds reach a stranger.
  // Dynamically imported, matching prepareProposeShield below — SwapService pulls in the
  // swap/quoting stack, which no native-only send should have to load.
  const { default: SwapService } = await import("./SwapService.js");
  const token = isNative ? undefined : SwapService.getInstance().getTokenBySymbol(network.network_id, tokenSymbol!);
  if (!isNative && !token) {
    const known = SwapService.getInstance()
      .getTokens(network.network_id)
      .filter((t) => !t.isNative)
      .map((t) => t.symbol);
    throw new ToolArgumentError(
      `"${tokenSymbol}" ${network.network_name} üzerinde tanınmıyor. ` +
      (known.length
        ? `Bu ağda gönderilebilen tokenlar: ${known.join(", ")} (ve native ${network.currency_symbol}).`
        : `Bu ağda kayıtlı bir ERC-20 yok — yalnızca native ${network.currency_symbol} gönderilebilir.`)
    );
  }

  const to = resolveAgentRecipient(toInput);

  // originalArgs carries the RESOLVED address onward, not the name the user typed.
  //
  // ConfirmationCard re-reads `to` at confirm time and signs against it, so leaving a name
  // there would mean the preview simulated one recipient and the signature paid whatever
  // that side resolved independently — two chances to disagree about where money goes. It
  // also puts the real address on the confirmation screen, which is the thing the user
  // should be checking before approving.
  const resolvedArgs = to === toInput ? args : { ...args, to };

  // The policy engine's ratio cap compares `amount` against `balance`, so for a token
  // transfer that has to be the TOKEN's balance. Handing it the native ETH balance would
  // measure a 100-USDC send against an ETH holding — a cap that means nothing in either
  // direction, and one that loosens exactly when the user holds a lot of gas money.
  const balance = token
    ? Number(await network.getTokenBalance(token.address, context.account))
    : Number(formatEther(await network.getBalance(context.account)));

  return {
    balance,
    amountNumber,
    buildPreview: async () => {
      const provider = await getEthersProvider(network);
      const simulation = token
        ? await (async () => {
            const { Interface, parseUnits } = await import("ethers");
            const iface = new Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
            // token.decimals comes from the curated registry, where each entry was read off
            // the contract itself — see SwapService's own note on why guessing 18 is unsafe.
            const data = iface.encodeFunctionData("transfer", [to, parseUnits(amount, token.decimals)]);
            return simulateAndEnrich(provider, { from: context.account, to: token.address, value: "0", data });
          })()
        : await (async () => {
            const { parseEther } = await import("ethers");
            return simulateAndEnrich(provider, { from: context.account, to, value: parseEther(amount).toString() });
          })();
      return { requiresConfirmation: true, toolName: "propose_send", originalArgs: resolvedArgs, simulation };
    },
  };
}

/**
 * Builds an ERC-20 shield preview's simulation.
 *
 * The real confirm-time flow (Network.shieldERC20) transparently sends an `approve` first
 * whenever the existing allowance is short — that's the common case for a token's first
 * shield. Running `shield()` itself through TransactionSimulator's eth_call pre-flight
 * would revert in exactly that case (no allowance yet), turning a perfectly normal first
 * shield into a misleading "simulation failed" error. So: only simulate `shield()` for
 * real once the allowance already covers it; otherwise fall back to a manually-built
 * passing result — same spirit as ConfirmationCard's static rate-truncation note, domain
 * knowledge filling in for something a live eth_call can't usefully tell us.
 */
async function buildErc20ShieldSimulation(
  network: Network,
  fromAddress: string,
  wrapper: string,
  underlyingAddress: string,
  amountValue: bigint
): Promise<SimResult> {
  const { Interface } = await import("ethers");
  const provider = await getEthersProvider(network);
  const allowanceIface = new Interface(["function allowance(address owner, address spender) view returns (uint256)"]);

  let hasAllowance = false;
  try {
    const hex = await provider.call({
      to: underlyingAddress,
      data: allowanceIface.encodeFunctionData("allowance", [fromAddress, wrapper]),
    });
    hasAllowance = !!hex && hex !== "0x" && BigInt(hex) >= amountValue;
  } catch {
    hasAllowance = false;
  }

  if (hasAllowance) {
    const shieldIface = new Interface(["function shield(address to, uint256 amount) returns (bytes32)"]);
    return simulateAndEnrich(provider, {
      from: fromAddress,
      to: wrapper,
      value: "0",
      data: shieldIface.encodeFunctionData("shield", [fromAddress, amountValue.toString()]),
    });
  }

  return {
    success: true,
    balanceChanges: [],
    warnings: ["🛡️ Kalkanlama (Shield): Önce bir onay (approve) işlemi, ardından shield işlemi yapılacak."],
    riskLevel: "LOW",
    operationType: "wrap",
    isContractInteraction: true,
    isNewRecipient: false,
    contractAgeDays: null,
  };
}

async function prepareProposeShield(
  network: Network,
  context: ToolExecutionContext,
  args: Record<string, unknown>
): Promise<PreparedProposal> {
  const { amount, amountNumber } = requirePositiveAmount(args);
  const tokenSymbol = requireTokenSymbol(args, true)!;
  const isNative = tokenSymbol.toLowerCase() === network.currency_symbol.toLowerCase();

  if (!isNative) {
    // Curated symbol → address registry (SwapService's, not TokenCache's — see
    // getTokenBySymbol's docs) closes the gap that used to block every non-native shield.
    const { default: SwapService } = await import("./SwapService.js");
    const erc20 = SwapService.getInstance().getTokenBySymbol(network.network_id, tokenSymbol);
    if (!erc20) {
      throw new ToolArgumentError(
        `"${tokenSymbol}" için shield önizlemesi şu an desteklenmiyor — bu araç yalnızca native token ` +
        `(${network.currency_symbol}) ve bilinen ERC-20'leri (ör. USDC, DAI) önizleyebilir.`
      );
    }

    const wrapper = await network.getWrapperFor(erc20.address);
    if (!wrapper) {
      throw new ToolArgumentError(`"${tokenSymbol}" için bu ağda henüz bir gizli (shielded) sürüm deploy edilmemiş.`);
    }

    const balanceStr = await network.getTokenBalance(erc20.address, context.account);
    const balance = Number(balanceStr);

    return {
      balance,
      amountNumber,
      buildPreview: async () => {
        const { parseUnits } = await import("ethers");
        const amountValue = parseUnits(amount, erc20.decimals);
        const simulation = await buildErc20ShieldSimulation(network, context.account, wrapper, erc20.address, amountValue);
        return { requiresConfirmation: true, toolName: "propose_shield", originalArgs: args, simulation };
      },
    };
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

/**
 * Resolves a shielded-token `tokenSymbol` against an already-fetched shielded portfolio.
 *
 * The schema's primary namespace is the confidential wrapper's own symbol (e.g. "aeETH"),
 * matched first — no registry gap there, get_shielded_portfolio already returns it. But in
 * practice a request (especially a small local model's, or a fast-path regex match) is far
 * more likely to name the PUBLIC underlying token ("ETH", "DAI") than its confidential
 * wrapper name, which nothing else in the wallet ever surfaces to the user. Falling back to
 * that — native by currency symbol, ERC-20 by the same curated registry propose_shield
 * resolves against — turns "ETH'imi unshield et" into a working proposal instead of a
 * guaranteed "Shielded token bulunamadı" for the single most natural way to ask. Shared by
 * propose_unshield and propose_confidential_transfer, which both need exactly this.
 */
async function resolveShieldedHolding(
  network: Network,
  portfolio: ShieldedHolding[],
  tokenSymbol: string
): Promise<ShieldedHolding | undefined> {
  const direct = portfolio.find((h) => {
    if (h.symbol.toLowerCase() === tokenSymbol.toLowerCase()) return true;
    if (h.isNative) return tokenSymbol.toLowerCase() === network.currency_symbol.toLowerCase();
    return false;
  });
  if (direct) return direct;

  const { default: SwapService } = await import("./SwapService.js");
  const erc20 = SwapService.getInstance().getTokenBySymbol(network.network_id, tokenSymbol);
  if (!erc20) return undefined;
  return portfolio.find((h) => !h.isNative && h.underlying.toLowerCase() === erc20.address.toLowerCase());
}

async function prepareProposeUnshield(
  network: Network,
  context: ToolExecutionContext,
  args: Record<string, unknown>
): Promise<PreparedProposal> {
  const { amount, amountNumber } = requirePositiveAmount(args);
  const tokenSymbol = requireTokenSymbol(args, true)!;
  const account = requireAccount(context);

  const portfolio = await network.getShieldedPortfolio(account);
  const resolvedHolding = await resolveShieldedHolding(network, portfolio, tokenSymbol);
  if (!resolvedHolding) {
    throw new ToolArgumentError(`Shielded token bulunamadı: "${tokenSymbol}".`);
  }

  return {
    // Confidential balance, already decrypted and decimal-formatted by getShieldedPortfolio
    // — exactly the unit `amount` is in, so no conversion needed for the ratio check.
    balance: Number(resolvedHolding.balance),
    amountNumber,
    buildPreview: async () => {
      const { Interface, parseUnits } = await import("ethers");
      // Mirrors Network.SHIELDED_ABI's unshield fragment exactly (see Network.unshield()).
      const iface = new Interface(["function unshield(address from, address to, uint64 amount)"]);
      const amountValue = parseUnits(amount, resolvedHolding.confidentialDecimals);

      const provider = await getEthersProvider(network);
      const simulation = await simulateAndEnrich(provider, {
        from: context.account,
        to: resolvedHolding.wrapper,
        value: "0",
        data: iface.encodeFunctionData("unshield", [context.account, context.account, amountValue]),
      });

      return { requiresConfirmation: true, toolName: "propose_unshield", originalArgs: args, simulation };
    },
  };
}

async function prepareProposeConfidentialTransfer(
  network: Network,
  context: ToolExecutionContext,
  args: Record<string, unknown>
): Promise<PreparedProposal> {
  const toInput = requireNonEmptyString(args, "to");
  const { amountNumber } = requirePositiveAmount(args);
  const tokenSymbol = requireTokenSymbol(args, true)!;
  const account = requireAccount(context);

  const portfolio = await network.getShieldedPortfolio(account);
  const resolvedHolding = await resolveShieldedHolding(network, portfolio, tokenSymbol);
  if (!resolvedHolding) {
    throw new ToolArgumentError(`Shielded token bulunamadı: "${tokenSymbol}".`);
  }

  const to = resolveAgentRecipient(toInput);
  const resolvedArgs = to === toInput ? args : { ...args, to };

  return {
    // Confidential balance, already decrypted and decimal-formatted by getShieldedPortfolio
    // — exactly the unit `amount` is in, so no conversion needed for the ratio check.
    balance: Number(resolvedHolding.balance),
    amountNumber,
    buildPreview: async () => {
      // Unlike unshield's plain uint64 amount, confidentialTransfer's calldata itself must
      // carry a real ciphertext + proof (Network.transferConfidential's encryptUint64 call) —
      // producing that needs the account's signer to authenticate an FHE permit, which this
      // module must never touch for a proposal tool (see file header: no path to
      // Account.ethers_wallet for a proposal, ever). So there is no eth_call worth running
      // here: simulating against a garbage/zero ciphertext would either revert for reasons
      // that say nothing about whether the REAL confirm-time transfer will succeed, or pass a
      // check the contract doesn't actually perform on nonsense input. Domain knowledge fills
      // in instead — same pattern as buildErc20ShieldSimulation's no-allowance branch. The
      // real encryption (and the only place this ever signs anything) happens in
      // ConfirmationCard at confirm time, via Network.transferConfidential itself.
      const simulation: SimResult = {
        success: true,
        balanceChanges: [],
        warnings: [
          "🔒 Gizli Transfer: Miktar şifreli olarak gönderilecek — zincirde görünmeyecek. " +
          "Şifreleme yalnızca siz onayladığınızda, cüzdanınızda yapılır.",
        ],
        riskLevel: "LOW",
        operationType: "transferEncrypted",
        isContractInteraction: true,
        isNewRecipient: false,
        contractAgeDays: null,
      };
      return { requiresConfirmation: true, toolName: "propose_confidential_transfer", originalArgs: resolvedArgs, simulation };
    },
  };
}

async function prepareProposeRevokeApproval(
  network: Network,
  context: ToolExecutionContext,
  args: Record<string, unknown>
): Promise<PreparedProposal> {
  const tokenAddress = requireNonEmptyString(args, "tokenAddress");
  const spenderAddress = requireNonEmptyString(args, "spenderAddress");

  const { isAddress } = await import("ethers");
  if (!isAddress(tokenAddress)) throw new ToolArgumentError(`"${tokenAddress}" geçerli bir adres değil.`);
  if (!isAddress(spenderAddress)) throw new ToolArgumentError(`"${spenderAddress}" geçerli bir adres değil.`);

  return {
    // Revoke has no "amount" — 0/0 makes evaluate()'s balance-ratio check a no-op (ratio is
    // always 0/anything), which is exactly right: nothing here scales with wallet balance.
    balance: 0,
    amountNumber: 0,
    buildPreview: async () => {
      const { Interface } = await import("ethers");
      const iface = new Interface(["function approve(address spender, uint256 amount) returns (bool)"]);
      const provider = await getEthersProvider(network);
      const simulation = await simulateAndEnrich(provider, {
        from: context.account,
        to: tokenAddress,
        value: "0",
        data: iface.encodeFunctionData("approve", [spenderAddress, 0]),
      });
      return { requiresConfirmation: true, toolName: "propose_revoke_approval", originalArgs: args, simulation };
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
    case "propose_confidential_transfer":
      return prepareProposeConfidentialTransfer(network, context, args);
    case "propose_revoke_approval":
      return prepareProposeRevokeApproval(network, context, args);
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
    throw new ToolArgumentError(
      `x402 ödemeleri bu ağda ("${context.networkId}") desteklenmiyor.`,
      "agent.confirmationCardX402UnsupportedNetwork"
    );
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
          return { result: await handleGetBalance(network, context, args) };
        case "get_token_balances":
          return { result: await handleGetTokenBalances(network, context) };
        case "get_accounts":
          return { result: handleGetAccounts() };
        case "get_shielded_balance":
          return { result: await handleGetShieldedBalance(network, requireAccount(context), args) };
        case "get_shielded_portfolio":
          return { result: await handleGetShieldedPortfolio(network, requireAccount(context)) };
        case "get_pending_claims":
          return { result: await handleGetPendingClaims(network, requireAccount(context), args, context) };
        case "get_faucet_info":
          return { result: handleGetFaucetInfo(network, context) };
        case "get_token_approvals":
          return { result: await handleGetTokenApprovals(network, context) };
        case "get_connected_sites":
          return { result: await handleGetConnectedSites(context) };
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

    // ── Immediate tools: execute right away, no evaluate() call and no confirmation card —
    //    see IMMEDIATE_TOOLS's own docs for the bar an action has to clear to belong here. ──
    if ((IMMEDIATE_TOOLS as readonly string[]).includes(toolName)) {
      switch (toolName as ImmediateTool) {
        case "create_account":
          return { result: handleCreateAccount(args) };
      }
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
    // A ToolArgumentError MAY carry a reasonKey (see its own docs — currently only the x402
    // unsupported-network case sets one); attach it the same way, so the model gets a
    // structured signal to distinguish it from every other unstructured ToolArgumentError
    // instead of having to guess from English prose alone.
    if (err instanceof ToolArgumentError && err.reasonKey) {
      return { error: err.message, reasonKey: err.reasonKey };
    }
    // Covers every other ToolArgumentError, a determined-to-fail simulation (see
    // simulateAndEnrich), and anything Network.ts throws (e.g. an FHE decrypt failure other
    // than CiphertextNotFoundError, which Network.ts already normalizes to a "0.0" balance
    // internally and never throws in the first place).
    return { error: errorMessage(err) };
  }
}
