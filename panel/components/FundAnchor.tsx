import { pt } from "../lib/language";
/**
 * The anchor's wallet, and a way for a visitor to refill it.
 *
 * Every deposit is paid out of one testnet account. When that account runs dry the deposit
 * does not fail — the worker keeps retrying, so it sits at pending and the page gives no
 * reason. This puts the reason and the remedy in one box: the address, what is left in it,
 * and the faucet that mints more.
 *
 * Safe to show publicly: the faucet hands out testnet USDC, and the secret that spends it
 * never leaves the machine running the anchor. Anyone can fill this account; nobody but the
 * anchor can empty it.
 */
import React from "react";
import {
  Box, Stack, Typography, Paper, Button, IconButton, Tooltip, Chip, useTheme, alpha,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopyOutlined";
import RefreshIcon from "@mui/icons-material/RefreshOutlined";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { ANCHOR_ASSET_CODE } from "../lib/anchor";
import { readTreasury, type AnchorTreasury } from "../lib/anchorLive";

/** Circle's testnet faucet — the only place this asset can be minted from. */
const FAUCET_URL = "https://faucet.circle.com/";

/**
 * Below this the treasury cannot cover an ordinary deposit.
 *
 * 5 USDC is roughly what 250 TRY buys at the sandbox rate, and 250 TRY is the amount the
 * bridge page suggests. A warning that fires later than the first stalled deposit is a
 * warning nobody reads in time.
 */
const LOW_USDC = 5;

export default function FundAnchor({ compact = false }: { compact?: boolean }) {
  const theme = useTheme();
  const [treasury, setTreasury] = React.useState<AnchorTreasury | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setBusy(true);
    try {
      setTreasury(await readTreasury());
    } finally {
      setBusy(false);
    }
  }, []);

  React.useEffect(() => { void refresh(); }, [refresh]);

  const address = treasury?.distribution ?? null;
  const usdc = treasury?.usdc ?? null;
  const low = usdc == null || usdc < LOW_USDC;

  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked by the browser. The address is on screen either way.
    }
  };

  const faucetButton = (
    <Button
      size="small"
      variant={compact ? "outlined" : "contained"}
      href={FAUCET_URL}
      target="_blank"
      rel="noopener noreferrer"
      endIcon={<OpenInNewIcon sx={{ fontSize: 16 }} />}
      sx={{ borderRadius: 3, fontWeight: 700, whiteSpace: "nowrap" }}
    >{pt("Circle faucet")}</Button>
  );

  const copyButton = (
    <Tooltip title={pt(copied ? "Kopyalandı" : "Adresi kopyala")}>
      <span>
        <IconButton size="small" onClick={copy} disabled={!address} aria-label={pt("Adresi kopyala")}>
          <ContentCopyIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </span>
    </Tooltip>
  );

  // The compact form is a warning, not a section: when the treasury can pay, it has nothing
  // to say and stays out of the bridge's way.
  if (compact) {
    if (!low) return null;
    return (
      <Paper
        elevation={0}
        sx={{
          p: 2, mb: 2, borderRadius: 3, border: "1px solid",
          borderColor: alpha(theme.palette.warning.main, 0.4),
          bgcolor: alpha(theme.palette.warning.main, 0.06),
        }}
      >
        <Stack direction={{ xs: "column", sm: "row" }} gap={1.5} alignItems={{ sm: "center" }}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="body2" sx={{ fontWeight: 700 }}>{pt("Anchor kasası azaldı")}</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.3, textTransform: "none", lineHeight: 1.6 }}>{pt(" Kasada ")}{usdc != null ? usdc.toFixed(2) : "—"}{pt(" ")}{pt(ANCHOR_ASSET_CODE)}{pt(" kaldı. Bunun üstündeki bir yükleme, kasa dolana kadar bekler. Faucet'ten doldurabilirsiniz — adres aşağıda. ")}</Typography>
            <Stack direction="row" alignItems="center" gap={0.5} sx={{ mt: 0.5 }}>
              <Typography
                variant="caption"
                sx={{ fontFamily: "var(--font-arbeit-technik)", wordBreak: "break-all", textTransform: "none" }}
              >
                {address ?? "—"}
              </Typography>
              {copyButton}
            </Stack>
          </Box>
          {faucetButton}
        </Stack>
      </Paper>
    );
  }

  return (
    <Paper elevation={0} sx={{ p: 2.5, border: "1px solid", borderColor: "divider", borderRadius: 3 }}>
      <Stack direction="row" alignItems="center" gap={1}>
        <Typography variant="caption" color="text.secondary" fontWeight={700}>{pt("KASAYI FONLA")}</Typography>
        <Chip
          size="small"
          label={pt(low ? "AZALDI" : "YETERLİ")}
          sx={{
            borderRadius: 3, height: 20, fontSize: 10, fontWeight: 700,
            bgcolor: low ? alpha(theme.palette.warning.main, 0.14) : alpha(theme.palette.success.main, 0.12),
            color: low ? "warning.main" : "success.main",
          }}
        />
        <Box sx={{ flex: 1 }} />
        <Tooltip title={pt("Yenile")}>
          <span>
            <IconButton size="small" onClick={() => void refresh()} disabled={busy} aria-label={pt("Yenile")}>
              <RefreshIcon sx={{ fontSize: 17 }} />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mt: 1.2, lineHeight: 1.7 }}>{pt(" Yüklemeleri bu hesap ödüyor. Boşaldığında yükleme hata vermez, ")}<b>{pt("bekler")}</b>{pt(" — kasa dolduğu anda ödenir. Testnet parası olduğu için kimden geldiğinin önemi yok: faucet'i bu adrese yönlendiren herkes demoyu ayakta tutar. ")}</Typography>

      <Box
        sx={{
          mt: 1.8, p: 1.5, borderRadius: 2, border: "1px solid", borderColor: "divider",
          bgcolor: alpha(theme.palette.text.primary, 0.03),
        }}
      >
        <Stack direction="row" alignItems="center" gap={0.5}>
          <Typography
            variant="caption"
            sx={{ flex: 1, fontFamily: "var(--font-arbeit-technik)", wordBreak: "break-all", textTransform: "none" }}
          >
            {address ?? "—"}
          </Typography>
          {copyButton}
        </Stack>
      </Box>

      <Stack direction="row" gap={3} sx={{ mt: 1.5 }}>
        <Box>
          <Typography variant="caption" color="text.secondary">{pt("Kasa")}</Typography>
          <Typography sx={{ fontFamily: "var(--font-arbeit-technik)", fontWeight: 700 }}>
            {usdc != null ? usdc.toFixed(4) : "—"} {pt(ANCHOR_ASSET_CODE)}
          </Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">{pt("İşlem ücreti için")}</Typography>
          <Typography sx={{ fontFamily: "var(--font-arbeit-technik)", fontWeight: 700 }}>
            {treasury?.xlm != null ? Number(treasury.xlm).toFixed(2) : "—"} XLM
          </Typography>
        </Box>
      </Stack>

      <Stack direction={{ xs: "column", sm: "row" }} gap={1} alignItems={{ sm: "center" }} sx={{ mt: 2 }}>
        {faucetButton}
        <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none", lineHeight: 1.6 }}>{pt(" Faucet'te ağ olarak Stellar Testnet seçin, bu adresi yapıştırın. Gelen ")}{pt(ANCHOR_ASSET_CODE)}{pt(" birkaç saniye içinde yukarıda görünür. ")}</Typography>
      </Stack>
    </Paper>
  );
}
