/**
 * Privacy — the confidential side of the wallet, on one screen.
 *
 * Shielding used to live inside the Send drawer, two taps deep and with no way to see what
 * was already shielded: the only view of a confidential balance was the unshield dropdown,
 * which is a picker, not a statement of holdings. That made the wallet's whole point the
 * hardest thing in it to find.
 *
 * Everything confidential is here instead — what is shielded, what is still owed from an
 * interrupted unshield, and the shield/unshield form itself.
 *
 * Balances shown here are decrypted locally. Reaching them costs a signed permit and a
 * round-trip to the threshold network, which is why the list renders from the cache Home
 * already filled and refreshes behind it, rather than blocking on a spinner.
 */

import React, { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  IconButton,
  Link,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  ArrowBack,
  ExpandLess,
  ExpandMore,
  HelpOutline,
  LockOpen,
  OpenInNew,
  Refresh,
  Send as SendIcon,
  Shield,
  Visibility,
  VisibilityOff,
} from "@mui/icons-material";

import { WalletContext } from "../AppContext.js";
import HuntMark from '../components/HuntMark';
import { ActiveAccountContext } from "../ActiveAccountProvider.js";
import ShieldPanel, { type ShieldFocusRequest } from "../components/panels/ShieldPanel.js";
import { getExplorerBaseForNetwork } from "../components/panels/shared.js";
import { isFheNetwork, NetworkId } from "../backend/NetworkTypes.js";
import { toUserMessage } from "../backend/UserFacingError.js";
import { onTxConfirmed } from "../backend/TxNotifier.js";
import { TokenListSkeleton } from "../components/SkeletonLoaders.js";
import type { ShieldedHolding } from "../types/fhe.js";
import type { PendingClaimIntent } from "../backend/PendingClaimQueue.js";

/** A shielded holding plus the USD figure the cache knows for it. */
interface PricedHolding extends ShieldedHolding {
  priceUsd: number;
  valueUsd: number;
}

const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

