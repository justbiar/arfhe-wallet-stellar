import { createTheme, type PaletteMode } from "@mui/material";
import getWalletTheme from "@wallet/components/ArfTheme";

/** Keep the extension's brand, with roomier surfaces for the web panel. */
export default function getTheme(mode: PaletteMode) {
  return createTheme(getWalletTheme(mode), {
    shape: { borderRadius: 6 },
    palette: {
      background: { default: mode === "light" ? "#F5F6FA" : "#0D0F12", paper: mode === "light" ? "#FFFFFF" : "#171B23" },
      divider: mode === "light" ? "#E1E4ED" : "#303644",
    },
    typography: {
      body1: { lineHeight: 1.65 }, body2: { lineHeight: 1.6 },
      caption: { letterSpacing: "0.01em", lineHeight: 1.5 },
      button: { fontFamily: "var(--font-arbeit-contrast)", letterSpacing: "0", textTransform: "none" },
    },
    components: {
      MuiCssBaseline: { styleOverrides: { body: { backgroundColor: mode === "light" ? "#F5F6FA" : "#0D0F12" } } },
      MuiButton: { styleOverrides: { root: { minHeight: 44, textTransform: "none", letterSpacing: "0", borderRadius: 12 } } },
      MuiPaper: { styleOverrides: { root: { backgroundImage: "none", backgroundColor: mode === "light" ? "#FFFFFF" : "#171B23" } } },
      MuiToggleButton: { styleOverrides: { root: { minHeight: 44, textTransform: "none" } } },
    },
  });
}
