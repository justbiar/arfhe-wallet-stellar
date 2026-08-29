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
 * current state right before acting rather than caching it. The preview itself, though, was
 * simulated against a specific account (originalAddressRef) — if the active account changes
 * while this card is still under review, it self-cancels rather than let a stale preview be
 * approved against a different account (see the effect + handleApprove's own check below).
 * NOTE: in practice pages/Agent.tsx now owns per-account chat history, so switching accounts
 * always swaps `conversationHistory` to the new account's own array in the same render this
 * card's tool_call_id came from — meaning this component gets unmounted, not re-rendered with
 * a new `activeAccount`, and Agent.tsx's own effect (using the same ACCOUNT_CHANGED_REASON_KEY) is
 * what actually performs the cancel. The effect below is kept as defense-in-depth for any path
 * where this component stays mounted across an account change.
 */

import * as React from "react";
import { Box, Typography, Button, Stack, Chip } from "@mui/material";
import { Cancel, CheckCircle, LockOutlined } from "@mui/icons-material";
import { useTranslation } from "react-i18next";
import { WalletContext } from "../AppContext.js";
import { useActiveAccount } from "../ActiveAccountProvider.js";
import { isDomainName, resolveDomain } from "../backend/DomainResolver.js";
import { toUserMessage } from "../backend/UserFacingError.js";
import TransactionResultCard, { type TransactionResultToolName } from "./TransactionResultCard.js";
import type { ProposalPreview } from "../backend/AgentToolRunner.js";
import { getUsdcTokenIdentity } from "../backend/AgentToolRunner.js";
import type { BalanceChange } from "../backend/TransactionSimulator.js";
import { fetchX402PaymentRequirement, settleX402Payment } from "../backend/X402ProxyClient.js";
import {
  signTransferWithAuthorization,
  generateAuthorizationNonce,
  type Eip3009Authorization,
} from "../backend/X402PaymentService.js";
import { X402SpendingLedger } from "../backend/X402SpendingLedger.js";
import { NetworkId } from "../backend/NetworkTypes.js";
import type { Network } from "../backend/Network.js";
import type { ShieldedHolding } from "../types/fhe.js";

/** Same instance shape as AgentToolRunner's own — both just read/write chrome.storage.local, no shared in-memory state needed. */
const spendingLedger = new X402SpendingLedger();

/**
 * Resolves a propose_shield ERC-20 `tokenSymbol` (the public underlying symbol, e.g. "DAI")
 * to its already-deployed wrapper, against an already-fetched shielded portfolio.
 *
 * Same curated symbol → address registry AgentToolRunner resolved this proposal against
 * (SwapService.getTokenBySymbol) — never TokenCache, see that method's docs. Returns null
 * for the native symbol or an unresolvable/undeployed token; callers already special-case
 * native shielding separately.
 */
async function findErc20ShieldHolding(
  network: Network,
  tokenSymbol: string,
  portfolio: ShieldedHolding[]
): Promise<{ address: string; decimals: number; wrapper: string } | null> {
  const { default: SwapService } = await import("../backend/SwapService.js");
  const erc20 = SwapService.getInstance().getTokenBySymbol(network.network_id, tokenSymbol);
  if (!erc20) return null;
  const holding = portfolio.find((h) => !h.isNative && h.underlying.toLowerCase() === erc20.address.toLowerCase());
  if (!holding) return null;
  return { address: erc20.address, decimals: erc20.decimals, wrapper: holding.wrapper };
}

/**
 * Resolves a propose_unshield `tokenSymbol` against an already-fetched shielded portfolio.
 *
 * The schema's primary namespace is the confidential wrapper's own symbol (e.g. "aeETH",
 * "aeDAI") — matched first. But nothing else in the wallet ever shows that name to a user, so
 * a request naming the PUBLIC underlying token instead ("ETH", "DAI" — what a person, or a
 * fast-path regex, actually types) is resolved the same way AgentToolRunner.prepareProposeUnshield
 * falls back: native by currency symbol, ERC-20 by SwapService's curated registry. Mirroring
 * that fallback here too matters, not just in the preview — this is what handleApprove and the
 * balance-display effects re-resolve against at confirm time, and a preview that succeeded on
 * the fallback must not fail to confirm because only half of this pair knew about it.
 */
async function findUnshieldHolding(
  network: Network,
  tokenSymbol: string,
  portfolio: ShieldedHolding[]
): Promise<ShieldedHolding | null> {
  const needle = tokenSymbol.toLowerCase();
  const direct = portfolio.find((h) => {
    if (h.symbol.toLowerCase() === needle) return true;
    if (h.isNative) return needle === network.currency_symbol.toLowerCase();
    return false;
  });
  if (direct) return direct;

  const { default: SwapService } = await import("../backend/SwapService.js");
  const erc20 = SwapService.getInstance().getTokenBySymbol(network.network_id, tokenSymbol);
  if (!erc20) return null;
  return portfolio.find((h) => !h.isNative && h.underlying.toLowerCase() === erc20.address.toLowerCase()) ?? null;
}

// ─── Public types ────────────────────────────────────────────────────

/** The terminal outcomes — what gets summarized back to the model and recorded in Agent Geçmişi. */
export type ConfirmationOutcome =
  | { status: "rejected"; toolName: string; reason?: string }
  | {
      status: "confirmed";
      toolName: string;
      originalArgs: Record<string, unknown>;
      txHash: string;
      newBalance?: { amount: string; symbol: string } | null;
    }
  | { status: "failed"; toolName: string; originalArgs: Record<string, unknown>; message: string };

/**
 * Every user-facing status this card can be in, terminal or not. `originalArgs` rides along on
 * every variant except "rejected" (which never needs a receipt — see AgentChatPanel's
 * "result" item) so the one place that persists these — AgentChatPanel — can rebuild a full
 * TransactionResultCard receipt purely from the status it was just handed, without having to
 * re-derive anything from this component (which has typically already unmounted by the time
 * that receipt renders — see onStatusChange's own docs for why).
 */
export type ConfirmationCardStatus =
  | ConfirmationOutcome
  | { status: "pending"; toolName: string; originalArgs: Record<string, unknown>; txHash?: string };

/**
 * i18n key for the "rejected" status's `reason` when the active account changed before approval
 * — see the auto-cancel effect below. Exported so pages/Agent.tsx's own account-switch handling
 * (which cancels a pending card for the OUTGOING account — this component will already have been
 * unmounted by then, so its own effect never gets a chance to run) translates the exact same
 * text, keeping Agent Geçmişi consistent regardless of which mechanism actually fired. A KEY
 * (translated at each call site via that caller's own `t`) rather than a fixed English string —
 * this reason is persisted verbatim into AgentProposalHistoryPanel's `record.reason` and rendered
 * there with no further translation step, so a raw English literal here used to leak untranslated
 * into "Agent Geçmişi" even when the UI language was Turkish.
 */
export const ACCOUNT_CHANGED_REASON_KEY = "agent.confirmationCardAccountChangedReason";

export interface ConfirmationCardProps {
  preview: ProposalPreview;
  /**
   * Fired every time this card's user-facing status changes: the instant approval starts
   * signing/broadcasting ("pending", no hash yet), as soon as a broadcast hash is known
   * ("pending" again, now with txHash — propose_send/propose_shield only), and exactly once at
   * the end ("confirmed"/"failed"/"rejected"). One callback for the whole lifecycle rather than
   * a separate one per transition, so there's exactly one place (AgentChatPanel's
   * handleCardStatusChange) that decides how to persist each status into conversationHistory —
   * new transitions can't be added to this component without also being wired into that single
   * switch, unlike with N separate callbacks where it's easy to add a transition and forget to
   * thread a new prop for it.
   */
  onStatusChange: (status: ConfirmationCardStatus) => void;
  /** Failed phase only: re-runs this same proposal (same toolName + originalArgs) from scratch. */
  onRetry?: (toolName: string, originalArgs: Record<string, unknown>) => void;
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
      return outcome.reason
        ? t("agent.confirmationCardOutcomeCancelled", { toolName: outcome.toolName, reason: outcome.reason })
        : t("agent.confirmationCardOutcomeRejected", { toolName: outcome.toolName });
    case "confirmed":
      return t("agent.confirmationCardOutcomeConfirmed", { toolName: outcome.toolName, txHash: outcome.txHash });
    case "failed":
      return t("agent.confirmationCardOutcomeFailed", { toolName: outcome.toolName, message: outcome.message });
  }
}

