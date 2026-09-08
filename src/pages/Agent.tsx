/**
 * Agent.tsx — In-wallet AI Agent page.
 *
 * Two tabs: "Sohbet" (AgentChatPanel — the actual chat/tool-calling UI) and "Agent Geçmişi"
 * (AgentProposalHistoryPanel — a persisted log of what every proposal the agent ever made
 * resulted in). Deliberately not the bottom-nav "History" page, which shows real on-chain
 * transactions — this is proposal-level, including ones AgentPolicyEngine denied before the
 * user ever saw a card. Selected tab persists across popup close/open (usePersistedState,
 * same chrome.storage.session pattern as the chat/proposal history below).
 *
 * Reads both `agent_chat_history` (per-account: `Record<address, ChatMessage[]>`) and
 * `agent_proposal_history` (cross-account, each record tagged with `accountAddress`) from
 * AgentSessionProvider (mounted in AppLayout, above the router) rather than owning them
 * itself — NOT AgentChatPanel/AgentProposalHistoryPanel either, which still only receive them
 * as props. See that provider's own docs for why ownership had to move up: a usePersistedState
 * instance living in THIS page component was torn down the moment the user switched to another
 * tab (or closed the popup) while an agent turn was still in flight, silently dropping the
 * reply that arrived after — indistinguishable from the operation having been cancelled.
 *
 * The account-switch handling below (cancel a pending card left on the OUTGOING account, drop
 * a notice into the INCOMING account's chat, toast) still lives here rather than in
 * AgentSessionProvider, deliberately — a toast and a chat notice are only meaningful while the
 * Agent tab is the thing on screen, unlike the raw history data itself.
 *
 * Per-account chat history (rather than one shared transcript, or a `agent_chat_history:
 * <address>` storage key per account) avoids a real UX bug: usePersistedState's initial read
 * only runs once per hook instance, so swapping which *key* a single instance reads on account
 * switch would show a flash of the outgoing account's messages before the async re-read caught
 * up. A single `Record<address, ChatMessage[]>` under one fixed key sidesteps that entirely —
 * switching accounts is just indexing into an already-loaded map, synchronous, no flash.
 */

import { useEffect } from "react";
import * as React from "react";
import { Box, Tabs, Tab } from "@mui/material";
import { useTranslation } from "react-i18next";
import { usePersistedState } from "../hooks/usePersistedState.js";
import { useHuntState } from "../components/HuntStateProvider";
import { useActiveAccount } from "../ActiveAccountProvider.js";
import { useAgentSession } from "../AgentSessionProvider.js";
import { useToast } from "../components/ToastProvider.js";
import type { ChatMessage } from "../backend/AgentOrchestrator.js";
import {
  buildRecordFromOutcome,
  appendProposalRecords,
  findPendingConfirmation,
} from "../backend/AgentProposalHistory.js";
import { buildConfirmationOutcomeSummary, ACCOUNT_CHANGED_REASON_KEY } from "../components/ConfirmationCard.js";
import AgentChatPanel from "../components/AgentChatPanel.js";
import AgentProposalHistoryPanel from "../components/AgentProposalHistoryPanel.js";

