/**
 * AgentChatPanel — chat UI for the in-wallet AI Agent (runAgentTurn / AgentOrchestrator.ts).
 *
 * Rendered by the /agent route (src/pages/Agent.tsx). conversationHistory is kept in the
 * OpenAI wire format AgentOrchestrator.ts speaks (system/user/assistant/tool messages,
 * including tool_calls plumbing), and is passed back in as-is on the next turn so the model
 * keeps its own tool-calling context. Only user/assistant messages with non-empty content
 * are rendered as text bubbles — intermediate tool_call/tool-result messages exist for the
 * model, not for the chat log, EXCEPT a tool-result carrying a PROPOSAL_TOOLS preview
 * (`{ result: { requiresConfirmation: true, ... } }`, from AgentToolRunner.ts via
 * AgentOrchestrator.ts), which renders inline as an interactive ConfirmationCard — see
 * buildChatItems() below.
 *
 * There is no separate settings panel: there is nothing left to configure (provider/model/
 * API key all disappeared with AgentService.ts — the proxy + OpenRouter picks the model
 * now), so the only user-facing control besides the chat itself is clearing the
 * conversation, exposed directly as a header icon.
 */

import * as React from "react";
import { Box, Typography, TextField, IconButton, Stack, CircularProgress } from "@mui/material";
import { Send, SmartToy, Person, DeleteSweep } from "@mui/icons-material";
import { useTranslation } from "react-i18next";
import { WalletContext } from "../AppContext.js";
import { useActiveAccount } from "../ActiveAccountProvider.js";
import { runAgentTurn, type ChatMessage } from "../backend/AgentOrchestrator.js";
import type { ProposalPreview } from "../backend/AgentToolRunner.js";
import ConfirmationCard, { buildConfirmationOutcomeSummary, type ConfirmationOutcome } from "./ConfirmationCard.js";

type ChatItem =
  | { kind: "message"; key: string; role: "user" | "assistant"; content: string }
  | { kind: "confirmation"; key: string; toolCallId: string; preview: ProposalPreview };

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

/** Finds the earliest not-yet-resolved proposal preview in history, if any — see buildChatItems(). */
function findPendingConfirmation(history: ChatMessage[]): { toolCallId: string; preview: ProposalPreview } | null {
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

/**
 * Derives the renderable chat log from the raw wire-format history: text bubbles for
 * user/assistant content, plus (at most one — see findPendingConfirmation) an interactive
 * ConfirmationCard slotted in exactly where its tool call happened. Resolving a card
 * rewrites that tool message's content in place (see handleConfirmationResolved), which is
 * also how "already resolved" is detected — a resolved message no longer parses as a
 * pending preview, so it simply stops showing up here.
 */
function buildChatItems(history: ChatMessage[]): ChatItem[] {
  const pending = findPendingConfirmation(history);
  const items: ChatItem[] = [];

  history.forEach((m, i) => {
    if ((m.role === "user" || m.role === "assistant") && m.content.trim().length > 0) {
      items.push({ kind: "message", key: `${i}-${m.role}`, role: m.role, content: m.content });
      return;
    }
    if (pending && m.role === "tool" && m.tool_call_id === pending.toolCallId) {
      items.push({ kind: "confirmation", key: `${i}-confirm-${pending.toolCallId}`, toolCallId: pending.toolCallId, preview: pending.preview });
    }
  });

  return items;
}

function AgentChatPanel() {
  const { t } = useTranslation();
  const wallet = React.useContext(WalletContext);
  const { activeAccount } = useActiveAccount();

  const [conversationHistory, setConversationHistory] = React.useState<ChatMessage[]>([]);
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

  const handleClear = () => {
    setConversationHistory([]);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || inputLocked || !address || networkId === undefined) return;

    setInput("");
    setSending(true);

    try {
      const { updatedHistory } = await runAgentTurn(text, conversationHistory, {
        account: address,
        networkId: String(networkId),
      });
      setConversationHistory(updatedHistory);
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
   * message's content is rewritten in place with the outcome, then runAgentTurn is called
   * again with no new user text (just "continue given this outcome") so the model reacts
   * naturally to what the user decided.
   */
  const handleConfirmationResolved = async (toolCallId: string, outcome: ConfirmationOutcome) => {
    const summary = buildConfirmationOutcomeSummary(outcome, t);
    const historyWithOutcome = conversationHistory.map((m) =>
      m.role === "tool" && m.tool_call_id === toolCallId
        ? { ...m, content: JSON.stringify({ result: summary }) }
        : m
    );
    setConversationHistory(historyWithOutcome);

    if (!address || networkId === undefined) return;
    setSending(true);

    try {
      const { updatedHistory } = await runAgentTurn("", historyWithOutcome, {
        account: address,
        networkId: String(networkId),
      });
      setConversationHistory(updatedHistory);
    } catch {
      setConversationHistory((prev) => [...prev, { role: "assistant", content: t("agent.panelUnexpectedError") }]);
    } finally {
      setSending(false);
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
          onClick={handleClear}
          disabled={inputLocked || chatItems.length === 0}
          aria-label={t("agent.panelClearAria")}
        >
          <DeleteSweep fontSize="small" />
        </IconButton>
      </Box>

      {/* Messages */}
      <Box sx={{ flex: 1, overflowY: "auto", px: 2, py: 2 }}>
        {chatItems.length === 0 && (
          <Box sx={{ textAlign: "center", mt: 6 }}>
            <SmartToy sx={{ fontSize: 40, color: "text.disabled", mb: 1 }} />
            <Typography variant="body2" color="text.secondary">
              {hasContext ? t("agent.panelEmptyState") : t("agent.panelNoAccount")}
            </Typography>
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
                  {item.role === "user" ? <Person sx={{ fontSize: 16 }} /> : <SmartToy sx={{ fontSize: 16 }} />}
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
            ) : (
              // Rendered as if it were one of the agent's own messages (SmartToy prefix,
              // same left alignment) but interactive — this is the only point in the whole
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
                  <SmartToy sx={{ fontSize: 16 }} />
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <ConfirmationCard
                    preview={item.preview}
                    onResolved={(outcome) => handleConfirmationResolved(item.toolCallId, outcome)}
                  />
                </Box>
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
          onClick={handleSend}
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
