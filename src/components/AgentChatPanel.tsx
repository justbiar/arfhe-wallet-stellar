/**
 * AgentChatPanel — chat UI for the in-wallet AI Agent (runAgentTurn / AgentOrchestrator.ts).
 *
 * Rendered by the /agent route's "Sohbet" tab (src/pages/Agent.tsx — the "Geçmiş" tab is
 * AgentProposalHistoryPanel.tsx, a separate persisted log of what every proposal actually
 * resulted in). `conversationHistory`/`setConversationHistory` are received as props rather
 * than owned here — Agent.tsx holds one `Record<accountAddress, ChatMessage[]>` (via
 * usePersistedState) and scopes them to the active account, so this component never has to
 * know about per-account storage; it also means Agent.tsx's account-switch handling (auto-
 * cancelling a pending card left behind on the OUTGOING account, inserting a switch notice into
 * the INCOMING one) sees the exact same state this component renders — no second, independently
 * stale copy of the same chrome.storage.session key (see Agent.tsx for why that matters).
 *
 * conversationHistory is kept in the OpenAI wire format AgentOrchestrator.ts speaks (system/
 * user/assistant/tool messages, including tool_calls plumbing), and is passed back in as-is on
 * the next turn so the model keeps its own tool-calling context. Only user/assistant messages
 * with non-empty content are rendered as text bubbles — intermediate tool_call/tool-result
 * messages exist for the model, not for the chat log, EXCEPT a tool-result carrying a
 * PROPOSAL_TOOLS preview (`{ result: { requiresConfirmation: true, ... } }`, from
 * AgentToolRunner.ts via AgentOrchestrator.ts), which renders inline as an interactive
 * ConfirmationCard, and its settled/settling follow-up states — see buildChatItems() below.
 * A role:"system" message carrying an account-switch notice (written by Agent.tsx) renders as
 * a small centered divider instead of a bubble.
 *
 * There is no separate settings panel: there is nothing left to configure (provider/model/
 * API key all disappeared with AgentService.ts — the proxy + OpenRouter picks the model
 * now), so the only user-facing control besides the chat itself is starting a new chat,
 * exposed directly as a header icon.
 */

import * as React from "react";
import { Box, Typography, TextField, IconButton, Stack, CircularProgress, Button } from "@mui/material";
import { Send, Person, AddComment, CheckCircle, Cancel, ErrorOutline } from "@mui/icons-material";
import { useTranslation } from "react-i18next";
import { WalletContext } from "../AppContext.js";
import { useActiveAccount } from "../ActiveAccountProvider.js";
import { runAgentTurn, type ChatMessage } from "../backend/AgentOrchestrator.js";
import { executeToolCall, type ProposalPreview } from "../backend/AgentToolRunner.js";
import {
  buildRecordFromOutcome,
  extractPolicyDenials,
  appendProposalRecords,
  findPendingConfirmation,
  type ProposalRecord,
} from "../backend/AgentProposalHistory.js";
import ConfirmationCard, {
  buildConfirmationOutcomeSummary,
  type ConfirmationCardStatus,
  type ConfirmationOutcome,
} from "./ConfirmationCard.js";
import TransactionResultCard, { type TransactionResultToolName } from "./TransactionResultCard.js";
import X402PaymentCard from "./X402PaymentCard.js";

/** Preset prompts shown on the empty-state screen — translation keys, also used as the literal message text sent. */
const QUICK_ACTIONS = [
  "agent.quickActionBalance",
  "agent.quickActionPortfolio",
  "agent.quickActionSend",
  "agent.quickActionShield",
] as const;

/** 🤖 stand-in for Arfio until there's a real illustrated avatar — see AGENT_AVATAR usage below. */
const AGENT_AVATAR = "🤖";

