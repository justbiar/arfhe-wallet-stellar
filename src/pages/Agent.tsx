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
 * OWNS both `agent_chat_history` (per-account: `Record<address, ChatMessage[]>`) and
 * `agent_proposal_history` (cross-account, each record tagged with `accountAddress`) — NOT
 * AgentChatPanel/AgentProposalHistoryPanel themselves, which receive them as props. Two
 * reasons this lives here rather than in the tab components:
 *
 *  1. usePersistedState instances don't sync with each other — each is an independent read of
 *     chrome.storage.session at mount, with one-directional (component → storage) writes. If
 *     both this page AND AgentChatPanel held their own copy of the same key, a write from one
 *     could be silently lost to a stale write from the other (last write wins, no merge). This
 *     page is always mounted for the whole /agent route regardless of which tab is showing, so
 *     it's the only place that can safely be the single source of truth for both keys.
 *  2. The account-switch handling below (cancel a pending card left on the OUTGOING account,
 *     drop a notice into the INCOMING account's chat, toast) needs to work no matter which tab
 *     the user is on — putting it inside AgentChatPanel would silently stop working whenever
 *     the user happened to be looking at the Agent Geçmişi tab when they switched accounts.
 *
 * Per-account chat history (rather than one shared transcript, or a `agent_chat_history:
 * <address>` storage key per account) avoids a real UX bug: usePersistedState's initial read
 * only runs once per hook instance, so swapping which *key* a single instance reads on account
 * switch would show a flash of the outgoing account's messages before the async re-read caught
 * up. A single `Record<address, ChatMessage[]>` under one fixed key sidesteps that entirely —
 * switching accounts is just indexing into an already-loaded map, synchronous, no flash.
 */

import * as React from "react";
import { Box, Tabs, Tab } from "@mui/material";
import { useTranslation } from "react-i18next";
import { usePersistedState } from "../hooks/usePersistedState.js";
import { useActiveAccount } from "../ActiveAccountProvider.js";
import { useToast } from "../components/ToastProvider.js";
import type { ChatMessage } from "../backend/AgentOrchestrator.js";
import {
  PROPOSAL_HISTORY_STORAGE_KEY,
  buildRecordFromOutcome,
  appendProposalRecords,
  findPendingConfirmation,
  type ProposalRecord,
} from "../backend/AgentProposalHistory.js";
import { buildConfirmationOutcomeSummary, ACCOUNT_CHANGED_REASON } from "../components/ConfirmationCard.js";
import AgentChatPanel from "../components/AgentChatPanel.js";
import AgentProposalHistoryPanel from "../components/AgentProposalHistoryPanel.js";

function Agent() {
  const { t } = useTranslation();
  const [tabIndex, setTabIndex] = usePersistedState("agent_active_tab", 0);

  const [historyByAccount, setHistoryByAccount] = usePersistedState<Record<string, ChatMessage[]>>(
    "agent_chat_history",
    {}
  );
  const [proposalHistory, setProposalHistory] = usePersistedState<ProposalRecord[]>(PROPOSAL_HISTORY_STORAGE_KEY, []);

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
    //    — same mechanism/reason text as ConfirmationCard's own effect (see ACCOUNT_CHANGED_REASON),
    //    just performed here because that component will already be unmounted by the time this
    //    runs (conversationHistory swaps to the INCOMING account's array in the same render).
    const outgoingHistory = historyByAccount[previous] ?? [];
    const pending = findPendingConfirmation(outgoingHistory);
    if (pending) {
      const cancelOutcome = { status: "rejected" as const, toolName: pending.preview.toolName, reason: ACCOUNT_CHANGED_REASON };
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
