/**
 * AgentProposalHistoryPanel — "Agent Geçmişi" tab (src/pages/Agent.tsx).
 *
 * Distinct from the bottom-nav "History" page (History.tsx, real on-chain transactions this
 * wallet made): this is a log of every PROPOSAL_TOOLS call the AI agent ever made and how it
 * was resolved — approved, denied by AgentPolicyEngine before the user saw a card, rejected by
 * the user, or approved but failed to settle. `records` is the FULL cross-account list, owned
 * by Agent.tsx (single usePersistedState instance — see that file for why this panel doesn't
 * read the storage key itself); this component only filters it down to the currently active
 * account and renders. Read-only: never mutates `records`.
 */

import * as React from "react";
import { Box, Typography, Stack, Link } from "@mui/material";
import { CheckCircle, Cancel, ErrorOutline, Block, OpenInNew, History as HistoryIcon } from "@mui/icons-material";
import { useTranslation } from "react-i18next";
import { WalletContext } from "../AppContext.js";
import { useActiveAccount } from "../ActiveAccountProvider.js";
import { toolNameLabelKey, type ProposalRecord, type ProposalRecordStatus } from "../backend/AgentProposalHistory.js";
import { getExplorerBaseForNetwork } from "./panels/shared.js";

export interface AgentProposalHistoryPanelProps {
  records: ProposalRecord[];
}

function shortenAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function statusIcon(status: ProposalRecordStatus) {
  switch (status) {
    case "approved":
      return <CheckCircle color="success" sx={{ fontSize: 18 }} />;
    case "failed":
      return <ErrorOutline color="error" sx={{ fontSize: 18 }} />;
    case "policy_rejected":
      return <Block color="warning" sx={{ fontSize: 18 }} />;
    case "user_cancelled":
      return <Cancel sx={{ fontSize: 18, color: "text.disabled" }} />;
  }
}

const STATUS_LABEL_KEY: Record<ProposalRecordStatus, string> = {
  approved: "agent.historyStatusApproved",
  policy_rejected: "agent.historyStatusPolicyRejected",
  user_cancelled: "agent.historyStatusUserCancelled",
  failed: "agent.historyStatusFailed",
};

function AgentProposalHistoryPanel({ records }: AgentProposalHistoryPanelProps) {
  const { t } = useTranslation();
  const wallet = React.useContext(WalletContext);
  const { activeAccount } = useActiveAccount();
  const network = wallet?.networkProvider.getActiveNetwork();
  const address = activeAccount?.GetAddress();

  // Newest first — records are appended chronologically (see appendProposalRecords). Filtered
  // to the active account: records is the full cross-account list (Agent.tsx owns it so the
  // account-switch effect can write to any account, not just whichever one is on screen).
  const ordered = React.useMemo(
    () => records.filter((r) => r.accountAddress === address).reverse(),
    [records, address]
  );

  if (ordered.length === 0) {
    return (
      <Box sx={{ textAlign: "center", mt: 6, px: 2 }}>
        <HistoryIcon sx={{ fontSize: 40, color: "text.disabled", mb: 1 }} />
        <Typography variant="body2" color="text.secondary">
          {t("agent.historyEmptyState")}
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ flex: 1, overflowY: "auto", px: 2, py: 2 }}>
      <Stack spacing={1}>
        {ordered.map((record) => {
          const amountText = record.amount
            ? `${record.amount}${record.tokenSymbol ? ` ${record.tokenSymbol}` : ""}`
            : undefined;

          return (
            <Box
              key={record.id}
              sx={{
                display: "flex",
                gap: 1,
                px: 1.5,
                py: 1,
                border: "1px solid",
                borderColor: "divider",
              }}
            >
              <Box sx={{ flexShrink: 0, pt: 0.25 }}>{statusIcon(record.status)}</Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" justifyContent="space-between" alignItems="baseline" gap={1}>
                  <Typography variant="body2" fontWeight={700}>
                    {t(toolNameLabelKey(record.toolName))} — {t(STATUS_LABEL_KEY[record.status])}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap", flexShrink: 0 }}>
                    {new Date(record.timestamp).toLocaleString()}
                  </Typography>
                </Stack>

                {(amountText || record.recipient) && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                    {[amountText, record.recipient ? `→ ${shortenAddress(record.recipient)}` : undefined]
                      .filter(Boolean)
                      .join("  ")}
                  </Typography>
                )}

                {record.reason && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block", fontStyle: "italic" }}>
                    {/* reasonKey (AgentPolicyEngine denial, see PolicyDecision's own docs) is the
                        user-facing, already-localized counterpart to `reason` — that field stays
                        English on purpose (model-facing). Older records / non-policy reasons
                        (e.g. an approve failure's outcome.message, or ConfirmationCard's own
                        account-changed reason, which is ALREADY translated at write time — see
                        ACCOUNT_CHANGED_REASON_KEY) have no reasonKey and fall back to `reason` as-is. */}
                    {record.reasonKey ? t(record.reasonKey, record.reasonParams) : record.reason}
                  </Typography>
                )}

                {record.status === "approved" && record.txHash && network && (
                  <Link
                    href={`${getExplorerBaseForNetwork(network)}/tx/${record.txHash}`}
                    target="_blank"
                    rel="noopener"
                    sx={{ fontSize: "0.7rem", display: "inline-flex", alignItems: "center", gap: 0.5, mt: 0.25 }}
                  >
                    {t("agent.confirmationCardViewExplorer")} <OpenInNew sx={{ fontSize: 12 }} />
                  </Link>
                )}
              </Box>
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}

export default AgentProposalHistoryPanel;
