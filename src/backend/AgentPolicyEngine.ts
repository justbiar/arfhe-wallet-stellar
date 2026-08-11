/**
 * AgentPolicyEngine — Tool authorization gate for the in-wallet AI Agent (Agent.tsx).
 *
 * IMPORTANT: This module runs ONLY inside the extension. It is never sent to, imported
 * by, or executed on the backend / any remote agent runtime. The agent (its tool-calling
 * loop driven by AgentOrchestrator.ts, via the backend-proxy) never gets raw key access or
 * direct contract calls — every tool call it wants to make is routed through `evaluate()`
 * first, which runs entirely in the user's browser against locally-held wallet state.
 *
 * Three tool tiers:
 *  - READ_ONLY_TOOLS   — pure data reads (balances, history, simulation). Always allowed.
 *  - PROPOSAL_TOOLS     — state-changing actions (send, shield, approve...). The agent may
 *                          only *propose* these; the wallet UI still requires the user to
 *                          review and confirm before anything is signed or broadcast.
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

export type ReadOnlyTool = (typeof READ_ONLY_TOOLS)[number];
export type ProposalTool = (typeof PROPOSAL_TOOLS)[number];
export type ForbiddenTool = (typeof FORBIDDEN_TOOLS)[number];
export type KnownTool = ReadOnlyTool | ProposalTool | ForbiddenTool;

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
  | "allowed_proposal";

export interface PolicyDecision {
  allowed: boolean;
  /** True when `allowed` is a proposal that still needs explicit user confirmation before execution. */
  requiresConfirmation: boolean;
  reasonCode: PolicyDecisionReasonCode;
  reason: string;
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
      };
    }

    if (this.proposalsThisSession >= this.config.maxProposalsPerSession) {
      return {
        allowed: false,
        requiresConfirmation: false,
        reasonCode: "session_proposal_limit_reached",
        reason: `Session proposal limit reached (${this.config.maxProposalsPerSession}).`,
      };
    }

    if (typeof args.amount === "number" && walletContext.balance > 0) {
      const ratio = args.amount / walletContext.balance;
      if (ratio > this.config.maxProposalRatio) {
        return {
          allowed: false,
          requiresConfirmation: false,
          reasonCode: "exceeds_balance_ratio",
          reason: `Proposed amount is ${(ratio * 100).toFixed(1)}% of balance, exceeding the ${(this.config.maxProposalRatio * 100).toFixed(0)}% limit.`,
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
}

export default AgentPolicyEngine;
