/**
 * AgentPolicyEngine — Tool authorization gate for the in-wallet AI Agent (Agent.tsx).
 *
 * IMPORTANT: This module runs ONLY inside the extension. It is never sent to, imported
 * by, or executed on the backend / any remote agent runtime. The agent (its tool-calling
 * loop driven by AgentOrchestrator.ts, via the backend-proxy) never gets raw key access or
 * direct contract calls — every tool call it wants to make is routed through `evaluate()`
 * first, which runs entirely in the user's browser against locally-held wallet state.
 *
 * Four tool tiers:
 *  - READ_ONLY_TOOLS   — pure data reads (balances, history, simulation). Always allowed.
 *  - PROPOSAL_TOOLS     — state-changing actions (send, shield, approve...). The agent may
 *                          only *propose* these; the wallet UI still requires the user to
 *                          review and confirm before anything is signed or broadcast.
 *  - IMMEDIATE_TOOLS     — local, non-financial wallet actions (create_account) that execute
 *                          right away, with no confirmation card — see that constant's own
 *                          docs for the bar an action has to clear to belong here.
 *  - FORBIDDEN_TOOLS     — never exposed to the agent, proposal or otherwise. These grant or
 *                          spend the confidential balance in ways a single bad proposal
 *                          can't undo (delegating the whole encrypted balance, releasing a
 *                          claim), so they are excluded at the tool-listing level, not just
 *                          rejected at evaluation time.
 *
 * evaluate() is the single choke point a caller runs a proposed tool call through before
 * acting on it: it enforces the forbidden list, the per-proposal balance ratio cap, and the
 * per-session proposal count cap.
 */

/**
 * Tools the agent may call freely — they only read wallet/network state.
 *
 * Names are snake_case because these are sent to OpenRouter as OpenAI-style function-calling
 * tool names (see agentTools.ts), not JS identifiers — they don't have to match the
 * corresponding Network.ts method name, though they currently do by convention.
 */
export const READ_ONLY_TOOLS = [
  "get_balance",
  "get_accounts",
  "get_token_balance",
  "get_token_balances",
  "get_token_metadata",
  "get_nft_balance",
  "get_nft_metadata",
  "get_token_prices",
  "get_history",
  "get_block_number",
  "simulate_transaction",
  "get_shielded_balance",
  "get_shielded_portfolio",
  "get_pending_claims",
  "get_faucet_info",
  "get_token_approvals",
  "get_connected_sites",
] as const;

/**
 * State-changing tools the agent may only propose — never execute.
 *
 * Each one produces a preview (see agentTools.ts for the exact schema) for the wallet UI to
 * show the user; nothing is signed or broadcast until the user explicitly confirms outside
 * this flow. `propose_*` naming (rather than e.g. `send_transaction`) is deliberate — it
 * keeps it obvious at the tool-name level that these never move funds by themselves.
 */
export const PROPOSAL_TOOLS = [
  "propose_send",
  "propose_shield",
  "propose_unshield",
  "propose_confidential_transfer",
  "propose_revoke_approval",
] as const;

/**
 * Tools the agent must never see, let alone propose.
 *
 * `set_operator` delegates the entire confidential balance to a third address until its
 * expiry — there is no partial or reversible version of that grant. `claim_unshielded`
 * settles a burn that already happened outside the agent's own proposal flow, so letting
 * the agent trigger it would let a compromised or confused agent redirect funds a human
 * unshielded earlier. Both are excluded here rather than merely denied in `evaluate()`, so
 * they can't leak into a tool listing built by unioning READ_ONLY_TOOLS + PROPOSAL_TOOLS.
 */
export const FORBIDDEN_TOOLS = [
  "set_operator",
  "claim_unshielded",
  "export_private_key",
  "export_mnemonic",
  "remove_account",
] as const;

/**
 * Tools that trigger an x402 micro-payment (Faz 3). Deliberately its own list, not folded into
 * PROPOSAL_TOOLS: these never go through `evaluate()` — the auto-pay/confirm decision is
 * `evaluateX402Payment()`'s job, using a budget/ceiling check that has nothing to do with
 * `evaluate()`'s balance-ratio or session-count logic (a payment here might execute with NO
 * confirmation at all, which no PROPOSAL_TOOLS call is ever allowed to do). Kept as a named
 * list purely so callers (AgentToolRunner, agentTools.ts) classify a tool name by referencing
 * this constant rather than hardcoding "pay_for_resource" as a string literal more than once.
 */
