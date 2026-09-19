/**
 * The wallet's two faces: the chain one and the bank one.
 *
 * Turkish exchanges put this switch at the top of the account screen, and the habit is worth
 * borrowing — someone who came to move lira should not have to find a settings page to do
 * it. What sits behind the two segments is genuinely different machinery (EVM networks and
 * balances on one side, a SEP-6 anchor and an IBAN on the other), which is exactly why they
 * are two modes rather than one screen with a filter.
 *
 * It navigates rather than swapping content in place: the two views have separate routes,
 * separate loading and separate failure states, and folding them into one component would
 * tie a bank outage to the page that shows your tokens.
 */

import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Box, ButtonBase, Typography, useTheme, alpha } from "@mui/material";

export type WalletMode = "web3" | "bank";

export default function WalletModeSwitch({ mode }: { mode: WalletMode }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const navigate = useNavigate();

  const Segment = ({ value, label }: { value: WalletMode; label: string }) => {
    const active = mode === value;
    return (
      <ButtonBase
        onClick={() => { if (!active) navigate(value === "bank" ? "/bank" : "/home"); }}
        aria-pressed={active}
        sx={{
          flex: 1,
          borderRadius: 3,
          py: 0.8,
          transition: "background-color .15s, color .15s",
          bgcolor: active ? "background.paper" : "transparent",
          boxShadow: active ? "0 2px 8px rgba(0,0,0,0.06)" : "none",
        }}
      >
        <Typography
          sx={{
            fontSize: 13,
            fontWeight: active ? 700 : 600,
            color: active ? "text.primary" : "text.secondary",
          }}
        >
          {label}
        </Typography>
      </ButtonBase>
    );
  };

  return (
    <Box sx={{ px: 2, pt: 2 }}>
      <Box
        sx={{
          display: "flex",
          gap: 0.5,
          p: 0.5,
          borderRadius: 4,
          bgcolor: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.08 : 0.05),
        }}
      >
        <Segment value="web3" label={t("bank.modeWeb3")} />
        <Segment value="bank" label={t("bank.modeBank")} />
      </Box>
    </Box>
  );
}
