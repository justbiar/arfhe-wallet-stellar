/**
 * The bank side: where the order is opened and the transfer is confirmed.
 *
 * Styled as a Turkish retail banking screen because the demo's argument is that the familiar
 * half stays familiar. The bank is simulated — the anchor issues the IBAN and the reference,
 * and the arrival of the money is something the visitor asserts by pressing a button.
 *
 * The reference in the description field is the part people skip and the part that matters:
 * it is what ties an otherwise anonymous bank transfer to one specific deposit order.
 */
import React from "react";
import {
  Box, Stack, Typography, TextField, Button, Divider, InputAdornment, Alert,
  CircularProgress, Chip,
} from "@mui/material";
import AccountBalanceIcon from "@mui/icons-material/AccountBalanceOutlined";
import PaneFrame from "./PaneFrame";
import { DEPOSIT_MIN_TRY, DEPOSIT_MAX_TRY, FIAT_CODE, ANCHOR_ASSET_CODE } from "../lib/anchor";
import type { Ramp } from "../lib/useRamp";
import type { Direction } from "../pages/Bridge";

const BANK_ACCENT = "#C8102E";

/** Field the anchor filled in, shown as read-only rather than as an empty input. */
function Filled({ label, value, help }: { label: string; value: string | null; help?: string }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Box
        sx={{
          mt: 0.5, px: 1.5, py: 1.2, border: "1px solid", borderColor: value ? "text.primary" : "divider",
          fontFamily: "var(--font-arbeit-technik)", fontSize: 13,
          color: value ? "text.primary" : "text.disabled", wordBreak: "break-all",
        }}
      >
        {value ?? "—"}
      </Box>
      {help && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5, textTransform: "none" }}>
          {help}
        </Typography>
      )}
    </Box>
  );
}

