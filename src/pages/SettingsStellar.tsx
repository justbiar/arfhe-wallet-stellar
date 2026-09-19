/**
 * SettingsStellar.tsx — the wallet's Stellar account, where a person can actually see it.
 *
 * Stellar is deliberately NOT in the network switcher. That list is EVM chains, and every
 * piece of machinery behind it — chain ids, ethers wallets, RPC calls, the token list —
 * applies to none of this. Stellar is a different curve, a different address format and a
 * different ledger; putting it in that dropdown would make a switch that half the wallet
 * silently ignores.
 *
 * So it lives here, as its own account derived from the same recovery phrase (SEP-5), with
 * its own balances read from Horizon. Read-only for now, and the screen says so rather than
 * offering a send button that does not exist.
 */

import React, { useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  Box, Container, Typography, Paper, Stack, IconButton, Chip, Alert, CircularProgress,
  Divider, Tooltip, Link as MuiLink, alpha, useTheme,
} from "@mui/material";
import {
  ArrowBack, ContentCopyOutlined, Check, OpenInNew, Refresh,
} from "@mui/icons-material";
import { WalletContext } from "../AppContext.js";
import { toUserMessage } from "../backend/UserFacingError.js";

const EXPLORER = "https://stellar.expert/explorer/testnet/account";

interface Balance {
  code: string;
  issuer: string | null;
  balance: string;
  isNative: boolean;
}

export default function SettingsStellar() {
  const { t } = useTranslation();
  const theme = useTheme();
  const navigate = useNavigate();
  const context = useContext(WalletContext);
  const account = context?.accountManager?.GetActive();

  const [address, setAddress] = useState<string | null>(null);
  const [balances, setBalances] = useState<Balance[] | null>(null);
  const [exists, setExists] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [reloadAt, setReloadAt] = useState(0);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;

    void (async () => {
      setLoading(true);
      setError("");
      try {
        const service = await import("../backend/StellarService.js");
        const derived = await service.getAddress(account);
        if (cancelled) return;
        setAddress(derived);

        // Null is a real answer, not a failure: an account imported from a raw private key
        // has no phrase to derive from, and inventing one would hand the user an address
        // their backup cannot restore.
        if (!derived) {
          setBalances(null);
          return;
        }

        const read = await service.getBalances(derived);
        if (cancelled) return;
        setExists(read.exists);
        setBalances(read.balances);
      } catch (e) {
        if (!cancelled) setError(toUserMessage(e, t));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [account, reloadAt, t]);

  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked; the address is on screen to select */ }
  };

  return (
    <Container maxWidth="sm" sx={{ py: 2 }}>
      <Stack direction="row" alignItems="center" gap={1} sx={{ mb: 2 }}>
        <IconButton onClick={() => navigate("/settings")} size="small" aria-label={t("common.back")}>
          <ArrowBack fontSize="small" />
        </IconButton>
        <Typography variant="h6" fontWeight={800}>{t("stellar.title")}</Typography>
        <Box sx={{ flex: 1 }} />
        <Chip size="small" label={t("stellar.testnet")} sx={{ fontWeight: 700, fontSize: "0.65rem" }} />
        <Tooltip title={t("common.refresh")}>
          <span>
            <IconButton size="small" onClick={() => setReloadAt(Date.now())} disabled={loading}>
              <Refresh fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2, lineHeight: 1.6 }}>
        {t("stellar.intro")}
      </Typography>

      {loading && (
        <Stack alignItems="center" sx={{ py: 4 }}><CircularProgress size={24} /></Stack>
      )}

      {!loading && error && <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }}>{error}</Alert>}

      {/* An account with no recovery phrase has no Stellar address, and saying why is the
          whole content of this screen for those users. */}
      {!loading && !error && address === null && (
        <Alert severity="info" sx={{ borderRadius: 2 }}>{t("stellar.noMnemonic")}</Alert>
      )}

      {!loading && !error && address && (
        <>
          <Paper elevation={0} sx={{ p: 2, borderRadius: 3, bgcolor: alpha(theme.palette.primary.main, 0.05), mb: 2 }}>
            <Stack direction="row" alignItems="center" gap={0.5}>
              <Typography variant="caption" color="text.secondary" fontWeight={700}>
                {t("stellar.address")}
              </Typography>
              <Tooltip title={copied ? t("common.copied") : t("common.copy")}>
                <IconButton size="small" onClick={copy} sx={{ p: 0.3 }}>
                  {copied ? <Check sx={{ fontSize: 14 }} /> : <ContentCopyOutlined sx={{ fontSize: 14 }} />}
                </IconButton>
              </Tooltip>
            </Stack>
            <Typography sx={{ fontFamily: "monospace", fontSize: 12.5, mt: 0.5, wordBreak: "break-all" }}>
              {address}
            </Typography>
            <MuiLink
              href={`${EXPLORER}/${address}`}
              target="_blank" rel="noopener noreferrer" variant="caption"
              sx={{ display: "inline-flex", alignItems: "center", gap: 0.4, mt: 1, textTransform: "none" }}
            >
              {t("stellar.viewOnChain")} <OpenInNew sx={{ fontSize: 12 }} />
            </MuiLink>
          </Paper>

          {exists === false ? (
            // Not an error. On Stellar an account does not exist until something funds it.
            <Alert severity="info" sx={{ borderRadius: 2, mb: 2 }}>{t("stellar.notFunded")}</Alert>
          ) : (
            <Paper elevation={0} sx={{ p: 2, borderRadius: 3, border: "1px solid", borderColor: "divider", mb: 2 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={700}>
                {t("stellar.balances")}
              </Typography>
              <Stack gap={1} sx={{ mt: 1 }}>
                {(balances ?? []).map((b) => (
                  <Stack key={`${b.code}:${b.issuer ?? "native"}`} direction="row" justifyContent="space-between" alignItems="baseline">
                    <Typography variant="body2" fontWeight={700}>{b.code}</Typography>
                    <Typography variant="body2" sx={{ fontFamily: "monospace" }}>{b.balance}</Typography>
                  </Stack>
                ))}
                {(balances ?? []).length === 0 && (
                  <Typography variant="caption" color="text.secondary">{t("stellar.noBalances")}</Typography>
                )}
              </Stack>
            </Paper>
          )}

          <Divider sx={{ my: 2 }} />

          <Typography variant="caption" color="text.secondary" sx={{ display: "block", textTransform: "none", lineHeight: 1.6 }}>
            {t("stellar.readOnly")}
          </Typography>
        </>
      )}
    </Container>
  );
}
