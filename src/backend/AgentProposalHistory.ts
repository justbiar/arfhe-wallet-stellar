/**
 * AgentProposalHistory — pure data layer for the "Agent Geçmişi" tab (AgentProposalHistoryPanel.tsx).
 *
 * Distinct from AgentChatPanel's `agent_chat_history` (the raw OpenAI-wire-format transcript,
 * kept so the model retains its own tool-calling context) — this is a UI-facing log of what
 * every PROPOSAL_TOOLS call actually resulted in: approved and broadcast, denied by
 * AgentPolicyEngine before the user ever saw a card, rejected by the user in ConfirmationCard
 * (manually, or auto-cancelled because the active account changed mid-review — see that
 * component's `reason`, and pages/Agent.tsx's account-switch effect), or approved by the user
 * but failed to settle on-chain. Persisted separately (`agent_proposal_history`, owned by
 * pages/Agent.tsx — see that file) so "New Chat" (which wipes only the active account's
 * transcript) never erases this record. Every record is tagged with the `accountAddress` it
 * belongs to (see ProposalRecord) so AgentProposalHistoryPanel.tsx can filter to just the
 * currently active account.
 *
 * Two ways a record gets created:
 *  - buildRecordFromOutcome(): AgentChatPanel already has the full ConfirmationOutcome once a
 *    ConfirmationCard resolves (approved/rejected/failed) — no scanning needed.
 *  - extractPolicyDenials(): AgentPolicyEngine's denial never becomes a ConfirmationCard — the
 *    model just gets `{ error }` back and reacts in text. The only place that's visible is the
 *    `role:"tool"` message AgentOrchestrator.runOneToolCall() produces, so this scans the slice
 *    of history a single runAgentTurn() call newly appended for exactly that shape.
 */

import type { ChatMessage } from "./AgentOrchestrator.js";
import type { ProposalPreview } from "./AgentToolRunner.js";
import { PROPOSAL_TOOLS } from "./AgentPolicyEngine.js";

/**
 * Structurally compatible with ConfirmationCard.tsx's ConfirmationOutcome (this module runs
 * only inside the extension too, but stays UI-agnostic like every other backend/ file — no
 * backend module imports from components/, so this is redeclared rather than imported).
 */
type ResolvedProposalOutcome =
  | { status: "rejected"; reason?: string }
  | { status: "confirmed"; txHash: string }
  | { status: "failed"; message: string };

export const PROPOSAL_HISTORY_STORAGE_KEY = "agent_proposal_history";

/**
 * FIFO cap, applied PER ACCOUNT (not globally) — appendProposalRecords only trims the
 * account(s) a call actually added to. A global cap would let a lightly-used account's fresh
 * proposal evict a heavily-used account's older history just because they share one storage
 * key; per-account keeps each account's log independent, at a trivial storage cost (a few
 * hundred bytes per record).
 */
export const MAX_PROPOSAL_RECORDS = 50;

export type ProposalRecordStatus = "approved" | "policy_rejected" | "user_cancelled" | "failed";

export interface ProposalRecord {
  /** The originating tool_call_id — stable per proposal attempt, used to de-dup. */
  id: string;
  /** Address of the account active when this record was created — see MAX_PROPOSAL_RECORDS. */
  accountAddress: string;
  toolName: string;
  amount?: string;
  tokenSymbol?: string;
  /** Only set for propose_send. */
  recipient?: string;
  status: ProposalRecordStatus;
  /** Human-readable reason — policy denial text, outcome.message, or a fixed "user rejected" label. */
  reason?: string;
  /** Only set when status === "approved". */
  txHash?: string;
  timestamp: number;
}

function readStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const raw = args[key];
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return String(raw);
  return undefined;
}

/**
 * Builds the record for a proposal that reached a ConfirmationCard and was resolved one way or
 * another. `toolCallId` and `preview` come from the same closure AgentChatPanel already has
 * (buildChatItems' `item.toolCallId` / `item.preview`) — no re-parsing of history required.
 * `accountAddress` is the account the proposal was generated/resolved against — the caller's
 * responsibility to pass the right one (the OUTGOING account for an account-switch auto-cancel,
 * not necessarily whatever is active by the time this runs — see pages/Agent.tsx).
 */
export function buildRecordFromOutcome(
  toolCallId: string,
  preview: ProposalPreview,
  outcome: ResolvedProposalOutcome,
  accountAddress: string
): ProposalRecord {
  const args = preview.originalArgs;
  const base = {
    id: toolCallId,
    accountAddress,
    toolName: preview.toolName,
    amount: readStringArg(args, "amount"),
    tokenSymbol: readStringArg(args, "tokenSymbol"),
    recipient: readStringArg(args, "to"),
    timestamp: Date.now(),
  };

  switch (outcome.status) {
    case "confirmed":
      return { ...base, status: "approved", txHash: outcome.txHash };
    case "rejected":
      // reason is only set for an auto-cancel (e.g. the active account changed mid-review,
      // see ConfirmationCard.tsx) — a manual Reject click carries none, so it stays undefined
      // (JSON.stringify drops it) rather than showing a misleading empty string in the panel.
      return { ...base, status: "user_cancelled", reason: outcome.reason };
    case "failed":
      return { ...base, status: "failed", reason: outcome.message };
  }
}

