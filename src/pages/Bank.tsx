/**
 * Bank.tsx — the wallet's lira side.
 *
 * A Turkish exchange shows two faces of the same account: the crypto one and the bank one.
 * This is the bank one. It is deliberately not called "your IBAN": measured against this
 * anchor, two different Stellar accounts get the same account number and differ only in the
 * reference code, so the honest screen is "send here, with this reference" — which is what
 * the exchanges with a shared collection account do too.
 *
 * The reference is minted per request. It cannot exist before an amount does, so the screen
 * asks for the amount first rather than showing a code that belongs to nothing.
 *
 * One state deserves its own treatment: a deposit stops at `pending_trust` when the account
 * cannot hold USDC yet. That is not a failure — the anchor has the money and is waiting —
 * so the screen says what is missing and offers the one action that fixes it.
 */

import React, { useCallback, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  Box, Container, Typography, Paper, Stack, IconButton, Chip, Alert, CircularProgress,
  Divider, Button, Tooltip, alpha, useTheme,
} from "@mui/material";
import { ContentCopyOutlined, Check, Refresh } from "@mui/icons-material";
import { Link as MuiLink } from "@mui/material";
import { WalletContext } from "../AppContext.js";
import WalletModeSwitch from "../components/WalletModeSwitch.js";
import { toUserMessage } from "../backend/UserFacingError.js";
import type { AnchorTx, DepositInstructions } from "../backend/AnchorService.js";

/** Long enough for an anchor round trip, short enough that "stuck" is not mistaken for slow. */
const TIMEOUT_MS = 20_000;

/**
 * How long a deposit may sit untouched before the screen calls it stuck.
 *
 * The anchor's own estimate for the paying step is five seconds. A minute of silence is not
 * a slow network — it is a payout that is not happening — and telling the user that beats a
 * spinner that implies progress nobody is making.
 */
const STALLED_AFTER_MS = 60_000;

/**
 * Where a hash can be checked by someone who does not trust this screen.
 *
 * The anchor reports "completed" and the balance changes, but both of those are this side
 * of the wall saying so. The transaction id is the part anyone can verify against the
 * ledger, which is why it belongs on the row rather than in a log.
 */
const EXPLORER_TX = "https://stellar.expert/explorer/testnet/tx";

function withTimeout<T>(work: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), TIMEOUT_MS)),
  ]);
}

function CopyLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked; the value is on screen to select */ }
  };
  return (
    <Stack direction="row" alignItems="center" gap={1}>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="caption" color="text.secondary">{label}</Typography>
        <Typography sx={{ fontFamily: "monospace", fontSize: 13, wordBreak: "break-all" }}>{value}</Typography>
      </Box>
      <IconButton size="small" onClick={copy} aria-label={label}>
        {copied ? <Check sx={{ fontSize: 16 }} /> : <ContentCopyOutlined sx={{ fontSize: 16 }} />}
      </IconButton>
    </Stack>
  );
}

