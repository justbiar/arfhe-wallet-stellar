/**
 * AgentChatPanel — chat UI for the in-wallet AI Agent (runAgentTurn / AgentOrchestrator.ts).
 *
 * Rendered by the /agent route (src/pages/Agent.tsx). conversationHistory is kept in the
 * OpenAI wire format AgentOrchestrator.ts speaks (system/user/assistant/tool messages,
 * including tool_calls plumbing), and is passed back in as-is on the next turn so the model
 * keeps its own tool-calling context. Only user/assistant messages with non-empty content
 * are rendered — intermediate tool_call/tool-result messages exist for the model, not for
 * the chat log.
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

interface DisplayMessage {
  key: string;
  role: "user" | "assistant";
  content: string;
}

/** Derives the renderable chat log from the raw wire-format history. */
function toDisplayMessages(history: ChatMessage[]): DisplayMessage[] {
  return history
    .filter(
      (m): m is ChatMessage & { role: "user" | "assistant" } =>
        (m.role === "user" || m.role === "assistant") && m.content.trim().length > 0
    )
    .map((m, i) => ({ key: `${i}-${m.role}`, role: m.role, content: m.content }));
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

  const displayMessages = React.useMemo(() => toDisplayMessages(conversationHistory), [conversationHistory]);

  const handleClear = () => {
    setConversationHistory([]);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending || !address || networkId === undefined) return;

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
          disabled={sending || displayMessages.length === 0}
          aria-label={t("agent.panelClearAria")}
        >
          <DeleteSweep fontSize="small" />
        </IconButton>
      </Box>

      {/* Messages */}
      <Box sx={{ flex: 1, overflowY: "auto", px: 2, py: 2 }}>
        {displayMessages.length === 0 && (
          <Box sx={{ textAlign: "center", mt: 6 }}>
            <SmartToy sx={{ fontSize: 40, color: "text.disabled", mb: 1 }} />
            <Typography variant="body2" color="text.secondary">
              {hasContext ? t("agent.panelEmptyState") : t("agent.panelNoAccount")}
            </Typography>
          </Box>
        )}

        <Stack spacing={1.5}>
          {displayMessages.map((m) => (
            <Box
              key={m.key}
              sx={{
                display: "flex",
                gap: 1,
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                flexDirection: m.role === "user" ? "row-reverse" : "row",
                maxWidth: "85%",
                ml: m.role === "user" ? "auto" : 0,
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
                {m.role === "user" ? <Person sx={{ fontSize: 16 }} /> : <SmartToy sx={{ fontSize: 16 }} />}
              </Box>
              <Box
                sx={{
                  px: 1.5,
                  py: 1,
                  border: "1px solid",
                  borderColor: "divider",
                  bgcolor: m.role === "user" ? "action.hover" : "transparent",
                }}
              >
                <Typography variant="body2" sx={{ color: "text.primary", whiteSpace: "pre-wrap" }}>
                  {m.content}
                </Typography>
              </Box>
            </Box>
          ))}
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
          disabled={sending || !hasContext}
        />
        <IconButton
          onClick={handleSend}
          disabled={sending || !input.trim() || !hasContext}
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
