/**
 * TransactionResultCard — renders what actually happened to an approved proposal, receipt-style.
 *
 * SECURITY / TRUST: every value shown here (phase, txHash, errorMessage, newBalance, amount,
 * recipient) is passed in as a prop by ConfirmationCard, computed from real Network.ts calls
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
import { Box, Typography, Stack, CircularProgress, Link, Divider, Button } from "@mui/material";
import { Check, Close, OpenInNew, ContentCopy } from "@mui/icons-material";
import { useTranslation } from "react-i18next";
import { getExplorerBaseForNetwork } from "./panels/shared.js";

export type TransactionResultPhase = "pending" | "success" | "failed";

/** The proposal tools this card can render a receipt for — mirrors AgentToolRunner's PROPOSAL_TOOLS. */
export type TransactionResultToolName = "propose_send" | "propose_shield" | "propose_unshield" | "pay_for_resource";

export interface TransactionResultCardProps {
  phase: TransactionResultPhase;
  /** Which proposal tool this receipt is for — drives the title wording ("Transfer"/"Shield"/"Unshield"). */
  toolName?: TransactionResultToolName;
  /** Real broadcast tx hash — set as soon as it's known, i.e. before "success" too. */
  txHash?: string;
  /** Set only when phase is "failed" — already a user-facing message (see UserFacingError.ts), never raw. */
  errorMessage?: string;
  /** Set only when phase is "success" and the post-confirmation balance fetch succeeded. */
  newBalance?: { amount: string; symbol: string } | null;
  /** Amount being sent/shielded/unshielded, formatted for display. */
  amount?: string;
  /** Token symbol for `amount`. */
  symbol?: string;
  /** Recipient address — only meaningful for propose_send (shield/unshield move funds within the same account). */
  recipient?: string;
  /**
   * Optional finer-grained sub-status for the "pending" phase (e.g. "Waiting for signature...",
   * "Burning shielded balance...") — shown as an extra row above the others when present.
   */
  pendingLabel?: string;
  /** Active network, for the Explorer link — same object ConfirmationCard already reads from WalletContext. */
  network?: Parameters<typeof getExplorerBaseForNetwork>[0];
  /** When this outcome was recorded — defaults to the moment the card first mounts. */
  timestamp?: number;
  /** Failed phase only: re-runs the same proposal (same args) without the user retyping anything. */
  onRetry?: () => void;
}

/** "0x1234...5678" — never shows a full address/hash inline; the full value is one click away. */
export function shortenHex(value: string, front = 6, back = 4): string {
  if (!value) return value;
  if (value.length <= front + back + 3) return value;
  return `${value.slice(0, front)}...${value.slice(-back)}`;
}

function toolNoun(toolName: TransactionResultToolName | undefined, t: (key: string) => string): string {
  switch (toolName) {
    case "propose_shield":
      return t("agent.txResultActionShield");
    case "propose_unshield":
      return t("agent.txResultActionUnshield");
    case "pay_for_resource":
      return t("agent.txResultActionX402");
    case "propose_send":
    default:
      return t("agent.txResultActionSend");
  }
}

function StatusIcon({ phase }: { phase: TransactionResultPhase }) {
  const size = 32;
  const baseSx = {
    width: size,
    height: size,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };

  if (phase === "pending") {
    return (
      <Box sx={{ ...baseSx, border: "2px solid", borderColor: "primary.main" }}>
        <CircularProgress size={14} thickness={6} sx={{ color: "primary.main" }} />
      </Box>
    );
  }
  if (phase === "success") {
    return (
      <Box sx={{ ...baseSx, bgcolor: "success.main" }}>
        <Check sx={{ fontSize: 18, color: "success.contrastText" }} />
      </Box>
    );
  }
  return (
    <Box sx={{ ...baseSx, bgcolor: "error.main" }}>
      <Close sx={{ fontSize: 18, color: "error.contrastText" }} />
    </Box>
  );
}

/** One label/value line of the receipt table — label muted on the left, value on the right. */
function ResultRow({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
        {label}
      </Typography>
      <Box sx={{ minWidth: 0, textAlign: "right" }}>{value}</Box>
    </Stack>
  );
}

