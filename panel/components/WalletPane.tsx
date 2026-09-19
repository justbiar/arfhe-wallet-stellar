/**
 * The Arfhe side: the demo account, its balances, and where the asset lands.
 *
 * The account is created here and belongs to this tab. The panel never asks for a recovery
 * phrase and has no field to type one into — see lib/stellar.ts for why that is a refusal
 * rather than an omission.
 */
import React from "react";
import {
  Box, Stack, Typography, Button, Divider, Chip, Tooltip, IconButton, CircularProgress, Alert, Link as MuiLink,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopyOutlined";
import CheckIcon from "@mui/icons-material/Check";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import PaneFrame from "./PaneFrame";
import { ANCHOR_ASSET_CODE } from "../lib/anchor";
import { shortAddress } from "../lib/stellar";
import type { Ramp } from "../lib/useRamp";
import type { Direction } from "../pages/Bridge";

const ACCENT = "#4338CA";

/** A number the user is meant to read, not scan past. */
function Amount({ value, code }: { value: string | null; code: string }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">{code}</Typography>
      <Typography sx={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.2 }}>
        {value === null ? "—" : trimZeros(value)}
      </Typography>
    </Box>
  );
}

/** Stellar reports seven decimals; showing 2.0396090 as-is is noise for a balance. */
function trimZeros(v: string): string {
  return v.includes(".") ? v.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "") : v;
}

export default function WalletPane({ direction, ramp }: { direction: Direction; ramp: Ramp }) {
  const [copied, setCopied] = React.useState(false);
  const connected = ramp.address !== null && ramp.phase !== "connecting";
  const busy = ramp.phase === "connecting";

  const copy = async () => {
    if (!ramp.address) return;
    try {
      await navigator.clipboard.writeText(ramp.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked; the address is on screen to select by hand */ }
  };

  return (
    <PaneFrame
      label="ARFHE WALLET"
      accent={ACCENT}
      title={
        <Chip
          size="small"
          label={connected ? "BAĞLI" : "BAĞLI DEĞİL"}
          sx={{
            borderRadius: 0, height: 20, fontSize: 10, fontWeight: 700,
            bgcolor: connected ? `${ACCENT}1A` : "action.hover",
            color: connected ? ACCENT : "text.secondary",
          }}
        />
      }
    >
      <Box sx={{ border: "1px solid", borderColor: "divider", p: 2 }}>
        <Stack direction="row" alignItems="center" gap={0.5}>
          <Typography variant="caption" color="text.secondary">STELLAR ADRESİ</Typography>
          {ramp.address && (
            <Tooltip title={copied ? "Kopyalandı" : "Kopyala"}>
              <IconButton size="small" onClick={copy} sx={{ p: 0.3 }}>
                {copied ? <CheckIcon sx={{ fontSize: 13 }} /> : <ContentCopyIcon sx={{ fontSize: 13 }} />}
              </IconButton>
            </Tooltip>
          )}
        </Stack>
        <Typography
          sx={{
            fontFamily: "var(--font-arbeit-technik)", fontSize: 13, mt: 0.5,
            color: ramp.address ? "text.primary" : "text.disabled", wordBreak: "break-all",
          }}
        >
          {ramp.address ? shortAddress(ramp.address, 10, 6) : "G···"}
        </Typography>

        <Stack direction="row" gap={3} sx={{ mt: 2 }}>
          <Amount value={ramp.balances?.usdc ?? null} code={ANCHOR_ASSET_CODE} />
          <Amount value={ramp.balances?.xlm ?? null} code="XLM" />
        </Stack>

        {ramp.address && (
          <MuiLink
            href={`https://stellar.expert/explorer/testnet/account/${ramp.address}`}
            target="_blank" rel="noopener noreferrer"
            variant="caption"
            sx={{ display: "inline-flex", alignItems: "center", gap: 0.4, mt: 1.5, color: "text.secondary", textTransform: "none" }}
          >
            Zincirde gör <OpenInNewIcon sx={{ fontSize: 12 }} />
          </MuiLink>
        )}
      </Box>

      <Divider sx={{ my: 2.5 }} />

      <Typography variant="caption" color="text.secondary" fontWeight={700}>
        {direction === "deposit" ? "YÜKLEME ALACAK" : "USDC GÖNDER"}
      </Typography>

      <Stack gap={2} sx={{ mt: 1.5 }}>
        {ramp.phase === "done" && (
          <Alert severity="success" sx={{ borderRadius: 0 }}>
            {trimZeros(ramp.status?.amountOut ?? "")} {ANCHOR_ASSET_CODE} hesabınıza geçti.
          </Alert>
        )}

        {ramp.error && (
          <Alert severity="error" sx={{ borderRadius: 0 }}>{ramp.error}</Alert>
        )}

        <Box sx={{ border: "1px dashed", borderColor: "divider", p: 2 }}>
          <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.6 }}>
            {direction === "deposit"
              ? "Havale onaylandığında USDC bu hesaba geçer. Güven hattı bağlanırken açıldı, yani ödeme doğrudan düşer — bekleyen bir talep olarak kalmaz."
              : "Gönderim, anchor'ın verdiği memo ile yapılır. Memo olmadan ödeme hangi çekim talebine ait olduğu anlaşılamaz."}
          </Typography>
        </Box>

        {!connected ? (
          <Button
            variant="contained"
            onClick={ramp.connect}
            disabled={busy}
            startIcon={busy ? <CircularProgress size={14} color="inherit" /> : null}
            sx={{ borderRadius: 0, py: 1.2, bgcolor: ACCENT, "&:hover": { bgcolor: "#3730A3" } }}
          >
            {busy ? "Hesap hazırlanıyor…" : "Demo cüzdanı oluştur"}
          </Button>
        ) : (
          <Button
            variant="outlined"
            onClick={ramp.refreshBalances}
            sx={{ borderRadius: 0, py: 1.2, borderColor: "divider", color: "text.primary" }}
          >
            Bakiyeleri yenile
          </Button>
        )}

        <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none", textAlign: "center", lineHeight: 1.5 }}>
          Bu sekme için üretilmiş tek kullanımlık testnet hesabı.<br />
          Kurtarma ifadeniz hiçbir zaman istenmez.
        </Typography>
      </Stack>
    </PaneFrame>
  );
}
