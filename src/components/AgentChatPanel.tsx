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
import type { ProposalPreview } from "../backend/AgentToolRunner.js";
import {
  buildRecordFromOutcome,
  extractPolicyDenials,
  appendProposalRecords,
  findPendingConfirmation,
  type ProposalRecord,
} from "../backend/AgentProposalHistory.js";
import ConfirmationCard, { buildConfirmationOutcomeSummary, type ConfirmationOutcome } from "./ConfirmationCard.js";

/** Preset prompts shown on the empty-state screen — translation keys, also used as the literal message text sent. */
const QUICK_ACTIONS = [
  "agent.quickActionBalance",
  "agent.quickActionPortfolio",
  "agent.quickActionSend",
  "agent.quickActionShield",
] as const;

/** 🤖 stand-in for Arfio until there's a real illustrated avatar — see AGENT_AVATAR usage below. */
const AGENT_AVATAR = "🤖";

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
  | { kind: "divider"; key: string; label: string };

/** Written by Agent.tsx into a role:"system" message when the active account changes — see that file. */
function isAccountSwitchNotice(value: unknown): value is { accountSwitchNotice: true; label: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.accountSwitchNotice === true && typeof v.label === "string";
}

/**
 * Written into a tool message's content the instant the user hits Approve (see
 * ConfirmationCard's onApproveStarted), before the transaction has actually settled.
 * Distinct from a resolved outcome (buildConfirmationOutcomeSummary) — the agent hasn't been
 * told anything yet, this only exists so a popup close/reopen mid-broadcast (history now
 * persists across that, see usePersistedState below) can't re-render the card as approvable
 * and risk a double-submit.
 */
function isPendingSettlement(value: unknown): value is { pendingSettlement: true; toolName: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.pendingSettlement === true && typeof v.toolName === "string";
}

/**
 * Written into a tool message's content once a ConfirmationCard has fully resolved (approved
 * and settled, rejected, or approved-but-failed) — see handleConfirmationResolved. Replaces
 * the old plain-string outcome: `summary` is still exactly buildConfirmationOutcomeSummary's
 * text (what the model reads), but `status`/`toolName` let buildChatItems render a minimal,
 * persistent "already resolved" indicator instead of the card just vanishing — full detail
 * lives in the "Agent Geçmişi" tab (AgentProposalHistoryPanel.tsx), so the chat itself only
 * needs to say "this is done", not re-explain what happened.
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

/**
 * Derives the renderable chat log from the raw wire-format history: text bubbles for
 * user/assistant content, plus (at most one — see findPendingConfirmation, imported from
 * AgentProposalHistory.ts) an interactive ConfirmationCard slotted in exactly where its tool
 * call happened. Resolving a card rewrites that tool message's content in place (see
 * handleConfirmationResolved / handleApproveStarted) through one of three shapes, checked in
 * order: still a pending ProposalPreview (interactive card), a transient pendingSettlement
 * marker (approved, broadcasting), or a terminal isSettledMarker (approved/rejected/failed —
 * minimal persistent indicator, full detail in the "Agent Geçmişi" tab). A role:"system"
 * account-switch notice (written by Agent.tsx) renders as a centered divider.
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
      if (isPendingSettlement(result)) {
        items.push({ kind: "settling", key: `${i}-settling-${m.tool_call_id}`, toolName: result.toolName });
        return;
      }
      if (isSettledMarker(result)) {
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
   * Resolving a card never appends a second tool-message for the same tool_call_id — the
   * tool-calling protocol allows exactly one answer per call, and that call was already
   * answered (with the preview) the moment AgentToolRunner produced it. Instead, that
   * message's content is rewritten in place with the outcome (see isSettledMarker /
   * buildChatItems) — TransactionResultCard (rendered inside ConfirmationCard itself) is
   * what shows the user what actually happened, from real Network.ts data. This deliberately
   * does NOT call runAgentTurn again: doing so used to trigger an immediate model-authored
   * reply narrating the outcome in its own words (including transcribing the tx hash) right
   * after approval, with no user action in between — the same class of bug as a model
   * hallucinating a completion, just one step later in the flow. The settled marker written
   * here is real, code-produced data that simply becomes part of `conversationHistory`; the
   * model only sees and reacts to it the next time the user actually sends a message (see
   * handleSend), not proactively.
   */
  /**
   * Fires the instant the user hits Approve, before the transaction has signed/broadcast.
   * Marks the history entry in place so that a popup close mid-broadcast (history is
   * persisted by Agent.tsx) never brings the card back as approvable on reopen — see
   * isPendingSettlement. handleConfirmationResolved overwrites this with the real outcome
   * once the transaction actually settles.
   */
  const handleApproveStarted = (toolCallId: string, toolName: string) => {
    setConversationHistory((prev) =>
      prev.map((m) =>
        m.role === "tool" && m.tool_call_id === toolCallId
          ? { ...m, content: JSON.stringify({ result: { pendingSettlement: true, toolName } }) }
          : m
      )
    );
  };

  const handleConfirmationResolved = (toolCallId: string, preview: ProposalPreview, outcome: ConfirmationOutcome) => {
    const summary = buildConfirmationOutcomeSummary(outcome, t);
    const historyWithOutcome = conversationHistory.map((m) =>
      m.role === "tool" && m.tool_call_id === toolCallId
        ? { ...m, content: JSON.stringify({ result: { settled: true, status: outcome.status, toolName: outcome.toolName, summary } }) }
        : m
    );
    setConversationHistory(historyWithOutcome);
    if (address) {
      setProposalHistory((prev) => appendProposalRecords(prev, [buildRecordFromOutcome(toolCallId, preview, outcome, address)]));
    }
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
                    onResolved={(outcome) => handleConfirmationResolved(item.toolCallId, item.preview, outcome)}
                    onApproveStarted={(toolName) => handleApproveStarted(item.toolCallId, toolName)}
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
                  {t("agent.panelSettlingNote", { toolName: item.toolName })}
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
                    { toolName: item.toolName }
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
