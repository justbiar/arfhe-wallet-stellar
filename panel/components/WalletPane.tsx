/**
 * The Arfhe side.
 *
 * A Stellar account, its balances, and the action that starts a ramp. Styled to match the
 * wallet rather than the bank: same bone surface, same mono numerals, same square edges.
 *
 * No key is generated or held here yet — this pane shows the shape of the flow while the
 * Stellar and SEP layers are built underneath it. Nothing displayed below is invented data:
 * where a value is not yet known it says so rather than showing a plausible number, because
 * a demo that shows a fake balance teaches the wrong thing about a wallet.
 */
import React from "react";
import {
  Box, Stack, Typography, Button, Divider, Chip, TextField, InputAdornment, Tooltip, IconButton,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopyOutlined";
import PaneFrame from "./PaneFrame";
import { ANCHOR_ASSET_CODE, WITHDRAW_MIN_USDC } from "../lib/anchor";
import type { Direction } from "../pages/Bridge";

export default function WalletPane({ direction }: { direction: Direction }) {
  const [amount, setAmount] = React.useState("");
  const accent = "#4338CA";

  return (
    <PaneFrame
      label="ARFHE WALLET"
      accent={accent}
      title={
        <Chip
          size="small"
          label="BAĞLI DEĞİL"
          sx={{ borderRadius: 0, height: 20, fontSize: 10, fontWeight: 700, bgcolor: "action.hover", color: "text.secondary" }}
        />
      }
    >
      {/* ── Hesap ── */}
      <Box sx={{ border: "1px solid", borderColor: "divider", p: 2 }}>
        <Stack direction="row" alignItems="center" gap={0.5}>
          <Typography variant="caption" color="text.secondary">STELLAR ADRESİ</Typography>
          <Tooltip title="Kopyala">
            <span>
              <IconButton size="small" disabled sx={{ p: 0.3 }}>
                <ContentCopyIcon sx={{ fontSize: 13 }} />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
        <Typography sx={{ fontFamily: "var(--font-arbeit-technik)", fontSize: 13, mt: 0.5, color: "text.disabled" }}>
          G···
        </Typography>

        <Stack direction="row" gap={3} sx={{ mt: 2 }}>
          <Box>
            <Typography variant="caption" color="text.secondary">{ANCHOR_ASSET_CODE}</Typography>
            <Typography sx={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.2 }}>—</Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">XLM</Typography>
            <Typography sx={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.2 }}>—</Typography>
          </Box>
        </Stack>
      </Box>

      <Divider sx={{ my: 2.5 }} />

      {/* ── İşlem ── */}
      <Typography variant="caption" color="text.secondary" fontWeight={700}>
        {direction === "deposit" ? "YÜKLEME ALACAK" : "USDC GÖNDER"}
      </Typography>

      <Stack gap={2} sx={{ mt: 1.5 }}>
        {direction === "withdraw" && (
          <TextField
            label="Tutar"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            fullWidth
            helperText={`En az ${WITHDRAW_MIN_USDC} ${ANCHOR_ASSET_CODE}`}
            InputProps={{
              endAdornment: <InputAdornment position="end">{ANCHOR_ASSET_CODE}</InputAdornment>,
              sx: { borderRadius: 0 },
            }}
          />
        )}

        <Box sx={{ border: "1px dashed", borderColor: "divider", p: 2 }}>
          <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.6 }}>
            {direction === "deposit"
              ? "Havale onaylandığında USDC bu hesaba geçer. Hesapta USDC için bir güven hattı (trustline) yoksa, anchor ödemeyi talep edilebilir bakiye olarak bekletir."
              : "Gönderim, anchor'ın verdiği memo ile yapılır. Memo olmadan ödeme hangi çekim talebine ait olduğu anlaşılamaz ve eşleşmez."}
          </Typography>
        </Box>

        <Button
          variant="contained"
          disabled
          sx={{ borderRadius: 0, py: 1.2, bgcolor: accent, "&:hover": { bgcolor: "#3730A3" } }}
        >
          Cüzdanı bağla
        </Button>

        <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none", textAlign: "center" }}>
          Anahtarınız kimliğinizdir — şifre yok, hesap açma yok
        </Typography>
      </Stack>
    </PaneFrame>
  );
}