export default function Privacy() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const wallet = useContext(WalletContext);
  const activeContext = useContext(ActiveAccountContext);

  const network = wallet?.networkProvider?.getActiveNetwork();
  const networkId = wallet?.networkProvider?.getActiveNetworkId() ?? NetworkId.Unknown;
  const account = activeContext?.activeAccount;
  const address = account?.GetAddress() ?? "";
  const fheAvailable = isFheNetwork(networkId);

  const [holdings, setHoldings] = useState<PricedHolding[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [hidden, setHidden] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [claims, setClaims] = useState<PendingClaimIntent[]>([]);
  const [claiming, setClaiming] = useState(false);
  const [claimMsg, setClaimMsg] = useState("");

  /** Bumped to tell the embedded form which token the user tapped. */
  const [focus, setFocus] = useState<ShieldFocusRequest | undefined>();
  const focusSeq = React.useRef(0);

  // ── Pricing ─────────────────────────────────────────────────────
  //
  // A wrapper is worth exactly what it holds, so it is priced through its underlying.
  // Home already worked this out and stored the result per wrapper address; recomputing it
  // here would mean a second price fetch for numbers the wallet is holding.
  const priceFor = useCallback(
    (wrapper: string): number => {
      const cached = address ? wallet?.dataCacheService?.getAllowStale(address, networkId) : null;
      const row = cached?.data?.balances?.[wrapper.toLowerCase()] as { priceUsd?: number } | undefined;
      return row?.priceUsd ?? 0;
    },
    [address, networkId, wallet?.dataCacheService]
  );

  // ── Load ────────────────────────────────────────────────────────
  const load = useCallback(
    async (isRefresh = false) => {
      if (!network || !account || !fheAvailable) {
        setHoldings([]);
        setLoading(false);
        return;
      }
      if (isRefresh) setRefreshing(true);
      setLoadError("");

      try {
        const list = await network.getShieldedPortfolio(account);
        setHoldings(
          list
            // A wrapper the account once used but has since emptied is not a holding —
            // but one we merely failed to decrypt still is. The on-chain ciphertext is
            // proof the balance exists; hiding the row would lose the asset.
            .filter((h) => parseFloat(h.balance) > 0 || h.decryptFailed)
            .map((h) => {
              const priceUsd = priceFor(h.wrapper);
              return { ...h, priceUsd, valueUsd: parseFloat(h.balance) * priceUsd };
            })
            .sort((a, b) => b.valueUsd - a.valueUsd)
        );
      } catch (e) {
        // Keep whatever is already on screen. A failed refresh must not blank a list the
        // user is reading — decrypted balances are expensive to get back.
        setLoadError(toUserMessage(e, t));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [network, account, fheAvailable, priceFor, t]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // A shield or unshield started elsewhere — the send drawer, a queued claim settling in
  // the background — moves the very balances this page is showing.
  useEffect(() => onTxConfirmed(() => { void load(true); }), [load]);

  // ── Pending claims ──────────────────────────────────────────────
  useEffect(() => {
    const queue = wallet?.pendingClaimQueue;
    if (!queue || !address) return;

    const sync = () => setClaims(queue.getFor(address, Number(networkId)));
    sync();
    return queue.subscribe(sync);
  }, [wallet?.pendingClaimQueue, address, networkId]);

  const settleClaims = async () => {
    if (!network || !account || !wallet?.pendingClaimQueue) return;
    setClaiming(true);
    setClaimMsg("");
    try {
      const settled = await network.drainPendingClaims(account, wallet.pendingClaimQueue);
      setClaimMsg(settled > 0 ? t("privacy.claimSettled") : t("privacy.claimFailed"));
      await load(true);
    } catch (e) {
      setClaimMsg(`${t("privacy.claimFailed")}: ${toUserMessage(e, t)}`);
    } finally {
      setClaiming(false);
    }
  };

  // ── Actions on a holding ────────────────────────────────────────

  /** Open Send in confidential mode with this wrapper already picked. */
  const sendConfidential = (wrapper: string) => {
    window.dispatchEvent(
      new CustomEvent("open-arf-menu", { detail: { tab: 0, token: wrapper, confidential: true } })
    );
  };

  /** Point the form below at this holding, and scroll it into view. */
  const unshieldHolding = (wrapper: string) => {
    focusSeq.current += 1;
    setFocus({ mode: "unshield", tokenKey: wrapper, seq: focusSeq.current });
    document.getElementById("privacy-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const totalShieldedUsd = useMemo(
    () => holdings.reduce((sum, h) => (h.decryptFailed ? sum : sum + h.valueUsd), 0),
    [holdings]
  );

  /** Rows the wallet can see on-chain but could not open this time. */
  const unreadable = useMemo(() => holdings.filter((h) => h.decryptFailed).length, [holdings]);

  const money = (v: number) =>
    hidden ? "***" : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const explorer = getExplorerBaseForNetwork(network);

  return (
    <Box sx={{ pb: 12, px: 2, pt: 2 }}>
      {/* ── Header ─────────────────────────────────────────────── */}
      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 0.5 }}>
        <IconButton onClick={() => navigate(-1)} aria-label="Go back" sx={{ ml: -1 }}>
          <ArrowBack />
        </IconButton>
        <Shield sx={{ fontSize: 20, color: "secondary.main" }} />
        <Typography variant="h6" fontWeight={800} sx={{ letterSpacing: "-0.02em", flex: 1 }}>
          {t("privacy.title")}
        </Typography>
        <Chip
          label="FHE"
          size="small"
          color="secondary"
          variant="outlined"
          sx={{ height: 20, fontSize: "0.65rem", fontWeight: 700 }}
        />
        <Tooltip title={hidden ? t("home.showBalance") : t("home.hideBalance")}>
          <IconButton
            size="small"
            onClick={() => setHidden(!hidden)}
            aria-label={hidden ? t("home.showBalance") : t("home.hideBalance")}
          >
            {hidden ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Stack>

      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 2, pl: 0.5 }}>
        {t("privacy.subtitle")}
      </Typography>

      {/* CoFHE runs on three chains. Saying so beats an empty screen that looks broken. */}
      {!fheAvailable ? (
        <Alert severity="info" sx={{ borderRadius: '0px' }}>
          <Typography variant="subtitle2" fontWeight={700}>
            {t("privacy.notAvailableTitle")}
          </Typography>
          <Typography variant="caption">{t("privacy.notAvailableBody")}</Typography>
        </Alert>
      ) : (
        <>
          {/* ── Total shielded ───────────────────────────────────── */}
          <Paper
            elevation={0}
            sx={{
              p: 2,
              mb: 2,
              border: "1px solid",
              borderColor: "divider",
              bgcolor: "background.paper",
            }}
          >
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Box>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  fontWeight={700}
                  sx={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: "0.65rem" }}
                >
                  {t("privacy.shieldedBalances")}
                </Typography>
                <Typography variant="h5" fontWeight={800} sx={{ mt: 0.25 }}>
                  {money(totalShieldedUsd)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {t("privacy.assetCount", { count: holdings.length })} ·{" "}
                  {t("privacy.encryptedOnChain")}
                </Typography>
                {/* The headline figure leaves out what could not be read, so it has to say
                    so — otherwise it silently understates the wallet. */}
                {unreadable > 0 && (
                  <Typography variant="caption" color="warning.main" sx={{ display: "block" }}>
                    {t("privacy.excludedFromTotal", { count: unreadable })}
                  </Typography>
                )}
              </Box>
              <Tooltip title={t("common.refresh")}>
                <span>
                  <IconButton onClick={() => void load(true)} disabled={refreshing} aria-label="Refresh">
                    {refreshing ? <CircularProgress size={18} /> : <Refresh />}
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>
          </Paper>

          {/* A refresh that failed leaves the previous list on screen; it has to say so
              rather than let stale decrypted figures pass as current. */}
          {loadError && (
            <Alert severity="warning" sx={{ mb: 2, borderRadius: '0px', fontSize: "0.78rem" }}>
              {loadError}
            </Alert>
          )}

          {/* ── Pending unshields ────────────────────────────────── */}
          {claims.length > 0 && (
            <Paper
              elevation={0}
              sx={{
                p: 2,
                mb: 2,
                border: "1px solid",
                borderColor: "warning.main",
                bgcolor: "background.paper",
              }}
            >
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
                <LockOpen sx={{ fontSize: 18, color: "warning.main" }} />
                <Typography variant="subtitle2" fontWeight={700} sx={{ flex: 1 }}>
                  {t("privacy.pendingUnshields")}
                </Typography>
                <Chip label={claims.length} size="small" sx={{ height: 20, fontWeight: 800 }} />
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
                {t("privacy.pendingHintLong")}
              </Typography>

              <Stack spacing={0.5} sx={{ mb: 1 }}>
                {claims.map((c) => (
                  <Stack
                    key={c.ctHash}
                    direction="row"
                    alignItems="center"
                    justifyContent="space-between"
                  >
                    <Typography variant="caption" fontWeight={700}>
                      {c.symbol}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontFamily: "monospace" }}
                    >
                      {short(c.ctHash)}
                    </Typography>
                  </Stack>
                ))}
              </Stack>

              {claimMsg && (
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
                  {claimMsg}
                </Typography>
              )}

              <Button
                fullWidth
                size="small"
                variant="contained"
                color="warning"
                onClick={() => void settleClaims()}
                disabled={claiming}
                startIcon={claiming ? <CircularProgress size={14} color="inherit" /> : undefined}
              >
                {claiming ? t("privacy.claiming") : t("privacy.claim")}
              </Button>
            </Paper>
          )}

          {/* ── Shielded holdings ────────────────────────────────── */}
          <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 1, pl: 0.5 }}>
            {t("privacy.allBalances")}
          </Typography>

          {loading && holdings.length === 0 ? (
            <TokenListSkeleton rows={3} />
          ) : holdings.length === 0 ? (
            <Alert severity="info" sx={{ borderRadius: '0px', fontSize: "0.78rem", mb: 2 }}>
              {t("privacy.nothingShielded")}
            </Alert>
          ) : (
            <Stack spacing={1} sx={{ mb: 2 }}>
              {holdings.map((h) => {
                const isOpen = expanded === h.wrapper;
                const underlyingSymbol = h.symbol.replace(/^ae/, "");
                return (
                  <Paper
                    key={h.wrapper}
                    elevation={0}
                    sx={{ border: "1px solid", borderColor: "divider", bgcolor: "background.paper" }}
                  >
                    <Stack
                      direction="row"
                      alignItems="center"
                      spacing={1.5}
                      sx={{ p: 1.5, cursor: "pointer" }}
                      onClick={() => setExpanded(isOpen ? null : h.wrapper)}
                    >
                      <Avatar
                        sx={{
                          width: 36,
                          height: 36,
                          bgcolor: "transparent",
                          border: "1px solid",
                          borderColor: "secondary.main",
                          color: "secondary.main",
                          fontSize: "0.8rem",
                          fontWeight: 800,
                        }}
                      >
                        {underlyingSymbol.slice(0, 2).toUpperCase()}
                      </Avatar>

                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Stack direction="row" alignItems="center" spacing={0.5}>
                          <Typography variant="subtitle2" fontWeight={700} noWrap>
                            {h.symbol}
                          </Typography>
                          {/* Two wrappers around one token hold two separate pools. Without
                              this the superseded one is indistinguishable from the live one. */}
                          {h.isLegacy && (
                            <Chip
                              label={t("privacy.legacyShort")}
                              size="small"
                              color="warning"
                              variant="outlined"
                              sx={{ height: 16, fontSize: "0.6rem", fontWeight: 700 }}
                            />
                          )}
                        </Stack>
                        {h.decryptFailed ? (
                          <Typography variant="caption" color="warning.main" noWrap>
                            {t("privacy.couldNotDecrypt")}
                          </Typography>
                        ) : (
                          <Typography variant="caption" color="text.secondary" noWrap>
                            {hidden ? "***" : `${h.balance} ${h.symbol}`}
                          </Typography>
                        )}
                      </Box>

                      <Box sx={{ textAlign: "right" }}>
                        {/* A wrapper whose underlying has no price yet would otherwise
                            render a confident "$0.00" over a real balance. */}
                        <Typography variant="subtitle2" fontWeight={700}>
                          {h.decryptFailed || h.priceUsd === 0 ? "—" : money(h.valueUsd)}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {isOpen ? <ExpandLess sx={{ fontSize: 14 }} /> : <ExpandMore sx={{ fontSize: 14 }} />}
                        </Typography>
                      </Box>
                    </Stack>

                    <Collapse in={isOpen} unmountOnExit>
                      <Divider />
                      <Box sx={{ p: 1.5, pt: 1.25 }}>
                        <Stack spacing={0.75} sx={{ mb: 1.5 }}>
                          <DetailRow label={t("privacy.viewContract", { symbol: h.symbol })}>
                            {explorer ? (
                              <Link
                                href={`${explorer}/address/${h.wrapper}`}
                                target="_blank"
                                rel="noopener"
                                sx={{ display: "flex", alignItems: "center", gap: 0.5, fontSize: "0.72rem" }}
                              >
                                {short(h.wrapper)}
                                <OpenInNew sx={{ fontSize: 12 }} />
                              </Link>
                            ) : (
                              <Typography variant="caption" sx={{ fontFamily: "monospace" }}>{short(h.wrapper)}</Typography>
                            )}
                          </DetailRow>

                          {h.underlying && (
                            <DetailRow label={t("privacy.underlyingToken")}>
                              {explorer ? (
                                <Link
                                  href={`${explorer}/address/${h.underlying}`}
                                  target="_blank"
                                  rel="noopener"
                                  sx={{ display: "flex", alignItems: "center", gap: 0.5, fontSize: "0.72rem" }}
                                >
                                  {short(h.underlying)}
                                  <OpenInNew sx={{ fontSize: 12 }} />
                                </Link>
                              ) : (
                                <Typography variant="caption" sx={{ fontFamily: "monospace" }}>{short(h.underlying)}</Typography>
                              )}
                            </DetailRow>
                          )}

                          {/* Confidential balances are euint64 and capped at 6 decimals, so
                              amounts round down. Users hit this the moment they shield a
                              token with 18; it belongs on screen, not in a support reply. */}
                          <DetailRow label={t("privacy.precision")}>
                            <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
                              {t("privacy.decimalsSuffix", { count: h.confidentialDecimals })}
                            </Typography>
                          </DetailRow>

                          <DetailRow label={t("privacy.status")}>
                            <Chip
                              label={h.decryptFailed ? t("privacy.couldNotDecrypt") : t("privacy.encryptedOnChain")}
                              size="small"
                              color={h.decryptFailed ? "warning" : "secondary"}
                              variant="outlined"
                              sx={{ height: 18, fontSize: "0.6rem", fontWeight: 700 }}
                            />
                          </DetailRow>
                        </Stack>

                        {h.decryptFailed && (
                          <Alert
                            severity="warning"
                            sx={{ mb: 1.5, borderRadius: '0px', fontSize: "0.72rem" }}
                            action={
                              <Button size="small" onClick={() => void load(true)} disabled={refreshing}>
                                {t("common.retry")}
                              </Button>
                            }
                          >
                            {t("privacy.couldNotDecryptHint")}
                          </Alert>
                        )}

                        {h.isLegacy && (
                          <Alert severity="warning" sx={{ mb: 1.5, borderRadius: '0px', fontSize: "0.72rem" }}>
                            {t("privacy.legacyWrapperHint", { symbol: h.symbol })}
                          </Alert>
                        )}

                        <Stack direction="row" spacing={1}>
                          <Button
                            fullWidth
                            size="small"
                            variant="outlined"
                            color="secondary"
                            startIcon={<SendIcon sx={{ fontSize: 14 }} />}
                            onClick={() => sendConfidential(h.wrapper)}
                          >
                            {t("send.confidential")}
                          </Button>
                          <Button
                            fullWidth
                            size="small"
                            variant="outlined"
                            color="warning"
                            startIcon={<LockOpen sx={{ fontSize: 14 }} />}
                            onClick={() => unshieldHolding(h.wrapper)}
                          >
                            {t("privacy.unshield")}
                          </Button>
                        </Stack>
                      </Box>
                    </Collapse>
                  </Paper>
                );
              })}
            </Stack>
          )}

          {/* ── Shield / unshield form ───────────────────────────── */}
          <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 1, pl: 0.5 }}>
            {t("privacy.shield")} / {t("privacy.unshield")}
          </Typography>
          <Paper
            id="privacy-form"
            elevation={0}
            sx={{
              p: 2,
              mb: 2,
              border: "1px solid",
              borderColor: "divider",
              bgcolor: "background.paper",
              scrollMarginTop: 8,
            }}
          >
            <ShieldPanel hideTitle focus={focus} onCompleted={() => void load(true)} />
          </Paper>

          {/* ── How it works ─────────────────────────────────────── */}
          <Paper
            elevation={0}
            sx={{ border: "1px solid", borderColor: "divider", bgcolor: "background.paper" }}
          >
            <Stack
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{ p: 1.5, cursor: "pointer" }}
              onClick={() => setShowHelp(!showHelp)}
            >
              <HelpOutline sx={{ fontSize: 18, color: "text.secondary" }} />
              <Typography variant="subtitle2" fontWeight={700} sx={{ flex: 1 }}>
                {t("privacy.howItWorks")}
              </Typography>
              {showHelp ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
            </Stack>
            <Collapse in={showHelp} unmountOnExit>
              <Divider />
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", p: 1.5, lineHeight: 1.6 }}
              >
                {t("privacy.howItWorksBody")}
              </Typography>
            </Collapse>
          </Paper>
        </>
      )}

      {/* Treasure hunt — 3 of 3. */}
      <Box sx={{ display: "flex", justifyContent: "center", mt: 3 }}>
        <HuntMark reveal="5. clog   6. armor" hint="Arfhe" onlyIn="dark" />
      </Box>

    </Box>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
      <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
        {label}
      </Typography>
      {children}
    </Stack>
  );
}