function Agent() {
  const { t } = useTranslation();
  const [tabIndex, setTabIndex] = usePersistedState("agent_active_tab", 0);

  // Owned by AgentSessionProvider (mounted in AppLayout, above the router's <Outlet/>) rather
  // than here directly — see that provider's docs for why: a usePersistedState instance living
  // in this page component would be torn down the moment the user switches to another tab
  // while an agent turn is still in flight, silently dropping the reply that arrives after.
  const { historyByAccount, setHistoryByAccount, proposalHistory, setProposalHistory } = useAgentSession();

  const { activeAccount } = useActiveAccount();
  const { showToast } = useToast();
  const address = activeAccount?.GetAddress();

  // Tracks the previously-seen address purely to detect a real switch (A → B), as opposed to
  // the initial mount or a locked→unlocked transition (undefined → A) — neither of those is a
  // "switch" worth cancelling/notifying/toasting about.
  const previousAddressRef = React.useRef<string | undefined>(address);

  React.useEffect(() => {
    const previous = previousAddressRef.current;
    previousAddressRef.current = address;
    if (previous === address || previous === undefined || address === undefined) return;

    // 1. If the OUTGOING account left a pending confirmation card under review, auto-cancel it
    //    — same mechanism/reason text as ConfirmationCard's own effect (see ACCOUNT_CHANGED_REASON_KEY),
    //    just performed here because that component will already be unmounted by the time this
    //    runs (conversationHistory swaps to the INCOMING account's array in the same render).
    const outgoingHistory = historyByAccount[previous] ?? [];
    const pending = findPendingConfirmation(outgoingHistory);
    if (pending) {
      const cancelOutcome = { status: "rejected" as const, toolName: pending.preview.toolName, reason: t(ACCOUNT_CHANGED_REASON_KEY) };
      const summary = buildConfirmationOutcomeSummary(cancelOutcome, t);
      const cancelledHistory = outgoingHistory.map((m) =>
        m.role === "tool" && m.tool_call_id === pending.toolCallId
          ? { ...m, content: JSON.stringify({ result: { settled: true, status: "rejected", toolName: pending.preview.toolName, summary } }) }
          : m
      );
      setHistoryByAccount((prev) => ({ ...prev, [previous]: cancelledHistory }));
      setProposalHistory((prev) =>
        appendProposalRecords(prev, [buildRecordFromOutcome(pending.toolCallId, pending.preview, cancelOutcome, previous)])
      );
    }

    // 2. Drop a small system notice into the INCOMING account's chat (pre-formatted here, where
    //    `t` is available — buildChatItems just displays it verbatim, see AgentChatPanel.tsx).
    const accountLabel = activeAccount?.GetName() || address;
    const noticeMessage: ChatMessage = {
      role: "system",
      content: JSON.stringify({ accountSwitchNotice: true, label: t("agent.systemNoteAccountSwitched", { account: accountLabel }) }),
    };
    setHistoryByAccount((prev) => ({ ...prev, [address]: [...(prev[address] ?? []), noticeMessage] }));

    // 3. Toast — visible regardless of which tab is active (ToastProvider renders at the app root).
    showToast(t("agent.toastAccountSwitched", { account: accountLabel }), "info");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only address transitions should re-run this; historyByAccount/activeAccount/t/showToast are read fresh via closure, not stale (this render's address change implies they're already current — see file header)
  }, [address]);

  const conversationHistory = address ? historyByAccount[address] ?? [] : [];
  const hunt = useHuntState();

  // Counts what the user actually said, not the agent's replies or the tool traffic — ten
  // turns of real conversation, which is the thing worth rewarding.
  const userTurns = conversationHistory.filter((m) => m.role === "user").length;
  useEffect(() => {
    hunt.setState("agent-10-messages", userTurns >= 10);
    return () => hunt.setState("agent-10-messages", false);
  }, [userTurns, hunt]);
  const setConversationHistory = React.useCallback(
    (value: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
      if (!address) return;
      setHistoryByAccount((prev) => {
        const prevForAccount = prev[address] ?? [];
        const next = typeof value === "function" ? (value as (p: ChatMessage[]) => ChatMessage[])(prevForAccount) : value;
        return { ...prev, [address]: next };
      });
    },
    [address, setHistoryByAccount]
  );

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Tabs
        value={tabIndex}
        onChange={(_e, value) => setTabIndex(value)}
        variant="fullWidth"
        sx={{
          flexShrink: 0,
          borderBottom: "1px solid",
          borderColor: "divider",
          minHeight: 40,
          "& .MuiTabs-indicator": { backgroundColor: "text.primary", height: 2, borderRadius: "0px" },
          "& .MuiTab-root": {
            minHeight: 40,
            textTransform: "none",
            fontWeight: 700,
            fontSize: "0.85rem",
            color: "text.primary",
            opacity: 0.5,
            "&.Mui-selected": { color: "text.primary", opacity: 1 },
          },
        }}
      >
        <Tab label={t("agent.tabChat")} />
        <Tab label={t("agent.tabHistory")} />
      </Tabs>

      <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {tabIndex === 0 ? (
          <AgentChatPanel
            conversationHistory={conversationHistory}
            setConversationHistory={setConversationHistory}
            setProposalHistory={setProposalHistory}
          />
        ) : (
          <AgentProposalHistoryPanel records={proposalHistory} />
        )}
      </Box>
    </Box>
  );
}

export default Agent;
