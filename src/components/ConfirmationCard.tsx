/**
 * ConfirmationCard — the confirmation UI for a PROPOSAL_TOOLS preview
 * (`AgentToolRunner.executeToolCall`'s `{ requiresConfirmation: true, toolName, originalArgs,
 * simulation }` result).
 *
 * SECURITY: This is the ONLY place in the agent pipeline that signs or broadcasts anything.
 * Neither AgentToolRunner.ts nor AgentOrchestrator.ts ever touch `Account.ethers_wallet` or
 * call `Network.sendTransaction`/`shieldNative`/`unshieldAndClaim` — they only ever produce a
 * preview. Approving here calls the exact same real Network.ts functions SendPanel.tsx and
 * ShieldPanel.tsx call for a manually-typed transaction, in the exact same order (simulate
 * already happened upstream; this step is simulate-approved → sign → wait), so a proposal
 * that came from the agent is never less scrutinized than one typed by hand. Nothing here
 * re-derives a shortcut path — wrapper/recipient addresses are re-resolved live at approval
 * time (not trusted from the frozen preview), the same way SendPanel/ShieldPanel always read
 * current state right before acting rather than caching it.
 */

import * as React from "react";
import { Box, Typography, Button, Stack, Chip, CircularProgress, Link } from "@mui/material";
import { CheckCircle, Cancel, ErrorOutline, OpenInNew, LockOutlined } from "@mui/icons-material";
import { useTranslation } from "react-i18next";
import { WalletContext } from "../AppContext.js";
import { useActiveAccount } from "../ActiveAccountProvider.js";
import { isDomainName, resolveDomain } from "../backend/DomainResolver.js";
import { toUserMessage } from "../backend/UserFacingError.js";
import { getExplorerBaseForNetwork } from "./panels/shared.js";
import type { ProposalPreview } from "../backend/AgentToolRunner.js";
import type { BalanceChange } from "../backend/TransactionSimulator.js";

// ─── Public types ────────────────────────────────────────────────────

export type ConfirmationOutcome =
  | { status: "rejected"; toolName: string }
  | { status: "confirmed"; toolName: string; txHash: string }
  | { status: "failed"; toolName: string; message: string };

export interface ConfirmationCardProps {
  preview: ProposalPreview;
  /** Called exactly once, when the user has rejected, or the real transaction has settled (success or failure). */
  onResolved: (outcome: ConfirmationOutcome) => void;
}

/**
 * Turns a resolved outcome into a ready-to-append conversation message, so the agent's next
 * turn knows what happened. Callers own actually appending this to conversationHistory (as a
 * role:"tool" message matching the original tool_call_id) — this only builds the text.
 */
export function buildConfirmationOutcomeSummary(
  outcome: ConfirmationOutcome,
  t: (key: string, params?: Record<string, string>) => string
): string {
  switch (outcome.status) {
    case "rejected":
      return t("agent.confirmationCardOutcomeRejected", { toolName: outcome.toolName });
    case "confirmed":
      return t("agent.confirmationCardOutcomeConfirmed", { toolName: outcome.toolName, txHash: outcome.txHash });
    case "failed":
      return t("agent.confirmationCardOutcomeFailed", { toolName: outcome.toolName, message: outcome.message });
  }
}

// ─── Display helpers ─────────────────────────────────────────────────

type CardPhase = "review" | "working" | "success" | "error";

function primaryBalanceChange(changes: BalanceChange[]): BalanceChange | undefined {
  return changes.find((c) => c.type !== "FHE_ENCRYPTED") ?? changes[0];
}

function riskColor(risk: string): "success" | "info" | "warning" | "error" {
  if (risk === "CRITICAL") return "error";
  if (risk === "HIGH") return "warning";
  if (risk === "MEDIUM") return "info";
  return "success";
}

