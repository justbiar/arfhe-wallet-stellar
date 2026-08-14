/**
 * TransactionResultCard — renders what actually happened to an approved proposal.
 *
 * SECURITY / TRUST: every value shown here (phase, txHash, errorMessage, newBalance) is
 * passed in as a prop by ConfirmationCard, computed from real Network.ts calls
 * (sendTransaction/shieldNative/unshieldAndClaim, waitForTransaction, getBalance/
 * getShieldedPortfolio) — never from the model. This component has no access to
 * conversationHistory or any model output; it cannot render a hallucinated outcome because
 * it never receives one. See the bug this fixes: a free-tier model narrating "transaction
 * submitted, hash: 0x..." as plain assistant text with a fabricated hash, before the user
 * had even approved anything (AgentOrchestrator.ts's tool-loop break + system prompt now
 * stop that at the source — this component is the second layer: even the real completion
 * text is code-rendered, never model-authored).
 */

import * as React from "react";
import { Box, Typography, Stack, CircularProgress, Link } from "@mui/material";
import { CheckCircle, ErrorOutline, OpenInNew } from "@mui/icons-material";
import { useTranslation } from "react-i18next";
import { getExplorerBaseForNetwork } from "./panels/shared.js";

export type TransactionResultPhase = "pending" | "success" | "failed";

export interface TransactionResultCardProps {
  phase: TransactionResultPhase;
  /** Real broadcast tx hash — set as soon as it's known, i.e. before "success" too. */
  txHash?: string;
  /** Set only when phase is "failed". */
  errorMessage?: string;
  /** Set only when phase is "success" and the post-confirmation balance fetch succeeded. */
  newBalance?: { amount: string; symbol: string } | null;
  /**
   * Optional finer-grained label for the "pending" phase (e.g. "Waiting for signature...",
   * "Burning shielded balance...") — falls back to a generic "submitted, waiting for
   * confirmation" message when omitted.
   */
  pendingLabel?: string;
  /** Active network, for the Explorer link — same object ConfirmationCard already reads from WalletContext. */
  network?: Parameters<typeof getExplorerBaseForNetwork>[0];
}

export default function TransactionResultCard({
  phase,
  txHash,
  errorMessage,
  newBalance,
  network,
  pendingLabel,
}: TransactionResultCardProps) {
  const { t } = useTranslation();

  const explorerLink =
    txHash && network ? (
      <Link
        href={`${getExplorerBaseForNetwork(network)}/tx/${txHash}`}
        target="_blank"
        rel="noopener"
        sx={{ fontSize: "0.7rem", display: "inline-flex", alignItems: "center", gap: 0.5 }}
      >
        {t("agent.confirmationCardViewExplorer")} <OpenInNew sx={{ fontSize: 12 }} />
      </Link>
    ) : null;

  if (phase === "pending") {
    return (
      <Stack spacing={0.5}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <CircularProgress size={14} />
          <Typography variant="caption">{pendingLabel || t("agent.txResultPendingTitle")}</Typography>
        </Stack>
        {explorerLink}
      </Stack>
    );
  }

  if (phase === "success") {
    return (
      <Stack spacing={0.5}>
        <Stack direction="row" alignItems="center" spacing={0.5}>
          <CheckCircle color="success" sx={{ fontSize: 16 }} />
          <Typography variant="caption" fontWeight={700} color="success.main">
            {t("agent.confirmationCardSuccessTitle")}
          </Typography>
        </Stack>
        {explorerLink}
        {newBalance && (
          <Typography variant="caption" color="text.secondary">
            {t("agent.txResultNewBalance", { amount: newBalance.amount, symbol: newBalance.symbol })}
          </Typography>
        )}
      </Stack>
    );
  }

  return (
    <Stack spacing={0.25}>
      <Stack direction="row" spacing={0.5} alignItems="flex-start">
        <ErrorOutline color="error" sx={{ fontSize: 16, mt: 0.2 }} />
        <Box>
          <Typography variant="caption" fontWeight={700} color="error.main" sx={{ display: "block" }}>
            {t("agent.txResultFailedTitle")}
          </Typography>
          <Typography variant="caption" color="error.main">
            {errorMessage}
          </Typography>
        </Box>
      </Stack>
      <Typography variant="caption" color="text.secondary">
        {t("agent.txResultRetrySuggestion")}
      </Typography>
    </Stack>
  );
}