export const X402_TOOLS = ["pay_for_resource"] as const;

/**
 * Tools that execute immediately, with no confirmation card and no evaluate() call at all —
 * a third category alongside READ_ONLY_TOOLS (always allowed) and PROPOSAL_TOOLS (always needs
 * a human's Approve click). Reserved for actions that are local to the wallet itself: nothing
 * here ever touches a private key's signing capability, broadcasts to a network, or moves
 * anything of value, so there is no balance/risk for a confirmation card to summarize and no
 * ratio for evaluate() to check against. create_account is the first example — it derives a new
 * local keypair the same way the wallet's own "Create New Account" button does, which is why
 * asking a person to click Approve on it would be confirmation-fatigue theater, not safety.
 *
 * A tool belongs here only if getting it wrong costs the user nothing more than an extra local
 * account they didn't want — anything that could move funds, sign a message, leak a key, or
 * reach the network belongs in PROPOSAL_TOOLS (or FORBIDDEN_TOOLS) instead, never here.
 */
export const IMMEDIATE_TOOLS = ["create_account"] as const;

export type ReadOnlyTool = (typeof READ_ONLY_TOOLS)[number];
export type ProposalTool = (typeof PROPOSAL_TOOLS)[number];
export type ForbiddenTool = (typeof FORBIDDEN_TOOLS)[number];
export type X402Tool = (typeof X402_TOOLS)[number];
export type ImmediateTool = (typeof IMMEDIATE_TOOLS)[number];
export type KnownTool = ReadOnlyTool | ProposalTool | ForbiddenTool | X402Tool | ImmediateTool;

export interface AgentPolicyConfig {
  /** Max fraction of the relevant balance a single proposal may move. Default 0.5 (50%). */
  maxProposalRatio: number;
  /** Max number of PROPOSAL_TOOLS calls allowed per session. Default 10. */
  maxProposalsPerSession: number;
}

export const DEFAULT_AGENT_POLICY_CONFIG: AgentPolicyConfig = {
  maxProposalRatio: 0.5,
  maxProposalsPerSession: 10,
};

/**
 * x402 micro-payment hard ceilings (Faz 3).
 *
 * These are the ONE place the absolute limit is defined — X402SettingsService clamps whatever
 * the user configures against these before persisting, and (once written) AgentPolicyEngine's
 * evaluateX402Payment() clamps again at evaluation time, so a lowered ceiling in a future
 * release retroactively tightens even a setting saved under a higher one. No user-supplied
 * number, however it reached storage, can ever push a decision past these values — unlike
 * `maxProposalRatio`/`maxProposalsPerSession` above (session-only guardrails on a flow that
 * always ends in a human clicking Approve), x402 payments settle with NO confirmation dialog
 * when they're within budget, so the ceiling here is the last line of defense, not a first one.
 *
 * Amounts are USD, 1:1 with the USDC the "exact" x402 scheme moves — deliberately conservative
 * for a first integration (micro-payments, not meant to cover a real invoice), tunable later
 * once the facilitator integration (Faz 3, sonraki tur) has real-world usage to calibrate against.
 */
export interface X402AbsoluteCaps {
  /** Hard ceiling on a single x402 payment, regardless of what the user configured. */
  maxPerTransactionUsd: number;
  /** Hard ceiling on total x402 spend within one rolling day, regardless of what the user configured. */
  maxDailyBudgetUsd: number;
}

export const X402_ABSOLUTE_CAPS: X402AbsoluteCaps = {
  maxPerTransactionUsd: 1,
  maxDailyBudgetUsd: 10,
};

/**
 * Tolerance for USD floating-point comparisons in evaluateX402Payment() — far below the
 * smallest amount x402 actually moves (fractions of a cent), so it only absorbs IEEE 754
 * representation error at an exact budget boundary (e.g. `5 - 4.95 !== 0.05`), never a real
 * over-budget amount.
 */
