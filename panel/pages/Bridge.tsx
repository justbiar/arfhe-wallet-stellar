import { pt } from "../lib/language";
/**
 * The split screen: a bank on the right, Arfhe Wallet on the left, money crossing between.
 *
 * The two panes are deliberately styled as two different products rather than two halves of
 * one — a bank's screen and a wallet's screen do not look alike, and the point of putting
 * them side by side is that the handoff between them is the only thing they share.
 *
 * This file is the layout and the state that spans both panes. The Stellar and SEP calls
 * live in lib/ so the same code can be pointed at a production anchor later.
 */
import React from "react";
import { Box, Stack, Typography, Chip, Divider, ToggleButton, ToggleButtonGroup, useTheme, alpha } from "@mui/material";
import SwapHorizIcon from "@mui/icons-material/SwapHoriz";
import { ANCHOR_HOME_DOMAIN, FIAT_CODE, ANCHOR_ASSET_CODE } from "../lib/anchor";
import { useRamp } from "../lib/useRamp";
import BankPane from "../components/BankPane";
import WalletPane from "../components/WalletPane";

export type Direction = "deposit" | "withdraw";

export default function Bridge() {
  const theme = useTheme();
  const [direction, setDirection] = React.useState<Direction>("deposit");
  const ramp = useRamp();

  return (
    <Box sx={{ maxWidth: 1180, mx: "auto", px: { xs: 2, md: 3 }, py: { xs: 3, md: 5 } }}>
      <Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "flex-end" }} gap={1.5} sx={{ mb: 3 }}>
        <Box sx={{ flex: 1 }}>
          <Typography sx={{ fontFamily: "var(--font-arbeit-contrast)", fontWeight: 800, fontSize: { xs: 28, md: 34 }, letterSpacing: "-0.02em" }}>{pt(" Köprü ")}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{pt(" Solda cüzdanınız, sağda banka. Para ikisi arasında gidip geliyor. ")}</Typography>
        </Box>
        {/*
          * The direction switch lives here, not only in the divider between the panes.
          *
          * That divider is hidden below the md breakpoint, which left narrow screens with the
          * arrow as the only control and therefore no way to switch at all. Direction is the
          * page's primary choice; it belongs somewhere always visible, and the arrow between
          * the panes is the echo of it rather than the other way round.
          */}
        <ToggleButtonGroup
          exclusive
          size="small"
          value={direction}
          onChange={(_, v) => { if (v) setDirection(v as Direction); }}
          aria-label={pt("Yön")}
          sx={{
            "& .MuiToggleButton-root": {
              borderRadius: 3, px: 1.8, py: 0.6, fontSize: 11, fontWeight: 700,
              borderColor: "divider",
            },
          }}
        >
          <ToggleButton value="deposit">{pt("Yükleme")}</ToggleButton>
          <ToggleButton value="withdraw">{pt("Çekme")}</ToggleButton>
        </ToggleButtonGroup>

        <Chip
          size="small"
          label={pt(`${ANCHOR_HOME_DOMAIN} · TESTNET`)}
          sx={{
            borderRadius: 3, fontWeight: 700,
            bgcolor: alpha(theme.palette.primary.main, 0.1),
            color: theme.palette.primary.main,
            border: "1px solid", borderColor: alpha(theme.palette.primary.main, 0.3),
          }}
        />
      </Stack>

      {/* ── İki pano ── */}
      <Box
        sx={{
          display: "grid",
          gap: { xs: 2, md: 0 },
          gridTemplateColumns: { xs: "1fr", md: "1fr auto 1fr" },
          alignItems: "stretch",
        }}
      >
        <WalletPane direction={direction} ramp={ramp} />

        {/* Ortadaki yön göstergesi — mobilde araya girmez, sadece geniş ekranda sütun olur. */}
        <Stack
          alignItems="center"
          justifyContent="center"
          sx={{ px: 2, display: { xs: "none", md: "flex" } }}
        >
          <Divider orientation="vertical" sx={{ flex: 1 }} />
          <Box
            role="button"
            tabIndex={0}
            onClick={() => setDirection((d) => (d === "deposit" ? "withdraw" : "deposit"))}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setDirection((d) => (d === "deposit" ? "withdraw" : "deposit")); }}
            aria-label={pt("Yönü değiştir")}
            title={pt("Yönü değiştir")}
            sx={{
              my: 1.5, width: 44, height: 44, cursor: "pointer",
              display: "grid", placeItems: "center",
              border: "1px solid", borderColor: "divider", bgcolor: "background.paper",
              transition: "border-color .15s",
              "&:hover, &:focus-visible": { borderColor: "text.primary" },
            }}
          >
            <SwapHorizIcon
              sx={{
                fontSize: 20,
                transform: direction === "withdraw" ? "scaleX(-1)" : "none",
                transition: "transform .2s",
              }}
            />
          </Box>
          <Divider orientation="vertical" sx={{ flex: 1 }} />
        </Stack>

        <BankPane direction={direction} ramp={ramp} />
      </Box>

      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 3, textTransform: "none" }}>
        {pt(direction === "deposit"
          ? `${FIAT_CODE} → ${ANCHOR_ASSET_CODE}: bankadan gelen havale, cüzdanınıza ${ANCHOR_ASSET_CODE} olarak geçer.`
          : `${ANCHOR_ASSET_CODE} → ${FIAT_CODE}: cüzdanınızdan çıkan ${ANCHOR_ASSET_CODE}, IBAN'ınıza ${FIAT_CODE} olarak döner.`)}
      </Typography>
    </Box>
  );
}
