/**
 * The bank side.
 *
 * Styled as a Turkish retail banking screen — account row, IBAN, a transfer form with an
 * "açıklama" field — because the demo's argument is that the familiar half stays familiar.
 * Everything here is simulated: the anchor issues the IBAN and reference, and the arrival of
 * the money is something the visitor asserts by pressing a button.
 *
 * The reference in the description field is the part that matters and the part people skip:
 * it is what ties an anonymous bank transfer to a specific deposit order.
 */
import React from "react";
import {
  Box, Stack, Typography, TextField, Button, Divider, InputAdornment, Alert,
} from "@mui/material";
import AccountBalanceIcon from "@mui/icons-material/AccountBalanceOutlined";
import PaneFrame from "./PaneFrame";
import { DEPOSIT_MIN_TRY, DEPOSIT_MAX_TRY, FIAT_CODE } from "../lib/anchor";
import type { Direction } from "../pages/Bridge";

/** The bank's own colour, kept away from the wallet's accent so the two read as separate products. */
const BANK_ACCENT = "#C8102E";

/** Placeholder account the sandbox presents. Not a real IBAN — the checksum is deliberately not valid. */
const DEMO_IBAN = "TR00 0001 0000 0000 0000 0000 00";

export default function BankPane({ direction }: { direction: Direction }) {
  const [amount, setAmount] = React.useState("");

  const numeric = Number(amount.replace(",", "."));
  const tooSmall = amount !== "" && numeric < DEPOSIT_MIN_TRY;
  const tooLarge = amount !== "" && numeric > DEPOSIT_MAX_TRY;
  const amountError = direction === "deposit" && (tooSmall || tooLarge);

  return (
    <PaneFrame
      label="BANKA"
      accent={BANK_ACCENT}
      title={
        <Stack direction="row" alignItems="center" gap={0.8}>
          <AccountBalanceIcon sx={{ fontSize: 16, color: BANK_ACCENT }} />
          <Typography variant="caption" sx={{ fontWeight: 700, color: BANK_ACCENT }}>
            SİMÜLE
          </Typography>
        </Stack>
      }
    >
      {/* ── Hesap ── */}
      <Box sx={{ border: "1px solid", borderColor: "divider", p: 2 }}>
        <Typography variant="caption" color="text.secondary">VADESİZ HESAP</Typography>
        <Typography sx={{ fontFamily: "var(--font-arbeit-technik)", fontSize: 13, mt: 0.5, color: "text.secondary" }}>
          {DEMO_IBAN}
        </Typography>
        <Stack direction="row" alignItems="baseline" gap={0.8} sx={{ mt: 1.5 }}>
          <Typography sx={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.02em" }}>—</Typography>
          <Typography variant="body2" color="text.secondary" fontWeight={700}>{FIAT_CODE}</Typography>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none" }}>
          Bakiye, bir yükleme başlatıldığında görünür
        </Typography>
      </Box>

      <Divider sx={{ my: 2.5 }} />

      {/* ── İşlem ── */}
      <Typography variant="caption" color="text.secondary" fontWeight={700}>
        {direction === "deposit" ? "PARA GÖNDER" : "GELEN HAVALE"}
      </Typography>

      {direction === "deposit" ? (
        <Stack gap={2} sx={{ mt: 1.5 }}>
          <TextField
            label="Tutar"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            fullWidth
            error={amountError}
            helperText={
              amountError
                ? `${DEPOSIT_MIN_TRY} – ${DEPOSIT_MAX_TRY} ${FIAT_CODE} arasında olmalı`
                : `İşlem başına ${DEPOSIT_MIN_TRY} – ${DEPOSIT_MAX_TRY} ${FIAT_CODE}`
            }
            InputProps={{
              endAdornment: <InputAdornment position="end">{FIAT_CODE}</InputAdornment>,
              sx: { borderRadius: 0 },
            }}
          />

          <TextField
            label="Alıcı IBAN"
            value=""
            placeholder="Yükleme başlatıldığında dolar"
            fullWidth
            disabled
            InputProps={{ sx: { borderRadius: 0, fontFamily: "var(--font-arbeit-technik)", fontSize: 13 } }}
          />

          <TextField
            label="Açıklama"
            value=""
            placeholder="Referans kodu buraya gelir"
            fullWidth
            disabled
            helperText="Bu referans olmadan havale hangi işleme ait olduğu anlaşılamaz"
            InputProps={{ sx: { borderRadius: 0, fontFamily: "var(--font-arbeit-technik)", fontSize: 13 } }}
          />

          <Button
            variant="contained"
            disabled
            sx={{ borderRadius: 0, py: 1.2, bgcolor: BANK_ACCENT, "&:hover": { bgcolor: "#A50D26" } }}
          >
            Havaleyi gönder
          </Button>
        </Stack>
      ) : (
        <Stack gap={2} sx={{ mt: 1.5 }}>
          <Alert severity="info" sx={{ borderRadius: 0 }}>
            Çekim yönünde banka alıcı taraftır. Cüzdandan çıkan USDC karşılığı {FIAT_CODE},
            simüle edilmiş bir FAST transferiyle bu hesaba geçer.
          </Alert>
          <Box sx={{ border: "1px dashed", borderColor: "divider", p: 2, textAlign: "center" }}>
            <Typography variant="body2" color="text.secondary">
              Henüz bekleyen bir gelen havale yok
            </Typography>
          </Box>
        </Stack>
      )}
    </PaneFrame>
  );
}
