/**
 * X402PaymentCard — informational-only receipt for an AUTOMATIC x402 micro-payment (Faz 3).
 *
 * Rendered exactly once, for a `pay_for_resource` result that already carries `autoPaid: true`
 * (see AgentToolRunner.handlePayForResource / AgentPolicyEngine.evaluateX402Payment) — the
 * payment has ALREADY happened by the time this card exists. Unlike ConfirmationCard, there is
 * no Approve/Reject here and never will be: this component's whole reason for existing is the
 * "bütçe içindeyse onaysız öde" half of the x402 design (bkz. CONTEXT.md bölüm 14) — a card that
 * asked for confirmation here would contradict the design it renders.
 *
 * Same receipt visual language as TransactionResultCard (circle icon, title, date, thin divider,
 * label/value rows, shortened+linked tx hash) but deliberately a SEPARATE component, not a new
 * TransactionResultCard phase — this card shows "kalan bütçe" (the x402 daily budget), which has
 * nothing to do with TransactionResultCard's "kalan bakiye" (native/shielded wallet balance).
 * Conflating the two into one component would risk exactly the mix-up ConfirmationCard's own
 * pay_for_resource case deliberately avoids (see that file: it suppresses the balance row
 * entirely rather than show the wrong asset).
 */

import * as React from "react";
import { Box, Typography, Stack, Divider, Link } from "@mui/material";
import { Check, OpenInNew } from "@mui/icons-material";
import { useTranslation } from "react-i18next";
import { getExplorerBaseForNetwork } from "./panels/shared.js";
import { shortenHex } from "./TransactionResultCard.js";

export interface X402PaymentCardProps {
  /** What was paid for — a URL/identifier, shown verbatim (never a mechanical tool name — see internalLeakGuard.ts's rule). */
  resource: string;
  amountUsd: number;
  /** Budget remaining for the rest of the day AFTER this payment — see AgentPolicyEngine.evaluateX402Payment's remainingBudgetUsd. */
  remainingBudgetUsd: number;
  /** Settlement tx hash, once known — omitted entirely (no row) while absent, never shown raw/unshortened. */
  txHash?: string;
  /** Active network, for the Explorer link — same object TransactionResultCard/ConfirmationCard read from WalletContext. */
  network?: Parameters<typeof getExplorerBaseForNetwork>[0];
  /** When this payment was recorded — defaults to the moment the card first mounts. */
  timestamp?: number;
}

/** One label/value line of the receipt table — same shape as TransactionResultCard's own (not exported there, so kept in sync by hand). */
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

export default function X402PaymentCard({ resource, amountUsd, remainingBudgetUsd, txHash, network, timestamp }: X402PaymentCardProps) {
  const { t, i18n } = useTranslation();

  // Fixed at mount so the receipt's timestamp doesn't drift on re-render — same pattern as
  // TransactionResultCard.
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

  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, overflow: "hidden" }}>
      <Box sx={{ p: 1.5 }}>
        <Stack direction="row" spacing={1.25} alignItems="center">
          <Box
            sx={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              bgcolor: "success.main",
            }}
          >
            <Check sx={{ fontSize: 18, color: "success.contrastText" }} />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" fontWeight={700}>
              {t("agent.x402PaymentCardTitle")}
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
          <ResultRow
            label={t("agent.txResultAmountLabel")}
            value={
              <Typography variant="caption" fontWeight={700}>
                {amountUsd.toFixed(2)} USDC
              </Typography>
            }
          />

          <ResultRow label={t("agent.confirmationCardResource")} value={<Typography variant="caption" sx={{ wordBreak: "break-all" }}>{resource}</Typography>} />

          <ResultRow
            label={t("agent.x402PaymentCardRemainingBudgetLabel")}
            value={<Typography variant="caption">{remainingBudgetUsd.toFixed(2)} USDC</Typography>}
          />

          {txHash && (
            <ResultRow
              label={t("agent.txResultTxLabel")}
              value={
                network ? (
                  <Link
                    href={`${getExplorerBaseForNetwork(network)}/tx/${txHash}`}
                    target="_blank"
                    rel="noopener"
                    aria-label={t("agent.confirmationCardViewExplorer")}
                    sx={{ fontFamily: "monospace", fontSize: "0.75rem", display: "inline-flex", alignItems: "center", gap: 0.4 }}
                  >
                    {shortenHex(txHash)} <OpenInNew sx={{ fontSize: 12 }} />
                  </Link>
                ) : (
                  <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
                    {shortenHex(txHash)}
                  </Typography>
                )
              }
            />
          )}
        </Stack>
      </Box>
    </Box>
  );
}