/** A shortened address that copies its full value to the clipboard on click. */
function AddressValue({ address }: { address: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = React.useState(false);

  const handleCopy = () => {
    void navigator.clipboard?.writeText(address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <Stack
      direction="row"
      spacing={0.5}
      alignItems="center"
      justifyContent="flex-end"
      onClick={handleCopy}
      role="button"
      aria-label={t("agent.txResultCopyAddress")}
      sx={{ cursor: "pointer" }}
    >
      <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
        {copied ? t("agent.txResultCopied") : shortenHex(address)}
      </Typography>
      {!copied && <ContentCopy sx={{ fontSize: 12, color: "text.secondary" }} />}
    </Stack>
  );
}

/** A shortened tx hash, linking out to the block explorer for the active network. */
function TxHashValue({ txHash, network }: { txHash: string; network?: TransactionResultCardProps["network"] }) {
  const { t } = useTranslation();
  if (!network) {
    return (
      <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
        {shortenHex(txHash)}
      </Typography>
    );
  }
  return (
    <Link
      href={`${getExplorerBaseForNetwork(network)}/tx/${txHash}`}
      target="_blank"
      rel="noopener"
      aria-label={t("agent.confirmationCardViewExplorer")}
      sx={{ fontFamily: "monospace", fontSize: "0.75rem", display: "inline-flex", alignItems: "center", gap: 0.4 }}
    >
      {shortenHex(txHash)} <OpenInNew sx={{ fontSize: 12 }} />
    </Link>
  );
}

export default function TransactionResultCard({
  phase,
  toolName,
  txHash,
  errorMessage,
  newBalance,
  amount,
  symbol,
  recipient,
  network,
  pendingLabel,
  timestamp,
  onRetry,
}: TransactionResultCardProps) {
  const { t, i18n } = useTranslation();

  // Fixed at mount so the receipt's timestamp doesn't drift on re-render.
  const [mountedAt] = React.useState(() => timestamp ?? Date.now());
  const formattedTime = React.useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(timestamp ?? mountedAt)),
    [timestamp, mountedAt, i18n.language]
  );

  const action = toolNoun(toolName, t);
  const title =
    phase === "pending"
      ? t("agent.txResultPendingTitle", { action })
      : phase === "success"
      ? t("agent.txResultSuccessTitle", { action })
      : t("agent.txResultFailedTitle", { action });

  const amountValue =
    amount !== undefined && symbol !== undefined ? (
      <Typography variant="caption" fontWeight={700}>
        {amount} {symbol}
      </Typography>
    ) : null;

  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, overflow: "hidden" }}>
      <Box sx={{ p: 1.5 }}>
        <Stack direction="row" spacing={1.25} alignItems="center">
          <StatusIcon phase={phase} />
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" fontWeight={700}>
              {title}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {formattedTime}
            </Typography>
          </Box>
        </Stack>
      </Box>

      <Divider />

      <Box sx={{ p: 1.5 }}>
        <Stack spacing={1}>
          {phase === "pending" && pendingLabel && <ResultRow label={t("agent.txResultStatusLabel")} value={<Typography variant="caption">{pendingLabel}</Typography>} />}

          {amountValue && <ResultRow label={t("agent.txResultAmountLabel")} value={amountValue} />}

          {recipient && phase !== "failed" && (
            <ResultRow label={t("agent.txResultRecipientLabel")} value={<AddressValue address={recipient} />} />
          )}

          {phase === "success" && newBalance && (
            <ResultRow
              label={t("agent.txResultRemainingBalanceLabel")}
              value={<Typography variant="caption">{newBalance.amount} {newBalance.symbol}</Typography>}
            />
          )}

          {(phase === "pending" || phase === "success") && txHash && (
            <ResultRow label={t("agent.txResultTxLabel")} value={<TxHashValue txHash={txHash} network={network} />} />
          )}

          {phase === "failed" && (
            <>
              <Typography variant="caption" color="error.main">
                {errorMessage}
              </Typography>
              <Button size="small" variant="outlined" fullWidth onClick={onRetry} disabled={!onRetry}>
                {t("agent.txResultRetry")}
              </Button>
            </>
          )}
        </Stack>
      </Box>
    </Box>
  );
}