// ─── Display helpers ─────────────────────────────────────────────────

type CardPhase = "review" | "working" | "success" | "error" | "cancelled";

function primaryBalanceChange(changes: BalanceChange[]): BalanceChange | undefined {
  return changes.find((c) => c.type !== "FHE_ENCRYPTED") ?? changes[0];
}

function riskColor(risk: string): "success" | "info" | "warning" | "error" {
  if (risk === "CRITICAL") return "error";
  if (risk === "HIGH") return "warning";
  if (risk === "MEDIUM") return "info";
  return "success";
}

export default function ConfirmationCard({ preview, onStatusChange, onRetry }: ConfirmationCardProps) {
  const { t } = useTranslation();
  const wallet = React.useContext(WalletContext);
  const { activeAccount } = useActiveAccount();
  const network = wallet?.networkProvider.getActiveNetwork();

  const [cardPhase, setCardPhase] = React.useState<CardPhase>("review");
  const [workingLabel, setWorkingLabel] = React.useState("");
  const [txHash, setTxHash] = React.useState("");
  const [errorMessage, setErrorMessage] = React.useState("");
  const [beforeBalance, setBeforeBalance] = React.useState<number | null>(null);
  const [newBalance, setNewBalance] = React.useState<{ amount: string; symbol: string } | null>(null);
  const [resultTimestamp, setResultTimestamp] = React.useState<number | null>(null);

  const { toolName, originalArgs, simulation } = preview;

  // The account this card's preview (simulation, risk level, to/amount) was actually generated
  // against — fixed on mount, never re-derived. Compared below against the live activeAccount
  // so a mid-review account switch can't leave a stale preview approvable.
  const originalAddressRef = React.useRef(activeAccount?.GetAddress());

  // SECURITY: a proposal preview (simulation/risk/to/amount) is only valid for the account it
  // was generated against — AgentToolRunner simulated it there, not against whatever account
  // happens to be active later. If the user switches accounts while this card is still
  // reviewable, auto-cancel rather than let a stale preview be approved (and signed/broadcast)
  // against a different account. Only acts in "review" — once approval has started
  // (cardPhase !== "review"), the terminal onStatusChange has already fired and there's nothing
  // left to cancel.
  React.useEffect(() => {
    if (cardPhase !== "review") return;
    if (activeAccount?.GetAddress() === originalAddressRef.current) return;
    setCardPhase("cancelled");
    onStatusChange({ status: "rejected", toolName, reason: t(ACCOUNT_CHANGED_REASON_KEY) });
  }, [activeAccount, cardPhase, onStatusChange, toolName, t]);
  const change = primaryBalanceChange(simulation.balanceChanges);

  // propose_unshield's calldata never gets a balanceChange entry (TransactionSimulator's FHE
  // decoder only pushes a warning for "unwrap"), so amount/symbol come from originalArgs —
  // the same string AgentToolRunner already validated and simulated successfully with.
  const displayAmount =
    toolName === "propose_unshield" || !change || change.type === "FHE_ENCRYPTED"
      ? String(originalArgs.amount ?? "")
      : change.amountFormatted ?? String(originalArgs.amount ?? "");
  const displaySymbol =
    toolName === "propose_unshield" || toolName === "propose_shield"
      // propose_shield's calldata (native or ERC-20) never gets a balanceChange symbol
      // either — see buildErc20ShieldSimulation/decodeFheOperation's "wrap" case — so this
      // reads the same originalArgs.tokenSymbol the proposal was built from, same as unshield.
      ? String(originalArgs.tokenSymbol ?? network?.currency_symbol ?? "")
      : change?.symbol ?? network?.currency_symbol ?? "ETH";

  const summaryKey =
    toolName === "propose_shield"
      ? "agent.confirmationCardShieldSummary"
      : toolName === "propose_unshield"
      ? "agent.confirmationCardUnshieldSummary"
      : toolName === "pay_for_resource"
      ? "agent.confirmationCardX402Summary"
      : "agent.confirmationCardSendSummary";

  // ── Load the "before" balance so the remaining-after-this-action amount can be shown. ──
  // Skipped for pay_for_resource: it spends USDC, not the native/shielded asset this effect
  // knows how to fetch — showing "remaining ETH balance" under a USDC payment would be wrong,
  // not just unhelpful, so beforeBalance simply stays null and the row below never renders.
  React.useEffect(() => {
    let cancelled = false;
    const address = activeAccount?.GetAddress();
    if (!network || !address || toolName === "pay_for_resource") return;

    (async () => {
      try {
        if (toolName === "propose_unshield") {
          const tokenSymbol = String(originalArgs.tokenSymbol ?? "");
          const portfolio = await network.getShieldedPortfolio(activeAccount!);
          const holding = await findUnshieldHolding(network, tokenSymbol, portfolio);
          if (!cancelled) setBeforeBalance(holding ? Number(holding.balance) : null);
        } else if (
          toolName === "propose_shield" &&
          String(originalArgs.tokenSymbol ?? "").toLowerCase() !== network.currency_symbol.toLowerCase()
        ) {
          // ERC-20 shield: "remaining" is the underlying token's public balance, not ETH.
          const portfolio = await network.getShieldedPortfolio(activeAccount!);
          const erc20 = await findErc20ShieldHolding(network, String(originalArgs.tokenSymbol ?? ""), portfolio);
          const balanceStr = erc20 ? await network.getTokenBalance(erc20.address, address) : null;
          if (!cancelled) setBeforeBalance(balanceStr !== null ? Number(balanceStr) : null);
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

  /**
   * Refreshes the balance TransactionResultCard shows after a confirmed transaction — real
   * Network.ts data, read the same way beforeBalance above was. Never throws: an unavailable
   * network/account here just means the success state renders without a balance line. Returns
   * the balance (also mirrored into local `newBalance` state for this component's own render)
   * rather than only setting state, because handleApprove awaits this before calling
   * onStatusChange — see that call site for why: AgentChatPanel replaces this whole card with a
   * persistent receipt the instant the terminal status fires, so a value only reachable via a
   * *later* setState here would never make it into that receipt.
   */
  async function loadNewBalance(): Promise<{ amount: string; symbol: string } | null> {
    // Same reasoning as the beforeBalance effect above — this reads the native/shielded
    // balance, not USDC, so it would show the wrong asset for an x402 payment. The
    // informational "kalan bütçe" the auto-pay path shows instead (X402PaymentCard, a
    // different piece) is the metric that's actually meaningful here.
    if (!network || !activeAccount || toolName === "pay_for_resource") return null;
    try {
      if (toolName === "propose_unshield") {
        const tokenSymbol = String(originalArgs.tokenSymbol ?? "");
        const portfolio = await network.getShieldedPortfolio(activeAccount);
        const holding = await findUnshieldHolding(network, tokenSymbol, portfolio);
        if (!holding) return null;
        const balance = { amount: holding.balance, symbol: holding.symbol };
        setNewBalance(balance);
        return balance;
      } else if (
        toolName === "propose_shield" &&
        String(originalArgs.tokenSymbol ?? "").toLowerCase() !== network.currency_symbol.toLowerCase()
      ) {
        const tokenSymbol = String(originalArgs.tokenSymbol ?? "");
        const portfolio = await network.getShieldedPortfolio(activeAccount);
        const erc20 = await findErc20ShieldHolding(network, tokenSymbol, portfolio);
        if (!erc20) return null;
        const amount = await network.getTokenBalance(erc20.address, activeAccount.GetAddress());
        const balance = { amount, symbol: tokenSymbol };
        setNewBalance(balance);
        return balance;
      } else {
        const balanceWei = await network.getBalance(activeAccount.GetAddress());
        const { formatEther } = await import("ethers");
        const balance = { amount: formatEther(balanceWei), symbol: network.currency_symbol };
        setNewBalance(balance);
        return balance;
      }
    } catch {
      // Leave newBalance null — TransactionResultCard simply omits the line.
      return null;
    }
  }

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
    // Defense-in-depth alongside the account-change effect above: that effect only runs
    // between renders, so if the account switch and this click landed in the same commit
    // (a race the effect hasn't caught yet), this catches it before anything is ever signed.
    if (activeAccount?.GetAddress() !== originalAddressRef.current) {
      setCardPhase("cancelled");
      onStatusChange({ status: "rejected", toolName, reason: t(ACCOUNT_CHANGED_REASON_KEY) });
      return;
    }

    if (!wallet || !network || !activeAccount) {
      setErrorMessage(t("agent.confirmationCardNoWallet"));
      setCardPhase("error");
      return;
    }

    setCardPhase("working");
    setErrorMessage("");
    setWorkingLabel(t("agent.confirmationCardSigning"));
    setResultTimestamp(Date.now());
    onStatusChange({ status: "pending", toolName, originalArgs });

    try {
      let hash: string;

      switch (toolName) {
        case "propose_send": {
          const to = await resolveRecipient(String(originalArgs.to ?? ""));
          const amount = String(originalArgs.amount ?? "");
          hash = await network.sendTransaction(activeAccount, { to, value: amount }, (broadcastHash) => {
            setTxHash(broadcastHash);
            setWorkingLabel(t("agent.confirmationCardConfirming"));
            onStatusChange({ status: "pending", toolName, originalArgs, txHash: broadcastHash });
          });
          await network.waitForTransaction(hash);
          break;
        }

        case "propose_shield": {
          const amount = String(originalArgs.amount ?? "");
          const tokenSymbol = String(originalArgs.tokenSymbol ?? "");
          const isNativeShield = tokenSymbol.toLowerCase() === network.currency_symbol.toLowerCase();
          // Re-resolved live rather than trusted from the preview — the wrapper the preview
          // simulated against could have been superseded in the meantime.
          const portfolio = await network.getShieldedPortfolio(activeAccount);

          if (isNativeShield) {
            const nativeHolding = portfolio.find((h) => h.isNative);
            if (!nativeHolding) throw new Error(t("agent.confirmationCardWrapperMissing"));
            hash = await network.shieldNative(activeAccount, nativeHolding.wrapper, amount);
          } else {
            const erc20 = await findErc20ShieldHolding(network, tokenSymbol, portfolio);
            if (!erc20) throw new Error(t("agent.confirmationCardWrapperMissing"));
            // Network.shieldERC20 handles the approve step internally (and waits for it to
            // land) before shielding — see its docs — so this one call covers both legs.
            hash = await network.shieldERC20(activeAccount, erc20.address, erc20.wrapper, amount);
          }

          setTxHash(hash);
          setWorkingLabel(t("agent.confirmationCardConfirming"));
          onStatusChange({ status: "pending", toolName, originalArgs, txHash: hash });
          await network.waitForTransaction(hash);
          break;
        }

        case "propose_unshield": {
          const amount = String(originalArgs.amount ?? "");
          const tokenSymbol = String(originalArgs.tokenSymbol ?? "");
          const portfolio = await network.getShieldedPortfolio(activeAccount);
          const holding = await findUnshieldHolding(network, tokenSymbol, portfolio);
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

        case "pay_for_resource": {
          // Faz 3 only targets Base Sepolia — see AgentToolRunner's getUsdcTokenIdentity dep,
          // which the auto-pay path already checks; this is the same guard for the manual
          // (over-budget) approval path.
          if (Number(network.network_id) !== NetworkId.Base_Sepolia) {
            throw new Error(t("agent.confirmationCardX402UnsupportedNetwork"));
          }
          if (!activeAccount.ethers_wallet) {
            throw new Error(t("agent.confirmationCardNoWallet"));
          }

          const resource = String(originalArgs.resource ?? "");
          // Re-fetched live rather than trusted from the preview — same principle as
          // propose_shield's wrapper re-resolution above: the terms (amount/payTo) the preview
          // was built from could be stale by the time the user actually approves.
          const requirement = await fetchX402PaymentRequirement(resource);
          // Read from the same AgentToolRunner dep the auto-pay path uses (configured once in
          // AppContext.ts) rather than re-declaring the domain locally — a second, independently
          // maintained copy is exactly what let this domain drift out of sync before (name:
          // "USD Coin" vs "USDC"), which the token contract silently rejects as an invalid
          // signature rather than a helpful error.
          const tokenIdentity = getUsdcTokenIdentity(String(network.network_id));
          if (!tokenIdentity) {
            throw new Error(t("agent.confirmationCardX402UnsupportedNetwork"));
          }
          const authorization: Eip3009Authorization = {
            from: activeAccount.GetAddress()!,
            to: requirement.payTo,
            value: requirement.maxAmountRequired,
            validAfter: 0,
            validBefore: Math.floor(Date.now() / 1000) + requirement.maxTimeoutSeconds,
            nonce: generateAuthorizationNonce(),
          };

          const signed = await signTransferWithAuthorization(activeAccount.ethers_wallet, tokenIdentity, authorization);
          setWorkingLabel(t("agent.confirmationCardSettling"));
          const settlement = await settleX402Payment(resource, signed);
          hash = settlement.txHash;
          setTxHash(hash);

          await spendingLedger.recordPayment({
            id: settlement.txHash,
            accountAddress: activeAccount.GetAddress()!,
            amountUsd: Number(requirement.maxAmountRequired) / 1_000_000,
            timestamp: Date.now(),
            service: resource,
            txHash: settlement.txHash,
          });
          break;
        }

        default:
          throw new Error(`Unknown proposal tool: "${toolName}"`);
      }

      setCardPhase("success");
      // Awaited (unlike the old fire-and-forget) so the real balance is available in time for
      // onStatusChange — AgentChatPanel's persistent receipt is built entirely from that call's
      // argument, since this component unmounts the instant the terminal status fires (see
      // onStatusChange's own JSDoc). A failed balance refresh still never turns a confirmed
      // transaction into an error state — loadNewBalance never throws, it just resolves to null.
      const balanceAfter = await loadNewBalance();
      onStatusChange({ status: "confirmed", toolName, originalArgs, txHash: hash, newBalance: balanceAfter });
    } catch (err) {
      const message = toUserMessage(err, t);
      setErrorMessage(message);
      setCardPhase("error");
      onStatusChange({ status: "failed", toolName, originalArgs, message });
    }
  };

  const handleReject = () => {
    onStatusChange({ status: "rejected", toolName });
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

          {/* Resource/service, pay_for_resource only */}
          {toolName === "pay_for_resource" && (
            <Box>
              <Typography variant="caption" color="text.secondary">
                {t("agent.confirmationCardResource")}
              </Typography>
              <Typography variant="body2" sx={{ wordBreak: "break-all" }}>
                {String(originalArgs.resource ?? "")}
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

          {/* Working / success / error states — real Network.ts data only, see TransactionResultCard. */}
          {(cardPhase === "working" || cardPhase === "success" || cardPhase === "error") && (
            <TransactionResultCard
              phase={cardPhase === "working" ? "pending" : cardPhase === "success" ? "success" : "failed"}
              toolName={toolName as TransactionResultToolName}
              amount={displayAmount}
              symbol={displaySymbol}
              recipient={
                toolName === "propose_send"
                  ? String(originalArgs.to ?? "")
                  : toolName === "pay_for_resource"
                  ? change?.to
                  : undefined
              }
              txHash={txHash || undefined}
              errorMessage={errorMessage || undefined}
              newBalance={cardPhase === "success" ? newBalance : null}
              network={network}
              pendingLabel={workingLabel}
              timestamp={resultTimestamp ?? undefined}
              onRetry={onRetry ? () => onRetry(toolName, originalArgs) : undefined}
            />
          )}

          {cardPhase === "cancelled" && (
            <Stack direction="row" spacing={0.5} alignItems="flex-start">
              <Cancel sx={{ fontSize: 16, mt: 0.2, color: "text.disabled" }} />
              <Typography variant="caption" color="text.secondary">
                {t("agent.confirmationCardAccountChangedCancelled")}
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