const FLOAT_EPSILON_USD = 1e-9;

/** Arguments a proposed tool call may carry. Only the fields the engine reasons about. */
export interface AgentToolArgs {
  /** Proposed amount, in the same unit as `WalletContext.balance` (e.g. formatted ETH/token units, not wei). */
  amount?: number;
  [key: string]: unknown;
}

/** Wallet state the engine needs to evaluate a proposal. Supplied by the caller, never fetched here. */
export interface WalletContext {
  /** Balance of the asset the proposed tool would move, in the same unit as `args.amount`. */
  balance: number;
}

export type PolicyDecisionReasonCode =
  | "forbidden_tool"
  | "unknown_tool"
  | "exceeds_balance_ratio"
  | "session_proposal_limit_reached"
  | "allowed_read_only"
  | "allowed_proposal"
  | "x402_disabled"
  | "x402_invalid_amount"
  | "x402_auto_paid"
  | "x402_requires_confirmation";

export interface PolicyDecision {
  allowed: boolean;
  /** True when `allowed` is a proposal that still needs explicit user confirmation before execution. */
  requiresConfirmation: boolean;
  reasonCode: PolicyDecisionReasonCode;
  /**
   * Model-facing, English, plain-text explanation — this is what the agent reads back as the
   * tool call's `{error}` and reacts to in its own reply. NEVER localized: the model's own
   * reasoning/response language is a separate concern from the wallet UI's language, and a
   * consistent English contract here is what LLM prompting actually relies on. Do not change
   * this field's language or add interpolation braces to it — see reasonKey/reasonParams below
   * for the user-facing counterpart.
   */
  reason: string;
  /**
   * User-facing counterpart to `reason`, set ONLY on a denial (allowed:false) — an i18n key
   * (e.g. "agent.policyReasonExceedsBalanceRatio") plus its interpolation params, both string
   * keys/values exactly like every other `t()` call in this codebase. Exists because `reason`
   * above must stay English for the model, but the SAME denial also gets persisted into
   * AgentProposalHistoryPanel's `record.reason` and shown to a human — who may have the UI set
   * to Turkish. Never set for an "allowed" decision (allowed_read_only/allowed_proposal/
   * x402_auto_paid/x402_requires_confirmation) — those reasons are never surfaced as a denial
   * anywhere, so there's nothing for a human to read a translation of. Optional: a caller with
   * no i18n concerns (this class itself, most tests) can ignore both fields entirely and only
   * `reason` still works exactly as before.
   */
  reasonKey?: string;
  reasonParams?: Record<string, string>;
  /**
   * Set only by evaluateX402Payment(): budget left for the rest of the day AFTER this payment,
   * using the same (re-clamped) daily cap the decision itself was made against. The auto-paid
   * informational card (Faz 3, later step) reads this to show "kalan bütçe" without re-deriving
   * it from settings + ledger a second time.
   */
  remainingBudgetUsd?: number;
}

/**
 * Structurally compatible with X402Settings (X402SettingsService.ts) — redeclared rather than
 * imported, same reasoning as AgentProposalHistory.ts's ResolvedProposalOutcome: this module
 * must not gain a dependency on a settings-storage module, and the caller is free to hand in a
 * value that did NOT come from X402SettingsService.getSettings() (a stub in a test, or — the
 * exact case evaluateX402Payment() has to defend against — some future code path that read
 * chrome.storage.local directly and skipped X402SettingsService's own clamp).
 */
export interface X402PaymentSettings {
  enabled: boolean;
  perTransactionCapUsd: number;
  dailyBudgetCapUsd: number;
}

function isReadOnlyTool(toolName: string): toolName is ReadOnlyTool {
  return (READ_ONLY_TOOLS as readonly string[]).includes(toolName);
}

function isProposalTool(toolName: string): toolName is ProposalTool {
  return (PROPOSAL_TOOLS as readonly string[]).includes(toolName);
}

function isForbiddenTool(toolName: string): toolName is ForbiddenTool {
  return (FORBIDDEN_TOOLS as readonly string[]).includes(toolName);
}

export class AgentPolicyEngine {
  private config: AgentPolicyConfig;
  private proposalsThisSession = 0;