export default function Bank() {
  const { t } = useTranslation();
  const theme = useTheme();
  const navigate = useNavigate();
  const context = useContext(WalletContext);
  const account = context?.accountManager?.GetActive();

  const [address, setAddress] = useState<string | null>(null);
  const [state, setState] = useState<{ exists: boolean; trusted: boolean } | null>(null);
  const [txs, setTxs] = useState<AnchorTx[] | null>(null);
  /** The account's standing deposit instructions — created once, then shown. */
  const [identity, setIdentity] = useState<DepositInstructions | null>(null);
  const [usdc, setUsdc] = useState<string | null>(null);
  /** TRY per USDC, as the anchor prices it. Null when it will not say. */
  const [rate, setRate] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [reloadAt, setReloadAt] = useState(0);

  /** Lira the anchor has seen but not yet turned into USDC. */
  const pendingTry = (txs ?? [])
    .filter((tx) => tx.kind === "deposit" && tx.status !== "completed" && tx.amountIn)
    .reduce((sum, tx) => sum + Number(tx.amountIn), 0) || null;

  /**
   * Lira that actually came through this rail: deposits in, withdrawals out.
   *
   * The headline used to be the whole USDC balance converted at today's rate, which reads
   * as "this much money arrived from the bank" and is not true — an account's USDC also
   * comes from a faucet, a payroll run, someone else's payment. Converting all of it dressed
   * unrelated money up as bank money.
   *
   * Only settled transfers count. A deposit the anchor has not paid out yet is money it
   * holds, not money that arrived, and it has its own line.
   */
  const settled = (txs ?? []).filter((tx) => tx.status === "completed");
  const depositedTry = settled
    .filter((tx) => tx.kind === "deposit" && tx.amountIn)
    .reduce((sum, tx) => sum + Number(tx.amountIn), 0);
  const withdrawnTry = settled
    .filter((tx) => tx.kind === "withdrawal" && tx.amountOut)
    .reduce((sum, tx) => sum + Number(tx.amountOut), 0);
  const netTry = depositedTry - withdrawnTry;

  const load = useCallback(async () => {
    if (!account) { setLoading(false); return; }
    setLoading(true);
    setError("");
    try {
      const stellar = await import("../backend/StellarService.js");
      const anchor = await import("../backend/AnchorService.js");
      const derived = await stellar.getAddress(account);
      setAddress(derived);
      if (!derived) return;

      setState(await withTimeout(anchor.hasTrustline(derived), t("bank.timedOut")));

      // The balance behind the IBAN: what the rail actually delivered. Read from the chain
      // rather than from the anchor, because the anchor's word for it stops at the payout.
      const read = await stellar.getBalances(derived);
      setUsdc(read.balances.find((b) => b.code === "USDC")?.balance ?? null);
      setRate(await anchor.getSellRate());

      try {
        setIdentity(await withTimeout(anchor.getDepositIdentity(account), t("bank.timedOut")));
      } catch {
        setIdentity(null);
      }
      // Listing needs a SEP-10 session, so it is the first thing that can fail for reasons
      // that have nothing to do with the account itself. Its failure must not blank the
      // rest of the screen.
      try {
        setTxs(await withTimeout(anchor.listTransactions(account), t("bank.timedOut")));
      } catch {
        setTxs(null);
      }
    } catch (e) {
      setError(toUserMessage(e, t));
    } finally {
      setLoading(false);
    }
  }, [account, t]);

  useEffect(() => { void load(); }, [load, reloadAt]);

  /**
   * Watch a deposit while it is moving.
   *
   * Without this the screen showed whatever the status was at the moment of the last fetch,
   * so an anchor that had finished looked stuck and an anchor that was stuck looked the
   * same as one still working. Polling separates the two: the row either changes, or it
   * visibly does not — and after {@link STALLED_AFTER_MS} the screen says so instead of
   * spinning forever on the user's behalf.
   *
   * Stops as soon as nothing is pending, so a settled screen makes no requests at all.
   */
  const pending = (txs ?? []).some((tx) => tx.status !== "completed" && tx.status !== "error" && tx.status !== "refunded");

  useEffect(() => {
    if (!pending || !account) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const anchor = await import("../backend/AnchorService.js");
        const fresh = await anchor.listTransactions(account);
        if (!cancelled) setTxs(fresh);
      } catch {
        // A poll that fails is not an error the user needs; the next one may work.
      }
    }, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [pending, account]);

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(toUserMessage(e, t));
    } finally {
      setBusy(null);
    }
  };

  const fund = () => run("fund", async () => {
    if (!address) return;
    const anchor = await import("../backend/AnchorService.js");
    await withTimeout(anchor.fundWithFriendbot(address), t("bank.timedOut"));
    setState(await anchor.hasTrustline(address));
  });

  const trust = () => run("trust", async () => {
    if (!account || !address) return;
    const anchor = await import("../backend/AnchorService.js");
    await withTimeout(anchor.openTrustline(account), t("bank.timedOut"));
    setState(await anchor.hasTrustline(address));
  });

  /** The one thing standing between the money and the account, if anything is. */
  const blocker = state === null ? null : !state.exists ? "fund" : !state.trusted ? "trust" : null;

  return (
    <Container maxWidth="sm" sx={{ py: 2 }}>
      <Box sx={{ mx: -2, mb: 1 }}><WalletModeSwitch mode="bank" /></Box>

      {/* No title and no back arrow: the Web3 / Bank switch above is both. A heading that
          repeats the selected tab and an arrow that does what the other tab does are two
          ways of saying the same thing, in a popup that has no room to say anything twice. */}
      <Stack direction="row" alignItems="center" gap={1} sx={{ mb: 2 }}>
        <Box sx={{ flex: 1 }} />
        <Chip size="small" label={t("bank.testnet")} sx={{ fontWeight: 700, fontSize: "0.65rem" }} />
        <Tooltip title={t("common.refresh")}>
          <span>
            <IconButton size="small" onClick={() => setReloadAt(Date.now())} disabled={loading}>
              <Refresh fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {loading ? (
        <Stack alignItems="center" sx={{ py: 6 }}><CircularProgress size={22} /></Stack>
      ) : !account ? (
        <Alert severity="info">{t("bank.noAccount")}</Alert>
      ) : !address ? (
        <Stack gap={1.5}>
          <Alert severity="info">{t("bank.noPhrase")}</Alert>
          {/* Worth spelling out: from an imported account, "add account" derives another
              private key (social/N), not a phrase — so the obvious next tap lands the user
              back on this same screen. */}
          <Typography variant="caption" color="text.secondary">
            {t("bank.noPhraseHint")}
          </Typography>
          <Button variant="outlined" onClick={() => navigate("/settings/accounts")}>
            {t("bank.goToAccounts")}
          </Button>
        </Stack>
      ) : (
        <Stack gap={2}>
          {error && <Alert severity="error" onClose={() => setError("")}>{error}</Alert>}

          {/* Readiness is a card only while something is wrong. In the ordinary case there
              is nothing to say, and a permanent "everything is fine" panel is three lines
              of furniture between the person and their balance. */}
          {blocker && (
            <Alert severity="warning">
              {/* The action sits under the sentence rather than beside it: at popup width
                  an `action` slot and a sentence-long label squeeze each other into
                  ellipses, which is how the amount field ended up unreadable. */}
              <Typography variant="caption" sx={{ display: "block" }}>
                {blocker === "fund" ? t("bank.accountMissing") : t("bank.trustlineWhy")}
              </Typography>
              <Button
                fullWidth
                size="small"
                variant="outlined"
                color="inherit"
                onClick={blocker === "fund" ? fund : trust}
                disabled={busy !== null}
                startIcon={busy === blocker ? <CircularProgress size={12} /> : null}
                sx={{ mt: 1.5 }}
              >
                {blocker === "fund" ? t("bank.fund") : t("bank.openTrustline")}
              </Button>
            </Alert>
          )}

          {/* The balance, and nothing competing with it. */}
          <Paper
            variant="outlined"
            sx={{ p: 3, borderRadius: 3, textAlign: "center", bgcolor: alpha(theme.palette.primary.main, 0.04) }}
          >
            <Typography variant="caption" color="text.secondary" fontWeight={700} letterSpacing="0.08em">
              {t("bank.balanceLabel")}
            </Typography>
            <Typography sx={{ fontSize: "clamp(2rem, 11vw, 3rem)", fontWeight: 800, lineHeight: 1.1, mt: 0.5 }}>
              {netTry.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              <Typography component="span" sx={{ fontSize: 16, fontWeight: 700, ml: 0.75 }}>TRY</Typography>
            </Typography>
            {/* The chain balance belongs here too, and separately: it is what the account
                actually holds, which is a different quantity from what the bank rail
                delivered. Keeping them apart is the point of the line. */}
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
              {t("bank.railSummary", {
                deposited: depositedTry.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                withdrawn: withdrawnTry.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
              })}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
              {rate !== null
                ? t("bank.chainHolds", {
                    usdc: usdc ?? "0",
                    rate: rate.toLocaleString("tr-TR", { minimumFractionDigits: 4, maximumFractionDigits: 4 }),
                  })
                : t("bank.rateUnavailable", { usdc: usdc ?? "0" })}
            </Typography>

            {pendingTry !== null && (
              <Box sx={{ mt: 2, py: 1, borderRadius: 2, bgcolor: alpha(theme.palette.text.primary, 0.05) }}>
                <Typography variant="caption" fontWeight={700}>
                  {t("bank.pendingLabel", { amount: pendingTry })}
                </Typography>
              </Box>
            )}
          </Paper>

          {/* One action, and the two lines it needs. */}
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
            <Typography fontWeight={700} sx={{ mb: 1.5 }}>{t("bank.depositTitle")}</Typography>

            {identity?.iban ? (
              <Stack gap={1.5}>
                <CopyLine label={t("bank.iban")} value={identity.iban} />
                {identity.reference && <CopyLine label={t("bank.reference")} value={identity.reference} />}
                <Typography variant="caption" color="text.secondary">
                  {t("bank.sharedIbanNote")}
                </Typography>
              </Stack>
            ) : (
              <Typography variant="body2" color="text.secondary">{t("bank.identityUnavailable")}</Typography>
            )}

          </Paper>

          {/* Only when there is something to list. An empty "no transactions yet" card is
              a card that says nothing. */}
          {txs !== null && txs.length > 0 && (
            <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
              <Typography fontWeight={700} sx={{ mb: 1 }}>{t("bank.history")}</Typography>
              <Stack divider={<Divider />} gap={1}>
                {txs.map((tx) => {
                  const settled = tx.status === "completed";
                  // The anchor stamps `updated_at` when it touches the record. A record it
                  // opened and never returned to is the difference between slow and stuck,
                  // and it is the only evidence this screen has for saying so.
                  const idleMs = tx.updatedAt ? Date.now() - new Date(tx.updatedAt).getTime() : 0;
                  const stalled = !settled && idleMs > STALLED_AFTER_MS;
                  return (
                    <Box key={tx.id} sx={{ pt: 1 }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center">
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="body2" fontWeight={600}>
                            {tx.kind === "withdrawal"
                              ? `${tx.amountIn} USDC → ${tx.amountOut} TRY`
                              : `${tx.amountIn} TRY → ${tx.amountOut} USDC`}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {t("bank.fee")}: {tx.amountFee} · {tx.status}
                          </Typography>
                        </Box>
                        {settled
                          ? <Check sx={{ fontSize: 16, color: "success.main" }} />
                          : <CircularProgress size={13} />}
                      </Stack>

                      {/* The chain's receipt, once there is one.
                          On a deposit this is the anchor's payout; on a withdrawal it is
                          the payment that was sent to it. Either way it is the only line
                          here that can be checked without taking the anchor's word. */}
                      {tx.stellarTxId && (
                        <Box sx={{ mt: 0.8 }}>
                          <Typography
                            variant="caption"
                            sx={{
                              display: "block", fontFamily: "monospace", fontSize: 10,
                              wordBreak: "break-all", color: "text.secondary", lineHeight: 1.5,
                            }}
                          >
                            {tx.stellarTxId}
                          </Typography>
                          <MuiLink
                            href={`${EXPLORER_TX}/${tx.stellarTxId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            variant="caption"
                          >
                            {t("bank.viewOnChain")}
                          </MuiLink>
                        </Box>
                      )}

                      {/* The anchor's own words, not a paraphrase. */}
                      {!settled && tx.message && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
                          {tx.message}
                        </Typography>
                      )}

                      {stalled && (
                        <Alert severity="warning" sx={{ mt: 1, py: 0 }}>
                          <Typography variant="caption">
                            {t("bank.stalled", { minutes: Math.round(idleMs / 60000) })}
                            {tx.moreInfoUrl && (
                              <>
                                {" "}
                                <MuiLink href={tx.moreInfoUrl} target="_blank" rel="noopener noreferrer">
                                  {t("bank.anchorDetails")}
                                </MuiLink>
                              </>
                            )}
                          </Typography>
                        </Alert>
                      )}
                    </Box>
                  );
                })}
              </Stack>
            </Paper>
          )}

          <Typography variant="caption" color="text.secondary">
            {t("bank.footer")}
          </Typography>
        </Stack>
      )}
    </Container>
  );
}