/**
 * Scans a single runAgentTurn() call's newly-appended messages (i.e.
 * `updatedHistory.slice(baseHistoryLength)`, never the whole transcript — a resolved proposal's
 * tool message keeps matching PROPOSAL_TOOLS forever, so re-scanning old messages would produce
 * duplicate/incorrect records) for AgentPolicyEngine denials: a `role:"tool"` message naming a
 * PROPOSAL_TOOLS tool whose content is `{ error }` rather than `{ result }`. The denied amount/
 * recipient come from the matching assistant `tool_calls[].function.arguments` in the same
 * slice — the tool message itself never got that far. `accountAddress` is the account that turn
 * actually ran against (the `context.account` passed to runAgentTurn), not necessarily whatever
 * is active by the time this is called.
 */
export function extractPolicyDenials(newMessages: ChatMessage[], accountAddress: string): ProposalRecord[] {
  const records: ProposalRecord[] = [];

  for (const m of newMessages) {
    if (m.role !== "tool" || !m.tool_call_id || !m.name) continue;
    if (!(PROPOSAL_TOOLS as readonly string[]).includes(m.name)) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(m.content);
    } catch {
      continue;
    }
    const error = (parsed as { error?: unknown } | null)?.error;
    if (typeof error !== "string") continue;

    let args: Record<string, unknown> = {};
    for (const am of newMessages) {
      if (am.role !== "assistant" || !am.tool_calls) continue;
      const call = am.tool_calls.find((tc) => tc.id === m.tool_call_id);
      if (call) {
        try {
          const parsedArgs = JSON.parse(call.function.arguments || "{}");
          if (parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)) {
            args = parsedArgs as Record<string, unknown>;
          }
        } catch {
          // malformed tool_call arguments — record still worth keeping, just without amount/recipient.
        }
        break;
      }
    }

    records.push({
      id: m.tool_call_id,
      accountAddress,
      toolName: m.name,
      amount: readStringArg(args, "amount"),
      tokenSymbol: readStringArg(args, "tokenSymbol"),
      recipient: readStringArg(args, "to"),
      status: "policy_rejected",
      reason: error,
      timestamp: Date.now(),
    });
  }

  return records;
}

/**
 * Appends new records, de-duping by `id` (a proposal already recorded — e.g. re-delivered by a
 * duplicate render — is never recorded twice) and trimming each affected account's own records
 * to MAX_PROPOSAL_RECORDS (oldest first out) — see that constant's docs. Only the account(s)
 * `additions` actually belongs to are ever candidates for trimming; every other account's
 * history is left untouched.
 */
export function appendProposalRecords(current: ProposalRecord[], additions: ProposalRecord[]): ProposalRecord[] {
  if (additions.length === 0) return current;

  const existingIds = new Set(current.map((r) => r.id));
  const toAdd = additions.filter((r) => !existingIds.has(r.id));
  if (toAdd.length === 0) return current;

  let combined = [...current, ...toAdd];

  const touchedAccounts = new Set(toAdd.map((r) => r.accountAddress));
  for (const account of touchedAccounts) {
    const forAccount = combined.filter((r) => r.accountAddress === account);
    const excess = forAccount.length - MAX_PROPOSAL_RECORDS;
    if (excess <= 0) continue;
    const idsToDrop = new Set(forAccount.slice(0, excess).map((r) => r.id));
    combined = combined.filter((r) => !idsToDrop.has(r.id));
  }

  return combined;
}

// ─── Shared wire-format history helpers (also used by AgentChatPanel.tsx / pages/Agent.tsx) ──

function isProposalPreview(value: unknown): value is ProposalPreview {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.requiresConfirmation === true &&
    typeof v.toolName === "string" &&
    typeof v.originalArgs === "object" &&
    v.originalArgs !== null &&
    typeof v.simulation === "object" &&
    v.simulation !== null
  );
}

/**
 * Finds the earliest not-yet-resolved proposal preview in a wire-format history, if any. Used
 * both by AgentChatPanel.tsx (buildChatItems / input-lock) and pages/Agent.tsx (to know whether
 * the OUTGOING account has a pending card to auto-cancel when the active account changes).
 */
export function findPendingConfirmation(
  history: ChatMessage[]
): { toolCallId: string; preview: ProposalPreview } | null {
  for (const m of history) {
    if (m.role !== "tool" || !m.tool_call_id) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(m.content);
    } catch {
      continue;
    }
    const result = (parsed as { result?: unknown } | null)?.result;
    if (isProposalPreview(result)) {
      return { toolCallId: m.tool_call_id, preview: result };
    }
  }
  return null;
}