  constructor(config: Partial<AgentPolicyConfig> = {}) {
    this.config = { ...DEFAULT_AGENT_POLICY_CONFIG, ...config };
  }

  /** Tool names safe to hand to the agent, forbidden tools excluded by construction. */
  getAvailableTools(): { readOnly: readonly ReadOnlyTool[]; proposal: readonly ProposalTool[] } {
    return { readOnly: READ_ONLY_TOOLS, proposal: PROPOSAL_TOOLS };
  }

  /** Number of proposals evaluated as allowed so far this session. */
  getProposalCount(): number {
    return this.proposalsThisSession;
  }

  /** Resets the per-session proposal counter — call on new chat session / wallet unlock. */
  resetSession(): void {
    this.proposalsThisSession = 0;
  }

  /**
   * Evaluate a tool call the agent wants to make.
   *
   * Read-only tools are always allowed. Proposal tools are allowed only if the tool call
   * survives, in order: the forbidden-list check, the per-proposal balance ratio cap, and
   * the per-session proposal count cap. Passing this check means the UI may show the user a
   * confirmation dialog — it never means the action executes on its own.
   */
  evaluate(toolName: string, args: AgentToolArgs, walletContext: WalletContext): PolicyDecision {
    if (isForbiddenTool(toolName)) {
      return {
        allowed: false,
        requiresConfirmation: false,
        reasonCode: "forbidden_tool",
        reason: `"${toolName}" is a forbidden tool and is never exposed to the agent.`,
        reasonKey: "agent.policyReasonForbiddenTool",
        reasonParams: { toolName },
      };
    }

    if (isReadOnlyTool(toolName)) {
      return {
        allowed: true,
        requiresConfirmation: false,
        reasonCode: "allowed_read_only",
        reason: `"${toolName}" is read-only.`,
      };
    }

    if (!isProposalTool(toolName)) {
      return {
        allowed: false,
        requiresConfirmation: false,
        reasonCode: "unknown_tool",
        reason: `"${toolName}" is not a recognized tool.`,
        reasonKey: "agent.policyReasonUnknownTool",
        reasonParams: { toolName },
      };
    }

    if (this.proposalsThisSession >= this.config.maxProposalsPerSession) {
      return {
        allowed: false,
        requiresConfirmation: false,
        reasonCode: "session_proposal_limit_reached",
        reason: `Session proposal limit reached (${this.config.maxProposalsPerSession}).`,
        reasonKey: "agent.policyReasonSessionLimitReached",
        reasonParams: { limit: String(this.config.maxProposalsPerSession) },
      };
    }

    if (typeof args.amount === "number" && walletContext.balance > 0) {
      const ratio = args.amount / walletContext.balance;
      if (ratio > this.config.maxProposalRatio) {
        const ratioPercent = (ratio * 100).toFixed(1);
        const limitPercent = (this.config.maxProposalRatio * 100).toFixed(0);
        return {
          allowed: false,
          requiresConfirmation: false,
          reasonCode: "exceeds_balance_ratio",
          reason: `Proposed amount is ${ratioPercent}% of balance, exceeding the ${limitPercent}% limit.`,
          reasonKey: "agent.policyReasonExceedsBalanceRatio",
          reasonParams: { ratio: ratioPercent, limit: limitPercent },
        };
      }
    }

    this.proposalsThisSession += 1;
    return {
      allowed: true,
      requiresConfirmation: true,
      reasonCode: "allowed_proposal",
      reason: `"${toolName}" requires user confirmation before it can execute.`,
    };
  }

