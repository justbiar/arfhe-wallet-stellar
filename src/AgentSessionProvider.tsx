/**
 * AgentSessionProvider — owns the AI Agent's chat/proposal history above the router, so an
 * in-flight agent turn survives navigating away from the /agent route within the same popup
 * session.
 *
 * Why this has to live here and not inside Agent.tsx (where it used to): AgentChatPanel.handleSend
 * fires off `await runVpsAgentTurn(...)` / `await runAgentTurn(...)` and, once that resolves,
 * calls `setConversationHistory(updatedHistory)` — a prop that closes over Agent.tsx's own
 * usePersistedState setter. If the user switches to a different tab (Home, History, ...) or
 * closes the popup while that request is still running, React Router unmounts Agent.tsx (and
 * AgentChatPanel with it): the async chain itself keeps running to completion (a plain promise,
 * not tied to component lifetime), but the eventual setState call lands on a torn-down hook
 * instance and is silently dropped — no crash, no warning, just a reply that never gets
 * persisted. From the user's side that is indistinguishable from "the operation was cancelled"
 * (Ömer Aydoğan, 30.08.2026: "agent sayfasında işlem devam ederken sayfa değiştirince yada
 * extension kapanınca devam eden işlem iptal oluyor").
 *
 * Moving ownership of the two storage-backed values up to here — a provider that wraps the
 * whole router, mounted once for the popup's entire lifetime — means the setter AgentChatPanel
 * calls belongs to a hook instance that survives the route change. The state itself already
 * persists to chrome.storage.session (usePersistedState), so this only closes the gap between
 * "the update happened in memory" and "the component that would have committed it still exists"
 * — it does NOT survive the popup being closed entirely (that tears down this provider too, and
 * with it the whole JS execution context — no promise can outlive that without moving the
 * actual work into the background service worker, the way the transaction-broadcast/watch flow
 * already does in service-worker.js; the agent's own LLM round-trip does not do that today).
 *
 * Everything else Agent.tsx used to own alongside this (tab index, the account-switch side
 * effects: cancelling a pending card, toasting, dropping a system note into the new account's
 * history) stays exactly where it was — those are either synchronous UI state with nothing to
 * lose on unmount, or side effects that only make sense while the Agent tab is actually visible.
 */

import * as React from "react";
import { usePersistedState } from "./hooks/usePersistedState.js";
import type { ChatMessage } from "./backend/AgentOrchestrator.js";
import { PROPOSAL_HISTORY_STORAGE_KEY, type ProposalRecord } from "./backend/AgentProposalHistory.js";

export interface AgentSessionContextType {
  historyByAccount: Record<string, ChatMessage[]>;
  setHistoryByAccount: (
    value: Record<string, ChatMessage[]> | ((prev: Record<string, ChatMessage[]>) => Record<string, ChatMessage[]>)
  ) => void;
  proposalHistory: ProposalRecord[];
  setProposalHistory: (value: ProposalRecord[] | ((prev: ProposalRecord[]) => ProposalRecord[])) => void;
  /**
   * Which accounts currently have a turn in flight — read by AgentChatPanel instead of owning
   * its own local `sending` state, for the same reason the history above moved up: `sending`
   * used to be a plain useState inside AgentChatPanel, so it reset to false the instant the
   * component unmounted (switching tabs) and initialized back to false on remount regardless
   * of whether the request was actually still running. The user saw the "thinking" indicator
   * and disabled input vanish — Ömer Aydoğan, 30.08.2026: "agent düşünürken başka bir sekmeye
   * gidince kapanıyor" — even though (after the fix above) the reply was still going to land
   * correctly once it arrived. Keyed by account, not a single boolean, so switching accounts
   * mid-turn doesn't show the wrong account's spinner. Deliberately NOT persisted like the
   * history above: if the popup closes entirely the in-flight work is gone regardless, so
   * defaulting back to "not pending" on the next open is exactly correct, not a compromise.
   */
  pendingByAccount: Record<string, boolean>;
  setPendingByAccount: (value: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)) => void;
}

const AgentSessionContext = React.createContext<AgentSessionContextType | undefined>(undefined);

export function useAgentSession(): AgentSessionContextType {
  const ctx = React.useContext(AgentSessionContext);
  if (!ctx) throw new Error("useAgentSession must be used inside AgentSessionProvider");
  return ctx;
}

export function AgentSessionProvider({ children }: { children: React.ReactNode }) {
  const [historyByAccount, setHistoryByAccount] = usePersistedState<Record<string, ChatMessage[]>>(
    "agent_chat_history",
    {}
  );
  const [proposalHistory, setProposalHistory] = usePersistedState<ProposalRecord[]>(
    PROPOSAL_HISTORY_STORAGE_KEY,
    []
  );
  const [pendingByAccount, setPendingByAccount] = React.useState<Record<string, boolean>>({});

  const value = React.useMemo(
    () => ({
      historyByAccount,
      setHistoryByAccount,
      proposalHistory,
      setProposalHistory,
      pendingByAccount,
      setPendingByAccount,
    }),
    [historyByAccount, setHistoryByAccount, proposalHistory, setProposalHistory, pendingByAccount]
  );

  return <AgentSessionContext.Provider value={value}>{children}</AgentSessionContext.Provider>;
}