export default function ConfirmationCard({ preview, onResolved }: ConfirmationCardProps) {
  const { t } = useTranslation();
  const wallet = React.useContext(WalletContext);
  const { activeAccount } = useActiveAccount();
  const network = wallet?.networkProvider.getActiveNetwork();

  const [cardPhase, setCardPhase] = React.useState<CardPhase>("review");
  const [workingLabel, setWorkingLabel] = React.useState("");
  const [txHash, setTxHash] = React.useState("");
  const [errorMessage, setErrorMessage] = React.useState("");
  const [beforeBalance, setBeforeBalance] = React.useState<number | null>(null);

  const { toolName, originalArgs, simulation } = preview;
  const change = primaryBalanceChange(simulation.balanceChanges);

  // propose_unshield's calldata never gets a balanceChange entry (TransactionSimulator's FHE
  // decoder only pushes a warning for "unwrap"), so amount/symbol come from originalArgs —
  // the same string AgentToolRunner already validated and simulated successfully with.
  const displayAmount =
    toolName === "propose_unshield" || !change || change.type === "FHE_ENCRYPTED"
      ? String(originalArgs.amount ?? "")
      : change.amountFormatted ?? String(originalArgs.amount ?? "");
  const displaySymbol =
    toolName === "propose_unshield"
      ? String(originalArgs.tokenSymbol ?? "")
      : change?.symbol ?? network?.currency_symbol ?? "ETH";

  const summaryKey =
    toolName === "propose_shield"
      ? "agent.confirmationCardShieldSummary"
      : toolName === "propose_unshield"
      ? "agent.confirmationCardUnshieldSummary"
      : "agent.confirmationCardSendSummary";

  // ── Load the "before" balance so the remaining-after-this-action amount can be shown. ──
  React.useEffect(() => {
    let cancelled = false;
    const address = activeAccount?.GetAddress();
    if (!network || !address) return;

    (async () => {
      try {
        if (toolName === "propose_unshield") {
          const tokenSymbol = String(originalArgs.tokenSymbol ?? "").toLowerCase();
          const portfolio = await network.getShieldedPortfolio(activeAccount!);
          const holding = portfolio.find((h) => h.symbol.toLowerCase() === tokenSymbol);
          if (!cancelled) setBeforeBalance(holding ? Number(holding.balance) : null);
        } else {
          const balanceWei = await network.getBalance(address);
          const { formatEther } = await import("ethers");
          if (!cancelled) setBeforeBalance(Number(formatEther(balanceWei)));
        }
      } catch {
        if (!cancelled) setBeforeBalance(null);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- preview identity changes per confirmation card instance
  }, [network, activeAccount, toolName]);

  const remaining =
    beforeBalance !== null && Number.isFinite(Number(displayAmount))
      ? Math.max(0, beforeBalance - Number(displayAmount))
      : null;

  // ── Approve: the only place that ever signs/broadcasts. ──────────────
  async function resolveRecipient(rawTo: string): Promise<string> {
    const trimmed = rawTo.trim();
    if (!isDomainName(trimmed)) return trimmed;
    const resolved = await resolveDomain(trimmed);
    if (!resolved.address) {
      throw new Error(resolved.error ?? t("agent.confirmationCardDomainUnresolved", { domain: trimmed }));
    }
    return resolved.address;
  }

  const handleApprove = async () => {
    if (!wallet || !network || !activeAccount) {
      setErrorMessage(t("agent.confirmationCardNoWallet"));
      setCardPhase("error");
      return;
    }

    setCardPhase("working");
    setErrorMessage("");
    setWorkingLabel(t("agent.confirmationCardSigning"));

    try {
      let hash: string;

      switch (toolName) {
        case "propose_send": {
          const to = await resolveRecipient(String(originalArgs.to ?? ""));
          const amount = String(originalArgs.amount ?? "");
          hash = await network.sendTransaction(activeAccount, { to, value: amount }, (broadcastHash) => {
            setTxHash(broadcastHash);
            setWorkingLabel(t("agent.confirmationCardConfirming"));
          });
          await network.waitForTransaction(hash);
          break;
        }

        case "propose_shield": {
          const amount = String(originalArgs.amount ?? "");
          // Re-resolved live rather than trusted from the preview — the wrapper the preview
          // simulated against could have been superseded in the meantime.
          const portfolio = await network.getShieldedPortfolio(activeAccount);
          const nativeHolding = portfolio.find((h) => h.isNative);
          if (!nativeHolding) throw new Error(t("agent.confirmationCardWrapperMissing"));

          hash = await network.shieldNative(activeAccount, nativeHolding.wrapper, amount);
          setTxHash(hash);
          setWorkingLabel(t("agent.confirmationCardConfirming"));
          await network.waitForTransaction(hash);
          break;
        }

        case "propose_unshield": {
          const amount = String(originalArgs.amount ?? "");
          const tokenSymbol = String(originalArgs.tokenSymbol ?? "");
          const portfolio = await network.getShieldedPortfolio(activeAccount);
          const holding = portfolio.find((h) => h.symbol.toLowerCase() === tokenSymbol.toLowerCase());
          if (!holding) throw new Error(t("agent.confirmationCardTokenMissing", { symbol: tokenSymbol }));

          // unshieldAndClaim waits out burn + decrypt + claim itself — no extra
          // waitForTransaction here, same as ShieldPanel's own unshield branch.
          hash = await network.unshieldAndClaim(
            activeAccount,
            holding.wrapper,
            amount,
            wallet.pendingClaimQueue,
            holding.symbol,
            (phase) => {
              if (phase === "burning") setWorkingLabel(t("agent.confirmationCardBurning"));
              if (phase === "confirming") setWorkingLabel(t("agent.confirmationCardConfirming"));
              if (phase === "decrypting") setWorkingLabel(t("agent.confirmationCardDecrypting"));
              if (phase === "claiming") setWorkingLabel(t("agent.confirmationCardClaiming"));
            }
          );
          setTxHash(hash);
          break;
        }

        default:
          throw new Error(`Unknown proposal tool: "${toolName}"`);
      }

      setCardPhase("success");
      onResolved({ status: "confirmed", toolName, txHash: hash });
    } catch (err) {
      const message = toUserMessage(err, t);
      setErrorMessage(message);
      setCardPhase("error");
      onResolved({ status: "failed", toolName, message });
    }
  };

  const handleReject = () => {
    onResolved({ status: "rejected", toolName });
  };

  const isWorking = cardPhase === "working";
  const risk = simulation.riskLevel;
  const blocked = risk === "CRITICAL";

  return (
    <Box
      sx={{
        border: "1px solid",
        borderColor: `${riskColor(risk)}.main`,
        borderRadius: 1,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <Box sx={{ px: 1.5, py: 1, borderBottom: "1px solid", borderColor: "divider", bgcolor: "action.hover" }}>
        <Typography variant="caption" sx={{ fontFamily: "var(--font-mono)", textTransform: "uppercase", fontWeight: 700 }}>
          {t("agent.confirmationCardTitle")}
        </Typography>
      </Box>

      <Box sx={{ p: 1.5 }}>
        <Stack spacing={1.25}>
          {/* Risk chip */}
          <Chip
            size="small"
            color={riskColor(risk)}
            label={t(`agent.confirmationCardRisk${risk.charAt(0)}${risk.slice(1).toLowerCase()}`)}
            sx={{ alignSelf: "flex-start", fontWeight: 700, fontSize: "0.65rem" }}
          />

          {/* Primary summary: "X ETH gönderilecek" etc. */}
          <Typography variant="body2" fontWeight={700}>
            {t(summaryKey, { amount: displayAmount, symbol: displaySymbol })}
          </Typography>

          {/* Recipient, propose_send only */}
          {toolName === "propose_send" && (
            <Box>
              <Typography variant="caption" color="text.secondary">
                {t("agent.confirmationCardRecipient")}
              </Typography>
              <Typography variant="body2" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                {String(originalArgs.to ?? "")}
              </Typography>
            </Box>
          )}

          {/* Remaining balance */}
          {remaining !== null && (
            <Typography variant="caption" color="text.secondary">
              {t("agent.confirmationCardRemainingBalance", { amount: remaining.toString(), symbol: displaySymbol })}
            </Typography>
          )}

          {/* propose_shield: static rate-truncation note — TransactionSimulator has no way
              to compute this from an eth_call, so it's domain knowledge, not simulated data. */}
          {toolName === "propose_shield" && (
            <Box sx={{ p: 1, borderRadius: 1, bgcolor: "action.hover" }}>
              <Typography variant="caption" color="text.secondary">
                {t("agent.confirmationCardRateTruncationWarning")}
              </Typography>
            </Box>
          )}

          {/* propose_unshield: two-step process note */}
          {toolName === "propose_unshield" && (
            <Box sx={{ p: 1, borderRadius: 1, bgcolor: "action.hover" }}>
              <Stack direction="row" spacing={0.5} alignItems="flex-start">
                <LockOutlined sx={{ fontSize: 14, mt: 0.2 }} />
                <Typography variant="caption" color="text.secondary">
                  {t("agent.confirmationCardTwoStepUnshieldNote")}
                </Typography>
              </Stack>
            </Box>
          )}

          {/* Simulation warnings, generic */}
          {simulation.warnings.length > 0 && (
            <Stack spacing={0.25}>
              {simulation.warnings.map((w, i) => (
                <Typography key={i} variant="caption" color="text.secondary" sx={{ display: "block" }}>
                  {w}
                </Typography>
              ))}
            </Stack>
          )}

          {/* Working / success / error states */}
          {cardPhase === "working" && (
            <Stack direction="row" alignItems="center" spacing={1}>
              <CircularProgress size={14} />
              <Typography variant="caption">{workingLabel}</Typography>
            </Stack>
          )}

          {cardPhase === "success" && (
            <Stack spacing={0.5}>
              <Stack direction="row" alignItems="center" spacing={0.5}>
                <CheckCircle color="success" sx={{ fontSize: 16 }} />
                <Typography variant="caption" fontWeight={700} color="success.main">
                  {t("agent.confirmationCardSuccessTitle")}
                </Typography>
              </Stack>
              {txHash && network && (
                <Link
                  href={`${getExplorerBaseForNetwork(network)}/tx/${txHash}`}
                  target="_blank"
                  rel="noopener"
                  sx={{ fontSize: "0.7rem", display: "inline-flex", alignItems: "center", gap: 0.5 }}
                >
                  {t("agent.confirmationCardViewExplorer")} <OpenInNew sx={{ fontSize: 12 }} />
                </Link>
              )}
            </Stack>
          )}

          {cardPhase === "error" && (
            <Stack direction="row" spacing={0.5} alignItems="flex-start">
              <ErrorOutline color="error" sx={{ fontSize: 16, mt: 0.2 }} />
              <Typography variant="caption" color="error.main">
                {errorMessage}
              </Typography>
            </Stack>
          )}

          {/* Actions */}
          {cardPhase === "review" && (
            <Stack direction="row" spacing={1}>
              <Button
                size="small"
                variant="outlined"
                color="inherit"
                startIcon={<Cancel fontSize="small" />}
                onClick={handleReject}
                fullWidth
              >
                {t("agent.confirmationCardReject")}
              </Button>
              <Button
                size="small"
                variant="contained"
                color={blocked ? "error" : risk === "HIGH" ? "warning" : "primary"}
                startIcon={<CheckCircle fontSize="small" />}
                onClick={handleApprove}
                disabled={blocked || isWorking}
                fullWidth
              >
                {blocked ? t("agent.confirmationCardRiskCritical") : t("agent.confirmationCardApprove")}
              </Button>
            </Stack>
          )}
        </Stack>
      </Box>
    </Box>
  );
}
