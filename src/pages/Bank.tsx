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
  Divider, TextField, Button, Tooltip, alpha, useTheme,
} from "@mui/material";
import { ArrowBack, ContentCopyOutlined, Check, Refresh } from "@mui/icons-material";
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
  const [amount, setAmount] = useState("500");
  /** The account's standing deposit instructions — created once, then shown. */
  const [identity, setIdentity] = useState<DepositInstructions | null>(null);
  const [usdc, setUsdc] = useState<string | null>(null);
  /** TRY per USDC, as the anchor prices it. Null when it will not say. */
  const [rate, setRate] = useState<number | null>(null);
  /** The account's own payout IBAN, as the anchor assigns it. */
  const [payoutIban, setPayoutIban] = useState<string | null>(null);
  const [withdrawAmount, setWithdrawAmount] = useState("5");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [reloadAt, setReloadAt] = useState(0);

  /** Lira the anchor has seen but not yet turned into USDC. */
  const pendingTry = (txs ?? [])
    .filter((tx) => tx.kind === "deposit" && tx.status !== "completed" && tx.amountIn)
    .reduce((sum, tx) => sum + Number(tx.amountIn), 0) || null;

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
      setPayoutIban(await anchor.getPayoutIban(account));

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

  const simulate = () => run("simulate", async () => {
    if (!account || !identity) return;
    const anchor = await import("../backend/AnchorService.js");
    // Settled against the standing request, so the money arrives under the reference the
    // screen has been showing all along rather than a second one made for this click.
    await withTimeout(anchor.simulateBankTransfer(account, identity.id, amount), t("bank.timedOut"));
    setTxs(await anchor.listTransactions(account));
  });

  const fund = () => run("fund", async () => {
    if (!address) return;
    const anchor = await import("../backend/AnchorService.js");
    await withTimeout(anchor.fundWithFriendbot(address), t("bank.timedOut"));
    setState(await anchor.hasTrustline(address));
  });

  /**
   * Out to the bank: open the request, then pay the anchor with the memo it asked for.
   *
   * One button rather than two steps, because the second without the first is a payment
   * into the anchor's account that nothing is expecting. If the payment fails the request
   * is simply never settled, which is the state the anchor already handles.
   */
  const withdraw = () => run("withdraw", async () => {
    if (!account) return;
    const anchor = await import("../backend/AnchorService.js");
    const order = await withTimeout(anchor.openWithdraw(account, withdrawAmount), t("bank.timedOut"));
    setPayoutIban(order.payoutIban);
    await withTimeout(anchor.payWithdrawal(account, order, withdrawAmount), t("bank.timedOut"));
    setTxs(await anchor.listTransactions(account));
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

      <Stack direction="row" alignItems="center" gap={1} sx={{ mb: 2 }}>
        <IconButton onClick={() => navigate("/home")} size="small" aria-label={t("common.back")}>
          <ArrowBack fontSize="small" />
        </IconButton>
        <Typography variant="h6" fontWeight={800}>{t("bank.title")}</Typography>
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
            {/* The account's own number first, the way a bank app opens: this is the
                identity, the balance is what is in it. It is the anchor's assignment, not
                an IBAN the user chose — and the label says which. */}
            {payoutIban && (
              <Box sx={{ mb: 2, textAlign: "left" }}>
                <CopyLine label={t("bank.yourIban")} value={payoutIban} />
                <Divider sx={{ mt: 1.5 }} />
              </Box>
            )}

            <Typography variant="caption" color="text.secondary" fontWeight={700} letterSpacing="0.08em">
              {t("bank.balanceLabel")}
            </Typography>
            <Typography sx={{ fontSize: "clamp(2rem, 11vw, 3rem)", fontWeight: 800, lineHeight: 1.1, mt: 0.5 }}>
              {rate !== null && usdc !== null
                ? Number(usdc) * rate > 0
                  ? (Number(usdc) * rate).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                  : "0,00"
                : "—"}
              <Typography component="span" sx={{ fontSize: 16, fontWeight: 700, ml: 0.75 }}>TRY</Typography>
            </Typography>
            {/* Quiet, but present: the lira figure is a conversion, and the thing the
                account actually holds should never be a number the screen hides. */}
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
              {rate !== null
                ? t("bank.backedBy", {
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

            <Divider sx={{ my: 2 }} />

            {/* Stacked, not side by side. The wallet renders at popup width and this
                button's label is a sentence; in a row the amount field collapsed to about
                forty pixels and clipped both its label and the number inside it. */}
            <Stack gap={1.5}>
              <TextField
                fullWidth
                size="small"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ""))}
                label={t("bank.amountTry")}
                inputProps={{ inputMode: "decimal", style: { fontSize: 18, fontWeight: 700 } }}
              />
              <Button
                fullWidth
                variant="contained"
                onClick={simulate}
                disabled={busy !== null || amount === "" || !identity}
                startIcon={busy === "simulate" ? <CircularProgress size={13} color="inherit" /> : null}
                sx={{ minHeight: 44, borderRadius: 2 }}
              >
                {t("bank.simulate")}
              </Button>
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
              {t("bank.simulateWhy")}
            </Typography>
          </Paper>

          {/* Out. Deliberately below the deposit card: money leaving is the rarer action and
              the one with a step that cannot be undone. */}
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
            <Typography fontWeight={700} sx={{ mb: 1.5 }}>{t("bank.withdrawTitle")}</Typography>

            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.5 }}>
              {t("bank.payoutNote")}
            </Typography>

            <Stack gap={1.5}>
              <TextField
                fullWidth
                size="small"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value.replace(/[^\d.,]/g, ""))}
                label={t("bank.amountUsdc")}
                inputProps={{ inputMode: "decimal", style: { fontSize: 18, fontWeight: 700 } }}
              />
              <Button
                fullWidth
                variant="outlined"
                onClick={withdraw}
                disabled={busy !== null || withdrawAmount === "" || !state?.trusted}
                startIcon={busy === "withdraw" ? <CircularProgress size={13} /> : null}
                sx={{ minHeight: 44, borderRadius: 2 }}
              >
                {t("bank.withdraw")}
              </Button>
            </Stack>
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
                            {tx.amountIn} TRY → {tx.amountOut} USDC
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {t("bank.fee")}: {tx.amountFee} · {tx.status}
                          </Typography>
                        </Box>
                        {settled
                          ? <Check sx={{ fontSize: 16, color: "success.main" }} />
                          : <CircularProgress size={13} />}
                      </Stack>

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