  /**
   * Evaluate one x402 micro-payment. Unlike evaluate() above, "allowed" here does NOT always
   * mean "the model may propose this and a human still has to click Approve" — when the
   * payment is fully within budget, `requiresConfirmation` comes back false and the caller is
   * meant to pay immediately, with no ConfirmationCard at all (see Faz 3's design: the model
   * never decides this, and neither does the user for an in-budget payment — the code does).
   * A payment outside the user's own configured budget still comes back `allowed: true`
   * (`requiresConfirmation: true`) and falls through to the ordinary ConfirmationCard flow,
   * same as any PROPOSAL_TOOLS proposal — being over budget for auto-pay doesn't mean the user
   * can never approve it themselves, it only means the code won't do it unattended.
   *
   * `settings` and `spentTodayUsd` are supplied by the caller (X402SettingsService.getSettings()
   * / X402SpendingLedger.getSpentToday()) rather than read from storage here — same pattern as
   * `evaluate()`'s `walletContext` parameter: this class does no I/O of its own, which is also
   * what keeps it synchronous and trivially testable.
   *
   * SECURITY: `settings.perTransactionCapUsd`/`dailyBudgetCapUsd` are clamped AGAIN here against
   * X402_ABSOLUTE_CAPS, even though X402SettingsService already clamps before persisting. This
   * is deliberate defense-in-depth, not redundancy — if `settings` ever arrives here having
   * bypassed that service (a bug, a future code path that writes `arfhe_x402_settings` directly,
   * a manually edited storage blob), the `Math.min` below still makes it structurally impossible
   * for this method to return an auto-pay (`requiresConfirmation: false`) decision for an amount
   * exceeding the hard ceiling — there is no code path from "amount above X402_ABSOLUTE_CAPS" to
   * "allowed with no confirmation" that skips this clamp, because auto-pay eligibility is checked
   * against the clamped value, never against `settings`'s raw one.
   */
  evaluateX402Payment(amountUsd: number, settings: X402PaymentSettings, spentTodayUsd: number): PolicyDecision {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return {
        allowed: false,
        requiresConfirmation: false,
        reasonCode: "x402_invalid_amount",
        reason: `x402 payment amount must be a positive number (got ${amountUsd}).`,
        reasonKey: "agent.policyReasonX402InvalidAmount",
        reasonParams: { amount: String(amountUsd) },
      };
    }

    if (!settings.enabled) {
      return {
        allowed: false,
        requiresConfirmation: false,
        reasonCode: "x402_disabled",
        reason: "x402 payments are disabled in settings.",
        reasonKey: "agent.policyReasonX402Disabled",
      };
    }

    // Defense-in-depth clamp — see this method's own JSDoc. Never trust settings' raw numbers,
    // however they got here.
    const effectivePerTxCap = Math.min(settings.perTransactionCapUsd, X402_ABSOLUTE_CAPS.maxPerTransactionUsd);
    const effectiveDailyBudget = Math.min(settings.dailyBudgetCapUsd, X402_ABSOLUTE_CAPS.maxDailyBudgetUsd);
    const remainingBudgetBeforePayment = Math.max(0, effectiveDailyBudget - spentTodayUsd);

    // USD amounts arrive as floats (e.g. a daily budget of 5 minus 4.95 already spent isn't
    // exactly 0.05 in IEEE 754), so an at-the-limit payment must not get bounced by rounding
    // noise a fraction of a cent below the true boundary. FLOAT_EPSILON is far smaller than
    // any amount x402 actually moves, so it can never let a genuinely-over-budget payment
    // through — it only forgives binary floating-point representation error at the boundary.
    const withinPerTxCap = amountUsd <= effectivePerTxCap + FLOAT_EPSILON_USD;
    const withinDailyBudget = amountUsd <= remainingBudgetBeforePayment + FLOAT_EPSILON_USD;

    if (withinPerTxCap && withinDailyBudget) {
      return {
        allowed: true,
        requiresConfirmation: false,
        reasonCode: "x402_auto_paid",
        reason: `Payment of $${amountUsd} is within the per-payment cap ($${effectivePerTxCap}) and remaining daily budget ($${remainingBudgetBeforePayment}) — paid automatically.`,
        remainingBudgetUsd: Math.max(0, remainingBudgetBeforePayment - amountUsd),
      };
    }

    return {
      allowed: true,
      requiresConfirmation: true,
      reasonCode: "x402_requires_confirmation",
      reason: withinPerTxCap
        ? `Payment of $${amountUsd} would exceed today's remaining budget ($${remainingBudgetBeforePayment}) — requires user confirmation.`
        : `Payment of $${amountUsd} exceeds the per-payment cap ($${effectivePerTxCap}) — requires user confirmation.`,
      remainingBudgetUsd: remainingBudgetBeforePayment,
    };
  }
}

export default AgentPolicyEngine;