/**
 * Maps a raw tool name (e.g. "propose_send") to its already-translated, user-facing label
 * (e.g. "Gönder") — reuses the labels AgentProposalHistoryPanel.tsx already shows for the same
 * tools, so the "settling"/"settled" breadcrumbs below never leak a raw function name into the
 * UI. Falls back to the raw name only if it's an unrecognized tool, which should never happen
 * for PROPOSAL_TOOLS.
 */
/**
 * Amount/symbol/recipient for a "result" item's TransactionResultCard — derived straight from
 * the tool call's originalArgs (exactly what the user asked for), not from a re-run simulation
 * (ConfirmationCard's own displayAmount logic isn't reachable here, see isSettledMarker's docs).
 * `nativeSymbol` is the active network's currency symbol, used for propose_send (which never
 * carries a tokenSymbol arg — it's native-only) and as a shield/unshield fallback.
 */
function resultDisplayFields(
  toolName: string,
  originalArgs: Record<string, unknown>,
  nativeSymbol: string | undefined
): { amount?: string; symbol?: string; recipient?: string } {
  const amount = typeof originalArgs.amount === "string" ? originalArgs.amount : undefined;
  if (toolName === "propose_send") {
    return { amount, symbol: nativeSymbol, recipient: typeof originalArgs.to === "string" ? originalArgs.to : undefined };
  }
  const symbol = typeof originalArgs.tokenSymbol === "string" ? originalArgs.tokenSymbol : nativeSymbol;
  return { amount, symbol };
}

function toolActionLabel(toolName: string, t: (key: string) => string): string {
  switch (toolName) {
    case "propose_send":
      return t("agent.historyToolSend");
    case "propose_shield":
      return t("agent.historyToolShield");
    case "propose_unshield":
      return t("agent.historyToolUnshield");
    default:
      return toolName;
  }
}

export interface AgentChatPanelProps {
  conversationHistory: ChatMessage[];
  setConversationHistory: (value: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  setProposalHistory: (value: ProposalRecord[] | ((prev: ProposalRecord[]) => ProposalRecord[])) => void;
}

type ChatItem =
  | { kind: "message"; key: string; role: "user" | "assistant"; content: string }
  | { kind: "confirmation"; key: string; toolCallId: string; preview: ProposalPreview }
  | { kind: "settling"; key: string; toolName: string }
  | { kind: "settled"; key: string; toolName: string; status: ConfirmationOutcome["status"] }
  | {
      kind: "result";
      key: string;
      phase: "pending" | "success" | "failed";
      toolName: string;
      originalArgs: Record<string, unknown>;
      txHash?: string;
      newBalance?: { amount: string; symbol: string } | null;
      message?: string;
    }
  | {
      kind: "x402Payment";
      key: string;
      resource: string;
      amountUsd: number;
      remainingBudgetUsd: number;
      txHash?: string;
    }
  | { kind: "divider"; key: string; label: string };

/** Written by Agent.tsx into a role:"system" message when the active account changes — see that file. */
function isAccountSwitchNotice(value: unknown): value is { accountSwitchNotice: true; label: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.accountSwitchNotice === true && typeof v.label === "string";
}

/**
 * Written into a tool message's content the instant the user hits Approve, and again as soon as
 * a broadcast tx hash is known — see handleCardStatusChange's "pending" branch (fed by
 * ConfirmationCard's onStatusChange). Distinct from a terminal outcome (isSettledMarker) — the
 * agent hasn't been told anything yet, and this also exists so a popup close/reopen mid-broadcast
 * (history persists across that, see usePersistedState in pages/Agent.tsx) can't re-render the
 * card as approvable and risk a double-submit.
 *
 * `originalArgs` lets buildChatItems render the real pending receipt (TransactionResultCard,
 * phase="pending") instead of the old "settling" breadcrumb — see that function's docs for why
 * this data has to be captured here rather than read off ConfirmationCard's own render output.
 * A marker from an older build (before `originalArgs` existed) simply lacks it and falls back to
 * the breadcrumb, same fallback strategy as isSettledMarker below.
 */
function isPendingSettlement(value: unknown): value is {
  pendingSettlement: true;
  toolName: string;
  originalArgs?: Record<string, unknown>;
  txHash?: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.pendingSettlement === true && typeof v.toolName === "string";
}

/**
 * Written into a tool message's content once a ConfirmationCard has fully resolved (confirmed,
 * rejected, or failed) — see handleCardStatusChange's terminal branch. `summary` is still exactly
 * buildConfirmationOutcomeSummary's text (what the model reads), but `status`/`toolName` let
 * buildChatItems render the right follow-up UI instead of the card just vanishing — full detail
 * always also lives in the "Agent Geçmişi" tab (AgentProposalHistoryPanel.tsx).
 *
 * For "confirmed"/"failed", the marker additionally carries `originalArgs` plus `txHash`/
 * `newBalance` (confirmed) or `message` (failed) so buildChatItems can render a persistent
 * "result" item: the full receipt-style TransactionResultCard (with a working "Tekrar dene"
 * button on failure). This exists because ConfirmationCard calls onStatusChange synchronously in
 * the same tick as its own terminal setCardPhase("success"/"error") — React 18 batches both into
 * one commit, so by the time this component re-renders with the settled tool message,
 * ConfirmationCard (and whatever it just tried to render locally) has already been swapped out of
 * the tree. The receipt therefore has to be reconstructed here, from data handleCardStatusChange
 * captured before that swap, not read off ConfirmationCard's own (already-unmounted) output.
 *
 * "rejected" (and any marker from an older build, before `originalArgs` existed) falls back to
 * the minimal breadcrumb — there's no TransactionResultCard phase for a user-cancelled proposal.
 */
function isSettledMarker(
  value: unknown
): value is { settled: true; status: ConfirmationOutcome["status"]; toolName: string; summary: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.settled === true &&
    (v.status === "confirmed" || v.status === "rejected" || v.status === "failed") &&
    typeof v.toolName === "string" &&
    typeof v.summary === "string"
  );
}