export default function BankPane({ direction, ramp }: { direction: Direction; ramp: Ramp }) {
  const [amount, setAmount] = React.useState("100");

  const numeric = Number(amount.replace(",", "."));
  const outOfRange = amount !== "" && (numeric < DEPOSIT_MIN_TRY || numeric > DEPOSIT_MAX_TRY);

  const connected = ramp.address !== null && ramp.phase !== "connecting";
  const ordering = ramp.phase === "ordering";
  const settling = ramp.phase === "settling";
  const paying = ramp.phase === "paying";
  const hasOrder = ramp.order !== null;

  const tryAmount = direction === "deposit" ? ramp.status?.amountIn : ramp.status?.amountOut;

  return (
    <PaneFrame
      label="BANKA · CONFIDENTIAL ANCHOR"
      accent={BANK_ACCENT}
      title={
        <Stack direction="row" alignItems="center" gap={0.8}>
          <AccountBalanceIcon sx={{ fontSize: 16, color: BANK_ACCENT }} />
          <Typography variant="caption" sx={{ fontWeight: 700, color: BANK_ACCENT }}>SİMÜLE</Typography>
        </Stack>
      }
    >
      <Box sx={{ border: "1px solid", borderColor: "divider", p: 2 }}>
        <Typography variant="caption" color="text.secondary">VADESİZ HESAP</Typography>
        <Typography sx={{ fontFamily: "var(--font-arbeit-technik)", fontSize: 13, mt: 0.5, color: "text.secondary" }}>
          TR00 0001 0000 0000 0000 0000 00
        </Typography>
        {/* Which side of the pair is TRY flips with the direction: on a deposit the user
            sends fiat (`amount_in`), on a withdrawal they receive it (`amount_out`).
            Showing the same field in both would print USDC under a TRY label. */}
        <Stack direction="row" alignItems="baseline" gap={0.8} sx={{ mt: 1.5 }}>
          <Typography sx={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.02em" }}>
            {tryAmount ?? "—"}
          </Typography>
          <Typography variant="body2" color="text.secondary" fontWeight={700}>{FIAT_CODE}</Typography>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none" }}>
          {tryAmount
            ? (direction === "deposit" ? "Bu işlemde gönderilen tutar" : "Bu işlemde alınan tutar")
            : "Bakiye, bir işlem başlatıldığında görünür"}
        </Typography>
      </Box>

      <Divider sx={{ my: 2.5 }} />

      {direction === "deposit" ? (
        <>
          <Typography variant="caption" color="text.secondary" fontWeight={700}>PARA GÖNDER</Typography>
          <Stack gap={2} sx={{ mt: 1.5 }}>
            <TextField
              label="Tutar"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              fullWidth
              disabled={hasOrder || !connected}
              error={outOfRange}
              helperText={
                outOfRange
                  ? `${DEPOSIT_MIN_TRY} – ${DEPOSIT_MAX_TRY} ${FIAT_CODE} arasında olmalı`
                  : `İşlem başına ${DEPOSIT_MIN_TRY} – ${DEPOSIT_MAX_TRY} ${FIAT_CODE}`
              }
              InputProps={{
                endAdornment: <InputAdornment position="end">{FIAT_CODE}</InputAdornment>,
                sx: { borderRadius: 0 },
              }}
            />

            <Filled label="Alıcı IBAN" value={ramp.order?.iban ?? null} />
            <Filled
              label="Açıklama"
              value={ramp.order?.reference ?? null}
              help="Bu referans olmadan havale hangi işleme ait olduğu anlaşılamaz"
            />

            {!connected && (
              <Alert severity="info" sx={{ borderRadius: 0 }}>
                Önce soldan demo cüzdanı oluşturun — yükleme bir Stellar hesabına yapılır.
              </Alert>
            )}

            {ramp.phase === "done" && (
              <Alert severity="success" sx={{ borderRadius: 0 }}>
                {ramp.status?.amountIn} {FIAT_CODE} gönderildi,{" "}
                {ramp.status?.amountOut} {ANCHOR_ASSET_CODE} olarak karşıya geçti.
              </Alert>
            )}

            {settling && (
              <Stack direction="row" alignItems="center" gap={1.2}>
                <CircularProgress size={15} />
                <Typography variant="body2" color="text.secondary">
                  Anchor işliyor{ramp.status?.status ? ` — ${ramp.status.status}` : "…"}
                </Typography>
              </Stack>
            )}

            {!hasOrder ? (
              <Button
                variant="contained"
                disabled={!connected || outOfRange || amount === "" || ordering}
                onClick={() => ramp.openDeposit(amount)}
                startIcon={ordering ? <CircularProgress size={14} color="inherit" /> : null}
                sx={{ borderRadius: 0, py: 1.2, bgcolor: BANK_ACCENT, "&:hover": { bgcolor: "#A50D26" } }}
              >
                {ordering ? "Yükleme açılıyor…" : "Yükleme başlat"}
              </Button>
            ) : ramp.phase === "done" ? (
              <Button
                variant="outlined"
                onClick={ramp.reset}
                sx={{ borderRadius: 0, py: 1.2, borderColor: "divider", color: "text.primary" }}
              >
                Yeni yükleme
              </Button>
            ) : (
              <Button
                variant="contained"
                disabled={settling}
                onClick={() => ramp.confirmTransfer(amount)}
                sx={{ borderRadius: 0, py: 1.2, bgcolor: BANK_ACCENT, "&:hover": { bgcolor: "#A50D26" } }}
              >
                {settling ? "Bekleniyor…" : "Havaleyi gönder"}
              </Button>
            )}

            {hasOrder && ramp.phase !== "done" && (
              <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none", textAlign: "center" }}>
                Sandbox: bankayı siz oynuyorsunuz. Düğme, havalenin geldiğini anchor'a bildirir.
              </Typography>
            )}
          </Stack>
        </>
      ) : (
        <>
          <Typography variant="caption" color="text.secondary" fontWeight={700}>GELEN HAVALE</Typography>
          <Stack gap={2} sx={{ mt: 1.5 }}>
            {/* In this direction the bank does nothing until the chain moves. There is no
                button on this side on purpose: the order of events is the difference
                between the two flows, and a control here would suggest otherwise. */}
            {!ramp.withdrawOrder ? (
              <Alert severity="info" sx={{ borderRadius: 0 }}>
                {connected
                  ? `Soldan bir çekim talebi açın. ${ANCHOR_ASSET_CODE} zincirde gönderildikten sonra ` +
                    `anchor ${FIAT_CODE} ödemesini buraya yapar.`
                  : "Önce soldan bir hesap bağlayın."}
              </Alert>
            ) : (
              <>
                <Filled
                  label="Alacak IBAN"
                  value={ramp.withdrawOrder.iban}
                  help={`${FIAT_CODE} bu hesaba yatar — banka tarafı simüle`}
                />

                {/* The anchor's own sentence, verbatim. It carries the locked rate and the
                    exact terms, and paraphrasing them here would be this page speaking for
                    the anchor about money it is about to pay. */}
                {ramp.withdrawOrder.message && (
                  <Box sx={{ border: "1px dashed", borderColor: "divider", p: 1.5 }}>
                    <Typography variant="caption" color="text.secondary" fontWeight={700} sx={{ display: "block", mb: 0.5 }}>
                      ANCHOR'IN BEYANI
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none", lineHeight: 1.6 }}>
                      {ramp.withdrawOrder.message}
                    </Typography>
                  </Box>
                )}
              </>
            )}

            {(paying || settling) && (
              <Stack direction="row" alignItems="center" gap={1.2}>
                <CircularProgress size={15} />
                <Typography variant="body2" color="text.secondary">
                  {paying
                    ? `${ANCHOR_ASSET_CODE} gönderiliyor…`
                    : `Anchor işliyor${ramp.status?.status ? ` — ${ramp.status.status}` : "…"}`}
                </Typography>
              </Stack>
            )}

            {ramp.phase === "done" && (
              <Alert severity="success" sx={{ borderRadius: 0 }}>
                {ramp.status?.amountOut} {FIAT_CODE} hesabınıza geçti
                {ramp.status?.externalTxId ? ` · dekont ${ramp.status.externalTxId}` : ""}.
              </Alert>
            )}

            <Chip
              label="BANKA AYAĞI SİMÜLE"
              size="small"
              sx={{ borderRadius: 0, alignSelf: "flex-start" }}
            />
          </Stack>
        </>
      )}
    </PaneFrame>
  );
}