function hasOriginalArgs(value: unknown): value is { originalArgs: Record<string, unknown> } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.originalArgs === "object" && v.originalArgs !== null;
}

/** Like hasOriginalArgs, but also exposes the terminal (confirmed/failed) fields isSettledMarker's own predicate doesn't declare. */
function hasResultDetail(value: unknown): value is {
  originalArgs: Record<string, unknown>;
  txHash?: string;
  newBalance?: { amount: string; symbol: string } | null;
  message?: string;
} {
  return hasOriginalArgs(value);
}

/**
 * The `pay_for_resource` tool's own result when AgentPolicyEngine.evaluateX402Payment() decided
 * the payment was within budget — AgentToolRunner.handlePayForResource has ALREADY signed,
 * settled, and recorded it to the ledger by the time this shape exists (see that function's own
 * docs). Unlike every other marker in this file, this is the tool message's ORIGINAL, unmodified
 * content — AgentChatPanel never rewrites it (there's no ConfirmationCard/onStatusChange
 * involved at all for this path), so buildChatItems reads it directly off whatever
 * AgentOrchestrator appended to history.
 */
function isAutoPaidX402Result(value: unknown): value is {
  autoPaid: true;
  toolName: string;
  resource: string;
  amountUsd: number;
  txHash?: string;
  remainingBudgetUsd: number;
} {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.autoPaid === true &&
    typeof v.toolName === "string" &&
    typeof v.resource === "string" &&
    typeof v.amountUsd === "number" &&
    typeof v.remainingBudgetUsd === "number"
  );
}

/**
 * Derives the renderable chat log from the raw wire-format history: text bubbles for
 * user/assistant content, plus (at most one — see findPendingConfirmation, imported from
 * AgentProposalHistory.ts) an interactive ConfirmationCard slotted in exactly where its tool
 * call happened. Resolving a card rewrites that tool message's content in place (see
 * handleCardStatusChange) through one of three shapes, checked in order: still a pending
 * ProposalPreview (interactive card), a transient isPendingSettlement marker (approved,
 * broadcasting — a "result" item, phase="pending", when it carries originalArgs), or a terminal
 * isSettledMarker (confirmed/failed — a "result" item too, phase="success"/"failed"; rejected
 * stays the minimal "settled" breadcrumb, see isSettledMarker's docs). A role:"system"
 * account-switch notice (written by Agent.tsx) renders as a centered divider.
 *
 * A `pay_for_resource` tool message carrying isAutoPaidX402Result is a fourth, SIMPLER case: an
 * "x402Payment" item, read directly off the tool message's own original content — there's no
 * ConfirmationCard/onStatusChange rewrite step for this path at all (the payment already
 * happened before AgentOrchestrator ever appended the message), so unlike "result" this doesn't
 * need any of handleCardStatusChange's captured-before-unmount data. Checked first in the tool
 * branch below since its shape (`autoPaid: true`) is unambiguous and never overlaps the others.
 */
function buildChatItems(history: ChatMessage[]): ChatItem[] {
  const pending = findPendingConfirmation(history);
  const items: ChatItem[] = [];

  history.forEach((m, i) => {
    if ((m.role === "user" || m.role === "assistant") && m.content.trim().length > 0) {
      items.push({ kind: "message", key: `${i}-${m.role}`, role: m.role, content: m.content });
      return;
    }
    if (m.role === "system") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(m.content);
      } catch {
        return;
      }
      if (isAccountSwitchNotice(parsed)) {
        items.push({ kind: "divider", key: `${i}-divider`, label: parsed.label });
      }
      return;
    }
    if (pending && m.role === "tool" && m.tool_call_id === pending.toolCallId) {
      items.push({ kind: "confirmation", key: `${i}-confirm-${pending.toolCallId}`, toolCallId: pending.toolCallId, preview: pending.preview });
      return;
    }
    if (m.role === "tool" && m.tool_call_id) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(m.content);
      } catch {
        return;
      }
      const result = (parsed as { result?: unknown } | null)?.result;
      if (isAutoPaidX402Result(result)) {
        items.push({
          kind: "x402Payment",
          key: `${i}-x402-${m.tool_call_id}`,
          resource: result.resource,
          amountUsd: result.amountUsd,
          remainingBudgetUsd: result.remainingBudgetUsd,
          txHash: result.txHash,
        });
        return;
      }
      if (isPendingSettlement(result)) {
        if (hasOriginalArgs(result)) {
          items.push({
            kind: "result",
            key: `${i}-result-${m.tool_call_id}`,
            phase: "pending",
            toolName: result.toolName,
            originalArgs: result.originalArgs,
            txHash: result.txHash,
          });
          return;
        }
        items.push({ kind: "settling", key: `${i}-settling-${m.tool_call_id}`, toolName: result.toolName });
        return;
      }
      if (isSettledMarker(result)) {
        if ((result.status === "confirmed" || result.status === "failed") && hasResultDetail(result)) {
          items.push({
            kind: "result",
            key: `${i}-result-${m.tool_call_id}`,
            phase: result.status === "confirmed" ? "success" : "failed",
            toolName: result.toolName,
            originalArgs: result.originalArgs,
            txHash: result.txHash,
            newBalance: result.newBalance,
            message: result.message,
          });
          return;
        }
        items.push({
          kind: "settled",
          key: `${i}-settled-${m.tool_call_id}`,
          toolName: result.toolName,
          status: result.status,
        });
      }
    }
  });

  return items;
}

function AgentChatPanel({ conversationHistory, setConversationHistory, setProposalHistory }: AgentChatPanelProps) {
  const { t } = useTranslation();
  const wallet = React.useContext(WalletContext);
  const { activeAccount } = useActiveAccount();

  const [input, setInput] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const address = activeAccount?.GetAddress();
  const networkId = wallet?.networkProvider.getActiveNetworkId();
  const hasContext = !!wallet && !!address && networkId !== undefined;
  // For "result" items' TransactionResultCard — same object ConfirmationCard itself reads,
  // needed for the Explorer link and (for propose_send) the native currency symbol fallback.
  const network = wallet?.networkProvider.getActiveNetwork();

  React.useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversationHistory, sending]);

  const chatItems = React.useMemo(() => buildChatItems(conversationHistory), [conversationHistory]);
  const hasPendingConfirmation = React.useMemo(
    () => findPendingConfirmation(conversationHistory) !== null,
    [conversationHistory]
  );
  const inputLocked = sending || hasPendingConfirmation;

  /** "New Chat" — wipes the transcript only, no archiving. agent_proposal_history is untouched. */
  const handleNewChat = () => {
    setConversationHistory([]);
  };

  /** Records any PROPOSAL_TOOLS calls this turn's newly-appended slice denied by AgentPolicyEngine. */
  const recordPolicyDenials = (baseHistory: ChatMessage[], updatedHistory: ChatMessage[], accountAddress: string) => {
    const denials = extractPolicyDenials(updatedHistory.slice(baseHistory.length), accountAddress);
    if (denials.length > 0) {
      setProposalHistory((prev) => appendProposalRecords(prev, denials));
    }
  };

  const handleSend = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || inputLocked || !address || networkId === undefined) return;

    setInput("");
    setSending(true);

    try {
      const { updatedHistory } = await runAgentTurn(text, conversationHistory, {
        account: address,
        networkId: String(networkId),
      });
      setConversationHistory(updatedHistory);
      recordPolicyDenials(conversationHistory, updatedHistory, address);
    } catch {
      // runAgentTurn is designed to never throw — this is a last-resort guard, not the
      // normal error path (proxy/model failures already come back as a friendly `reply`).
      setConversationHistory((prev) => [
        ...prev,
        { role: "user", content: text },
        { role: "assistant", content: t("agent.panelUnexpectedError") },
      ]);
    } finally {
      setSending(false);
    }
  };

  /**
   * The ONLY place that writes a ConfirmationCard's status into conversationHistory — wired to
   * ConfirmationCard's single onStatusChange prop, which fires on every transition (approval
   * start, broadcast hash known, and the terminal confirmed/failed/rejected). Having one handler
   * for the whole lifecycle, instead of a separate one per transition, means there's exactly one
   * switch that decides how each status gets persisted: a new transition can't be added to
   * ConfirmationCard without this switch needing to grow to handle it, so it can't quietly fall
   * through unhandled the way a missed prop easily could.
   *
   * Never appends a second tool-message for the same tool_call_id — the tool-calling protocol
   * allows exactly one answer per call, and that call was already answered (with the preview)
   * the moment AgentToolRunner produced it. Every status just rewrites that message's content in
   * place (see isPendingSettlement / isSettledMarker / buildChatItems) — TransactionResultCard
   * (rendered directly by AgentChatPanel as a "result" item, see buildChatItems' docs) is what
   * shows the user what actually happened, from real Network.ts data. This deliberately never
   * calls runAgentTurn: doing so used to trigger an immediate model-authored reply narrating the
   * outcome in its own words (including transcribing the tx hash) right after approval, with no
   * user action in between — the same class of bug as a model hallucinating a completion, just
   * one step later in the flow. Every marker written here is real, code-produced data that simply
   * becomes part of `conversationHistory`; the model only sees and reacts to it the next time the
   * user actually sends a message (see handleSend), not proactively.
   */
  const handleCardStatusChange = (toolCallId: string, preview: ProposalPreview, status: ConfirmationCardStatus) => {
    if (status.status === "pending") {
      setConversationHistory((prev) =>
        prev.map((m) =>
          m.role === "tool" && m.tool_call_id === toolCallId
            ? {
                ...m,
                content: JSON.stringify({
                  result: { pendingSettlement: true, toolName: status.toolName, originalArgs: status.originalArgs, txHash: status.txHash },
                }),
              }
            : m
        )
      );
      return;
    }

    // Terminal: confirmed / failed / rejected. Confirmed/failed additionally carry originalArgs
    // (+ txHash/newBalance, or message) so buildChatItems can render the full receipt-style
    // result — see hasResultDetail and isSettledMarker's docs for why this data has to be
    // captured here rather than read off ConfirmationCard's own (already-unmounted) output.
    const summary = buildConfirmationOutcomeSummary(status, t);
    const resultDetail =
      status.status === "confirmed"
        ? { originalArgs: status.originalArgs, txHash: status.txHash, newBalance: status.newBalance }
        : status.status === "failed"
          ? { originalArgs: status.originalArgs, message: status.message }
          : {};
    setConversationHistory((prev) =>
      prev.map((m) =>
        m.role === "tool" && m.tool_call_id === toolCallId
          ? {
              ...m,
              content: JSON.stringify({
                result: { settled: true, status: status.status, toolName: status.toolName, summary, ...resultDetail },
              }),
            }
          : m
      )
    );
    if (address) {
      setProposalHistory((prev) => appendProposalRecords(prev, [buildRecordFromOutcome(toolCallId, preview, status, address)]));
    }
  };

  /**
   * "Tekrar dene" on a failed TransactionResultCard — re-runs the exact same proposal tool with
   * the exact same args, without the user retyping the recipient/amount. Calls
   * AgentToolRunner.executeToolCall directly (the same function AgentOrchestrator's tool loop
   * uses), never runAgentTurn: this must not become a second model turn — the user already
   * decided what they want, they're just asking for a fresh preview after a failure, and
   * involving the model here would risk it re-narrating or second-guessing a decision that's
   * already been made. On success, the new preview is appended as a synthetic tool_calls +
   * tool-result pair, exactly the shape a real model turn would have produced, so buildChatItems'
   * existing findPendingConfirmation logic picks it up and renders a new ConfirmationCard with no
   * special-casing needed.
   */
  const handleRetryProposal = async (toolName: string, originalArgs: Record<string, unknown>) => {
    if (!address || networkId === undefined) return;

    const outcome = await executeToolCall(toolName, originalArgs, { account: address, networkId: String(networkId) });

    if (outcome.error) {
      setConversationHistory((prev) => [...prev, { role: "assistant", content: outcome.error! }]);
      return;
    }

    const toolCallId = `retry_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    setConversationHistory((prev) => [
      ...prev,
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: toolCallId, type: "function", function: { name: toolName, arguments: JSON.stringify(originalArgs) } }],
      },
      { role: "tool", tool_call_id: toolCallId, name: toolName, content: JSON.stringify({ result: outcome.result }) },
    ]);
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          px: 2,
          py: 1.25,
          borderBottom: "1px solid",
          borderColor: "divider",
          flexShrink: 0,
        }}
      >
        <Typography
          variant="subtitle1"
          sx={{ fontFamily: "var(--font-mono)", textTransform: "uppercase", color: "text.primary" }}
        >
          {t("agent.panelTitle")}
        </Typography>
        <IconButton
          onClick={handleNewChat}
          disabled={inputLocked || chatItems.length === 0}
          aria-label={t("agent.panelNewChatAria")}
        >
          <AddComment fontSize="small" />
        </IconButton>
      </Box>

      {/* Messages */}
      <Box sx={{ flex: 1, overflowY: "auto", px: 2, py: 2 }}>
        {chatItems.length === 0 && (
          <Box sx={{ textAlign: "center", mt: 6 }}>
            <Typography sx={{ fontSize: 40, lineHeight: 1, mb: 1, filter: "grayscale(1)", opacity: 0.5 }}>
              {AGENT_AVATAR}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: hasContext ? 2 : 0 }}>
              {hasContext ? t("agent.panelEmptyState") : t("agent.panelNoAccount")}
            </Typography>
            {hasContext && (
              <Stack direction="row" flexWrap="wrap" justifyContent="center" gap={1} sx={{ px: 2 }}>
                {QUICK_ACTIONS.map((key) => (
                  <Button
                    key={key}
                    size="small"
                    variant="outlined"
                    disabled={sending}
                    onClick={() => handleSend(t(key))}
                    sx={{ borderRadius: 0, textTransform: "none", fontSize: "0.75rem" }}
                  >
                    {t(key)}
                  </Button>
                ))}
              </Stack>
            )}
          </Box>
        )}

        <Stack spacing={1.5}>
          {chatItems.map((item) =>
            item.kind === "message" ? (
              <Box
                key={item.key}
                sx={{
                  display: "flex",
                  gap: 1,
                  alignSelf: item.role === "user" ? "flex-end" : "flex-start",
                  flexDirection: item.role === "user" ? "row-reverse" : "row",
                  maxWidth: "85%",
                  ml: item.role === "user" ? "auto" : 0,
                }}
              >
                <Box
                  sx={{
                    width: 26,
                    height: 26,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: "1px solid",
                    borderColor: "divider",
                    color: "text.primary",
                  }}
                >
                  {item.role === "user" ? (
                    <Person sx={{ fontSize: 16 }} />
                  ) : (
                    <Typography sx={{ fontSize: 14, lineHeight: 1 }}>{AGENT_AVATAR}</Typography>
                  )}
                </Box>
                <Box
                  sx={{
                    px: 1.5,
                    py: 1,
                    border: "1px solid",
                    borderColor: "divider",
                    bgcolor: item.role === "user" ? "action.hover" : "transparent",
                  }}
                >
                  <Typography variant="body2" sx={{ color: "text.primary", whiteSpace: "pre-wrap" }}>
                    {item.content}
                  </Typography>
                </Box>
              </Box>
            ) : item.kind === "confirmation" ? (
              // Rendered as if it were one of the agent's own messages (avatar prefix, same
              // left alignment) but interactive — this is the only point in the whole
              // pipeline where the user can actually authorize a proposed transaction.
              <Box key={item.key} sx={{ display: "flex", gap: 1, alignSelf: "flex-start", maxWidth: "100%", width: "100%" }}>
                <Box
                  sx={{
                    width: 26,
                    height: 26,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: "1px solid",
                    borderColor: "divider",
                    color: "text.primary",
                  }}
                >
                  <Typography sx={{ fontSize: 14, lineHeight: 1 }}>{AGENT_AVATAR}</Typography>
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <ConfirmationCard
                    preview={item.preview}
                    onStatusChange={(status) => handleCardStatusChange(item.toolCallId, item.preview, status)}
                    onRetry={(toolName, originalArgs) => void handleRetryProposal(toolName, originalArgs)}
                  />
                </Box>
              </Box>
            ) : item.kind === "result" ? (
              // The persistent receipt for a confirmed/failed proposal — see isSettledMarker's
              // docs for why this is built from the settled marker's own captured data rather
              // than rendered by ConfirmationCard itself (which has already unmounted by now).
              <Box key={item.key} sx={{ display: "flex", gap: 1, alignSelf: "flex-start", maxWidth: "100%", width: "100%" }}>
                <Box
                  sx={{
                    width: 26,
                    height: 26,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: "1px solid",
                    borderColor: "divider",
                    color: "text.primary",
                  }}
                >
                  <Typography sx={{ fontSize: 14, lineHeight: 1 }}>{AGENT_AVATAR}</Typography>
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <TransactionResultCard
                    phase={item.phase}
                    toolName={item.toolName as TransactionResultToolName}
                    {...resultDisplayFields(item.toolName, item.originalArgs, network?.currency_symbol)}
                    txHash={item.txHash}
                    newBalance={item.newBalance}
                    errorMessage={item.message}
                    network={network}
                    onRetry={
                      item.phase === "failed" ? () => void handleRetryProposal(item.toolName, item.originalArgs) : undefined
                    }
                  />
                </Box>
              </Box>
            ) : item.kind === "x402Payment" ? (
              // Informational only — no Approve/Reject, the payment already happened before
              // this item ever existed (see isAutoPaidX402Result's docs). Never part of the
              // ConfirmationCard flow.
              <Box key={item.key} sx={{ display: "flex", gap: 1, alignSelf: "flex-start", maxWidth: "100%", width: "100%" }}>
                <Box
                  sx={{
                    width: 26,
                    height: 26,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: "1px solid",
                    borderColor: "divider",
                    color: "text.primary",
                  }}
                >
                  <Typography sx={{ fontSize: 14, lineHeight: 1 }}>{AGENT_AVATAR}</Typography>
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <X402PaymentCard
                    resource={item.resource}
                    amountUsd={item.amountUsd}
                    remainingBudgetUsd={item.remainingBudgetUsd}
                    txHash={item.txHash}
                    network={network}
                  />
                </Box>
              </Box>
            ) : item.kind === "settling" ? (
              // A transaction was approved but the popup closed before it settled — see
              // isPendingSettlement. No longer actionable; just tells the user where things
              // stand until the agent's next turn reports the real outcome.
              <Box key={item.key} sx={{ display: "flex", alignItems: "center", gap: 1, alignSelf: "flex-start" }}>
                <CircularProgress size={14} />
                <Typography variant="caption" color="text.secondary">
                  {t("agent.panelSettlingNote", { toolName: toolActionLabel(item.toolName, t) })}
                </Typography>
              </Box>
            ) : item.kind === "settled" ? (
              // A ConfirmationCard that fully resolved — see isSettledMarker. Full detail
              // (amount, reason, tx hash) lives in the "Agent Geçmişi" tab; this is just a
              // faded "already handled" breadcrumb so the same screen doesn't look stale.
              <Box key={item.key} sx={{ display: "flex", alignItems: "center", gap: 0.75, alignSelf: "flex-start", opacity: 0.55 }}>
                {item.status === "confirmed" ? (
                  <CheckCircle sx={{ fontSize: 14 }} />
                ) : item.status === "failed" ? (
                  <ErrorOutline sx={{ fontSize: 14 }} />
                ) : (
                  <Cancel sx={{ fontSize: 14 }} />
                )}
                <Typography variant="caption" color="text.secondary">
                  {t(
                    item.status === "confirmed"
                      ? "agent.panelSettledApproved"
                      : item.status === "failed"
                        ? "agent.panelSettledFailed"
                        : "agent.panelSettledCancelled",
                    { toolName: toolActionLabel(item.toolName, t) }
                  )}
                </Typography>
              </Box>
            ) : (
              // Account-switch notice (role:"system", written by Agent.tsx) — a centered,
              // non-interactive divider, distinct from both user/assistant bubbles and the
              // ConfirmationCard follow-up states above.
              <Box key={item.key} sx={{ textAlign: "center", my: 0.5 }}>
                <Typography variant="caption" color="text.disabled" sx={{ fontStyle: "italic" }}>
                  {item.label}
                </Typography>
              </Box>
            )
          )}
          {sending && (
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <CircularProgress size={16} />
              <Typography variant="caption" color="text.secondary">
                {t("agent.panelThinking")}
              </Typography>
            </Box>
          )}
        </Stack>
        <div ref={scrollRef} />
      </Box>

      {/* Input */}
      <Box sx={{ display: "flex", gap: 1, p: 1.5, borderTop: "1px solid", borderColor: "divider", flexShrink: 0 }}>
        <TextField
          fullWidth
          size="small"
          placeholder={t("agent.panelPlaceholder")}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          disabled={inputLocked || !hasContext}
        />
        <IconButton
          onClick={() => handleSend()}
          disabled={inputLocked || !input.trim() || !hasContext}
          aria-label={t("agent.panelSendAria")}
          sx={{ border: "1px solid", borderColor: "divider", borderRadius: 0 }}
        >
          <Send fontSize="small" />
        </IconButton>
      </Box>
    </Box>
  );
}

export default AgentChatPanel;
